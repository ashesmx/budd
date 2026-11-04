import type Database from 'better-sqlite3';
import { ulid } from 'ulid';
import type {
  Account,
  ClientAuthMethod,
  CodeRecord,
  ConnectionKey,
  LocalLogin,
  Theme,
  LoginResult,
  OAuthClient,
  OAuthGrant,
  TokenGrant,
  TokenPair,
} from '../../domain/auth.js';
import { slugify, withSuffix } from '../../domain/slug.js';
import type { Workspace } from '../../domain/types.js';
import type { AuthStore } from '../Storage.js';
import { run } from './async.js';
import { LOCAL_WORKSPACE_SLUG } from './SqliteControlStore.js';

interface ClientRow {
  client_id: string;
  client_secret_hash: string | null;
  auth_method: ClientAuthMethod;
  client_name: string | null;
  slug_base: string;
  redirect_uris_json: string;
  metadata_json: string;
  created_at: number;
}

interface GrantRow {
  id: string;
  client_id: string;
  workspace_id: string;
  connection_id: string;
  account_id: string;
  created_at: number;
}

interface KeyRow {
  workspace_id: string;
  connection_id: string;
  account_id: string;
  key_hint: string;
  created_at: number;
  last_used_at: number | null;
  expires_at: number;
}

const toKey = (r: KeyRow): ConnectionKey => ({
  workspaceId: r.workspace_id,
  connectionId: r.connection_id,
  accountId: r.account_id,
  hint: r.key_hint,
  createdAt: r.created_at,
  lastUsedAt: r.last_used_at,
  expiresAt: r.expires_at,
});

/** A key's use is recorded at most this often, so using it isn't a write per request. */
const KEY_USE_RECORDED_EVERY_MS = 3600_000;

/** A key works only while whoever made it is a member of its workspace (ADR 0016). */
const KEY_MAKER_IS_MEMBER =
  'JOIN memberships m ON m.account_id = k.account_id AND m.workspace_id = k.workspace_id';

interface TokenRow {
  token_hash: string;
  kind: 'access' | 'refresh';
  grant_id: string;
  family_id: string;
  expires_at: number;
  rotated_at: number | null;
  revoked_at: number | null;
}

const toGrant = (r: GrantRow): OAuthGrant => ({
  id: r.id,
  clientId: r.client_id,
  workspaceId: r.workspace_id,
  connectionId: r.connection_id,
  accountId: r.account_id,
  createdAt: r.created_at,
});

export class SqliteAuthStore implements AuthStore {
  constructor(private readonly db: Database.Database) {}

  signIn(input: {
    issuer: string;
    subject: string;
    email: string;
    name?: string | undefined;
    picture?: string | undefined;
    slugBase: string;
    now: number;
  }): Promise<LoginResult> {
    const { issuer, subject, email, now } = input;
    const name = input.name ?? null;
    const picture = input.picture ?? null;
    return run(() =>
      this.db.transaction((): LoginResult => {
        const existing = this.db
          .prepare('SELECT id FROM accounts WHERE oidc_issuer = ? AND oidc_subject = ?')
          .get(issuer, subject) as { id: string } | undefined;
        // An address can pass to a new identity (a leaver's address reissued, or
        // an alias). The identity is (issuer, subject), never the email, so an
        // older account still holding this address just loses it.
        this.db
          .prepare('UPDATE accounts SET email = NULL WHERE email = ? AND id IS NOT ?')
          .run(email, existing?.id ?? null);
        if (existing) {
          // Email can change at the provider; the (issuer, subject) pair is the identity.
          this.db
            .prepare('UPDATE accounts SET email = ?, name = ?, picture = ? WHERE id = ?')
            .run(email, name, picture, existing.id);
          // Erasing now deletes an account with its last workspace, but data erased
          // with the old `node -e` instructions kept the account: give it a fresh one.
          if (this.workspacesFor(existing.id).length === 0) {
            this.provisionWorkspace(existing.id, input.slugBase, now);
          }
          return {
            account: this.account(existing.id),
            created: false,
            workspaces: this.workspacesFor(existing.id),
          };
        }
        const id = ulid(now);
        this.db
          .prepare(
            `INSERT INTO accounts (id, email, name, picture, created_at, oidc_issuer, oidc_subject)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(id, email, name, picture, now, issuer, subject);
        this.provisionWorkspace(id, input.slugBase, now);
        return { account: this.account(id), created: true, workspaces: this.workspacesFor(id) };
      })(),
    );
  }

  /** A personal workspace slugged from `slugBase` (suffixed on collision), with the account as member. */
  private provisionWorkspace(accountId: string, slugBase: string, now: number): void {
    const base = slugify(slugBase);
    let slug = base;
    for (let n = 2; this.db.prepare('SELECT 1 FROM workspaces WHERE slug = ?').get(slug); n++) {
      slug = withSuffix(base, n);
    }
    const workspaceId = ulid(now);
    this.db
      .prepare('INSERT INTO workspaces (id, slug, created_at) VALUES (?, ?, ?)')
      .run(workspaceId, slug, now);
    this.db
      .prepare('INSERT INTO memberships (account_id, workspace_id, created_at) VALUES (?, ?, ?)')
      .run(accountId, workspaceId, now);
  }

  getAccount(accountId: string): Promise<Account | undefined> {
    return run(() => this.account(accountId));
  }

  recordSignIn(accountId: string, now: number): Promise<void> {
    return run(() => {
      this.db.prepare('UPDATE accounts SET last_sign_in_at = ? WHERE id = ?').run(now, accountId);
    });
  }

  findAccountId(issuer: string, subject: string): Promise<string | undefined> {
    return run(
      () =>
        (
          this.db
            .prepare('SELECT id FROM accounts WHERE oidc_issuer = ? AND oidc_subject = ?')
            .get(issuer, subject) as { id: string } | undefined
        )?.id,
    );
  }

  listWorkspacesForAccount(accountId: string): Promise<Workspace[]> {
    return run(() => this.workspacesFor(accountId));
  }

  createClient(c: OAuthClient): Promise<void> {
    return run(() => {
      this.db
        .prepare(
          `INSERT INTO oauth_clients (client_id, client_secret_hash, auth_method, client_name,
             slug_base, redirect_uris_json, metadata_json, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          c.clientId,
          c.clientSecretHash,
          c.authMethod,
          c.clientName,
          c.slugBase,
          JSON.stringify(c.redirectUris),
          JSON.stringify(c.metadata),
          c.createdAt,
        );
    });
  }

  getClient(clientId: string): Promise<OAuthClient | undefined> {
    return run(() => {
      const r = this.db.prepare('SELECT * FROM oauth_clients WHERE client_id = ?').get(clientId) as
        ClientRow | undefined;
      return (
        r && {
          clientId: r.client_id,
          clientSecretHash: r.client_secret_hash,
          authMethod: r.auth_method,
          clientName: r.client_name,
          slugBase: r.slug_base,
          redirectUris: JSON.parse(r.redirect_uris_json) as string[],
          metadata: JSON.parse(r.metadata_json) as Record<string, unknown>,
          createdAt: r.created_at,
        }
      );
    });
  }

  getGrant(clientId: string, workspaceId: string): Promise<OAuthGrant | undefined> {
    return run(() => {
      const r = this.db
        .prepare('SELECT * FROM oauth_grants WHERE client_id = ? AND workspace_id = ?')
        .get(clientId, workspaceId) as GrantRow | undefined;
      return r && toGrant(r);
    });
  }

  approvedRedirectUris(workspaceId: string): Promise<Map<string, string[]>> {
    return run(() => {
      const rows = this.db
        .prepare(
          `SELECT g.connection_id, c.redirect_uris_json FROM oauth_grants g
           JOIN oauth_clients c ON c.client_id = g.client_id
           WHERE g.workspace_id = ?`,
        )
        .all(workspaceId) as { connection_id: string; redirect_uris_json: string }[];
      const uris = new Map<string, string[]>();
      for (const r of rows) {
        uris.set(r.connection_id, [
          ...(uris.get(r.connection_id) ?? []),
          ...(JSON.parse(r.redirect_uris_json) as string[]),
        ]);
      }
      return uris;
    });
  }

  getGrantById(grantId: string): Promise<OAuthGrant | undefined> {
    return run(() => this.grant(grantId));
  }

  createGrant(g: OAuthGrant): Promise<void> {
    return run(() => {
      this.db
        .prepare(
          `INSERT INTO oauth_grants (id, client_id, workspace_id, connection_id, account_id, created_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(g.id, g.clientId, g.workspaceId, g.connectionId, g.accountId, g.createdAt);
    });
  }

  createCode(c: CodeRecord): Promise<void> {
    return run(() => {
      this.db
        .prepare(
          `INSERT INTO oauth_codes (code_hash, grant_id, redirect_uri, code_challenge, family_id, expires_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(c.codeHash, c.grantId, c.redirectUri, c.codeChallenge, c.familyId, c.expiresAt);
    });
  }

  redeemCode(
    codeHash: string,
    now: number,
  ): Promise<{ status: 'ok'; code: CodeRecord } | { status: 'reused' | 'invalid' }> {
    return run(() =>
      this.db.transaction(() => {
        const r = this.db.prepare('SELECT * FROM oauth_codes WHERE code_hash = ?').get(codeHash) as
          | {
              code_hash: string;
              grant_id: string;
              redirect_uri: string;
              code_challenge: string;
              family_id: string;
              expires_at: number;
              used_at: number | null;
            }
          | undefined;
        if (!r) return { status: 'invalid' as const };
        if (r.used_at !== null) {
          this.revokeFamily(r.family_id, now);
          return { status: 'reused' as const };
        }
        this.db
          .prepare('UPDATE oauth_codes SET used_at = ? WHERE code_hash = ?')
          .run(now, codeHash);
        if (r.expires_at <= now) return { status: 'invalid' as const };
        return {
          status: 'ok' as const,
          code: {
            codeHash: r.code_hash,
            grantId: r.grant_id,
            redirectUri: r.redirect_uri,
            codeChallenge: r.code_challenge,
            familyId: r.family_id,
            expiresAt: r.expires_at,
          },
        };
      })(),
    );
  }

  issueTokens(
    input: TokenPair & { grantId: string; familyId: string; now: number },
  ): Promise<void> {
    return run(() => {
      this.db.transaction(() => {
        this.insertPair(input, input.grantId, input.familyId, input.now);
      })();
    });
  }

  findAccessToken(accessHash: string, now: number): Promise<TokenGrant | undefined> {
    return run(() => {
      const t = this.db
        .prepare(
          `SELECT * FROM oauth_tokens
           WHERE token_hash = ? AND kind = 'access' AND revoked_at IS NULL AND expires_at > ?`,
        )
        .get(accessHash, now) as TokenRow | undefined;
      const grant = t && this.grant(t.grant_id);
      return t && grant && { grant, familyId: t.family_id, expiresAt: t.expires_at };
    });
  }

  rotateRefreshToken(input: {
    refreshHash: string;
    clientId: string;
    next: TokenPair;
    now: number;
  }): Promise<
    | { status: 'ok'; grant: OAuthGrant }
    | { status: 'reused'; grant: OAuthGrant | undefined }
    | { status: 'invalid'; grant?: undefined }
  > {
    const { refreshHash, clientId, next, now } = input;
    return run(() =>
      this.db.transaction(() => {
        const t = this.db
          .prepare(`SELECT * FROM oauth_tokens WHERE token_hash = ? AND kind = 'refresh'`)
          .get(refreshHash) as TokenRow | undefined;
        const grant = t && this.grant(t.grant_id);
        if (!t || !grant || grant.clientId !== clientId) return { status: 'invalid' as const };
        if (t.rotated_at !== null) {
          // An exchanged refresh token came back: someone else has a copy.
          this.revokeFamily(t.family_id, now);
          return { status: 'reused' as const, grant };
        }
        if (t.revoked_at !== null || t.expires_at <= now) return { status: 'invalid' as const };
        this.db
          .prepare('UPDATE oauth_tokens SET rotated_at = ? WHERE token_hash = ?')
          .run(now, refreshHash);
        // The old access token stops working once it has been refreshed.
        this.db
          .prepare(
            `UPDATE oauth_tokens SET revoked_at = ?
             WHERE family_id = ? AND kind = 'access' AND revoked_at IS NULL`,
          )
          .run(now, t.family_id);
        this.insertPair(next, t.grant_id, t.family_id, now);
        return { status: 'ok' as const, grant };
      })(),
    );
  }

  revokeToken(tokenHash: string, now: number, clientId?: string): Promise<OAuthGrant | undefined> {
    return run(() =>
      this.db.transaction(() => {
        const t = this.db
          .prepare('SELECT * FROM oauth_tokens WHERE token_hash = ?')
          .get(tokenHash) as TokenRow | undefined;
        const grant = t && this.grant(t.grant_id);
        if (!t || !grant || (clientId !== undefined && grant.clientId !== clientId)) {
          return undefined;
        }
        this.revokeFamily(t.family_id, now);
        return grant;
      })(),
    );
  }

  revokeConnection(
    workspaceId: string,
    connectionId: string,
    now: number,
  ): Promise<{ tokens: number; keys: number }> {
    return run(() =>
      this.db.transaction(() => ({
        tokens: this.db
          .prepare(
            `UPDATE oauth_tokens SET revoked_at = ?
             WHERE revoked_at IS NULL AND grant_id IN
               (SELECT id FROM oauth_grants WHERE workspace_id = ? AND connection_id = ?)`,
          )
          .run(now, workspaceId, connectionId).changes,
        keys: this.revokeKeys(workspaceId, connectionId, now),
      }))(),
    );
  }

  deleteGrants(workspaceId: string, connectionId: string): Promise<number> {
    return run(
      () =>
        this.db
          .prepare('DELETE FROM oauth_grants WHERE workspace_id = ? AND connection_id = ?')
          .run(workspaceId, connectionId).changes,
    );
  }

  createConnectionKey(input: {
    keyHash: string;
    hint: string;
    workspaceId: string;
    connectionId: string;
    accountId: string;
    expiresAt: number;
    now: number;
  }): Promise<number> {
    const { keyHash, hint, workspaceId, connectionId, accountId, expiresAt, now } = input;
    return run(() =>
      this.db.transaction(() => {
        const revoked = this.revokeKeys(workspaceId, connectionId, now);
        this.db
          .prepare(
            `INSERT INTO connection_keys
               (key_hash, workspace_id, connection_id, account_id, key_hint, created_at, expires_at)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(keyHash, workspaceId, connectionId, accountId, hint, now, expiresAt);
        return revoked;
      })(),
    );
  }

  useConnectionKey(
    keyHash: string,
    now: number,
    idleMs: number,
  ): Promise<ConnectionKey | 'expired' | undefined> {
    return run(() => {
      const row = this.db
        .prepare(`SELECT * FROM connection_keys WHERE key_hash = ? AND revoked_at IS NULL`)
        .get(keyHash) as KeyRow | undefined;
      if (!row) return undefined;
      if (row.expires_at <= now) return 'expired';
      if (row.last_used_at === null || now - row.last_used_at >= KEY_USE_RECORDED_EVERY_MS) {
        this.db
          .prepare('UPDATE connection_keys SET last_used_at = ?, expires_at = ? WHERE key_hash = ?')
          .run(now, now + idleMs, keyHash);
        return { ...toKey(row), lastUsedAt: now, expiresAt: now + idleMs };
      }
      return toKey(row);
    });
  }

  getConnectionKey(workspaceId: string, connectionId: string): Promise<ConnectionKey | undefined> {
    return run(() => {
      const row = this.db
        .prepare(
          `SELECT k.* FROM connection_keys k ${KEY_MAKER_IS_MEMBER}
           WHERE k.workspace_id = ? AND k.connection_id = ? AND k.revoked_at IS NULL`,
        )
        .get(workspaceId, connectionId) as KeyRow | undefined;
      return row && toKey(row);
    });
  }

  private revokeKeys(workspaceId: string, connectionId: string, now: number): number {
    return this.db
      .prepare(
        `UPDATE connection_keys SET revoked_at = ?
         WHERE revoked_at IS NULL AND workspace_id = ? AND connection_id = ?`,
      )
      .run(now, workspaceId, connectionId).changes;
  }

  liveConnectionIds(workspaceId: string, now: number): Promise<string[]> {
    return run(() =>
      (
        this.db
          .prepare(
            `SELECT DISTINCT g.connection_id FROM oauth_grants g JOIN oauth_tokens t ON t.grant_id = g.id
             WHERE g.workspace_id = ? AND t.revoked_at IS NULL AND t.rotated_at IS NULL AND t.expires_at > ?
             UNION
             SELECT k.connection_id FROM connection_keys k ${KEY_MAKER_IS_MEMBER}
             WHERE k.workspace_id = ? AND k.revoked_at IS NULL AND k.expires_at > ?`,
          )
          .all(workspaceId, now, workspaceId, now) as { connection_id: string }[]
      ).map((r) => r.connection_id),
    );
  }

  getLocalAccountId(): Promise<string | undefined> {
    return run(
      () =>
        (
          this.db
            .prepare(
              `SELECT m.account_id FROM memberships m JOIN workspaces w ON w.id = m.workspace_id
               WHERE w.slug = ? ORDER BY m.created_at LIMIT 1`,
            )
            .get(LOCAL_WORKSPACE_SLUG) as { account_id: string } | undefined
        )?.account_id,
    );
  }

  getLocalLogin(): Promise<LocalLogin | undefined> {
    return run(() => {
      const r = this.db.prepare('SELECT * FROM local_logins LIMIT 1').get() as
        | { account_id: string; username: string; password_hash: string; created_at: number }
        | undefined;
      return (
        r && {
          accountId: r.account_id,
          username: r.username,
          passwordHash: r.password_hash,
          createdAt: r.created_at,
        }
      );
    });
  }

  createLoginLink(codeHash: string, expiresAt: number, now: number): Promise<void> {
    return run(() => {
      this.db.transaction(() => {
        this.db.prepare('DELETE FROM local_login_links WHERE expires_at <= ?').run(now);
        this.db
          .prepare('INSERT INTO local_login_links (code_hash, expires_at) VALUES (?, ?)')
          .run(codeHash, expiresAt);
      })();
    });
  }

  redeemLoginLink(codeHash: string, now: number): Promise<boolean> {
    return run(() => {
      const row = this.db
        .prepare('DELETE FROM local_login_links WHERE code_hash = ? RETURNING expires_at')
        .get(codeHash) as { expires_at: number } | undefined;
      return row !== undefined && row.expires_at > now;
    });
  }

  setLocalLogin(login: Omit<LocalLogin, 'createdAt'> & { now: number }): Promise<void> {
    return run(() => {
      this.db.transaction(() => {
        this.db.prepare('DELETE FROM local_logins').run(); // there is only ever one
        this.db
          .prepare(
            `INSERT INTO local_logins (account_id, username, password_hash, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?)`,
          )
          .run(login.accountId, login.username, login.passwordHash, login.now, login.now);
      })();
    });
  }

  purge(input: {
    now: number;
    staleClientsBefore: number;
    maxUnauthorizedClients: number;
    recentClientsAfter: number;
  }): Promise<void> {
    return run(() => {
      this.db.transaction(() => {
        this.db.prepare('DELETE FROM oauth_codes WHERE expires_at <= ?').run(input.now);
        this.db.prepare('DELETE FROM oauth_tokens WHERE expires_at <= ?').run(input.now);
        this.db
          .prepare(
            `DELETE FROM oauth_clients WHERE created_at <= ?
             AND client_id NOT IN (SELECT client_id FROM oauth_grants)`,
          )
          .run(input.staleClientsBefore);
        // Beyond the cap, the oldest never-authorized registrations go first.
        // Ones younger than `recentClientsAfter` are spared, so a flood can't
        // evict an app whose user is still on the consent screen.
        this.db
          .prepare(
            `DELETE FROM oauth_clients WHERE created_at <= ? AND client_id IN (
               SELECT client_id FROM oauth_clients
               WHERE client_id NOT IN (SELECT client_id FROM oauth_grants)
               ORDER BY created_at DESC, client_id DESC
               LIMIT -1 OFFSET ?)`,
          )
          .run(input.recentClientsAfter, input.maxUnauthorizedClients);
      })();
    });
  }

  private insertPair(p: TokenPair, grantId: string, familyId: string, now: number): void {
    const insert = this.db.prepare(
      `INSERT INTO oauth_tokens (token_hash, kind, grant_id, family_id, expires_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    insert.run(p.accessHash, 'access', grantId, familyId, p.accessExpiresAt, now);
    insert.run(p.refreshHash, 'refresh', grantId, familyId, p.refreshExpiresAt, now);
  }

  private revokeFamily(familyId: string, now: number): void {
    this.db
      .prepare('UPDATE oauth_tokens SET revoked_at = ? WHERE family_id = ? AND revoked_at IS NULL')
      .run(now, familyId);
  }

  private grant(id: string): OAuthGrant | undefined {
    const r = this.db.prepare('SELECT * FROM oauth_grants WHERE id = ?').get(id) as
      GrantRow | undefined;
    return r && toGrant(r);
  }

  private account(id: string): Account;
  private account(id: string): Account | undefined {
    const r = this.db
      .prepare('SELECT id, email, name, picture, theme, created_at FROM accounts WHERE id = ?')
      .get(id) as
      | {
          id: string;
          email: string | null;
          name: string | null;
          picture: string | null;
          theme: Theme;
          created_at: number;
        }
      | undefined;
    if (!r) return undefined;
    return {
      id: r.id,
      email: r.email,
      name: r.name,
      picture: r.picture,
      theme: r.theme,
      createdAt: r.created_at,
    };
  }

  setTheme(accountId: string, theme: Theme): Promise<void> {
    return run(() => {
      this.db.prepare('UPDATE accounts SET theme = ? WHERE id = ?').run(theme, accountId);
    });
  }

  private workspacesFor(accountId: string): Workspace[] {
    return (
      this.db
        .prepare(
          `SELECT w.id, w.slug, w.created_at FROM workspaces w
           JOIN memberships m ON m.workspace_id = w.id
           WHERE m.account_id = ? ORDER BY w.created_at, w.slug`,
        )
        .all(accountId) as { id: string; slug: string; created_at: number }[]
    ).map((w) => ({ id: w.id, slug: w.slug, createdAt: w.created_at }));
  }
}

import { hashToken, KEY_PREFIX, newToken } from '../auth/tokens.js';
import type { ConnectionKey } from '../domain/auth.js';
import {
  isValidSlug,
  RESERVED_CONNECTION_SLUGS,
  SLUG_RULES,
  SYSTEM_CONNECTION_SLUG,
} from '../domain/slug.js';
import type { Connection } from '../domain/types.js';
import { log } from '../log.js';
import type { AdminContext, WorkspaceGateway } from '../storage/gateway.js';
import type { AuthStore } from '../storage/Storage.js';
import type { Config } from '../config.js';
import { AdminError, connectionLimitError } from './Admin.js';

/**
 * Hosted mode: connections a human creates in the UI for agents that can't
 * sign in with a browser (ADR 0016). The human names the connection; the agent
 * sends the API key as a bearer token. The key is shown once and stored hashed.
 */
export class ConnectionKeys {
  constructor(
    private readonly gateway: WorkspaceGateway,
    private readonly auth: AuthStore,
    private readonly config: Config,
    private readonly clock: () => number = Date.now,
  ) {}

  /** Creates the connection and its first key. Returns the key: show it once. */
  async create(
    ctx: AdminContext,
    accountId: string,
    input: { name: string; label: string },
  ): Promise<{ connection: Connection; key: string }> {
    const slug = input.name.trim().toLowerCase();
    const label = input.label.trim() || null;
    if (!isValidSlug(slug)) {
      throw new AdminError('invalid_input', `"${input.name}" can't be a name. Use ${SLUG_RULES}.`);
    }
    if (label !== null && label.length > 80) {
      throw new AdminError('invalid_input', 'Labels are limited to 80 characters.');
    }
    const store = await this.gateway.forAdmin(ctx);
    const connection = await store.createKeyConnection({
      slug,
      label,
      reserved: [...RESERVED_CONNECTION_SLUGS, ctx.workspace.slug],
      now: this.clock(),
    });
    if (connection === 'limit') throw connectionLimitError();
    if (connection === 'taken') {
      throw new AdminError(
        'invalid_input',
        `"${slug}" is already taken in this workspace (archived connections keep their names). Choose another name.`,
      );
    }
    return { connection, key: await this.issue(ctx, accountId, connection) };
  }

  /** A new key for a key connection; any old one stops working at once. Returns the key. */
  async rotate(ctx: AdminContext, accountId: string, slug: string): Promise<string> {
    const connection = await this.keyConnection(ctx, slug);
    if (connection.archivedAt !== null) {
      throw new AdminError('archived', `"${slug}" is archived. Restore it before giving it a key.`);
    }
    if (connection.status === 'blocked') {
      // Blocking revoked its key; unblocking first means the new key works when shown.
      throw new AdminError('blocked', `"${slug}" is blocked. Unblock it before giving it a key.`);
    }
    return this.issue(ctx, accountId, connection);
  }

  /** Revokes a key connection's key. Returns false if it had none. */
  async revoke(ctx: AdminContext, slug: string): Promise<boolean> {
    const connection = await this.keyConnection(ctx, slug);
    const now = this.clock();
    const { keys } = await this.auth.revokeConnection(ctx.workspace.id, connection.id, now);
    if (keys === 0) return false;
    await this.gateway.appendSystemAudit(ctx.workspace.id, {
      at: now,
      event: 'key_revoked',
      actor: 'human',
      connectionId: connection.id,
      detail: { connection: slug },
    });
    log.info('api key revoked', { workspace: ctx.workspace.slug, connection: slug });
    return true;
  }

  /** The connection's current key (never the key itself), if it has one. */
  current(ctx: AdminContext, connection: Connection): Promise<ConnectionKey | undefined> {
    return this.auth.getConnectionKey(ctx.workspace.id, connection.id);
  }

  /** Whether a key connection has a working key, so giving it one would replace it. */
  async hasKey(ctx: AdminContext, slug: string): Promise<boolean> {
    const key = await this.current(ctx, await this.keyConnection(ctx, slug));
    return key !== undefined && key.expiresAt > this.clock();
  }

  private async issue(ctx: AdminContext, accountId: string, connection: Connection) {
    const key = newToken(KEY_PREFIX);
    const now = this.clock();
    const replaced = await this.auth.createConnectionKey({
      keyHash: hashToken(key),
      hint: key.slice(-4),
      workspaceId: ctx.workspace.id,
      connectionId: connection.id,
      accountId,
      expiresAt: now + this.config.keyIdleExpiryMs,
      now,
    });
    await this.gateway.appendSystemAudit(ctx.workspace.id, {
      at: now,
      event: 'key_created',
      actor: 'human',
      connectionId: connection.id,
      detail: {
        connection: connection.slug,
        key: `${KEY_PREFIX}_…${key.slice(-4)}`,
        made_by: accountId,
        ...(replaced > 0 && { replaced_key: true }),
      },
    });
    log.info('api key created', {
      workspace: ctx.workspace.slug,
      connection: connection.slug,
      rotated: replaced > 0,
    });
    return key;
  }

  private async keyConnection(ctx: AdminContext, slug: string): Promise<Connection> {
    const store = await this.gateway.forAdmin(ctx);
    const connection = await store.getConnectionBySlug(slug);
    if (connection?.kind !== 'key' || slug === SYSTEM_CONNECTION_SLUG) {
      throw new AdminError('unknown_connection', `"${slug}" isn't a connection with an API key.`);
    }
    return connection;
  }
}

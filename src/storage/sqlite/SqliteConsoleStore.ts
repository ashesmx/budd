import type Database from 'better-sqlite3';
import type {
  ConsoleAccount,
  ConsoleKey,
  ConsoleStore,
  ConsoleWorkspace,
  Operator,
  UsagePoint,
  UsageSample,
} from '../Storage.js';
import { run } from './async.js';

interface UsageRow {
  hour: number;
  messages_bytes: number;
  audit_bytes: number;
  file_bytes: number;
}

const toPoint = (r: UsageRow): UsagePoint => ({
  hour: r.hour,
  messagesBytes: r.messages_bytes,
  auditBytes: r.audit_bytes,
  fileBytes: r.file_bytes,
});

/** Each workspace with its counts and latest storage figures; the parameters are `now` twice. */
const WORKSPACES = `
  SELECT w.id, w.created_at,
    (SELECT COUNT(*) FROM oauth_grants g WHERE g.workspace_id = w.id) AS apps,
    (SELECT COUNT(DISTINCT g.id) FROM oauth_grants g
      JOIN oauth_tokens t ON t.grant_id = g.id
      WHERE g.workspace_id = w.id AND t.kind = 'refresh' AND t.revoked_at IS NULL
        AND t.rotated_at IS NULL AND t.expires_at > ?) AS live_apps,
    (SELECT COUNT(*) FROM connection_keys k
      WHERE k.workspace_id = w.id AND k.revoked_at IS NULL AND k.expires_at > ?) AS keys,
    u.hour, u.messages_bytes, u.audit_bytes, u.file_bytes
  FROM workspaces w
  LEFT JOIN workspace_usage u ON u.workspace_id = w.id
    AND u.hour = (SELECT MAX(hour) FROM workspace_usage WHERE workspace_id = w.id)`;

type WorkspaceRow = {
  id: string;
  created_at: number;
  apps: number;
  live_apps: number;
  keys: number;
} & (UsageRow | { hour: null });

const toWorkspace = (r: WorkspaceRow): ConsoleWorkspace => ({
  id: r.id,
  createdAt: r.created_at,
  apps: r.apps,
  liveApps: r.live_apps,
  keys: r.keys,
  usage: r.hour === null ? undefined : toPoint(r),
});

export class SqliteConsoleStore implements ConsoleStore {
  constructor(private readonly db: Database.Database) {}

  isOperator(accountId: string): Promise<boolean> {
    return run(
      () =>
        this.db.prepare('SELECT 1 FROM operators WHERE account_id = ?').get(accountId) !==
        undefined,
    );
  }

  addOperator(accountId: string, now: number): Promise<void> {
    return run(() => {
      this.db
        .prepare('INSERT OR IGNORE INTO operators (account_id, added_at) VALUES (?, ?)')
        .run(accountId, now);
    });
  }

  removeOperator(accountId: string): Promise<boolean> {
    return run(
      () =>
        this.db.prepare('DELETE FROM operators WHERE account_id = ?').run(accountId).changes === 1,
    );
  }

  listOperators(): Promise<Operator[]> {
    return run(() =>
      (
        this.db
          .prepare(
            `SELECT o.account_id, o.added_at, a.last_sign_in_at
             FROM operators o JOIN accounts a ON a.id = o.account_id
             ORDER BY o.added_at`,
          )
          .all() as { account_id: string; added_at: number; last_sign_in_at: number | null }[]
      ).map((r) => ({
        accountId: r.account_id,
        addedAt: r.added_at,
        lastSignInAt: r.last_sign_in_at,
      })),
    );
  }

  createOperatorLink(
    codeHash: string,
    email: string,
    expiresAt: number,
    now: number,
  ): Promise<void> {
    return run(() => {
      this.db.transaction(() => {
        this.db.prepare('DELETE FROM operator_links WHERE expires_at <= ?').run(now);
        this.db
          .prepare('INSERT INTO operator_links (code_hash, email, expires_at) VALUES (?, ?, ?)')
          .run(codeHash, email.toLowerCase(), expiresAt);
      })();
    });
  }

  operatorLinkEmail(codeHash: string, now: number): Promise<string | undefined> {
    return run(
      () =>
        (
          this.db
            .prepare('SELECT email FROM operator_links WHERE code_hash = ? AND expires_at > ?')
            .get(codeHash, now) as { email: string } | undefined
        )?.email,
    );
  }

  redeemOperatorLink(codeHash: string, email: string, now: number): Promise<boolean> {
    return run(
      () =>
        this.db
          .prepare(
            'DELETE FROM operator_links WHERE code_hash = ? AND email = ? AND expires_at > ?',
          )
          .run(codeHash, email.toLowerCase(), now).changes === 1,
    );
  }

  lastUsageHour(): Promise<number | undefined> {
    return run(
      () =>
        (
          this.db.prepare('SELECT MAX(hour) AS hour FROM workspace_usage').get() as {
            hour: number | null;
          }
        ).hour ?? undefined,
    );
  }

  recordUsage(hour: number, samples: Map<string, UsageSample>, keepFrom: number): Promise<void> {
    return run(() => {
      this.db.transaction(() => {
        const insert = this.db.prepare(
          `INSERT OR REPLACE INTO workspace_usage
             (workspace_id, hour, messages_bytes, audit_bytes, file_bytes)
           SELECT id, ?, ?, ?, ? FROM workspaces WHERE id = ?`,
        );
        for (const [workspaceId, s] of samples) {
          insert.run(hour, s.messagesBytes, s.auditBytes, s.fileBytes, workspaceId);
        }
        this.db.prepare('DELETE FROM workspace_usage WHERE hour < ?').run(keepFrom);
      })();
    });
  }

  usage(workspaceId: string, since: number): Promise<UsagePoint[]> {
    return run(() =>
      (
        this.db
          .prepare(
            `SELECT hour, messages_bytes, audit_bytes, file_bytes FROM workspace_usage
             WHERE workspace_id = ? AND hour >= ? ORDER BY hour`,
          )
          .all(workspaceId, since) as UsageRow[]
      ).map(toPoint),
    );
  }

  totalMessages(since: number): Promise<{ hour: number; bytes: number }[]> {
    return run(
      () =>
        this.db
          .prepare(
            `SELECT hour, SUM(messages_bytes) AS bytes FROM workspace_usage
             WHERE hour >= ? GROUP BY hour ORDER BY hour`,
          )
          .all(since) as { hour: number; bytes: number }[],
    );
  }

  dailyMessages(days: number[]): Promise<Map<string, (number | null)[]>> {
    return run(() => {
      const rows = this.db
        .prepare(
          `SELECT workspace_id, hour, messages_bytes FROM workspace_usage
           WHERE hour IN (SELECT value FROM json_each(?))`,
        )
        .all(JSON.stringify(days)) as {
        workspace_id: string;
        hour: number;
        messages_bytes: number;
      }[];
      const byWorkspace = new Map<string, (number | null)[]>();
      for (const r of rows) {
        const points = byWorkspace.get(r.workspace_id) ?? days.map(() => null);
        points[days.indexOf(r.hour)] = r.messages_bytes;
        byWorkspace.set(r.workspace_id, points);
      }
      return byWorkspace;
    });
  }

  accounts(): Promise<ConsoleAccount[]> {
    return run(() =>
      (
        this.db
          .prepare(
            `SELECT a.id, a.oidc_issuer, a.created_at, a.last_sign_in_at,
               (SELECT GROUP_CONCAT(m.workspace_id) FROM memberships m WHERE m.account_id = a.id)
                 AS workspace_ids,
               EXISTS (SELECT 1 FROM operators o WHERE o.account_id = a.id) AS operator
             FROM accounts a ORDER BY a.created_at`,
          )
          .all() as {
          id: string;
          oidc_issuer: string | null;
          created_at: number;
          last_sign_in_at: number | null;
          workspace_ids: string | null;
          operator: number;
        }[]
      ).map((r) => ({
        id: r.id,
        issuer: r.oidc_issuer,
        createdAt: r.created_at,
        lastSignInAt: r.last_sign_in_at,
        workspaceIds: r.workspace_ids === null ? [] : r.workspace_ids.split(','),
        operator: r.operator === 1,
      })),
    );
  }

  workspaces(now: number): Promise<ConsoleWorkspace[]> {
    return run(() =>
      (this.db.prepare(`${WORKSPACES} ORDER BY w.created_at`).all(now, now) as WorkspaceRow[]).map(
        toWorkspace,
      ),
    );
  }

  workspace(id: string, now: number): Promise<ConsoleWorkspace | undefined> {
    return run(() => {
      const row = this.db.prepare(`${WORKSPACES} WHERE w.id = ?`).get(now, now, id) as
        WorkspaceRow | undefined;
      return row && toWorkspace(row);
    });
  }

  keys(workspaceId: string): Promise<ConsoleKey[]> {
    return run(() =>
      (
        this.db
          .prepare(
            `SELECT created_at, last_used_at, expires_at FROM connection_keys
             WHERE workspace_id = ? AND revoked_at IS NULL ORDER BY created_at`,
          )
          .all(workspaceId) as {
          created_at: number;
          last_used_at: number | null;
          expires_at: number;
        }[]
      ).map((r) => ({
        createdAt: r.created_at,
        lastUsedAt: r.last_used_at,
        expiresAt: r.expires_at,
      })),
    );
  }
}

import type Database from 'better-sqlite3';
import { ulid } from 'ulid';
import type {
  AuditActor,
  AuditEntry,
  AuditEventType,
  AuditRecord,
  Connection,
  ConnectionKind,
  ConnectionStatus,
  DeliveryRecord,
  DeliveryState,
  ExpiredDelivery,
  Handle,
  HistoryItem,
  MailboxCount,
  MessageRecord,
  MessageType,
  MessageView,
  NoticeDraft,
  Policy,
  PolicyMode,
} from '../../domain/types.js';
import type {
  AuditFilter,
  DueWakeUp,
  HandleRegistration,
  MailboxStats,
  MessageRoute,
  MessageFilter,
  SendPlan,
  SendState,
  WakeUpRecord,
  WorkspaceLimits,
  WorkspaceStore,
} from '../Storage.js';
import { AuditFullError } from '../Storage.js';

/** Rolls back a send that would take the workspace over MAX_WORKSPACE_MB. */
class WorkspaceFull extends Error {}
import { SYSTEM_CONNECTION_SLUG, withSuffix } from '../../domain/slug.js';
import { run } from './async.js';

interface ConnectionRow {
  id: string;
  slug: string;
  label: string | null;
  status: ConnectionStatus;
  kind: ConnectionKind;
  created_at: number;
  last_seen_at: number | null;
  archived_at: number | null;
  blocked_at: number | null;
  policy_mode: PolicyMode;
}

interface AuditRow {
  id: number;
  at: number;
  event: AuditEventType;
  actor: AuditActor;
  connection_id: string | null;
  detail_json: string;
}

interface ExpiredRow {
  message_id: string;
  to_handle: string;
  expires_at: number;
  to_slug: string;
  type: MessageType;
  thread_id: string;
  from_connection_id: string;
  from_slug: string;
  from_handle: string | null;
}

interface MessageRow {
  id: string;
  type: MessageType;
  from_connection_id: string;
  from_handle: string | null;
  to_json: string;
  subject: string | null;
  body_md: string | null;
  payload_json: string | null;
  thread_id: string;
  reply_to: string | null;
  created_at: number;
  expires_at: number;
}

interface MessageViewRow extends MessageRow {
  from_connection_slug: string;
}

const toConnection = (r: ConnectionRow): Connection => ({
  id: r.id,
  slug: r.slug,
  label: r.label,
  status: r.status,
  kind: r.kind,
  createdAt: r.created_at,
  lastSeenAt: r.last_seen_at,
  archivedAt: r.archived_at,
  blockedAt: r.blocked_at,
});

const HOUR = 3_600_000;

interface WakeUpRow {
  connection_id: string;
  handle: string;
  url_sealed: Buffer;
  token_sealed: Buffer | null;
  signing_secret_sealed: Buffer | null;
  hour_started_at: number | null;
  hour_count: number;
  host: string;
  token_hint: string | null;
  retry_interval_ms: number;
  max_retries: number;
  created_at: number;
  woken_at: number | null;
  attempt_at: number | null;
  retries: number;
  last_at: number | null;
  last_status: string | null;
  last_ok: number | null;
}

const toWakeUp = (r: WakeUpRow): WakeUpRecord => ({
  connectionId: r.connection_id,
  handle: r.handle,
  urlSealed: r.url_sealed,
  tokenSealed: r.token_sealed,
  signingSecretSealed: r.signing_secret_sealed,
  hourStartedAt: r.hour_started_at,
  hourCount: r.hour_count,
  host: r.host,
  tokenHint: r.token_hint,
  retryIntervalMs: r.retry_interval_ms,
  maxRetries: r.max_retries,
  createdAt: r.created_at,
  wokenAt: r.woken_at,
  attemptAt: r.attempt_at,
  retries: r.retries,
  lastAt: r.last_at,
  lastStatus: r.last_status,
  lastOk: r.last_ok === null ? null : r.last_ok === 1,
});

interface HandleRow {
  connection_id: string;
  name: string;
  first_seen_at: number;
  archived_at: number | null;
}

const toHandle = (r: HandleRow): Handle => ({
  connectionId: r.connection_id,
  name: r.name,
  firstSeenAt: r.first_seen_at,
  archivedAt: r.archived_at,
});

const toMessage = (r: MessageRow): MessageRecord => ({
  id: r.id,
  type: r.type,
  fromConnectionId: r.from_connection_id,
  fromHandle: r.from_handle,
  to: JSON.parse(r.to_json) as string[],
  subject: r.subject,
  bodyMd: r.body_md,
  payload: r.payload_json === null ? null : (JSON.parse(r.payload_json) as Record<string, unknown>),
  threadId: r.thread_id,
  replyTo: r.reply_to,
  createdAt: r.created_at,
  expiresAt: r.expires_at,
});

const toView = (r: MessageViewRow): MessageView => ({
  ...toMessage(r),
  fromConnectionSlug: r.from_connection_slug,
});

/** A LIKE pattern that matches `text` literally anywhere: its `%`, `_` and `\` are escaped. */
const contains = (text: string) => `%${text.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

/** A WHERE clause over `messages m` and its named parameters. */
function messageWhere(f: MessageFilter = {}): { sql: string; params: Record<string, unknown> } {
  const clauses: string[] = [];
  const params: Record<string, unknown> = { ...f };
  // Independent subqueries, not EXISTS(... d.message_id = m.id): with no table
  // statistics SQLite answers a correlated one through the state index, once
  // per message, which is quadratic.
  const delivered = (where: string) => `m.id IN (SELECT message_id FROM deliveries WHERE ${where})`;
  if (f.text !== undefined) {
    clauses.push(`(m.subject LIKE @text ESCAPE '\\' OR m.body_md LIKE @text ESCAPE '\\')`);
    params.text = contains(f.text);
  }
  if (f.connectionId !== undefined || f.handle !== undefined) {
    const on = (prefix: 'm.from_' | 'to_') =>
      [
        f.connectionId !== undefined && `${prefix}connection_id = @connectionId`,
        f.handle !== undefined && `${prefix}handle = @handle`,
      ]
        .filter(Boolean)
        .join(' AND ');
    clauses.push(`((${on('m.from_')}) OR ${delivered(on('to_'))})`);
  }
  if (f.state !== undefined) clauses.push(delivered('state = @state'));
  if (f.type !== undefined) clauses.push('m.type = @type');
  if (f.since !== undefined) clauses.push('m.created_at >= @since');
  if (f.until !== undefined) clauses.push('m.created_at <= @until');
  if (f.threadId !== undefined) clauses.push('m.thread_id = @threadId');
  return { sql: clauses.length === 0 ? '1' : clauses.join(' AND '), params: defined(params) };
}

/** A WHERE clause over `audit a` and its named parameters. */
function auditWhere(f: AuditFilter = {}): { sql: string; params: Record<string, unknown> } {
  const clauses = [
    f.events !== undefined && 'a.event IN (SELECT value FROM json_each(@events))',
    f.actor !== undefined && 'a.actor = @actor',
    f.connectionId !== undefined && 'a.connection_id = @connectionId',
    // Details name a mailbox as a JSON string, quotes included, so "a/b" doesn't match "a/bc".
    f.mailbox !== undefined && `a.detail_json LIKE @mailbox ESCAPE '\\'`,
    f.since !== undefined && 'a.at >= @since',
    f.until !== undefined && 'a.at <= @until',
    f.text !== undefined && `a.detail_json LIKE @text ESCAPE '\\'`,
  ].filter((c): c is string => typeof c === 'string');
  const params = defined({
    ...f,
    events: f.events === undefined ? undefined : JSON.stringify(f.events),
    mailbox: f.mailbox === undefined ? undefined : contains(JSON.stringify(f.mailbox)),
    text: f.text === undefined ? undefined : contains(f.text),
  });
  return { sql: clauses.length === 0 ? '1' : clauses.join(' AND '), params };
}

/** better-sqlite3 refuses named parameters the SQL doesn't use, so unset filters are left out. */
const defined = (o: Record<string, unknown>) =>
  Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));

const MESSAGE_VIEW_SELECT = `
  SELECT m.*, c.slug AS from_connection_slug
  FROM messages m JOIN connections c ON c.id = m.from_connection_id`;

export class SqliteWorkspaceStore implements WorkspaceStore {
  constructor(
    private readonly db: Database.Database,
    private readonly limits: WorkspaceLimits,
    private readonly onAudit: (entry: AuditEntry) => void = () => undefined,
  ) {}

  getConnectionBySlug(slug: string): Promise<Connection | undefined> {
    return run(() => this.connectionWhere('slug', slug));
  }

  getConnectionById(id: string): Promise<Connection | undefined> {
    return run(() => this.connectionWhere('id', id));
  }

  listConnections(): Promise<Connection[]> {
    return run(() =>
      (this.db.prepare('SELECT * FROM connections ORDER BY slug').all() as ConnectionRow[]).map(
        toConnection,
      ),
    );
  }

  isFull(): Promise<boolean> {
    return run(() => this.full());
  }

  storedBytes(): Promise<{ messages: number; audit: number }> {
    return run(() => this.countedBytes());
  }

  touchConnection(slug: string, now: number): Promise<Connection | 'limit'> {
    return run(() =>
      this.db.transaction(() => {
        const existing = this.connectionWhere('slug', slug);
        if (existing) {
          this.db
            .prepare('UPDATE connections SET last_seen_at = ? WHERE id = ?')
            .run(now, existing.id);
          return { ...existing, lastSeenAt: now };
        }
        if (this.full()) return 'limit';
        const id = this.createConnection(slug, now);
        this.audit({
          at: now,
          event: 'connection_registered',
          actor: 'agent',
          connectionId: id,
          detail: { connection: slug },
        });
        return {
          id,
          slug,
          label: null,
          status: 'active' as const,
          kind: 'app' as const,
          createdAt: now,
          lastSeenAt: now,
          archivedAt: null,
          blockedAt: null,
        };
      })(),
    );
  }

  registerConnection(input: {
    slugBase: string;
    reserved: string[];
    detail: Record<string, unknown>;
    now: number;
  }): Promise<Connection | 'limit'> {
    const { slugBase, reserved, now } = input;
    return run(() =>
      this.db.transaction(() => {
        if (this.full()) return 'limit';
        let slug = slugBase;
        for (let n = 2; reserved.includes(slug) || this.connectionWhere('slug', slug); n++) {
          slug = withSuffix(slugBase, n);
        }
        const id = this.createConnection(slug, now);
        this.audit({
          at: now,
          event: 'connection_registered',
          actor: 'human',
          connectionId: id,
          detail: { connection: slug, ...input.detail },
        });
        const created = this.connectionWhere('id', id);
        if (!created) throw new Error('connection vanished');
        return created;
      })(),
    );
  }

  createKeyConnection(input: {
    slug: string;
    label: string | null;
    reserved: string[];
    now: number;
  }): Promise<Connection | 'taken' | 'limit'> {
    const { slug, label, reserved, now } = input;
    return run(() =>
      this.db.transaction(() => {
        // Archived connections keep their slug, so their name stays taken too.
        if (reserved.includes(slug) || this.connectionWhere('slug', slug)) return 'taken';
        if (this.full()) return 'limit';
        const id = ulid(now);
        this.db
          .prepare(
            `INSERT INTO connections (id, slug, label, kind, created_at) VALUES (?, ?, ?, 'key', ?)`,
          )
          .run(id, slug, label, now);
        this.audit({
          at: now,
          event: 'connection_registered',
          actor: 'human',
          connectionId: id,
          detail: { connection: slug, via: 'key' },
        });
        const created = this.connectionWhere('id', id);
        if (!created) throw new Error('connection vanished');
        return created;
      })(),
    );
  }

  touchConnectionById(id: string, now: number): Promise<void> {
    return run(() => {
      this.db.prepare('UPDATE connections SET last_seen_at = ? WHERE id = ?').run(now, id);
    });
  }

  setConnectionStatus(input: {
    connectionId: string;
    status: ConnectionStatus;
    now: number;
  }): Promise<boolean> {
    const { connectionId, status, now } = input;
    return run(() =>
      this.db.transaction(() => {
        const c = this.connectionWhere('id', connectionId);
        if (!c || c.status === status || (status === 'active' && c.archivedAt !== null)) {
          return false;
        }
        this.db
          .prepare(
            `UPDATE connections SET status = ?,
               blocked_at = CASE WHEN ? = 'blocked' THEN ? ELSE blocked_at END WHERE id = ?`,
          )
          .run(status, status, now, connectionId);
        this.audit({
          at: now,
          event: status === 'blocked' ? 'connection_blocked' : 'connection_unblocked',
          actor: 'human',
          connectionId,
          detail: { connection: c.slug },
        });
        return true;
      })(),
    );
  }

  setConnectionArchived(input: {
    connectionId: string;
    archived: boolean;
    now: number;
  }): Promise<boolean | 'limit'> {
    const { connectionId, archived, now } = input;
    return run(() =>
      this.db.transaction(() => {
        const c = this.connectionWhere('id', connectionId);
        if (!c || (c.archivedAt !== null) === archived) return false;
        if (!archived && this.full()) return 'limit';
        this.db
          .prepare(
            `UPDATE connections SET archived_at = ?, status = CASE WHEN ? THEN 'blocked' ELSE status END,
               blocked_at = CASE WHEN ? AND status <> 'blocked' THEN ? ELSE blocked_at END
             WHERE id = ?`,
          )
          .run(archived ? now : null, archived ? 1 : 0, archived ? 1 : 0, now, connectionId);
        if (archived && c.status !== 'blocked') {
          this.audit({
            at: now,
            event: 'connection_blocked',
            actor: 'human',
            connectionId,
            detail: { connection: c.slug, via: 'archive' },
          });
        }
        this.audit({
          at: now,
          event: archived ? 'connection_archived' : 'connection_restored',
          actor: 'human',
          connectionId,
          detail: { connection: c.slug },
        });
        // An archived connection is never woken: its wake-ups go, and aren't restored with it.
        if (archived) {
          const handles = this.db
            .prepare('SELECT handle FROM wake_ups WHERE connection_id = ?')
            .all(connectionId) as { handle: string }[];
          for (const { handle } of handles) {
            this.deleteWakeUp(connectionId, handle, 'human', 'connection archived', now);
          }
        }
        return true;
      })(),
    );
  }

  setConnectionLabel(input: {
    connectionId: string;
    label: string | null;
    now: number;
  }): Promise<void> {
    const { connectionId, label, now } = input;
    return run(() => {
      this.db.transaction(() => {
        const c = this.connectionWhere('id', connectionId);
        if (!c || c.label === label) return;
        this.db.prepare('UPDATE connections SET label = ? WHERE id = ?').run(label, connectionId);
        this.audit({
          at: now,
          event: 'connection_relabelled',
          actor: 'human',
          connectionId,
          detail: { connection: c.slug, from: c.label, to: label },
        });
      })();
    });
  }

  getPolicy(connectionId: string): Promise<Policy> {
    return run(() => this.policyFor(connectionId));
  }

  listPolicies(): Promise<Policy[]> {
    return run(() => {
      const modes = this.db.prepare('SELECT id, policy_mode FROM connections').all() as {
        id: string;
        policy_mode: PolicyMode;
      }[];
      const allowed = this.db
        .prepare(
          'SELECT connection_id, allowed_connection_id FROM policy_allowed ORDER BY allowed_connection_id',
        )
        .all() as { connection_id: string; allowed_connection_id: string }[];
      return modes.map((m) => ({
        connectionId: m.id,
        mode: m.policy_mode,
        allowedConnectionIds: allowed
          .filter((a) => a.connection_id === m.id)
          .map((a) => a.allowed_connection_id),
      }));
    });
  }

  replacePolicy(input: {
    connectionId: string;
    mode: PolicyMode;
    allowedConnectionIds: string[];
    event: 'policy_tightened' | 'policy_widened';
    actor: AuditActor;
    detail: Record<string, unknown>;
    now: number;
  }): Promise<void> {
    const { connectionId, mode, allowedConnectionIds, now } = input;
    return run(() => {
      this.db.transaction(() => {
        const before = this.policyFor(connectionId);
        this.db
          .prepare('UPDATE connections SET policy_mode = ? WHERE id = ?')
          .run(mode, connectionId);
        this.db.prepare('DELETE FROM policy_allowed WHERE connection_id = ?').run(connectionId);
        const insert = this.db.prepare(
          'INSERT OR IGNORE INTO policy_allowed (connection_id, allowed_connection_id) VALUES (?, ?)',
        );
        for (const id of allowedConnectionIds) insert.run(connectionId, id);
        const after = this.policyFor(connectionId);
        this.audit({
          at: now,
          event: input.event,
          actor: input.actor,
          connectionId,
          detail: {
            connection: this.connectionWhere('id', connectionId)?.slug,
            ...input.detail,
            before: this.describePolicy(before),
            after: this.describePolicy(after),
          },
        });
      })();
    });
  }

  getHandle(connectionId: string, name: string): Promise<Handle | undefined> {
    return run(() => {
      const row = this.db
        .prepare(
          'SELECT connection_id, name, first_seen_at, archived_at FROM handles WHERE connection_id = ? AND name = ?',
        )
        .get(connectionId, name) as HandleRow | undefined;
      return row && toHandle(row);
    });
  }

  listHandles(): Promise<Handle[]> {
    return run(() =>
      (
        this.db
          .prepare(
            'SELECT connection_id, name, first_seen_at, archived_at FROM handles ORDER BY name',
          )
          .all() as HandleRow[]
      ).map(toHandle),
    );
  }

  getWakeUp(connectionId: string, handle: string): Promise<WakeUpRecord | undefined> {
    return run(() => {
      const row = this.db
        .prepare('SELECT * FROM wake_ups WHERE connection_id = ? AND handle = ?')
        .get(connectionId, handle) as WakeUpRow | undefined;
      return row && toWakeUp(row);
    });
  }

  listWakeUps(): Promise<WakeUpRecord[]> {
    return run(() =>
      (this.db.prepare('SELECT * FROM wake_ups').all() as WakeUpRow[]).map(toWakeUp),
    );
  }

  setWakeUp(input: {
    connectionId: string;
    handle: string;
    urlSealed: Buffer;
    tokenSealed: Buffer | null;
    signingSecretSealed: Buffer | null;
    host: string;
    tokenHint: string | null;
    retryIntervalMs: number;
    maxRetries: number;
    newAddress: boolean;
    now: number;
  }): Promise<boolean> {
    const { connectionId, handle, now } = input;
    return run(() =>
      this.db.transaction(() => {
        if (this.handleState(connectionId, handle) !== 'active') return false;
        // Changing only the retries or token keeps where the current mail is up to. A new
        // address starts afresh: mail already unread wakes it at the next sweep.
        this.db
          .prepare(
            `INSERT INTO wake_ups (connection_id, handle, url_sealed, token_sealed,
               signing_secret_sealed, host, token_hint, retry_interval_ms, max_retries, created_at)
             VALUES (@connectionId, @handle, @urlSealed, @tokenSealed, @signingSecretSealed, @host,
               @tokenHint, @retryIntervalMs, @maxRetries, @now)
             ON CONFLICT (connection_id, handle) DO UPDATE SET
               url_sealed = excluded.url_sealed, token_sealed = excluded.token_sealed,
               signing_secret_sealed = excluded.signing_secret_sealed,
               host = excluded.host, token_hint = excluded.token_hint,
               retry_interval_ms = excluded.retry_interval_ms, max_retries = excluded.max_retries,
               woken_at = CASE WHEN @newAddress THEN NULL ELSE woken_at END,
               attempt_at = CASE WHEN @newAddress THEN NULL ELSE attempt_at END,
               retries = CASE WHEN @newAddress THEN 0 ELSE retries END,
               last_at = CASE WHEN @newAddress THEN NULL ELSE last_at END,
               last_status = CASE WHEN @newAddress THEN NULL ELSE last_status END,
               last_ok = CASE WHEN @newAddress THEN NULL ELSE last_ok END`,
          )
          .run({
            connectionId,
            handle,
            urlSealed: input.urlSealed,
            tokenSealed: input.tokenSealed,
            signingSecretSealed: input.signingSecretSealed,
            host: input.host,
            tokenHint: input.tokenHint,
            retryIntervalMs: input.retryIntervalMs,
            maxRetries: input.maxRetries,
            newAddress: input.newAddress ? 1 : 0,
            now,
          });
        this.audit({
          at: now,
          event: 'wake_up_set',
          actor: 'human',
          connectionId,
          detail: {
            mailbox: `${this.connectionWhere('id', connectionId)?.slug ?? '?'}/${handle}`,
            host: input.host,
            token: input.tokenHint !== null,
            signed: input.signingSecretSealed !== null,
            retries: input.maxRetries,
          },
        });
        return true;
      })(),
    );
  }

  removeWakeUp(input: {
    connectionId: string;
    handle: string;
    actor: AuditActor;
    reason?: string | undefined;
    now: number;
  }): Promise<boolean> {
    return run(() =>
      this.db.transaction(() =>
        this.deleteWakeUp(input.connectionId, input.handle, input.actor, input.reason, input.now),
      )(),
    );
  }

  dueWakeUps(now: number, maxPerHour: number): Promise<DueWakeUp[]> {
    return run(() => {
      const rows = this.db
        .prepare(
          `SELECT w.*, c.slug AS connection_slug,
             (SELECT MAX(d.read_at) FROM deliveries d
              WHERE d.to_connection_id = w.connection_id AND d.to_handle = w.handle) AS last_read,
             (SELECT MAX(m.created_at) FROM deliveries d JOIN messages m ON m.id = d.message_id
              WHERE d.to_connection_id = w.connection_id AND d.to_handle = w.handle
                AND d.state = 'unread' AND d.expires_at > @now) AS newest_unread,
             (SELECT MIN(m.created_at) FROM deliveries d JOIN messages m ON m.id = d.message_id
              WHERE d.to_connection_id = w.connection_id AND d.to_handle = w.handle
                AND d.state = 'unread' AND d.expires_at > @now) AS oldest_unread
           FROM wake_ups w
           JOIN connections c ON c.id = w.connection_id
             AND c.status = 'active' AND c.archived_at IS NULL
           JOIN handles h ON h.connection_id = w.connection_id AND h.name = w.handle
             AND h.archived_at IS NULL`,
        )
        .all({ now }) as (WakeUpRow & {
        connection_slug: string;
        last_read: number | null;
        newest_unread: number | null;
        oldest_unread: number | null;
      })[];
      return rows.flatMap((r): DueWakeUp[] => {
        if (r.newest_unread === null) return []; // nothing unread, nothing to wake for
        // At most maxPerHour in each hour, however much mail arrives.
        const hourOpen = r.hour_started_at !== null && now - r.hour_started_at < HOUR;
        if (hourOpen && r.hour_count >= maxPerHour) return [];
        const base = { ...toWakeUp(r), connectionSlug: r.connection_slug };
        const lastRead = r.last_read ?? 0;
        const waited = now >= (r.attempt_at ?? 0) + r.retry_interval_ms;
        // A new batch, woken at once: every unread message arrived after the agent last
        // read, and it has read since the last wake-up.
        if (r.woken_at === null) return [{ ...base, kind: 'first' }];
        const newBatch = r.woken_at <= lastRead && (r.oldest_unread ?? 0) > lastRead;
        // Woken again, but at most once a retry interval: mail left unread by a partial
        // read, or newer than a wake-up that failed or that the agent didn't act on.
        const again = (r.woken_at <= lastRead || r.newest_unread > r.woken_at) && waited;
        if (newBatch || again) return [{ ...base, kind: 'first' }];
        return r.retries < r.max_retries && waited ? [{ ...base, kind: 'retry' }] : [];
      });
    });
  }

  recordWakeUp(input: {
    connectionId: string;
    handle: string;
    kind: 'first' | 'retry' | 'test';
    ok: boolean;
    status: string;
    now: number;
  }): Promise<void> {
    const { connectionId, handle, kind, status, now } = input;
    // Wake-ups count towards the hour's cap; tests don't. NULL > x is false: a first hour.
    const hour = `hour_count = CASE WHEN hour_started_at > @now - ${String(HOUR)}
                    THEN hour_count + 1 ELSE 1 END,
                  hour_started_at = CASE WHEN hour_started_at > @now - ${String(HOUR)}
                    THEN hour_started_at ELSE @now END,`;
    const batch =
      kind === 'first'
        ? `woken_at = @now, attempt_at = @now, retries = 0, ${hour}`
        : kind === 'retry'
          ? `attempt_at = @now, retries = retries + 1, ${hour}`
          : '';
    return run(() => {
      this.db
        .prepare(
          `UPDATE wake_ups SET ${batch} last_at = @now, last_status = @status, last_ok = @ok
           WHERE connection_id = @connectionId AND handle = @handle`,
        )
        .run({ now, status: status.slice(0, 100), ok: input.ok ? 1 : 0, connectionId, handle });
    });
  }

  countHandles(connectionId: string): Promise<number> {
    return run(() => this.handleCount(connectionId));
  }

  setHandleArchived(input: {
    connectionId: string;
    name: string;
    archived: boolean;
    maxHandles: number;
    now: number;
  }): Promise<boolean | 'limit' | undefined> {
    const { connectionId, name, archived, now } = input;
    return run(() =>
      this.db.transaction(() => {
        const state = this.handleState(connectionId, name);
        if (state === 'none') return undefined;
        if ((state === 'archived') === archived) return false;
        if (!archived && this.handleCount(connectionId) >= input.maxHandles) return 'limit';
        this.db
          .prepare('UPDATE handles SET archived_at = ? WHERE connection_id = ? AND name = ?')
          .run(archived ? now : null, connectionId, name);
        // An archived mailbox is never woken: its wake-up goes, and isn't restored with it.
        if (archived) this.deleteWakeUp(connectionId, name, 'human', 'mailbox archived', now);
        this.audit({
          at: now,
          event: archived ? 'mailbox_archived' : 'mailbox_restored',
          actor: 'human',
          connectionId,
          detail: { mailbox: `${this.connectionWhere('id', connectionId)?.slug ?? '?'}/${name}` },
        });
        return true;
      })(),
    );
  }

  send<T>(input: {
    fromConnectionId: string;
    fromHandle: string;
    recipients: { connectionSlug: string; handle: string }[];
    replyTo: string | undefined;
    threadId: string | undefined;
    now: number;
    decide: (state: SendState) => { plan: SendPlan; result: T };
  }): Promise<T | 'limit' | 'archived' | 'full'> {
    const { fromConnectionId: from, now } = input;
    const send = this.db.transaction((): T | 'limit' | 'archived' => {
      if (this.handleState(from, input.fromHandle) === 'archived') return 'archived';
      const { plan, result } = input.decide({
        recipients: input.recipients.map((r) => {
          const connection = this.connectionWhere('slug', r.connectionSlug);
          return (
            connection && {
              connection,
              policy: this.policyFor(connection.id),
              handle: this.handleState(connection.id, r.handle),
              unread: this.unreadCount(connection.id, r.handle, now),
            }
          );
        }),
        outstanding: (
          this.db
            .prepare(
              `SELECT COUNT(*) AS n FROM deliveries d JOIN messages m ON m.id = d.message_id
                 WHERE m.from_connection_id = ? AND d.state = 'unread' AND d.expires_at > ?`,
            )
            .get(from, now) as { n: number }
        ).n,
        replyTo:
          input.replyTo === undefined ? undefined : this.visibleMessage('id', input.replyTo, from),
        threadVisible:
          input.threadId !== undefined &&
          this.visibleMessage('thread_id', input.threadId, from) !== undefined,
      });
      if (plan.message) {
        const { record, deliveries, newHandle } = plan.message;
        const registered = this.registerHandle(newHandle, now);
        if (registered === 'limit' || registered === 'archived') return registered;
        this.storeMessage(record, deliveries);
        // Measured by the stored_bytes trigger itself; throwing undoes the insert.
        if (this.countedBytes().messages > this.limits.maxWorkspaceBytes) throw new WorkspaceFull();
      }
      this.audit(plan.audit);
      return result;
    });
    return run(() => {
      try {
        return send();
      } catch (err) {
        if (err instanceof WorkspaceFull) return 'full';
        throw err;
      }
    });
  }

  countUnread(input: { connectionId: string; handle: string; now: number }): Promise<number> {
    return run(() => this.unreadCount(input.connectionId, input.handle, input.now));
  }

  claimHandle(input: {
    connectionId: string;
    name: string;
    maxHandles: number;
    now: number;
  }): Promise<HandleRegistration> {
    return run(() => this.db.transaction(() => this.registerHandle(input, input.now))());
  }

  consumeUnread(input: {
    connectionId: string;
    handle: string;
    limit: number;
    now: number;
  }): Promise<MessageView[]> {
    const { connectionId, handle, limit, now } = input;
    return run(() =>
      this.db.transaction(() => {
        const rows = this.db
          .prepare(
            `${MESSAGE_VIEW_SELECT}
             JOIN deliveries d ON d.message_id = m.id
             WHERE d.to_connection_id = ? AND d.to_handle = ?
               AND d.state = 'unread' AND d.expires_at > ?
             ORDER BY m.created_at, m.id
             LIMIT ?`,
          )
          .all(connectionId, handle, now, limit) as MessageViewRow[];
        const markRead = this.db.prepare(
          `UPDATE deliveries SET state = 'read', read_at = ?
           WHERE message_id = ? AND to_connection_id = ? AND to_handle = ? AND state = 'unread'`,
        );
        for (const r of rows) markRead.run(now, r.id, connectionId, handle);
        if (rows.length > 0) {
          this.audit({
            at: now,
            event: 'inbox_read',
            actor: 'agent',
            connectionId,
            detail: {
              mailbox: `${this.connectionWhere('id', connectionId)?.slug ?? '?'}/${handle}`,
              message_ids: rows.map((r) => r.id),
            },
          });
        }
        return rows.map(toView);
      })(),
    );
  }

  threadMessages(input: {
    connectionId: string;
    threadId: string;
    limit: number;
  }): Promise<MessageView[]> {
    const { connectionId, threadId, limit } = input;
    return run(() => {
      const rows = this.db
        .prepare(
          `${MESSAGE_VIEW_SELECT}
           WHERE m.thread_id = ?
             AND (m.from_connection_id = ?
                  OR EXISTS (SELECT 1 FROM deliveries d
                             WHERE d.message_id = m.id AND d.to_connection_id = ?
                               AND d.state = 'read'))
           ORDER BY m.created_at DESC, m.id DESC
           LIMIT ?`,
        )
        .all(threadId, connectionId, connectionId, limit) as MessageViewRow[];
      return rows.reverse().map(toView);
    });
  }

  expireDeliveries(input: {
    now: number;
    systemSlug: string;
    notice: (expired: ExpiredDelivery) => NoticeDraft | null;
  }): Promise<number> {
    const { now, systemSlug } = input;
    return run(() =>
      this.db.transaction(() => {
        const rows = this.db
          .prepare(
            `SELECT d.message_id, d.to_handle, d.expires_at, tc.slug AS to_slug,
                    m.type, m.thread_id, m.from_connection_id, fc.slug AS from_slug,
                    m.from_handle
             FROM deliveries d
             JOIN messages m ON m.id = d.message_id
             JOIN connections tc ON tc.id = d.to_connection_id
             JOIN connections fc ON fc.id = m.from_connection_id
             WHERE d.state = 'unread' AND d.expires_at <= ?
             ORDER BY d.expires_at, d.message_id`,
          )
          .all(now) as ExpiredRow[];
        if (rows.length === 0) return 0;
        this.db
          .prepare(
            `UPDATE deliveries SET state = 'expired' WHERE state = 'unread' AND expires_at <= ?`,
          )
          .run(now);

        let systemId: string | undefined;
        for (const r of rows) {
          const expired: ExpiredDelivery = {
            messageId: r.message_id,
            messageType: r.type,
            threadId: r.thread_id,
            fromConnectionId: r.from_connection_id,
            fromConnectionSlug: r.from_slug,
            fromHandle: r.from_handle,
            toConnectionSlug: r.to_slug,
            toHandle: r.to_handle,
            expiresAt: r.expires_at,
          };
          const recipient = `${r.to_slug}/${r.to_handle}`;
          this.audit({
            at: now,
            event: 'delivery_expired',
            actor: 'system',
            connectionId: r.from_connection_id,
            detail: { message_id: r.message_id, type: r.type, recipient },
          });
          const notice = input.notice(expired);
          if (!notice) continue;
          systemId ??=
            this.connectionWhere('slug', systemSlug)?.id ?? this.createConnection(systemSlug, now);
          this.storeMessage(
            {
              id: notice.id,
              type: 'notice',
              fromConnectionId: systemId,
              fromHandle: null,
              to: [notice.to],
              subject: notice.subject,
              bodyMd: notice.bodyMd,
              payload: notice.payload,
              threadId: notice.threadId,
              replyTo: notice.replyTo,
              createdAt: now,
              expiresAt: notice.expiresAt,
            },
            [
              {
                messageId: notice.id,
                toConnectionId: notice.toConnectionId,
                toHandle: notice.toHandle,
                state: 'unread',
                readAt: null,
                expiresAt: notice.expiresAt,
              },
            ],
          );
          this.audit({
            at: now,
            event: 'notice_created',
            actor: 'system',
            connectionId: notice.toConnectionId,
            detail: {
              notice_id: notice.id,
              about_message_id: r.message_id,
              to: notice.to,
              recipient,
            },
          });
        }
        return rows.length;
      })(),
    );
  }

  purgeMessages(input: { cutoff: number; now: number }): Promise<number> {
    return run(() => {
      const purged = this.db.transaction(() => {
        const deliveries = (
          this.db
            .prepare(
              `SELECT COUNT(*) AS n FROM deliveries
               WHERE message_id IN (SELECT id FROM messages WHERE created_at <= ?)`,
            )
            .get(input.cutoff) as { n: number }
        ).n;
        const messages = this.db
          .prepare('DELETE FROM messages WHERE created_at <= ?')
          .run(input.cutoff).changes;
        if (messages > 0) {
          this.audit({
            at: input.now,
            event: 'retention_purge',
            actor: 'system',
            connectionId: null,
            detail: { messages, deliveries, cutoff: new Date(input.cutoff).toISOString() },
          });
        }
        return messages;
      })();
      // A month's mail gone changes the tables enough to look at them again.
      if (purged > 0) this.db.pragma('optimize');
      return purged;
    });
  }

  purgeAudit(cutoff: number): Promise<number> {
    return run(() => this.db.prepare('DELETE FROM audit WHERE at <= ?').run(cutoff).changes);
  }

  appendAudit(entry: AuditEntry): Promise<void> {
    return run(() => {
      this.audit(entry);
    });
  }

  listAudit(input: {
    limit: number;
    beforeId?: number | undefined;
    filter?: AuditFilter | undefined;
  }): Promise<AuditRecord[]> {
    const where = auditWhere(input.filter);
    return run(() =>
      (
        this.db
          .prepare(
            `SELECT * FROM audit a WHERE a.id < @before AND ${where.sql} ORDER BY a.id DESC LIMIT @limit`,
          )
          .all({
            ...where.params,
            before: input.beforeId ?? Number.MAX_SAFE_INTEGER,
            limit: input.limit,
          }) as AuditRow[]
      ).map((r) => ({
        id: r.id,
        at: r.at,
        event: r.event,
        actor: r.actor,
        connectionId: r.connection_id,
        detail: JSON.parse(r.detail_json) as Record<string, unknown>,
      })),
    );
  }

  countAudit(filter: AuditFilter): Promise<number> {
    const where = auditWhere(filter);
    return run(
      () =>
        (
          this.db
            .prepare(`SELECT COUNT(*) AS n FROM audit a WHERE ${where.sql}`)
            .get(where.params) as { n: number }
        ).n,
    );
  }

  countUnreadByMailbox(now: number): Promise<MailboxCount[]> {
    return run(() =>
      (
        this.db
          .prepare(
            `SELECT to_connection_id, to_handle, COUNT(*) AS n FROM deliveries
             WHERE state = 'unread' AND expires_at > ?
             GROUP BY to_connection_id, to_handle`,
          )
          .all(now) as { to_connection_id: string; to_handle: string; n: number }[]
      ).map((r) => ({ connectionId: r.to_connection_id, handle: r.to_handle, unread: r.n })),
    );
  }

  messageRoutes(since: number): Promise<MessageRoute[]> {
    return run(() =>
      (
        this.db
          .prepare(
            `SELECT m.from_connection_id, m.from_handle, d.to_connection_id, d.to_handle,
                    COUNT(*) AS messages, SUM(d.state != 'read') AS unread
             FROM messages m JOIN deliveries d ON d.message_id = m.id
             WHERE m.created_at >= ? AND m.type = 'message' AND m.from_handle IS NOT NULL
             GROUP BY m.from_connection_id, m.from_handle, d.to_connection_id, d.to_handle`,
          )
          .all(since) as {
          from_connection_id: string;
          from_handle: string;
          to_connection_id: string;
          to_handle: string;
          messages: number;
          unread: number;
        }[]
      ).map((r) => ({
        fromConnectionId: r.from_connection_id,
        fromHandle: r.from_handle,
        toConnectionId: r.to_connection_id,
        toHandle: r.to_handle,
        messages: r.messages,
        unread: r.unread,
      })),
    );
  }

  mailboxStats(connectionId: string, since: number, now: number): Promise<MailboxStats[]> {
    return run(() =>
      (
        this.db
          .prepare(
            `SELECT handle, SUM(sent) AS sent, SUM(received) AS received, SUM(expired) AS expired,
                    MAX(last_sent) AS last_sent, MAX(last_received) AS last_received,
                    MAX(last_read) AS last_read, MIN(oldest_unread) AS oldest_unread
             FROM (
               SELECT from_handle AS handle, SUM(created_at >= @since) AS sent, 0 AS received,
                      0 AS expired, MAX(created_at) AS last_sent, NULL AS last_received,
                      NULL AS last_read, NULL AS oldest_unread
               FROM messages WHERE from_connection_id = @c AND from_handle IS NOT NULL
               GROUP BY from_handle
               UNION ALL
               SELECT d.to_handle, 0, SUM(m.created_at >= @since AND m.type = 'message'),
                      SUM(m.created_at >= @since AND m.type = 'message' AND (d.state = 'expired'
                          OR (d.state = 'unread' AND d.expires_at <= @now))),
                      NULL, MAX(m.created_at), MAX(d.read_at),
                      MIN(CASE WHEN d.state = 'unread' AND d.expires_at > @now THEN m.created_at END)
               FROM deliveries d JOIN messages m ON m.id = d.message_id
               WHERE d.to_connection_id = @c
               GROUP BY d.to_handle)
             GROUP BY handle`,
          )
          .all({ c: connectionId, since, now }) as {
          handle: string;
          sent: number;
          received: number;
          expired: number;
          last_sent: number | null;
          last_received: number | null;
          last_read: number | null;
          oldest_unread: number | null;
        }[]
      ).map((r) => ({
        handle: r.handle,
        sent: r.sent,
        received: r.received,
        expired: r.expired,
        lastSentAt: r.last_sent,
        lastReceivedAt: r.last_received,
        lastReadAt: r.last_read,
        oldestUnreadAt: r.oldest_unread,
      })),
    );
  }

  listHistory(input: {
    limit: number;
    beforeId?: string | undefined;
    filter?: MessageFilter | undefined;
  }): Promise<HistoryItem[]> {
    const where = messageWhere(input.filter);
    return run(() =>
      this.withDeliveries(
        this.db
          .prepare(
            `${MESSAGE_VIEW_SELECT}
             WHERE m.id < @before AND ${where.sql}
             ORDER BY m.id DESC
             LIMIT @limit`,
          )
          .all({
            ...where.params,
            before: input.beforeId ?? '~',
            limit: input.limit,
          }) as MessageViewRow[],
      ),
    );
  }

  countHistory(filter: MessageFilter): Promise<number> {
    const where = messageWhere(filter);
    return run(
      () =>
        (
          this.db
            .prepare(`SELECT COUNT(*) AS n FROM messages m WHERE ${where.sql}`)
            .get(where.params) as { n: number }
        ).n,
    );
  }

  threadHeads(threadIds: string[]): Promise<{ first: HistoryItem; messages: number }[]> {
    return run(() => {
      if (threadIds.length === 0) return [];
      const rows = this.db
        .prepare(
          `WITH t AS (
             SELECT thread_id, COUNT(*) AS n FROM messages
             WHERE thread_id IN (SELECT value FROM json_each(@ids))
             GROUP BY thread_id)
           SELECT m.*, c.slug AS from_connection_slug, t.n
           FROM messages m JOIN connections c ON c.id = m.from_connection_id
           JOIN t ON t.thread_id = m.thread_id
           WHERE m.id = (SELECT f.id FROM messages f WHERE f.thread_id = m.thread_id
                         ORDER BY f.created_at, f.id LIMIT 1)`,
        )
        .all({ ids: JSON.stringify(threadIds) }) as (MessageViewRow & { n: number })[];
      const counts = new Map(rows.map((r) => [r.thread_id, r.n]));
      return this.withDeliveries(rows).map((first) => ({
        first,
        messages: counts.get(first.message.threadId) ?? 1,
      }));
    });
  }

  auditRange(): Promise<{ first: number; last: number } | undefined> {
    return run(() => {
      // Two subqueries, so each can use the index's end instead of scanning it.
      const r = this.db
        .prepare('SELECT (SELECT MIN(at) FROM audit) AS first, (SELECT MAX(at) FROM audit) AS last')
        .get() as {
        first: number | null;
        last: number | null;
      };
      return r.first === null || r.last === null ? undefined : { first: r.first, last: r.last };
    });
  }

  private withDeliveries(rows: MessageViewRow[]): HistoryItem[] {
    if (rows.length === 0) return [];
    const deliveries = this.db
      .prepare(
        `SELECT d.message_id, d.to_handle, d.state, d.read_at, d.expires_at, c.slug AS to_slug
         FROM deliveries d JOIN connections c ON c.id = d.to_connection_id
         WHERE d.message_id IN (SELECT value FROM json_each(?))
         ORDER BY c.slug, d.to_handle`,
      )
      .all(JSON.stringify(rows.map((r) => r.id))) as {
      message_id: string;
      to_handle: string;
      state: DeliveryState;
      read_at: number | null;
      expires_at: number;
      to_slug: string;
    }[];
    return rows.map((r) => ({
      message: toView(r),
      deliveries: deliveries
        .filter((d) => d.message_id === r.id)
        .map((d) => ({
          toConnectionSlug: d.to_slug,
          toHandle: d.to_handle,
          state: d.state,
          readAt: d.read_at,
          expiresAt: d.expires_at,
        })),
    }));
  }

  private audit(e: AuditEntry): void {
    const { maxAuditBytes, rotateAudit } = this.limits;
    if (!rotateAudit && e.actor === 'agent' && this.countedBytes().audit >= maxAuditBytes) {
      throw new AuditFullError(maxAuditBytes);
    }
    this.insertAudit(e);
    if (rotateAudit && this.countedBytes().audit > maxAuditBytes) this.rotateAudit(e.at);
  }

  private insertAudit(e: AuditEntry): void {
    this.db
      .prepare(
        'INSERT INTO audit (at, event, actor, connection_id, detail_json) VALUES (?, ?, ?, ?, ?)',
      )
      .run(e.at, e.event, e.actor, e.connectionId, JSON.stringify(e.detail));
    this.onAudit(e);
  }

  private createConnection(slug: string, now: number): string {
    const id = ulid(now);
    this.db
      .prepare('INSERT INTO connections (id, slug, created_at, last_seen_at) VALUES (?, ?, ?, ?)')
      .run(id, slug, now, now);
    return id;
  }

  private storeMessage(m: MessageRecord, deliveries: DeliveryRecord[]): void {
    this.db
      .prepare(
        `INSERT INTO messages (id, type, from_connection_id, from_handle, to_json, subject,
           body_md, payload_json, thread_id, reply_to, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        m.id,
        m.type,
        m.fromConnectionId,
        m.fromHandle,
        JSON.stringify(m.to),
        m.subject,
        m.bodyMd,
        m.payload === null ? null : JSON.stringify(m.payload),
        m.threadId,
        m.replyTo,
        m.createdAt,
        m.expiresAt,
      );
    const insert = this.db.prepare(
      `INSERT INTO deliveries (message_id, to_connection_id, to_handle, state, read_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    for (const d of deliveries) {
      insert.run(d.messageId, d.toConnectionId, d.toHandle, d.state, d.readAt, d.expiresAt);
    }
  }

  private policyFor(connectionId: string): Policy {
    const row = this.db
      .prepare('SELECT policy_mode FROM connections WHERE id = ?')
      .get(connectionId) as { policy_mode: PolicyMode } | undefined;
    const allowed = this.db
      .prepare(
        'SELECT allowed_connection_id FROM policy_allowed WHERE connection_id = ? ORDER BY allowed_connection_id',
      )
      .all(connectionId) as { allowed_connection_id: string }[];
    return {
      connectionId,
      mode: row?.policy_mode ?? 'allowlist',
      allowedConnectionIds: allowed.map((a) => a.allowed_connection_id),
    };
  }

  private describePolicy(p: Policy): { mode: PolicyMode; allowed_connections: string[] } {
    return {
      mode: p.mode,
      allowed_connections: p.allowedConnectionIds
        .map((id) => this.connectionWhere('id', id)?.slug ?? id)
        .sort(),
    };
  }

  private connectionWhere(column: 'id' | 'slug', value: string): Connection | undefined {
    const row = this.db.prepare(`SELECT * FROM connections WHERE ${column} = ?`).get(value) as
      ConnectionRow | undefined;
    return row && toConnection(row);
  }

  private unreadCount(connectionId: string, handle: string, now: number): number {
    return (
      this.db
        .prepare(
          `SELECT COUNT(*) AS n FROM deliveries
           WHERE to_connection_id = ? AND to_handle = ? AND state = 'unread' AND expires_at > ?`,
        )
        .get(connectionId, handle, now) as { n: number }
    ).n;
  }

  /** A message (or any one in a thread) that the connection sent or holds a delivery of. */
  private visibleMessage(
    by: 'id' | 'thread_id',
    value: string,
    connectionId: string,
  ): MessageRecord | undefined {
    const row = this.db
      .prepare(
        `SELECT m.* FROM messages m
         WHERE m.${by} = ?
           AND (m.from_connection_id = ?
                OR EXISTS (SELECT 1 FROM deliveries d
                           WHERE d.message_id = m.id AND d.to_connection_id = ?))
         LIMIT 1`,
      )
      .get(value, connectionId, connectionId) as MessageRow | undefined;
    return row && toMessage(row);
  }

  /** Connections count against the workspace's cap, all but archived ones and Budd's own. */
  private full(): boolean {
    const { n } = this.db
      .prepare('SELECT COUNT(*) AS n FROM connections WHERE archived_at IS NULL AND slug <> ?')
      .get(SYSTEM_CONNECTION_SLUG) as { n: number };
    return n >= this.limits.maxConnections;
  }

  private countedBytes(): { messages: number; audit: number } {
    return this.db.prepare('SELECT messages, audit FROM stored_bytes').get() as {
      messages: number;
      audit: number;
    };
  }

  /**
   * Deletes the oldest entries until the log is at 90% of its cap, so rotating
   * is occasional. Batches are sized from the average entry, and the entry
   * just written is never deleted.
   */
  private rotateAudit(now: number): void {
    const target = Math.floor(this.limits.maxAuditBytes * 0.9);
    const { newest, rows } = this.db
      .prepare('SELECT MAX(id) AS newest, COUNT(*) AS rows FROM audit')
      .get() as { newest: number; rows: number };
    const deleteOldest = this.db.prepare(
      'DELETE FROM audit WHERE id IN (SELECT id FROM audit WHERE id < ? ORDER BY id LIMIT ?)',
    );
    let deleted = 0;
    for (let bytes = this.countedBytes().audit; bytes > target; bytes = this.countedBytes().audit) {
      const average = bytes / (rows - deleted);
      const changes = deleteOldest.run(
        newest,
        Math.max(1, Math.floor((bytes - target) / average)),
      ).changes;
      if (changes === 0) break;
      deleted += changes;
    }
    const oldest = this.db.prepare('SELECT MIN(at) AS at FROM audit').get() as { at: number };
    this.insertAudit({
      at: now,
      event: 'audit_rotated',
      actor: 'system',
      connectionId: null,
      detail: { deleted, oldest_kept: new Date(oldest.at).toISOString() },
    });
  }

  private deleteWakeUp(
    connectionId: string,
    handle: string,
    actor: AuditActor,
    reason: string | undefined,
    now: number,
  ): boolean {
    const row = this.db
      .prepare('DELETE FROM wake_ups WHERE connection_id = ? AND handle = ? RETURNING host')
      .get(connectionId, handle) as { host: string } | undefined;
    if (!row) return false;
    this.audit({
      at: now,
      event: 'wake_up_removed',
      actor,
      connectionId,
      detail: {
        mailbox: `${this.connectionWhere('id', connectionId)?.slug ?? '?'}/${handle}`,
        host: row.host,
        ...(reason !== undefined && { reason }),
      },
    });
    return true;
  }

  private handleState(connectionId: string, name: string): 'none' | 'active' | 'archived' {
    const row = this.db
      .prepare('SELECT archived_at FROM handles WHERE connection_id = ? AND name = ?')
      .get(connectionId, name) as { archived_at: number | null } | undefined;
    return row === undefined ? 'none' : row.archived_at === null ? 'active' : 'archived';
  }

  /** Mailboxes in use: archived ones don't count towards the cap. */
  private handleCount(connectionId: string): number {
    return (
      this.db
        .prepare(
          'SELECT COUNT(*) AS n FROM handles WHERE connection_id = ? AND archived_at IS NULL',
        )
        .get(connectionId) as { n: number }
    ).n;
  }

  private registerHandle(
    h: { connectionId: string; name: string; maxHandles: number },
    now: number,
  ): HandleRegistration {
    const state = this.handleState(h.connectionId, h.name);
    if (state !== 'none') return state === 'archived' ? 'archived' : 'exists';
    if (this.handleCount(h.connectionId) >= h.maxHandles) return 'limit';
    this.db
      .prepare('INSERT INTO handles (connection_id, name, first_seen_at) VALUES (?, ?, ?)')
      .run(h.connectionId, h.name, now);
    this.audit({
      at: now,
      event: 'handle_first_seen',
      actor: 'agent',
      connectionId: h.connectionId,
      detail: {
        handle: `${this.connectionWhere('id', h.connectionId)?.slug ?? '?'}/${h.name}`,
        verified: false,
      },
    });
    return 'created';
  }
}

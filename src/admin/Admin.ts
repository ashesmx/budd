import { isWidening } from '../bus/policy.js';
import { SYSTEM_CONNECTION_SLUG } from '../domain/slug.js';
import { log } from '../log.js';
import type { AuditRecord, Connection, HistoryItem, PolicyMode } from '../domain/types.js';
import type { AdminContext, WorkspaceGateway } from '../storage/gateway.js';
import type {
  AuditFilter,
  MailboxStats,
  MessageFilter,
  WorkspaceStore,
} from '../storage/Storage.js';

export class AdminError extends Error {
  override name = 'AdminError';
  constructor(
    readonly code:
      | 'unknown_connection'
      | 'invalid_input'
      | 'confirmation_required'
      | 'archived'
      | 'blocked'
      | 'connection_limit'
      | 'unknown_mailbox'
      | 'mailbox_limit'
      | 'test_too_soon',
    message: string,
  ) {
    super(message);
  }
}

export interface ConnectionOverview extends Connection {
  policy: { mode: PolicyMode; allowed: string[] };
  mailboxes: {
    handle: string;
    firstSeenAt: number;
    unread: number;
    /** When it last sent or was sent a message, and last read one. */
    lastMessageAt: number | null;
    lastReadAt: number | null;
    /** Set when a human archived it. */
    archivedAt: number | null;
  }[];
  /** Hosted mode: whether any app still holds a usable token for it. Undefined in local mode. */
  hasLiveTokens: boolean | undefined;
}

/** How long the map reuses a count of message routes. */
export const ROUTES_FRESH_MS = 30_000;

/** Messages from one mailbox to another, by address (`slug/handle`). */
export interface RouteCount {
  from: string;
  to: string;
  messages: number;
  /** Not read yet, expired included. */
  unread: number;
}

export interface PolicyPreview {
  before: { mode: PolicyMode; allowed: string[] };
  after: { mode: PolicyMode; allowed: string[] };
  changed: boolean;
  widened: boolean;
  /** What the change lets in: connection slugs, or ["everyone"]. */
  added: string[];
}

/**
 * What a human can do to a workspace: the only writes outside the bus (§15).
 * Never exposed over MCP. The UI wraps `setPolicy` in the two-step,
 * nonce-confirmed flow that §9 requires for widening.
 */
export class Admin {
  private readonly routeCounts = new Map<string, { at: number; counts: Promise<RouteCount[]> }>();

  constructor(
    private readonly gateway: WorkspaceGateway,
    private readonly clock: () => number = Date.now,
    /** Hosted mode: kills a blocked connection's tokens (§11). */
    private readonly onBlocked: (
      workspaceId: string,
      connectionId: string,
      reason: 'connection_blocked' | 'connection_archived',
    ) => Promise<void> = () => Promise.resolve(),
    /** Hosted mode: the workspace's connections that still have usable tokens. */
    private readonly liveConnectionIds?: (workspaceId: string) => Promise<string[]>,
    /** MAX_HANDLES_PER_CONNECTION: restoring a mailbox mustn't take a connection over it. */
    private readonly maxHandles = Number.MAX_SAFE_INTEGER,
  ) {}

  async block(ctx: AdminContext, slug: string): Promise<boolean> {
    const store = await this.gateway.forAdmin(ctx);
    const c = await this.connection(store, slug);
    const changed = await store.setConnectionStatus({
      connectionId: c.id,
      status: 'blocked',
      now: this.clock(),
    });
    await this.onBlocked(ctx.workspace.id, c.id, 'connection_blocked'); // even if already blocked
    if (changed)
      log.info('connection blocked', { workspace: ctx.workspace.slug, connection: slug });
    return changed;
  }

  /**
   * Hides a connection the human no longer uses (ADR 0011). It is blocked, its
   * tokens are revoked, and its history and audit rows are kept.
   */
  async archive(ctx: AdminContext, slug: string): Promise<boolean> {
    const store = await this.gateway.forAdmin(ctx);
    const c = await this.connection(store, slug);
    const changed = await store.setConnectionArchived({
      connectionId: c.id,
      archived: true,
      now: this.clock(),
    });
    await this.onBlocked(ctx.workspace.id, c.id, 'connection_archived');
    if (changed) {
      log.info('connection archived', { workspace: ctx.workspace.slug, connection: slug });
    }
    return changed === true;
  }

  /** Brings an archived connection back to the list, still blocked: unblocking is separate. */
  async restore(ctx: AdminContext, slug: string): Promise<boolean> {
    const store = await this.gateway.forAdmin(ctx);
    const c = await this.connection(store, slug);
    const changed = await store.setConnectionArchived({
      connectionId: c.id,
      archived: false,
      now: this.clock(),
    });
    if (changed === 'limit') throw connectionLimitError();
    if (changed) {
      log.info('connection restored', { workspace: ctx.workspace.slug, connection: slug });
    }
    return changed;
  }

  /**
   * Lets a blocked connection back in, so like a widening it is refused unless
   * `confirmed` is true (the UI's nonce-bound confirm step).
   */
  async unblock(
    ctx: AdminContext,
    slug: string,
    opts: { confirmed?: boolean } = {},
  ): Promise<boolean> {
    if (opts.confirmed !== true) {
      throw new AdminError(
        'confirmation_required',
        `Unblocking lets "${slug}" use Budd again. Confirm it before it takes effect.`,
      );
    }
    const store = await this.gateway.forAdmin(ctx);
    const c = await this.connection(store, slug);
    if (c.archivedAt !== null) {
      throw new AdminError('archived', `"${slug}" is archived. Restore it before unblocking it.`);
    }
    const changed = await store.setConnectionStatus({
      connectionId: c.id,
      status: 'active',
      now: this.clock(),
    });
    if (changed) {
      log.info('connection unblocked', { workspace: ctx.workspace.slug, connection: slug });
    }
    return changed;
  }

  /**
   * Archives a mailbox: it takes no new mail, no agent can use it, and it stops
   * counting towards the connection's handle cap. Its history is kept.
   */
  async archiveMailbox(ctx: AdminContext, slug: string, handle: string): Promise<boolean> {
    return this.setMailboxArchived(ctx, slug, handle, true);
  }

  /** Brings an archived mailbox back, if the connection has room for it. */
  async restoreMailbox(ctx: AdminContext, slug: string, handle: string): Promise<boolean> {
    return this.setMailboxArchived(ctx, slug, handle, false);
  }

  private async setMailboxArchived(
    ctx: AdminContext,
    slug: string,
    handle: string,
    archived: boolean,
  ): Promise<boolean> {
    const store = await this.gateway.forAdmin(ctx);
    const c = await this.connection(store, slug);
    const changed = await store.setHandleArchived({
      connectionId: c.id,
      name: handle,
      archived,
      maxHandles: this.maxHandles,
      now: this.clock(),
    });
    if (changed === undefined) {
      throw new AdminError('unknown_mailbox', `No mailbox "${slug}/${handle}".`);
    }
    if (changed === 'limit') {
      throw new AdminError(
        'mailbox_limit',
        `"${slug}" already uses the most mailboxes it may have. Archive another of its mailboxes first.`,
      );
    }
    if (changed) {
      log.info(archived ? 'mailbox archived' : 'mailbox restored', {
        workspace: ctx.workspace.slug,
        mailbox: `${slug}/${handle}`,
      });
    }
    return changed;
  }

  async relabel(ctx: AdminContext, slug: string, label: string | null): Promise<void> {
    const trimmed = label?.trim() || null;
    if (trimmed !== null && trimmed.length > 80) {
      throw new AdminError('invalid_input', 'Labels are limited to 80 characters.');
    }
    const store = await this.gateway.forAdmin(ctx);
    const c = await this.connection(store, slug);
    await store.setConnectionLabel({ connectionId: c.id, label: trimmed, now: this.clock() });
  }

  /**
   * Every agent connection with its policy, handles and unread counts (the live
   * queues). Its mailboxes' last activity costs a scan of its messages, so only
   * for `activityOf`, the connection a page is about.
   */
  async overview(
    ctx: AdminContext,
    opts: { activityOf?: string | undefined } = {},
  ): Promise<ConnectionOverview[]> {
    const store = await this.gateway.forAdmin(ctx);
    const [connections, handles, policies, unread, live] = await Promise.all([
      store.listConnections(),
      store.listHandles(),
      store.listPolicies(),
      store.countUnreadByMailbox(this.clock()),
      this.liveConnectionIds?.(ctx.workspace.id),
    ]);
    const of = opts.activityOf && connections.find((c) => c.slug === opts.activityOf);
    const now = this.clock();
    const activity = of ? await store.mailboxStats(of.id, now, now) : [];
    const slugOf = (id: string) => connections.find((c) => c.id === id)?.slug ?? id;
    return connections
      .filter((c) => c.slug !== SYSTEM_CONNECTION_SLUG)
      .map((c) => {
        const policy = policies.find((p) => p.connectionId === c.id);
        return {
          ...c,
          hasLiveTokens: live?.includes(c.id),
          policy: {
            mode: policy?.mode ?? 'allowlist',
            allowed: (policy?.allowedConnectionIds ?? []).map(slugOf).sort(),
          },
          mailboxes: handles
            .filter((h) => h.connectionId === c.id)
            .map((h) => {
              const seen = c === of ? activity.find((a) => a.handle === h.name) : undefined;
              const latest = [seen?.lastSentAt, seen?.lastReceivedAt].filter(
                (t): t is number => typeof t === 'number',
              );
              return {
                handle: h.name,
                firstSeenAt: h.firstSeenAt,
                unread:
                  unread.find((u) => u.connectionId === c.id && u.handle === h.name)?.unread ?? 0,
                lastMessageAt: latest.length > 0 ? Math.max(...latest) : null,
                lastReadAt: seen?.lastReadAt ?? null,
                archivedAt: h.archivedAt,
              };
            }),
        };
      });
  }

  /**
   * The routes messages took in the last `windowMs`, between mailboxes named
   * by slug. A month of a busy workspace takes a while to count, and the map
   * asks again on every change, so a count is reused for ROUTES_FRESH_MS.
   */
  async routes(ctx: AdminContext, windowMs: number): Promise<RouteCount[]> {
    const store = await this.gateway.forAdmin(ctx);
    const now = this.clock();
    for (const [key, entry] of this.routeCounts) {
      if (entry.at <= now - ROUTES_FRESH_MS) this.routeCounts.delete(key);
    }
    const key = `${ctx.workspace.id} ${String(windowMs)}`;
    const cached = this.routeCounts.get(key);
    if (cached) return cached.counts;
    const counts = this.countRoutes(store, now - windowMs);
    this.routeCounts.set(key, { at: now, counts });
    counts.catch(() => this.routeCounts.delete(key));
    return counts;
  }

  private async countRoutes(store: WorkspaceStore, since: number): Promise<RouteCount[]> {
    const [routes, connections] = await Promise.all([
      store.messageRoutes(since),
      store.listConnections(),
    ]);
    const slugs = new Map(connections.map((c) => [c.id, c.slug]));
    return routes.flatMap((r) => {
      const from = slugs.get(r.fromConnectionId);
      const to = slugs.get(r.toConnectionId);
      return from && to
        ? [
            {
              from: `${from}/${r.fromHandle}`,
              to: `${to}/${r.toHandle}`,
              messages: r.messages,
              unread: r.unread,
            },
          ]
        : [];
    });
  }

  /** A connection's mailboxes: what each sent and was sent in the last `windowMs`, and its latest mail. */
  async mailboxStats(ctx: AdminContext, slug: string, windowMs: number): Promise<MailboxStats[]> {
    const store = await this.gateway.forAdmin(ctx);
    const c = await store.getConnectionBySlug(slug);
    if (!c) return [];
    const now = this.clock();
    return store.mailboxStats(c.id, now - windowMs, now);
  }

  /** Whether a new connection would be refused (MAX_CONNECTIONS_PER_WORKSPACE). */
  async isFull(ctx: AdminContext): Promise<boolean> {
    return (await this.gateway.forAdmin(ctx)).isFull();
  }

  /** Every connection, the system one included: what the UI's filters offer. */
  async connections(ctx: AdminContext): Promise<Connection[]> {
    const store = await this.gateway.forAdmin(ctx);
    return store.listConnections();
  }

  /** Messages, newest first, without counting how many match: for pages that don't say. */
  async messages(
    ctx: AdminContext,
    page: { limit: number; filter?: MessageFilter | undefined },
  ): Promise<HistoryItem[]> {
    const store = await this.gateway.forAdmin(ctx);
    return store.listHistory({ limit: page.limit, filter: page.filter ?? {} });
  }

  async history(
    ctx: AdminContext,
    page: { limit: number; beforeId?: string | undefined; filter?: MessageFilter | undefined },
  ): Promise<{ items: HistoryItem[]; matching: number }> {
    const store = await this.gateway.forAdmin(ctx);
    const filter = page.filter ?? {};
    const [items, matching] = await Promise.all([
      store.listHistory({ limit: page.limit, beforeId: page.beforeId, filter }),
      store.countHistory(filter),
    ]);
    return { items, matching };
  }

  /** Each thread's first message, and how many messages it holds. */
  async threadHeads(
    ctx: AdminContext,
    threadIds: string[],
  ): Promise<{ first: HistoryItem; messages: number }[]> {
    return (await this.gateway.forAdmin(ctx)).threadHeads(threadIds);
  }

  /** When the oldest and newest audit entries were written. */
  async auditRange(ctx: AdminContext): Promise<{ first: number; last: number } | undefined> {
    return (await this.gateway.forAdmin(ctx)).auditRange();
  }

  async auditPage(
    ctx: AdminContext,
    page: { limit: number; beforeId?: number | undefined; filter?: AuditFilter | undefined },
  ): Promise<{ rows: (AuditRecord & { connection: string | null })[]; matching: number }> {
    const store = await this.gateway.forAdmin(ctx);
    const filter = page.filter ?? {};
    const [rows, matching, connections] = await Promise.all([
      store.listAudit({ limit: page.limit, beforeId: page.beforeId, filter }),
      store.countAudit(filter),
      store.listConnections(),
    ]);
    return {
      rows: rows.map((r) => ({
        ...r,
        connection: connections.find((c) => c.id === r.connectionId)?.slug ?? null,
      })),
      matching,
    };
  }

  /** What `setPolicy` would do, without doing it: used to build the confirm step. */
  async previewPolicy(
    ctx: AdminContext,
    slug: string,
    next: { mode: PolicyMode; allowed: string[] },
  ): Promise<PolicyPreview> {
    const store = await this.gateway.forAdmin(ctx);
    const target = await this.connection(store, slug);
    const allowed: string[] = [];
    for (const s of new Set(next.allowed)) {
      const c = await this.connection(store, s);
      if (c.id !== target.id) allowed.push(c.slug);
    }
    allowed.sort();
    const before = await store.getPolicy(target.id);
    const connections = await store.listConnections();
    const beforeAllowed = before.allowedConnectionIds
      .map((id) => connections.find((c) => c.id === id)?.slug ?? id)
      .sort();
    const added = allowed.filter((a) => !beforeAllowed.includes(a));
    const widened = isWidening(
      { mode: before.mode, allowedConnectionIds: beforeAllowed },
      { mode: next.mode, allowedConnectionIds: allowed },
    );
    return {
      before: { mode: before.mode, allowed: beforeAllowed },
      after: { mode: next.mode, allowed },
      changed: before.mode !== next.mode || beforeAllowed.join() !== allowed.join(),
      widened,
      added: next.mode === 'all' && before.mode !== 'all' ? ['everyone'] : added,
    };
  }

  /**
   * Replaces a connection's inbound policy, audited as `policy_widened` or
   * `policy_tightened`. A widening change is refused unless `confirmed` is true;
   * the UI sets it only after the human completes the nonce-bound confirm step.
   */
  async setPolicy(
    ctx: AdminContext,
    slug: string,
    next: { mode: PolicyMode; allowed: string[] },
    opts: { confirmed?: boolean } = {},
  ): Promise<{ widened: boolean; changed: boolean }> {
    const store = await this.gateway.forAdmin(ctx);
    const target = await this.connection(store, slug);
    const allowedIds: string[] = [];
    for (const s of new Set(next.allowed)) {
      const c = await this.connection(store, s);
      if (c.id !== target.id) allowedIds.push(c.id);
    }
    const before = await store.getPolicy(target.id);
    const after = { mode: next.mode, allowedConnectionIds: allowedIds.sort() };
    const changed =
      before.mode !== after.mode ||
      before.allowedConnectionIds.join() !== after.allowedConnectionIds.join();
    const widened = isWidening(before, after);
    if (widened && opts.confirmed !== true) {
      throw new AdminError(
        'confirmation_required',
        `This change lets more connections message "${slug}". Confirm it before it takes effect.`,
      );
    }
    if (changed) {
      await store.replacePolicy({
        connectionId: target.id,
        ...after,
        event: widened ? 'policy_widened' : 'policy_tightened',
        actor: 'human',
        detail: { via: 'admin', ...(widened && { confirmed: true }) },
        now: this.clock(),
      });
    }
    return { widened, changed };
  }

  async audit(ctx: AdminContext, limit = 100) {
    const store = await this.gateway.forAdmin(ctx);
    return store.listAudit({ limit });
  }

  private async connection(store: WorkspaceStore, slug: string): Promise<Connection> {
    const c = slug === SYSTEM_CONNECTION_SLUG ? undefined : await store.getConnectionBySlug(slug);
    if (!c) throw new AdminError('unknown_connection', `No connection named "${slug}".`);
    return c;
  }
}

/** For people in the workspace, who can't change the instance's setting. */
export const CONNECTION_LIMIT_MESSAGE =
  'This workspace already has the most connections it may have. Archive one you no longer use, then try again.';

export const connectionLimitError = () =>
  new AdminError('connection_limit', CONNECTION_LIMIT_MESSAGE);

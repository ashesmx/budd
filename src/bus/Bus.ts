import { isValid as isUlid, monotonicFactory } from 'ulid';
import { durationInWords, formatDuration, parseDuration, type Config } from '../config.js';
import { isValidSlug, SLUG_RULES, SYSTEM_CONNECTION_SLUG } from '../domain/slug.js';
import type { Connection, MessageRecord, Policy } from '../domain/types.js';
import type { RateLimiter } from '../ratelimit/RateLimiter.js';
import { TokenBucketRateLimiter } from '../ratelimit/TokenBucketRateLimiter.js';
import type { ConnectionContext, WorkspaceGateway } from '../storage/gateway.js';
import {
  AuditFullError,
  type RecipientState,
  type SendPlan,
  type SendState,
  type WorkspaceStore,
} from '../storage/Storage.js';
import { BUDD_PROTOCOL_VERSION, BUDD_VERSION } from '../version.js';
import { formatAddress, parseAddress } from './addressing.js';
import { type Envelope, toEnvelope } from './envelope.js';
import { BusError } from './errors.js';
import { accepts, isWidening, POLICY_HUMAN_ONLY } from './policy.js';
import {
  HANDLE_CHOOSE,
  HANDLE_NEEDED,
  HANDLE_WARNING,
  pollingGuidance,
  TRUST_EXPLANATION,
} from './trust.js';

export const MAX_SUBJECT_CHARS = 200;
export const DEFAULT_INBOX_LIMIT = 10;
/** Pretty-printing grows with the square of the depth, so a deep payload costs far more to show than to send. */
export const MAX_PAYLOAD_DEPTH = 32;

export type RejectionReason =
  | 'policy'
  | 'recipient_backlog'
  | 'unknown_connection'
  | 'unknown_handle'
  | 'mailbox_archived'
  | 'blocked'
  | 'cross_workspace';

export type RecipientResult =
  | { to: string; status: 'delivered' }
  | { to: string; status: 'rejected'; reason: RejectionReason; detail: string };

export interface SendInput {
  to: string[];
  subject?: string | undefined;
  body_md?: string | undefined;
  payload?: Record<string, unknown> | undefined;
  from_handle: string;
  thread_id?: string | undefined;
  reply_to?: string | undefined;
  /** Delivery TTL override, e.g. "6h" or "3d", capped at MAX_DELIVERY_TTL. */
  ttl?: string | undefined;
}

export interface SendResult {
  /** null when every recipient was rejected (nothing is stored). */
  message_id: string | null;
  thread_id: string | null;
  /** When unread deliveries expire (ISO 8601); null if nothing was stored. */
  expires_at: string | null;
  results: RecipientResult[];
}

export interface PolicyTightenInput {
  remove_connections?: string[] | undefined;
  mode?: string | undefined;
}

/** A recipient's address, split and checked but not yet looked up. */
interface Address {
  connectionSlug: string;
  handle: string;
}

/** A send, checked as far as it can be without the store. */
interface SendDraft {
  subject: string | null;
  bodyMd: string | null;
  payload: Record<string, unknown> | null;
  sizes: { body_bytes: number; payload_bytes: number };
  fromHandle: string;
  ttlMs: number;
  /** Per distinct recipient: an address to look up, or already rejected. */
  slots: (RecipientResult | Address)[];
}

/** Rejected recipients the audit log keeps in full; the rest are only counted. */
const AUDITED_REJECTIONS = 5;

/**
 * Recipients for the audit log. Every delivery names a real mailbox, but an
 * agent can list up to SENDER_MAX_OUTSTANDING addresses that don't exist, so
 * rejections are counted by reason and only the first few are kept.
 */
function auditResults(results: RecipientResult[]) {
  const rejected = results.filter((r) => r.status === 'rejected');
  const byReason = () => {
    const counts: Partial<Record<RejectionReason, number>> = {};
    for (const r of rejected) counts[r.reason] = (counts[r.reason] ?? 0) + 1;
    return counts;
  };
  return {
    delivered: results.filter((r) => r.status === 'delivered').map((r) => r.to),
    rejected: rejected
      .slice(0, AUDITED_REJECTIONS)
      .map((r) => ({ to: r.to.slice(0, 100), reason: r.reason })),
    ...(rejected.length > AUDITED_REJECTIONS && { rejected_by_reason: byReason() }),
  };
}

export class Bus {
  private readonly newId = monotonicFactory();
  private readonly rateLimiter: RateLimiter;
  private readonly refusalsAudited = new TokenBucketRateLimiter(1, 60_000, 100_000);

  constructor(
    private readonly gateway: WorkspaceGateway,
    private readonly config: Config,
    private readonly clock: () => number = Date.now,
  ) {
    this.rateLimiter = new TokenBucketRateLimiter(config.limits.sendRatePerMin, 60_000);
  }

  async whoami(ctx: ConnectionContext) {
    const store = await this.gateway.forConnection(ctx);
    const handles = (await store.listHandles())
      .filter((h) => h.connectionId === ctx.connection.id && h.archivedAt === null)
      .map((h) => h.name);
    return {
      workspace: ctx.workspace.slug,
      connection: ctx.connection.slug,
      connection_verified: true,
      address: `${ctx.workspace.slug}/${ctx.connection.slug}`,
      mode: this.config.mode,
      protocol_version: BUDD_PROTOCOL_VERSION,
      budd_version: BUDD_VERSION,
      handles_seen: handles,
      your_handle: handles.length === 0 ? HANDLE_NEEDED : HANDLE_CHOOSE,
      handles_note: HANDLE_WARNING,
      trust: TRUST_EXPLANATION,
      polling: pollingGuidance(this.config.ttl.deliveryMs),
      limits: this.limitsSummary(),
    };
  }

  async listConnections(ctx: ConnectionContext) {
    const store = await this.gateway.forConnection(ctx);
    const [connections, handles, policies] = await Promise.all([
      store.listConnections(),
      store.listHandles(),
      store.listPolicies(),
    ]);
    return {
      workspace: ctx.workspace.slug,
      connections: connections
        .filter((c) => c.slug !== SYSTEM_CONNECTION_SLUG && c.archivedAt === null)
        .map((c) => {
          const policy = policies.find((p) => p.connectionId === c.id);
          return {
            connection: c.slug,
            label: c.label,
            you: c.id === ctx.connection.id,
            status: c.status,
            accepts_messages_from_you:
              c.status === 'active' && policy !== undefined && accepts(policy, ctx.connection.id),
            handles: handles
              .filter((h) => h.connectionId === c.id && h.archivedAt === null)
              .map((h) => h.name),
          };
        }),
      handles_note: HANDLE_WARNING,
      policy_note: `A connection accepts messages from you only if its contact policy allows your connection. ${POLICY_HUMAN_ONLY}`,
    };
  }

  async send(ctx: ConnectionContext, input: SendInput): Promise<SendResult> {
    const store = await this.gateway.forConnection(ctx);
    const now = this.clock();
    try {
      return await this.trySend(ctx, store, input, now);
    } catch (err) {
      if (err instanceof BusError) await this.auditRefusal(ctx, store, input, err, now);
      throw err;
    }
  }

  /**
   * Records a refused send: once a minute for each connection and reason, so
   * an agent repeating a mistake (or a refusal in a loop) can't fill the
   * audit log. A full audit log records none.
   */
  private async auditRefusal(
    ctx: ConnectionContext,
    store: WorkspaceStore,
    input: SendInput,
    err: BusError,
    now: number,
  ): Promise<void> {
    if (!this.refusalsAudited.tryConsume(`${ctx.connection.id}/${err.code}`, now)) return;
    try {
      await store.appendAudit({
        at: now,
        event: 'send_refused',
        actor: 'agent',
        connectionId: ctx.connection.id,
        detail: {
          from: ctx.connection.slug,
          from_handle:
            typeof input.from_handle === 'string' ? input.from_handle.slice(0, 40) : null,
          reason: err.code,
          recipients: input.to.length,
          note: 'Further sends refused for this reason in the next minute are not recorded.',
        },
      });
    } catch (auditErr) {
      if (!(auditErr instanceof AuditFullError)) throw auditErr;
    }
  }

  private async trySend(
    ctx: ConnectionContext,
    store: WorkspaceStore,
    input: SendInput,
    now: number,
  ): Promise<SendResult> {
    const subject = input.subject?.trim() || null;
    const bodyMd = input.body_md ?? null;
    const payload = input.payload ?? null;
    const sizes = this.validateContent(subject, bodyMd, payload);
    if (input.to.length === 0) {
      throw new BusError('invalid_input', 'Add at least one recipient to "to".');
    }
    const fromHandle = this.normaliseHandle(input.from_handle, 'from_handle');
    const ttlMs = this.parseTtl(input.ttl);

    if (!this.rateLimiter.tryConsume(ctx.connection.id, now)) {
      throw new BusError(
        'rate_limited',
        `Send rate limit reached: ${this.config.limits.sendRatePerMin} messages per minute per connection. Wait a minute before sending again; don't retry in a loop.`,
      );
    }

    if (input.thread_id !== undefined && !isUlid(input.thread_id)) {
      throw new BusError(
        'invalid_input',
        'thread_id must be a message id (ULID). Omit it to start a new thread, or use the thread_id of a message you received.',
      );
    }

    // Addresses that can't name a recipient are rejected before the store is
    // asked; duplicates collapse to one delivery and one result.
    const slots: (RecipientResult | Address)[] = [];
    const seen = new Set<string>();
    for (const raw of input.to) {
      const parsed = this.parse(ctx, raw);
      const key =
        'status' in parsed
          ? `rejected:${parsed.to}`
          : formatAddress(parsed.connectionSlug, parsed.handle);
      if (seen.has(key)) continue;
      seen.add(key);
      slots.push(parsed);
    }
    const draft: SendDraft = { subject, bodyMd, payload, sizes, fromHandle, ttlMs, slots };

    const outcome = await store.send({
      fromConnectionId: ctx.connection.id,
      fromHandle: draft.fromHandle,
      recipients: slots.filter((s): s is Address => !('status' in s)),
      replyTo: input.reply_to,
      threadId: input.thread_id,
      now,
      decide: (state) => this.planSend(ctx, input, draft, state, now),
    });
    if (outcome === 'limit') throw this.handleLimitError(ctx);
    if (outcome === 'archived') throw this.archivedError(ctx, draft.fromHandle);
    if (outcome === 'full') {
      const mb = Math.floor(this.config.limits.maxWorkspaceBytes / 1024 / 1024);
      throw new BusError(
        'workspace_full',
        `This workspace's message storage is full (${String(mb)} MB, set by MAX_WORKSPACE_MB). Nothing was sent. Messages are deleted ${durationInWords(this.config.ttl.retentionMs)} after they're sent, which frees space. Tell your human, and don't retry in a loop.`,
      );
    }
    return outcome;
  }

  /** Decides a send on the state read in its transaction; throws to refuse it. */
  private planSend(
    ctx: ConnectionContext,
    input: SendInput,
    draft: SendDraft,
    state: SendState,
    now: number,
  ): { plan: SendPlan; result: SendResult } {
    const thread = this.threadFor(input, state);
    const { results, deliverTo } = this.resolveAll(ctx, draft.slots, state);
    const audit = (event: 'send' | 'send_undelivered', messageId: string | null) => ({
      at: now,
      event,
      actor: 'agent' as const,
      connectionId: ctx.connection.id,
      detail: {
        message_id: messageId,
        thread_id: messageId === null ? null : (thread.threadId ?? messageId),
        from: formatAddress(ctx.connection.slug, draft.fromHandle),
        from_handle_verified: false,
        ...draft.sizes,
        ttl: formatDuration(draft.ttlMs),
        ...auditResults(results),
      },
    });

    if (deliverTo.length === 0) {
      return {
        plan: { audit: audit('send_undelivered', null) },
        result: { message_id: null, thread_id: null, expires_at: null, results },
      };
    }
    const id = this.newId(now);
    const expiresAt = now + draft.ttlMs;
    const message: MessageRecord = {
      id,
      type: 'message',
      fromConnectionId: ctx.connection.id,
      fromHandle: draft.fromHandle,
      to: results.filter((r) => r.status === 'delivered').map((r) => r.to),
      subject: draft.subject,
      bodyMd: draft.bodyMd,
      payload: draft.payload,
      threadId: thread.threadId ?? id,
      replyTo: thread.replyTo,
      createdAt: now,
      expiresAt,
    };
    this.checkBacklog(state, deliverTo.length);
    return {
      plan: {
        message: {
          record: message,
          deliveries: deliverTo.map((d) => ({
            messageId: id,
            toConnectionId: d.connection.id,
            toHandle: d.handle,
            state: 'unread',
            readAt: null,
            expiresAt,
          })),
          newHandle: {
            connectionId: ctx.connection.id,
            name: draft.fromHandle,
            maxHandles: this.config.limits.maxHandlesPerConnection,
          },
        },
        audit: audit('send', id),
      },
      result: {
        message_id: id,
        thread_id: message.threadId,
        expires_at: new Date(expiresAt).toISOString(),
        results,
      },
    };
  }

  /** The thread a send joins: reply_to's, or thread_id, each only if the sender can see it. */
  private threadFor(
    input: SendInput,
    state: SendState,
  ): { threadId: string | null; replyTo: string | null } {
    let threadId: string | null = null;
    let replyTo: string | null = null;
    if (input.reply_to !== undefined) {
      if (!state.replyTo) {
        throw new BusError(
          'unknown_reply_to',
          `reply_to "${input.reply_to}" is not a message your connection sent or received, or it was deleted after ${durationInWords(this.config.ttl.retentionMs)}.`,
        );
      }
      replyTo = state.replyTo.id;
      threadId = state.replyTo.threadId;
    }
    if (input.thread_id !== undefined) {
      if (!state.threadVisible) {
        throw new BusError(
          'unknown_thread',
          `thread_id "${input.thread_id}" is not a thread your connection has sent or received a message in, or its messages were deleted after ${durationInWords(this.config.ttl.retentionMs)}. Omit it to start a new thread, or set reply_to to a message you received.`,
        );
      }
      threadId = input.thread_id;
    }
    return { threadId, replyTo };
  }

  /** Each recipient's result, in the order given, and who gets a delivery. */
  private resolveAll(ctx: ConnectionContext, slots: SendDraft['slots'], state: SendState) {
    const results: RecipientResult[] = [];
    const deliverTo: { connection: Connection; handle: string }[] = [];
    let lookup = 0;
    for (const slot of slots) {
      if ('status' in slot) {
        results.push(slot);
        continue;
      }
      const resolved = this.resolve(ctx, slot, state.recipients[lookup++]);
      results.push(resolved.result);
      if (resolved.connection)
        deliverTo.push({ connection: resolved.connection, handle: slot.handle });
    }
    return { results, deliverTo };
  }

  private checkBacklog(state: SendState, deliveries: number): void {
    const max = this.config.limits.senderMaxOutstanding;
    if (state.outstanding + deliveries > max) {
      throw new BusError(
        'sender_backlog',
        `Your connection already has ${state.outstanding} unread deliveries waiting with recipients, and sending this would exceed the limit of ${max}. Nothing was sent. Wait for recipients to read their messages, or for unread ones to expire (after ${formatDuration(this.config.ttl.deliveryMs)} by default).`,
      );
    }
  }

  /** Claims a handle without sending or polling, so others can address it at once. */
  async claim(ctx: ConnectionContext, input: { handle: string }) {
    const handle = this.normaliseHandle(input.handle, 'handle');
    const store = await this.gateway.forConnection(ctx);
    const outcome = await this.claimHandle(ctx, store, handle, this.clock());
    return {
      mailbox: formatAddress(ctx.connection.slug, handle),
      claimed: outcome === 'created' ? 'new' : 'already_yours',
      next: `Use "${handle}" as from_handle when you send, and poll inbox_count and inbox with handle "${handle}". Others reach you at "${formatAddress(ctx.connection.slug, handle)}".`,
      handles_note: HANDLE_WARNING,
    };
  }

  async inboxCount(ctx: ConnectionContext, input: { handle: string }) {
    const handle = this.normaliseHandle(input.handle, 'handle');
    const store = await this.gateway.forConnection(ctx);
    const now = this.clock();
    await this.claimHandle(ctx, store, handle, now);
    const unread = await store.countUnread({ connectionId: ctx.connection.id, handle, now });
    return { mailbox: formatAddress(ctx.connection.slug, handle), unread };
  }

  async inbox(ctx: ConnectionContext, input: { handle: string; limit?: number | undefined }) {
    const handle = this.normaliseHandle(input.handle, 'handle');
    const limit = Math.min(input.limit ?? DEFAULT_INBOX_LIMIT, this.config.limits.inboxMaxLimit);
    const store = await this.gateway.forConnection(ctx);
    const now = this.clock();
    await this.claimHandle(ctx, store, handle, now);
    const messages = await store.consumeUnread({
      connectionId: ctx.connection.id,
      handle,
      limit,
      now,
    });
    const remaining = await store.countUnread({ connectionId: ctx.connection.id, handle, now });
    return {
      mailbox: formatAddress(ctx.connection.slug, handle),
      messages: messages.map((m): Envelope => toEnvelope(m, ctx.workspace.slug)),
      remaining,
    };
  }

  async thread(ctx: ConnectionContext, input: { thread_id: string; limit?: number | undefined }) {
    if (!isUlid(input.thread_id)) {
      throw new BusError('invalid_input', 'thread_id must be a message id (ULID).');
    }
    const limit = Math.min(
      input.limit ?? this.config.limits.inboxMaxLimit,
      this.config.limits.inboxMaxLimit,
    );
    const store = await this.gateway.forConnection(ctx);
    const messages = await store.threadMessages({
      connectionId: ctx.connection.id,
      threadId: input.thread_id,
      limit,
    });
    return {
      thread_id: input.thread_id,
      messages: messages.map((m) => toEnvelope(m, ctx.workspace.slug)),
    };
  }

  async policyGet(ctx: ConnectionContext) {
    const store = await this.gateway.forConnection(ctx);
    return this.describePolicy(ctx, store, await store.getPolicy(ctx.connection.id));
  }

  async policyTighten(ctx: ConnectionContext, input: PolicyTightenInput) {
    const store = await this.gateway.forConnection(ctx);
    const now = this.clock();
    if (input.mode !== undefined && input.mode !== 'allowlist') {
      throw new BusError(
        input.mode === 'all' ? 'cannot_widen' : 'invalid_input',
        input.mode === 'all'
          ? `policy_tighten can't switch to "all": that would widen your policy. ${POLICY_HUMAN_ONLY}`
          : `mode must be "allowlist" (the only mode you can switch to).`,
      );
    }
    const remove = (input.remove_connections ?? []).map((s) => s.trim().toLowerCase());
    if (input.mode === undefined && remove.length === 0) {
      throw new BusError(
        'invalid_input',
        'Pass remove_connections (connections to stop accepting messages from), mode "allowlist", or both.',
      );
    }

    const before = await store.getPolicy(ctx.connection.id);
    const connections = await store.listConnections();
    const slugOf = (id: string) => connections.find((c) => c.id === id)?.slug ?? id;
    const removedIds = before.allowedConnectionIds.filter((id) => remove.includes(slugOf(id)));
    const after = {
      mode: input.mode ?? before.mode,
      allowedConnectionIds: before.allowedConnectionIds.filter((id) => !removedIds.includes(id)),
    };
    if (isWidening(before, after)) {
      // Unreachable by construction; kept as a guard for future edits.
      throw new BusError('cannot_widen', POLICY_HUMAN_ONLY);
    }
    const changed = after.mode !== before.mode || removedIds.length > 0;
    if (changed) {
      await store.replacePolicy({
        connectionId: ctx.connection.id,
        ...after,
        event: 'policy_tightened',
        actor: 'agent',
        detail: { via: 'mcp' },
        now,
      });
    }
    const removed = removedIds.map(slugOf);
    return {
      changed,
      removed,
      not_in_allowlist: [...new Set(remove)].filter((s) => !removed.includes(s)),
      policy: await this.describePolicy(ctx, store, await store.getPolicy(ctx.connection.id)),
    };
  }

  private async describePolicy(ctx: ConnectionContext, store: WorkspaceStore, policy: Policy) {
    const connections = await store.listConnections();
    const allowed = policy.allowedConnectionIds
      .map((id) => connections.find((c) => c.id === id)?.slug ?? id)
      .sort();
    return {
      connection: ctx.connection.slug,
      mode: policy.mode,
      allowed_connections: allowed,
      summary:
        policy.mode === 'all'
          ? 'Every connection in your workspace can message you.'
          : allowed.length === 0
            ? 'Only your own connection’s handles can message you; every other connection is refused.'
            : `Only ${allowed.join(', ')} (and your own connection’s handles) can message you.`,
      how_to_change: `You can tighten this with policy_tighten (remove connections, or switch to "allowlist"). ${POLICY_HUMAN_ONLY}`,
    };
  }

  private limitsSummary() {
    const { limits, ttl } = this.config;
    return {
      send_rate_per_minute: limits.sendRatePerMin,
      max_outstanding_deliveries: limits.senderMaxOutstanding,
      max_unread_per_mailbox: limits.recipientMaxUnread,
      max_message_bytes: limits.maxMessageBytes,
      max_connections: limits.maxConnectionsPerWorkspace,
      max_workspace_bytes: limits.maxWorkspaceBytes,
      inbox_max_per_call: limits.inboxMaxLimit,
      max_handles_per_connection: limits.maxHandlesPerConnection,
      delivery_ttl: formatDuration(ttl.deliveryMs),
      max_ttl: formatDuration(ttl.maxDeliveryMs),
      history_retention: formatDuration(ttl.retentionMs),
    };
  }

  private parseTtl(raw: string | undefined): number {
    if (raw === undefined) return this.config.ttl.deliveryMs;
    let ms: number;
    try {
      ms = parseDuration(raw);
    } catch {
      throw new BusError('invalid_input', `ttl "${raw}" is not a duration. Use e.g. "6h" or "3d".`);
    }
    const max = this.config.ttl.maxDeliveryMs;
    if (ms <= 0 || ms > max) {
      throw new BusError(
        'invalid_input',
        `ttl must be more than 0 and at most ${formatDuration(max)} (MAX_DELIVERY_TTL); got "${raw}".`,
      );
    }
    return ms;
  }

  private validateContent(
    subject: string | null,
    bodyMd: string | null,
    payload: Record<string, unknown> | null,
  ): { body_bytes: number; payload_bytes: number } {
    if (bodyMd === null && payload === null) {
      throw new BusError('invalid_input', 'A message needs body_md, payload, or both.');
    }
    if (subject !== null && subject.length > MAX_SUBJECT_CHARS) {
      throw new BusError('invalid_input', `subject is limited to ${MAX_SUBJECT_CHARS} characters.`);
    }
    if (payload !== null && depthOf(payload) > MAX_PAYLOAD_DEPTH) {
      throw new BusError(
        'invalid_input',
        `payload nests more than ${MAX_PAYLOAD_DEPTH} levels deep. Flatten it.`,
      );
    }
    const sizes = {
      body_bytes: bodyMd === null ? 0 : Buffer.byteLength(bodyMd, 'utf8'),
      payload_bytes: payload === null ? 0 : Buffer.byteLength(JSON.stringify(payload), 'utf8'),
    };
    const bytes = sizes.body_bytes + sizes.payload_bytes;
    const max = this.config.limits.maxMessageBytes;
    if (bytes > max) {
      throw new BusError(
        'size',
        `Message is ${bytes} bytes; body_md plus payload is limited to ${max} bytes. Shorten it or put links in payload (attachments aren't supported).`,
      );
    }
    return sizes;
  }

  private normaliseHandle(raw: string | undefined, field: 'handle' | 'from_handle'): string {
    const handle = raw?.trim().toLowerCase() ?? '';
    if (handle === '') {
      throw new BusError(
        'handle_required',
        field === 'from_handle'
          ? 'from_handle is required: say which agent is sending, e.g. "researcher". Your human should have given you a handle; if not, pick a short role name and use it consistently.'
          : 'handle is required: every mailbox belongs to a handle. Use your own handle, e.g. inbox(handle="researcher"). Your human should have given you one; if not, pick a short role name and use it consistently.',
      );
    }
    if (!isValidSlug(handle)) {
      throw new BusError('invalid_input', `${field} "${raw ?? ''}" is invalid. Use ${SLUG_RULES}.`);
    }
    return handle;
  }

  /** Polling with a handle claims it, so others can address it (ADR 0006). */
  private async claimHandle(
    ctx: ConnectionContext,
    store: WorkspaceStore,
    handle: string,
    now: number,
  ): Promise<'exists' | 'created'> {
    const max = this.config.limits.maxHandlesPerConnection;
    const outcome = await store.claimHandle({
      connectionId: ctx.connection.id,
      name: handle,
      maxHandles: max,
      now,
    });
    if (outcome === 'limit') throw this.handleLimitError(ctx);
    if (outcome === 'archived') throw this.archivedError(ctx, handle);
    return outcome;
  }

  private archivedError(ctx: ConnectionContext, handle: string): BusError {
    return new BusError(
      'mailbox_archived',
      `The mailbox "${formatAddress(ctx.connection.slug, handle)}" was archived by a human, so no agent can use it. Only a human can restore it, in the Budd UI. Use another handle, or tell your human if you need this one.`,
    );
  }

  private handleLimitError(ctx: ConnectionContext): BusError {
    return new BusError(
      'handle_limit',
      `Connection "${ctx.connection.slug}" already uses the maximum of ${this.config.limits.maxHandlesPerConnection} handles. Reuse an existing handle (see whoami).`,
    );
  }

  /**
   * Splits an address and rejects those that can't name a recipient in the
   * sender's workspace (ADR 0003, ADR 0006).
   */
  private parse(ctx: ConnectionContext, raw: string): RecipientResult | Address {
    const parts = parseAddress(raw);
    const ws = ctx.workspace.slug;
    const [connectionSlug, handle] = parts.slice(-2) as [string, string];
    const reject = (reason: RejectionReason, detail: string): RecipientResult => ({
      to: parts.join('/'),
      status: 'rejected',
      reason,
      detail,
    });
    if (parts.length === 3 && parts[0] !== ws) {
      return reject(
        'cross_workspace',
        `"${parts[0] ?? ''}" is not your workspace ("${ws}"), and cross-workspace messaging is not supported.`,
      );
    }
    if (connectionSlug === SYSTEM_CONNECTION_SLUG) {
      return reject(
        'unknown_connection',
        `"${SYSTEM_CONNECTION_SLUG}" is Budd itself: it sends notices and can't receive messages.`,
      );
    }
    return { connectionSlug, handle };
  }

  /** Decides one recipient from what the store found for it. */
  private resolve(
    ctx: ConnectionContext,
    address: Address,
    found: RecipientState | undefined,
  ): { result: RecipientResult; connection?: Connection } {
    const { connectionSlug, handle } = address;
    const to = formatAddress(connectionSlug, handle);
    const reject = (reason: RejectionReason, detail: string) => ({
      result: { to, status: 'rejected' as const, reason, detail },
    });
    if (!found) {
      return reject(
        'unknown_connection',
        `No connection named "${connectionSlug}" in workspace "${ctx.workspace.slug}". Call list_connections to see who you can message.`,
      );
    }
    if (found.connection.status === 'blocked') {
      return reject(
        'blocked',
        `Connection "${connectionSlug}" is blocked and can't receive messages.`,
      );
    }
    if (!accepts(found.policy, ctx.connection.id)) {
      return reject(
        'policy',
        `"${connectionSlug}" doesn't accept messages from your connection ("${ctx.connection.slug}"). A human has to update ${connectionSlug}'s contact policy in the Budd UI. Agents can't change it, so don't retry; tell your human if this message matters.`,
      );
    }
    if (found.handle === 'archived') {
      return reject(
        'mailbox_archived',
        `The mailbox "${to}" was archived by a human and no longer receives messages. Don't retry; tell your human if this message matters.`,
      );
    }
    if (found.handle === 'none') {
      return reject(
        'unknown_handle',
        `No agent on "${connectionSlug}" has used the handle "${handle}" yet (a handle exists once an agent sends or polls with it). Call list_connections to see known handles.`,
      );
    }
    const maxUnread = this.config.limits.recipientMaxUnread;
    if (found.unread >= maxUnread) {
      return reject(
        'recipient_backlog',
        `${to} already has ${maxUnread} unread messages, the most a mailbox can hold. Try again after it has read some.`,
      );
    }
    return { result: { to, status: 'delivered' }, connection: found.connection };
  }
}

/** Without recursion, so a hostile depth can't overflow the stack. */
function depthOf(value: unknown): number {
  let deepest = 0;
  const pending: [unknown, number][] = [[value, 1]];
  for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
    const [node, depth] = next;
    if (typeof node !== 'object' || node === null) continue;
    deepest = Math.max(deepest, depth);
    if (deepest > MAX_PAYLOAD_DEPTH) return deepest;
    for (const child of Object.values(node)) pending.push([child, depth + 1]);
  }
  return deepest;
}

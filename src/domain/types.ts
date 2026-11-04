export interface Workspace {
  id: string;
  slug: string;
  createdAt: number;
}

export type ConnectionStatus = 'active' | 'blocked';

/**
 * How a connection signs in (ADR 0016): `app` connected itself (OAuth, or its
 * local URL); `key` was created by a human in the UI and uses an API key.
 */
export type ConnectionKind = 'app' | 'key';

export interface Connection {
  id: string;
  slug: string;
  label: string | null;
  status: ConnectionStatus;
  kind: ConnectionKind;
  createdAt: number;
  lastSeenAt: number | null;
  /** Set when a human archived it: hidden from lists, and always blocked (ADR 0011). */
  archivedAt: number | null;
  /** When a human last blocked it (archiving included). */
  blockedAt: number | null;
}

export interface Handle {
  connectionId: string;
  name: string;
  firstSeenAt: number;
  /** Set when a human archived the mailbox: it takes no mail and no agent can use it. */
  archivedAt: number | null;
}

export type MessageType = 'message' | 'notice';

export interface MessageRecord {
  id: string;
  type: MessageType;
  fromConnectionId: string;
  fromHandle: string | null;
  /** Addresses exactly as the sender wrote them (after normalisation). */
  to: string[];
  subject: string | null;
  bodyMd: string | null;
  payload: Record<string, unknown> | null;
  threadId: string;
  replyTo: string | null;
  createdAt: number;
  expiresAt: number;
}

/** A message joined with its sender's connection slug, ready to render as an envelope. */
export interface MessageView extends MessageRecord {
  fromConnectionSlug: string;
}

export type DeliveryState = 'unread' | 'read' | 'expired';

export interface DeliveryRecord {
  messageId: string;
  toConnectionId: string;
  toHandle: string;
  state: DeliveryState;
  readAt: number | null;
  expiresAt: number;
}

export type PolicyMode = 'all' | 'allowlist';

/** A connection's inbound contact policy (§9). Enforced at connection level only. */
export interface Policy {
  connectionId: string;
  mode: PolicyMode;
  /** Connection ids allowed to message this one when `mode` is `allowlist`. */
  allowedConnectionIds: string[];
}

export type AuditActor = 'agent' | 'human' | 'system';

export type AuditEventType =
  | 'connection_registered'
  | 'connection_blocked'
  | 'connection_unblocked'
  | 'connection_relabelled'
  | 'connection_archived'
  | 'connection_restored'
  | 'connection_attached'
  | 'handle_first_seen'
  | 'send'
  | 'send_refused'
  | 'send_undelivered'
  | 'inbox_read'
  | 'delivery_expired'
  | 'notice_created'
  | 'retention_purge'
  | 'audit_rotated'
  | 'policy_tightened'
  | 'policy_widened'
  | 'login'
  | 'token_issued'
  | 'token_refreshed'
  | 'token_revoked'
  | 'key_created'
  | 'key_revoked'
  | 'mailbox_archived'
  | 'mailbox_restored'
  | 'wake_up_set'
  | 'wake_up_removed';

/** One append-only audit row. Metadata only: never message bodies or payloads (§12). */
export interface AuditEntry {
  at: number;
  event: AuditEventType;
  actor: AuditActor;
  /** The connection that acted or was acted on, if any. */
  connectionId: string | null;
  detail: Record<string, unknown>;
}

export interface AuditRecord extends AuditEntry {
  id: number;
}

/** An unread delivery the sweeper has just marked expired. */
export interface ExpiredDelivery {
  messageId: string;
  messageType: MessageType;
  threadId: string;
  fromConnectionId: string;
  fromConnectionSlug: string;
  fromHandle: string | null;
  toConnectionSlug: string;
  toHandle: string;
  expiresAt: number;
}

/** A notice Budd sends to one mailbox; stored as a `notice` from the system connection. */
export interface NoticeDraft {
  id: string;
  toConnectionId: string;
  toHandle: string;
  to: string;
  subject: string;
  bodyMd: string;
  payload: Record<string, unknown>;
  threadId: string;
  replyTo: string;
  expiresAt: number;
}

/** One recipient's delivery of a message, as shown in the UI's history. */
export interface DeliveryView {
  toConnectionSlug: string;
  toHandle: string;
  state: DeliveryState;
  readAt: number | null;
  expiresAt: number;
}

export interface HistoryItem {
  message: MessageView;
  deliveries: DeliveryView[];
}

/** Unread, unexpired deliveries in one mailbox. */
export interface MailboxCount {
  connectionId: string;
  handle: string;
  unread: number;
}

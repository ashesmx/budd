import type {
  Account,
  CodeRecord,
  ConnectionKey,
  ErasedAccount,
  LocalLogin,
  LoginResult,
  OAuthClient,
  OAuthGrant,
  TokenGrant,
  Theme,
  TokenPair,
} from '../domain/auth.js';
import type {
  AuditActor,
  AuditEntry,
  AuditEventType,
  AuditRecord,
  Connection,
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
  Workspace,
} from '../domain/types.js';

/** Each workspace's caps, from the instance's configuration. */
export interface WorkspaceLimits {
  /** Connections that aren't archived (MAX_CONNECTIONS_PER_WORKSPACE). */
  maxConnections: number;
  /** Bytes of stored messages (MAX_WORKSPACE_MB). */
  maxWorkspaceBytes: number;
  /** Bytes of audit entries (MAX_AUDIT_MB). */
  maxAuditBytes: number;
  /** At `maxAuditBytes`, delete the oldest entries (AUDIT_ROTATE) instead of refusing agents. */
  rotateAudit: boolean;
}

/**
 * Thrown when an agent's action would add to an audit log that is full and
 * doesn't rotate. Nothing was changed. A human's or Budd's own entries are
 * always written: blocking a connection must never fail for want of space.
 */
export class AuditFullError extends Error {
  constructor(readonly maxBytes: number) {
    super('audit log full');
  }
}

/**
 * All database access goes through a Storage implementation. Nothing outside an
 * adapter may issue SQL, and nothing SQLite-specific may leak out of the SQLite
 * adapter. The interface is async so a networked adapter (e.g. Postgres) is a
 * drop-in swap even though the v1 SQLite adapter is synchronous underneath.
 */
export interface Storage {
  /** Open the control DB and run its migrations. */
  init(): Promise<void>;
  /** Cheap liveness probe used by /health. */
  health(): Promise<{ ok: boolean }>;
  /** Close every open database handle. */
  close(): Promise<void>;

  /**
   * Called with each audit entry as it is written, tagged with its workspace.
   * Every state change is audited, so this is how live UI updates find out
   * about changes. It may fire for a transaction that then rolls back; a
   * listener must treat it as "something may have changed", nothing more.
   */
  onAudit(listener: (workspaceId: string, entry: AuditEntry) => void): void;

  /** Instance-level data: accounts, workspace registry, memberships. */
  readonly control: ControlStore;
  /** Hosted-mode sign-in and OAuth data (control DB). */
  readonly auth: AuthStore;
  /** The operator console's data (control DB). */
  readonly console: ConsoleStore;

  /**
   * Opens (creating and migrating if needed) one workspace's database.
   *
   * @internal Only `WorkspaceGateway` may call this. An architecture test
   * enforces it; every other caller must go through the gateway.
   */
  openWorkspace(workspaceId: string): Promise<WorkspaceStore>;

  /** The bytes a workspace takes on disk, which can exceed what its limits count. */
  workspaceDiskBytes(workspaceId: string): Promise<number>;

  /**
   * Erases a workspace: its database, its memberships, OAuth grants and
   * tokens, and every account left without a workspace (returned).
   *
   * @internal Only `WorkspaceGateway` may call this, like `openWorkspace`.
   */
  eraseWorkspace(workspaceId: string): Promise<ErasedAccount[]>;
}

export interface ControlStore {
  getWorkspaceById(id: string): Promise<Workspace | undefined>;
  getWorkspaceBySlug(slug: string): Promise<Workspace | undefined>;
  /** Every workspace on the instance (used by the sweeper). */
  listWorkspaces(): Promise<Workspace[]>;
  /**
   * Creates an account (if `email` is new) and a workspace slugged from
   * `slugBase`, suffixed on collision (`alice`, `alice-2`, ...), with the
   * account as a member.
   */
  createWorkspaceForAccount(input: {
    email: string | null;
    slugBase: string;
    now: number;
  }): Promise<Workspace>;
  /** The single local-mode workspace, slugged `local`, created on first use. */
  ensureLocalWorkspace(now: number): Promise<Workspace>;
  /**
   * The workspace's 32-byte key for secrets stored encrypted in its database.
   * Never leaves the server, never shown, never in a workspace file.
   */
  workspaceSecretKey(workspaceId: string): Promise<Buffer | undefined>;
  /**
   * Stores a workspace's key (as it is, or locked with BUDD_SECRET_KEY) if the
   * stored one is still `expected` (null: none); false if it changed meanwhile.
   */
  setWorkspaceSecretKey(
    workspaceId: string,
    stored: Buffer | null,
    expected: Buffer | null,
  ): Promise<boolean>;
}

/**
 * Hosted-mode accounts, OAuth clients, grants, codes and tokens. Codes and
 * tokens are only ever stored and looked up as SHA-256 hashes.
 */
export interface AuthStore {
  /**
   * Finds the account for an OpenID Connect identity, creating it and its
   * personal workspace (slugged from `slugBase`, suffixed on collision) on
   * first sign-in.
   */
  signIn(input: {
    issuer: string;
    subject: string;
    email: string;
    /** Display name and picture URL from the provider, if it gave them. */
    name?: string | undefined;
    picture?: string | undefined;
    slugBase: string;
    now: number;
  }): Promise<LoginResult>;
  getAccount(accountId: string): Promise<Account | undefined>;
  /** Saves the account's chosen theme (Preferences). */
  setTheme(accountId: string, theme: Theme): Promise<void>;
  /** Notes when the account last signed in, for the operator console. */
  recordSignIn(accountId: string, now: number): Promise<void>;
  /** The account for an OpenID Connect identity, if it has signed in before. */
  findAccountId(issuer: string, subject: string): Promise<string | undefined>;
  listWorkspacesForAccount(accountId: string): Promise<Workspace[]>;

  createClient(client: OAuthClient): Promise<void>;
  getClient(clientId: string): Promise<OAuthClient | undefined>;

  getGrant(clientId: string, workspaceId: string): Promise<OAuthGrant | undefined>;
  /** Per connection in the workspace, the redirect URIs of every app approved for it. */
  approvedRedirectUris(workspaceId: string): Promise<Map<string, string[]>>;
  getGrantById(grantId: string): Promise<OAuthGrant | undefined>;
  createGrant(grant: OAuthGrant): Promise<void>;

  createCode(code: CodeRecord): Promise<void>;
  /**
   * Redeems a code once. A second redemption returns `reused` and revokes
   * every token issued from it (RFC 6749 §4.1.2).
   */
  redeemCode(
    codeHash: string,
    now: number,
  ): Promise<{ status: 'ok'; code: CodeRecord } | { status: 'reused' | 'invalid' }>;

  /** Stores a new access/refresh pair in token family `familyId`. */
  issueTokens(input: TokenPair & { grantId: string; familyId: string; now: number }): Promise<void>;
  /** A live (unexpired, unrevoked) access token. */
  findAccessToken(accessHash: string, now: number): Promise<TokenGrant | undefined>;
  /**
   * Exchanges a refresh token for a new pair in one transaction. Presenting a
   * refresh token that was already exchanged revokes its whole family
   * (`reused`): someone else has a copy.
   */
  rotateRefreshToken(input: {
    refreshHash: string;
    /** The authenticated client; another client's token is `invalid`. */
    clientId: string;
    next: TokenPair;
    now: number;
  }): Promise<
    | { status: 'ok'; grant: OAuthGrant }
    | { status: 'reused'; grant: OAuthGrant | undefined }
    | { status: 'invalid'; grant?: undefined }
  >;
  /**
   * Revokes the family a token belongs to, if it belongs to `clientId` (when
   * given). Returns its grant if anything was revoked.
   */
  revokeToken(tokenHash: string, now: number, clientId?: string): Promise<OAuthGrant | undefined>;
  /**
   * Revokes every token and API key for a connection (used when it is blocked,
   * archived or reclaimed). Returns how many of each were revoked.
   */
  revokeConnection(
    workspaceId: string,
    connectionId: string,
    now: number,
  ): Promise<{ tokens: number; keys: number }>;
  /**
   * Forgets every app's approval for a connection, with their codes and
   * tokens, when another app takes it over: the old app must ask again.
   * Returns how many grants there were.
   */
  deleteGrants(workspaceId: string, connectionId: string): Promise<number>;
  /**
   * The workspace's connections that some app could still use: they hold an
   * unexpired, unrevoked access token, an unused refresh token, or an
   * unexpired API key.
   */
  liveConnectionIds(workspaceId: string, now: number): Promise<string[]>;

  /**
   * Stores a new API key for a connection, revoking any key it had, in one
   * transaction (ADR 0016). Returns how many keys were revoked.
   */
  createConnectionKey(input: {
    keyHash: string;
    hint: string;
    workspaceId: string;
    connectionId: string;
    accountId: string;
    expiresAt: number;
    now: number;
  }): Promise<number>;
  /**
   * The unrevoked key with this hash, or 'expired' if it went unused until
   * its expiry. Using it moves its expiry to `idleMs` from now.
   */
  useConnectionKey(
    keyHash: string,
    now: number,
    idleMs: number,
  ): Promise<ConnectionKey | 'expired' | undefined>;
  /** A connection's unrevoked key, expired or not, if it has one whose maker is still a member. */
  getConnectionKey(workspaceId: string, connectionId: string): Promise<ConnectionKey | undefined>;

  /** Local mode: the implicit account that owns the `local` workspace, if created. */
  getLocalAccountId(): Promise<string | undefined>;
  /** Local mode: the UI login, if one has been set up. */
  getLocalLogin(): Promise<LocalLogin | undefined>;
  /** Local mode: creates or replaces the UI login. */
  setLocalLogin(login: Omit<LocalLogin, 'createdAt'> & { now: number }): Promise<void>;
  /** Local mode: stores a `budd login` link's code, and forgets expired ones. */
  createLoginLink(codeHash: string, expiresAt: number, now: number): Promise<void>;
  /** Local mode: uses up a `budd login` link; true if it was valid and unexpired. */
  redeemLoginLink(codeHash: string, now: number): Promise<boolean>;

  /**
   * Deletes expired codes and tokens, clients never authorized after
   * `staleClientsBefore`, and the oldest never-authorized clients beyond
   * `maxUnauthorizedClients` (sparing those registered after `recentClientsAfter`).
   */
  purge(input: {
    now: number;
    staleClientsBefore: number;
    maxUnauthorizedClients: number;
    recentClientsAfter: number;
  }): Promise<void>;
}

/** One workspace's storage at one moment: what counts against its limits, and the file. */
export interface UsageSample {
  messagesBytes: number;
  auditBytes: number;
  fileBytes: number;
}

export interface UsagePoint extends UsageSample {
  /** The start of the hour it was measured in. */
  hour: number;
}

/** An account as the operator console shows it: no email, name or picture. */
export interface ConsoleAccount {
  id: string;
  /** The OpenID Connect issuer it signs in with; null for local mode's login. */
  issuer: string | null;
  createdAt: number;
  lastSignInAt: number | null;
  workspaceIds: string[];
  operator: boolean;
}

/** A workspace as the operator console shows it: by ID, never by name. */
export interface ConsoleWorkspace {
  id: string;
  createdAt: number;
  /** Apps approved into it, and how many still hold a live sign-in. */
  apps: number;
  liveApps: number;
  /** API keys that still work. */
  keys: number;
  /** Its latest hourly measurement, if any. */
  usage: UsagePoint | undefined;
}

export interface ConsoleKey {
  createdAt: number;
  lastUsedAt: number | null;
  expiresAt: number;
}

export interface Operator {
  accountId: string;
  addedAt: number;
  lastSignInAt: number | null;
}

/**
 * The operator console (ADR 0022): who may open it, and what it reads. Only
 * the control database: no workspace's own data.
 */
export interface ConsoleStore {
  isOperator(accountId: string): Promise<boolean>;
  addOperator(accountId: string, now: number): Promise<void>;
  /** False if it wasn't one. */
  removeOperator(accountId: string): Promise<boolean>;
  listOperators(): Promise<Operator[]>;
  /** Stores a `budd operator` link's code and whose it is, and forgets expired ones. */
  createOperatorLink(
    codeHash: string,
    email: string,
    expiresAt: number,
    now: number,
  ): Promise<void>;
  /** The email a link still works for, without using it up; undefined if it doesn't. */
  operatorLinkEmail(codeHash: string, now: number): Promise<string | undefined>;
  /** Uses up a link; true if it was valid, unexpired and for `email`. */
  redeemOperatorLink(codeHash: string, email: string, now: number): Promise<boolean>;

  /** The hour of the latest measurement, if any. */
  lastUsageHour(): Promise<number | undefined>;
  /** Records one hour's measurements and deletes those from before `keepFrom`. */
  recordUsage(hour: number, samples: Map<string, UsageSample>, keepFrom: number): Promise<void>;
  /** A workspace's measurements from `since` on, oldest first. */
  usage(workspaceId: string, since: number): Promise<UsagePoint[]>;
  /** Messages stored by every workspace together, per hour, from `since` on. */
  totalMessages(since: number): Promise<{ hour: number; bytes: number }[]>;
  /** Each workspace's messages figure at each UTC midnight in `days`, null where none was measured. */
  dailyMessages(days: number[]): Promise<Map<string, (number | null)[]>>;

  accounts(): Promise<ConsoleAccount[]>;
  workspaces(now: number): Promise<ConsoleWorkspace[]>;
  workspace(id: string, now: number): Promise<ConsoleWorkspace | undefined>;
  /** A workspace's API keys that haven't been revoked. */
  keys(workspaceId: string): Promise<ConsoleKey[]>;
}

/** 'archived': a human archived that mailbox, so no agent may use it. */
export type HandleRegistration = 'exists' | 'created' | 'limit' | 'archived';

/** One recipient of a send, as found in the workspace. */
export interface RecipientState {
  connection: Connection;
  policy: Policy;
  /** Whether the mailbox exists, and whether a human archived it. */
  handle: 'none' | 'active' | 'archived';
  /** Unread, unexpired deliveries in the mailbox. */
  unread: number;
}

/** Everything a send is decided on, read in the transaction that stores it. */
export interface SendState {
  /** Per requested recipient, in order; undefined if there's no such connection. */
  recipients: (RecipientState | undefined)[];
  /** Unread, unexpired deliveries of messages the sender's connection sent. */
  outstanding: number;
  /** The message `replyTo` names, if the sender's connection sent or received it. */
  replyTo: MessageRecord | undefined;
  /** Whether `threadId` has a message the sender's connection sent or received. */
  threadVisible: boolean;
}

/** What to store for a send: the message (unless nothing was delivered) and its audit entry. */
export interface SendPlan {
  message?: {
    record: MessageRecord;
    deliveries: DeliveryRecord[];
    /** The sender's handle, registered if new and the connection is under `maxHandles`. */
    newHandle: { connectionId: string; name: string; maxHandles: number };
  };
  audit: AuditEntry;
}

/**
 * One workspace's data. Methods that change state write their own audit rows in
 * the same transaction, so the audit log can't miss an event that happened.
 */
export interface WorkspaceStore {
  getConnectionBySlug(slug: string): Promise<Connection | undefined>;
  getConnectionById(id: string): Promise<Connection | undefined>;
  listConnections(): Promise<Connection[]>;
  /**
   * Returns the connection with `slug`, creating it if new (audited as
   * `connection_registered`); updates last_seen_at. Every method that adds a
   * connection returns 'limit' instead if the workspace already has its
   * `maxConnections` that aren't archived.
   */
  touchConnection(slug: string, now: number): Promise<Connection | 'limit'>;
  /** Whether the workspace has its `maxConnections`, so a new one would be refused. */
  isFull(): Promise<boolean>;
  /** Bytes counted against MAX_WORKSPACE_MB (messages) and MAX_AUDIT_MB (audit). */
  storedBytes(): Promise<{ messages: number; audit: number }>;
  /**
   * Hosted mode: creates a connection slugged `slugBase`, suffixed on collision
   * (`claude`, `claude-2`, ...) and never using a slug in `reserved`. Audited as
   * `connection_registered`.
   */
  registerConnection(input: {
    slugBase: string;
    reserved: string[];
    detail: Record<string, unknown>;
    now: number;
  }): Promise<Connection | 'limit'>;
  /**
   * Hosted mode: creates a connection a human named, for an API key (ADR 0016).
   * Audited as `connection_registered`. Returns 'taken' if the name is in use
   * (archived connections included) or in `reserved`.
   */
  createKeyConnection(input: {
    slug: string;
    label: string | null;
    reserved: string[];
    now: number;
  }): Promise<Connection | 'taken' | 'limit'>;
  /** Updates last_seen_at. */
  touchConnectionById(id: string, now: number): Promise<void>;
  /**
   * Blocks or unblocks a connection. Returns false if it was already in that
   * state, or if unblocking an archived connection (restore it first).
   */
  setConnectionStatus(input: {
    connectionId: string;
    status: ConnectionStatus;
    now: number;
  }): Promise<boolean>;
  /**
   * Archives a connection (which also blocks it) or restores one (which leaves
   * it blocked). Audited as `connection_archived` / `connection_restored`.
   * Returns false if it was already in that state, and 'limit' if restoring
   * it would take the workspace over `maxConnections`.
   */
  setConnectionArchived(input: {
    connectionId: string;
    archived: boolean;
    now: number;
  }): Promise<boolean | 'limit'>;
  setConnectionLabel(input: {
    connectionId: string;
    label: string | null;
    now: number;
  }): Promise<void>;

  getPolicy(connectionId: string): Promise<Policy>;
  listPolicies(): Promise<Policy[]>;
  /**
   * Replaces a connection's policy and records `event` in the audit log with the
   * before/after policies. Callers decide whether the change is allowed.
   */
  replacePolicy(input: {
    connectionId: string;
    mode: PolicyMode;
    allowedConnectionIds: string[];
    event: 'policy_tightened' | 'policy_widened';
    actor: AuditActor;
    detail: Record<string, unknown>;
    now: number;
  }): Promise<void>;

  getHandle(connectionId: string, name: string): Promise<Handle | undefined>;
  listHandles(): Promise<Handle[]>;
  getWakeUp(connectionId: string, handle: string): Promise<WakeUpRecord | undefined>;
  listWakeUps(): Promise<WakeUpRecord[]>;
  /**
   * Saves a mailbox's wake-up, replacing any, audited as `wake_up_set` with
   * the host only. Returns false if there's no such mailbox, or it's archived.
   */
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
    /** A different address: forget where the current mail was up to, and the last result. */
    newAddress: boolean;
    now: number;
  }): Promise<boolean>;
  /** Removes a mailbox's wake-up, audited as `wake_up_removed`. False if it had none. */
  removeWakeUp(input: {
    connectionId: string;
    handle: string;
    actor: AuditActor;
    reason?: string | undefined;
    now: number;
  }): Promise<boolean>;
  /**
   * Wake-ups to send now: mailboxes with unread mail that weren't woken since
   * they were last read, and retries due for mail still unread. Never for a
   * blocked or archived connection, or an archived mailbox.
   */
  dueWakeUps(now: number, maxPerHour: number): Promise<DueWakeUp[]>;
  /** Records a wake-up's result; a first or retry also moves the batch on. A test doesn't. */
  recordWakeUp(input: {
    connectionId: string;
    handle: string;
    kind: 'first' | 'retry' | 'test';
    ok: boolean;
    status: string;
    now: number;
  }): Promise<void>;

  /** Mailboxes a connection uses: archived ones don't count. */
  countHandles(connectionId: string): Promise<number>;
  /**
   * Archives a mailbox or restores one, audited as `mailbox_archived` /
   * `mailbox_restored`. Returns false if it was already so, undefined if
   * there's no such mailbox, and 'limit' if restoring it would take the
   * connection over `maxHandles`.
   */
  setHandleArchived(input: {
    connectionId: string;
    name: string;
    archived: boolean;
    maxHandles: number;
    now: number;
  }): Promise<boolean | 'limit' | undefined>;
  /**
   * Registers a handle for a connection if it is new and the connection is
   * under `maxHandles` (audited as `handle_first_seen`). Polling with a handle
   * claims it (ADR 0006).
   */
  claimHandle(input: {
    connectionId: string;
    name: string;
    maxHandles: number;
    now: number;
  }): Promise<HandleRegistration>;

  /**
   * A send, in one transaction: reads the `SendState` for the sender's
   * connection, passes it to `decide`, and stores the plan it returns. So
   * nothing a check relied on (a policy, a backlog, a block) can change
   * between the check and the write. `decide` runs synchronously inside the
   * transaction and may throw to refuse the send, which stores nothing.
   * Returns decide's result; or, storing nothing, 'limit' if the sender's
   * handle would exceed the connection's cap, 'archived' if a human archived
   * the sender's mailbox, and 'full' if the message would take the workspace
   * over `maxMessageBytes`.
   */
  send<T>(input: {
    fromConnectionId: string;
    /** The sender's handle: refused, storing nothing, if a human archived its mailbox. */
    fromHandle: string;
    recipients: { connectionSlug: string; handle: string }[];
    replyTo: string | undefined;
    threadId: string | undefined;
    now: number;
    decide: (state: SendState) => { plan: SendPlan; result: T };
  }): Promise<T | 'limit' | 'archived' | 'full'>;

  /** Unread, unexpired deliveries in one mailbox (`connection/handle`). */
  countUnread(input: { connectionId: string; handle: string; now: number }): Promise<number>;

  /**
   * In one transaction: selects up to `limit` unread, unexpired deliveries for
   * exactly one mailbox (`connection/handle`), oldest first, marks them read at
   * `now`, and audits the read (`inbox_read`) if there were any.
   */
  consumeUnread(input: {
    connectionId: string;
    handle: string;
    limit: number;
    now: number;
  }): Promise<MessageView[]>;

  /**
   * Up to `limit` most recent messages in `threadId` that the connection sent or
   * has read (ADR 0004), returned oldest first.
   */
  threadMessages(input: {
    connectionId: string;
    threadId: string;
    limit: number;
  }): Promise<MessageView[]>;

  /**
   * In one transaction: marks every unread delivery with `expires_at <= now` as
   * expired, audits each (`delivery_expired`), and stores the notice that
   * `notice` builds for it, if any (`notice_created`), from the system
   * connection `systemSlug` (created if missing). Returns how many expired.
   */
  expireDeliveries(input: {
    now: number;
    systemSlug: string;
    notice: (expired: ExpiredDelivery) => NoticeDraft | null;
  }): Promise<number>;

  /**
   * Deletes messages created at or before `cutoff`, with their deliveries, and
   * audits the purge (`retention_purge`). Audit rows are never touched.
   */
  purgeMessages(input: { cutoff: number; now: number }): Promise<number>;
  /**
   * Deletes audit rows at or before `cutoff`. Besides this, only a full log with
   * `rotateAudit` deletes its oldest rows (audited as `audit_rotated`).
   */
  purgeAudit(cutoff: number): Promise<number>;

  appendAudit(entry: AuditEntry): Promise<void>;
  /** Most recent first; `beforeId` pages backwards. */
  listAudit(input: {
    limit: number;
    beforeId?: number | undefined;
    filter?: AuditFilter | undefined;
  }): Promise<AuditRecord[]>;
  countAudit(filter: AuditFilter): Promise<number>;

  /** Unread, unexpired deliveries per mailbox (only mailboxes with any). */
  countUnreadByMailbox(now: number): Promise<MailboxCount[]>;
  /** Every route messages took since `since`, sender mailbox to recipient mailbox. */
  messageRoutes(since: number): Promise<MessageRoute[]>;
  /** Per mailbox of one connection: what it sent and was sent since `since`, and its latest mail. */
  mailboxStats(connectionId: string, since: number, now: number): Promise<MailboxStats[]>;
  /** Messages with their deliveries, newest first; `beforeId` pages backwards. */
  listHistory(input: {
    limit: number;
    beforeId?: string | undefined;
    filter?: MessageFilter | undefined;
  }): Promise<HistoryItem[]>;
  countHistory(filter: MessageFilter): Promise<number>;
  /** Each thread's first message, with its deliveries, and how many messages the thread holds. */
  threadHeads(threadIds: string[]): Promise<{ first: HistoryItem; messages: number }[]>;
  /** When the oldest and newest audit entries were written, if there are any. */
  auditRange(): Promise<{ first: number; last: number } | undefined>;
}

/** Narrows the message history. Every field is optional; all given must match. */
export interface MessageFilter {
  /** Found in the subject or body, ignoring case for ASCII letters. */
  text?: string | undefined;
  /** Sent by or delivered to this connection. */
  connectionId?: string | undefined;
  /** Sent from or delivered to this handle (on `connectionId`, when given). */
  handle?: string | undefined;
  /** Has at least one delivery in this state. */
  state?: DeliveryState | undefined;
  type?: MessageType | undefined;
  /** Sent at or after this time. */
  since?: number | undefined;
  /** Sent at or before this time. */
  until?: number | undefined;
  threadId?: string | undefined;
}

export interface AuditFilter {
  /** One of these events. */
  events?: AuditEventType[] | undefined;
  actor?: AuditActor | undefined;
  connectionId?: string | undefined;
  /** A mailbox address, `connection/handle`, named anywhere in the entry's details. */
  mailbox?: string | undefined;
  since?: number | undefined;
  until?: number | undefined;
  /** Found in the entry's details, ignoring case for ASCII letters. */
  text?: string | undefined;
}

/** A mailbox's wake-up as stored: its address and token still sealed. */
export interface WakeUpRecord {
  connectionId: string;
  handle: string;
  urlSealed: Buffer;
  tokenSealed: Buffer | null;
  /** The HMAC secret wake-ups are signed with, if any. */
  signingSecretSealed: Buffer | null;
  host: string;
  tokenHint: string | null;
  retryIntervalMs: number;
  maxRetries: number;
  createdAt: number;
  /** The current hour's window for WAKE_UPS_PER_HOUR: when it began, and how many were sent. */
  hourStartedAt: number | null;
  hourCount: number;
  wokenAt: number | null;
  attemptAt: number | null;
  retries: number;
  lastAt: number | null;
  lastStatus: string | null;
  /** Whether the platform accepted the latest one. */
  lastOk: boolean | null;
}

/** A wake-up the sweeper should send now: the first for new mail, or a retry. */
export interface DueWakeUp extends WakeUpRecord {
  connectionSlug: string;
  kind: 'first' | 'retry';
}

export interface MessageRoute {
  fromConnectionId: string;
  fromHandle: string;
  toConnectionId: string;
  toHandle: string;
  /** Deliveries: a message to three mailboxes takes three routes. */
  messages: number;
  /** Of those, not read yet, expired included. */
  unread: number;
}

export interface MailboxStats {
  handle: string;
  /** Since the window's start. */
  sent: number;
  received: number;
  /** Received in the window and expired unread. */
  expired: number;
  /** Within retention, whatever the window. */
  lastSentAt: number | null;
  lastReceivedAt: number | null;
  lastReadAt: number | null;
  /** When its oldest mail still waiting to be read was sent. */
  oldestUnreadAt: number | null;
}

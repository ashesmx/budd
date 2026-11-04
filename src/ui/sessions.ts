import type { PolicyPreview } from '../admin/Admin.js';
import { randomToken, safeEqual } from '../auth/tokens.js';

/** An OAuth authorization request that passed validation, awaiting the human's consent. */
export interface AuthorizationRequest {
  clientId: string;
  redirectUri: string;
  state: string | undefined;
  codeChallenge: string;
  scope: string | undefined;
}

/** A change waiting for the human to confirm it in a dialog. */
export type Pending =
  | { kind: 'policy'; slug: string; preview: PolicyPreview }
  | { kind: 'unblock'; slug: string }
  | { kind: 'rotate'; slug: string }
  | { kind: 'erase'; workspaceId: string }
  | {
      kind: 'authorize';
      request: AuthorizationRequest;
      workspaceIds: string[];
      /** Connection ids the consent screen offered to attach the app to (ADR 0011). */
      attachable: string[];
      /** Set once the human chose one: the takeover page then confirms that connection only. */
      takeover?: string;
    };

export interface Session {
  id: string;
  csrf: string;
  createdAt: number;
  lastUsedAt: number;
  /** Hosted mode: the signed-in account and the workspace being viewed. */
  accountId?: string;
  workspaceId?: string;
  /** Hosted mode: a session for the operator console only, which can't open the UI (ADR 0022). */
  console?: true;
  pending: Map<string, Pending & { expiresAt: number }>;
  /** Closes each live-update stream open on this session, oldest first. */
  streams: Set<() => void>;
}

/** Hosted mode: the browser's half of an OpenID Connect sign-in in progress. */
export interface PendingLogin {
  state: string;
  nonce: string;
  codeVerifier: string;
  returnTo: string;
  /** Set when this sign-in confirms erasing a workspace: whose session, and which workspace. */
  reauth?: { sessionId: string; workspaceId: string };
  /** Set when this sign-in is for the operator console. */
  console?: true;
  expiresAt: number;
}

export const SESSION_COOKIE = 'budd_session';
/** The operator console's own session, sent only to /console (ADR 0022). */
export const CONSOLE_COOKIE = 'budd_console';
/** SameSite=Lax: it must survive the redirect back from the identity provider. */
export const LOGIN_COOKIE = 'budd_login';
const NONCE_TTL_MS = 5 * 60_000;
const LOGIN_TTL_MS = 10 * 60_000;
export const MAX_SESSIONS = 10_000;
/**
 * Each sign-in starts a session; beyond this many, the account's least
 * recently used one ends. So one account can't fill the instance-wide cap
 * and sign everyone else out.
 */
export const MAX_SESSIONS_PER_ACCOUNT = 10;
/**
 * Live-update streams: a few tabs each, so one person can't hold every socket.
 * With the cap on sessions, an account has at most 50.
 */
export const MAX_STREAMS_PER_SESSION = 5;
/** A session ends after this long unused, or this long after sign-in, whichever comes first. */
export const SESSION_IDLE_MS = 12 * 3600_000;
export const SESSION_MAX_MS = 7 * 24 * 3600_000;
/** The operator console's sessions are shorter. */
export const CONSOLE_IDLE_MS = 3600_000;
export const CONSOLE_MAX_MS = 12 * 3600_000;
/** Each costs a few hundred bytes; generous so a /login flood can't easily evict a real sign-in. */
const MAX_PENDING_LOGINS = 10_000;

/**
 * Browser sessions, in memory: a restart only loses CSRF tokens, sign-ins and
 * half-finished confirmations. Each session carries a CSRF token for every
 * form and one-time nonces for confirm dialogs.
 */
export class UiSessions {
  private readonly sessions = new Map<string, Session>();
  private readonly logins = new Map<string, PendingLogin>();

  constructor(private readonly clock: () => number = Date.now) {}

  /** The session for `id`, or a new one if `id` is missing or unknown. */
  resume(id: string | undefined): { session: Session; created: boolean } {
    const existing = this.get(id);
    if (existing) return { session: existing, created: false };
    return { session: this.create(), created: true };
  }

  get(id: string | undefined): Session | undefined {
    const session = this.live(id);
    if (session) session.lastUsedAt = this.clock();
    return session;
  }

  /** The existing session for `id` if `csrf` matches its token. */
  verify(id: string | undefined, csrf: string | undefined): Session | undefined {
    const session = this.live(id);
    if (!session || csrf === undefined || !safeEqual(session.csrf, csrf)) return undefined;
    session.lastUsedAt = this.clock();
    return session;
  }

  /** Signing in always starts a fresh session (no session fixation). */
  signIn(
    accountId: string,
    workspaceId: string | undefined,
    { console = false }: { console?: boolean } = {},
  ): Session {
    // Console and UI sessions are capped apart, so signing in to one never ends the other.
    const own = this.accountSessions(accountId)
      .filter((s) => (s.console ?? false) === console)
      .sort((a, b) => a.lastUsedAt - b.lastUsedAt);
    const excess = own.length - MAX_SESSIONS_PER_ACCOUNT + 1;
    for (const s of own.slice(0, Math.max(0, excess))) this.drop(s);
    const session = this.create();
    session.accountId = accountId;
    if (workspaceId !== undefined) session.workspaceId = workspaceId;
    if (console) session.console = true;
    return session;
  }

  end(session: Session): void {
    this.drop(session);
  }

  /** Signs these accounts out everywhere (their workspace was erased). */
  endAccounts(accountIds: string[]): void {
    for (const s of this.sessions.values()) {
      if (s.accountId !== undefined && accountIds.includes(s.accountId)) this.drop(s);
    }
  }

  /** Whether `session` is still signed in, without counting this as using it. */
  isLive(session: Session): boolean {
    return this.live(session.id) === session;
  }

  /**
   * Registers a live-update stream; `close` ends it, and runs when the session
   * ends. Over the session's cap, its oldest stream is closed. Returns the
   * function to call when the stream ends by itself.
   */
  openStream(session: Session, close: () => void): () => void {
    if (session.streams.size >= MAX_STREAMS_PER_SESSION) session.streams.values().next().value?.();
    const entry = () => {
      session.streams.delete(entry);
      close();
    };
    session.streams.add(entry);
    return () => session.streams.delete(entry);
  }

  /** Records a change awaiting confirmation; returns its one-time nonce. */
  addPending(session: Session, pending: Pending): string {
    const nonce = randomToken();
    for (const [n, p] of session.pending) {
      if (p.expiresAt <= this.clock()) session.pending.delete(n);
    }
    session.pending.set(nonce, { ...pending, expiresAt: this.clock() + NONCE_TTL_MS });
    return nonce;
  }

  /**
   * Consumes a nonce: valid once, only in the session that created it, only for
   * the kind of change it was issued for, and only before it expires.
   */
  takePending<K extends Pending['kind']>(
    session: Session,
    nonce: string | undefined,
    kind: K,
  ): Extract<Pending, { kind: K }> | undefined {
    if (nonce === undefined) return undefined;
    const pending = session.pending.get(nonce);
    session.pending.delete(nonce);
    if (!pending || pending.expiresAt <= this.clock() || pending.kind !== kind) return undefined;
    return pending as unknown as Extract<Pending, { kind: K }>;
  }

  /**
   * A change awaiting confirmation, without using up its nonce: the page that
   * shows the confirm dialog after a redirect. Only in the session that made it.
   */
  peekPending(session: Session, nonce: string | undefined): Pending | undefined {
    if (nonce === undefined) return undefined;
    const pending = session.pending.get(nonce);
    return pending && pending.expiresAt > this.clock() ? pending : undefined;
  }

  /** Starts a sign-in; returns the key for the login cookie. */
  startLogin(login: Omit<PendingLogin, 'expiresAt'>): string {
    const key = randomToken();
    for (const [k, l] of this.logins) {
      // One re-authentication per session, so a session can't fill this map.
      const replaced = login.reauth && l.reauth?.sessionId === login.reauth.sessionId;
      if (l.expiresAt <= this.clock() || replaced) this.logins.delete(k);
    }
    if (this.logins.size >= MAX_PENDING_LOGINS) {
      this.logins.delete(this.logins.keys().next().value ?? '');
    }
    this.logins.set(key, { ...login, expiresAt: this.clock() + LOGIN_TTL_MS });
    return key;
  }

  /** Consumes a pending sign-in (once). */
  takeLogin(key: string | undefined): PendingLogin | undefined {
    if (key === undefined) return undefined;
    const login = this.logins.get(key);
    this.logins.delete(key);
    return login && login.expiresAt > this.clock() ? login : undefined;
  }

  /** The session for `id` unless it has timed out (then it is forgotten). */
  private live(id: string | undefined): Session | undefined {
    const session = id === undefined ? undefined : this.sessions.get(id);
    if (!session) return undefined;
    const now = this.clock();
    const [idle, max] = session.console
      ? [CONSOLE_IDLE_MS, CONSOLE_MAX_MS]
      : [SESSION_IDLE_MS, SESSION_MAX_MS];
    if (now - session.lastUsedAt >= idle || now - session.createdAt >= max) {
      this.drop(session);
      return undefined;
    }
    return session;
  }

  private create(): Session {
    if (this.sessions.size >= MAX_SESSIONS) this.evictOldest();
    const now = this.clock();
    const session: Session = {
      id: randomToken(),
      csrf: randomToken(),
      createdAt: now,
      lastUsedAt: now,
      pending: new Map(),
      streams: new Set(),
    };
    this.sessions.set(session.id, session);
    return session;
  }

  /**
   * Makes room: timed-out sessions go first, then up to a tenth of the cap
   * in sessions nobody signed in to, least recently used first, so a flood
   * of them doesn't scan every session on each new one. Only when none is
   * anonymous does one signed-in session end, the least recently used.
   */
  private evictOldest(): void {
    for (const s of this.sessions.values()) this.live(s.id);
    if (this.sessions.size < MAX_SESSIONS) return;
    const byAge = (a: Session, b: Session) => a.lastUsedAt - b.lastUsedAt;
    const all = [...this.sessions.values()];
    const anonymous = all.filter((s) => s.accountId === undefined).sort(byAge);
    const evict =
      anonymous.length > 0 ? anonymous.slice(0, MAX_SESSIONS / 10) : all.sort(byAge).slice(0, 1);
    for (const s of evict) this.drop(s);
  }

  private accountSessions(accountId: string): Session[] {
    return [...this.sessions.values()].filter((s) => s.accountId === accountId);
  }

  /** Forgets a session and closes its live-update streams. */
  private drop(session: Session): void {
    this.sessions.delete(session.id);
    for (const close of [...session.streams]) close();
  }
}

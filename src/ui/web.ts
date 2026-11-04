import type { Context, MiddlewareHandler } from 'hono';
import { TokenBucketRateLimiter } from '../ratelimit/TokenBucketRateLimiter.js';
import { messagePage } from './authPages.js';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import type { Config } from '../config.js';
import {
  CONSOLE_COOKIE,
  LOGIN_COOKIE,
  MAX_SESSIONS,
  SESSION_COOKIE,
  UiSessions,
  type Session,
} from './sessions.js';

/** Images from Budd only, plus (on a signed-in page) the origin of the person's own picture. */
export const csp = (pictureOrigin?: string) =>
  `default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'${
    pictureOrigin ? ` ${pictureOrigin}` : ''
  }; form-action 'self'; frame-ancestors 'none'; base-uri 'none'`;

export const SECURITY_HEADERS: Record<string, string> = {
  'Content-Security-Policy': csp(),
  'X-Frame-Options': 'DENY',
  'X-Content-Type-Options': 'nosniff',
  // Not "no-referrer": with that policy browsers send `Origin: null` on form
  // POSTs, which the same-origin check (rightly) refuses. "same-origin" still
  // leaks nothing to other sites.
  'Referrer-Policy': 'same-origin',
  'Cache-Control': 'no-store',
};

export const securityHeaders: MiddlewareHandler = async (c, next) => {
  await next();
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) {
    if (!c.res.headers.has(k)) c.header(k, v); // a route may tighten or adjust its own
  }
};

/**
 * Browser plumbing shared by the UI, sign-in and OAuth consent: sessions,
 * cookies, and the checks every form POST must pass.
 */
export class Web {
  readonly sessions: UiSessions;
  /** Over HTTPS cookies get the `__Host-` prefix: Secure, path=/, no domain. */
  private readonly secure: boolean;

  constructor(
    readonly config: Config,
    clock: () => number,
  ) {
    this.sessions = new UiSessions(clock);
    this.secure = config.hosted?.publicUrl.startsWith('https:') ?? false;
  }

  get hosted(): boolean {
    return this.config.mode === 'hosted';
  }

  private name(base: string): string {
    return this.secure ? `__Host-${base}` : base;
  }

  /** The browser's origin as users see it (PUBLIC_URL in hosted mode, behind a tunnel). */
  selfOrigin(c: Context): string {
    return this.config.hosted?.publicUrl ?? new URL(c.req.url).origin;
  }

  /** The address an AI app connects to; in local mode `<name>` stands for a name you choose. */
  mcpUrl(c: Context): string {
    return `${this.selfOrigin(c)}/mcp${this.hosted ? '' : '/<name>'}`;
  }

  /** The UI's session, never the console's. */
  current(c: Context): Session | undefined {
    const session = this.sessions.get(getCookie(c, this.name(SESSION_COOKIE)));
    return session?.console ? undefined : session;
  }

  /**
   * The operator console's session: its own in hosted mode (ADR 0022), the
   * UI's in local mode, where the one login is the operator.
   */
  consoleSession(c: Context): Session | undefined {
    if (!this.hosted) return this.current(c);
    const session = this.sessions.get(getCookie(c, this.consoleCookie));
    return session?.console ? session : undefined;
  }

  /**
   * Path=/ for the `__Host-` prefix, which no other host can set: the cookie
   * paths aren't what keeps the two sessions apart, the `console` flag is.
   */
  private get consoleCookie(): string {
    return this.name(CONSOLE_COOKIE);
  }

  setConsoleSession(c: Context, session: Session): void {
    setCookie(c, this.consoleCookie, session.id, {
      httpOnly: true,
      sameSite: 'Strict',
      path: '/',
      secure: this.secure,
    });
  }

  /** Ends the console's session, if this browser has one, and its cookie. */
  endConsoleSession(c: Context): void {
    const session = this.sessions.get(getCookie(c, this.consoleCookie));
    if (session?.console) this.sessions.end(session);
    deleteCookie(c, this.consoleCookie, { path: '/', secure: this.secure });
  }

  /** The session for a page view, created (and its cookie set) if needed. */
  pageSession(c: Context): Session {
    const { session, created } = this.sessions.resume(getCookie(c, this.name(SESSION_COOKIE)));
    if (created) this.setSession(c, session);
    return session;
  }

  setSession(c: Context, session: Session): void {
    setCookie(c, this.name(SESSION_COOKIE), session.id, {
      httpOnly: true,
      sameSite: 'Strict',
      path: '/',
      secure: this.secure,
    });
  }

  clearSession(c: Context): void {
    deleteCookie(c, this.name(SESSION_COOKIE), { path: '/', secure: this.secure });
  }

  setLoginCookie(c: Context, key: string): void {
    setCookie(c, this.name(LOGIN_COOKIE), key, {
      httpOnly: true,
      sameSite: 'Lax',
      path: '/',
      secure: this.secure,
      maxAge: 600,
    });
  }

  takeLoginCookie(c: Context): string | undefined {
    const key = getCookie(c, this.name(LOGIN_COOKIE));
    deleteCookie(c, this.name(LOGIN_COOKIE), { path: '/', secure: this.secure });
    return key;
  }

  /**
   * Every form POST needs the session cookie, that session's CSRF token, and,
   * if the browser sends an Origin, exactly Budd's own origin. SameSite alone
   * isn't enough: a page on another localhost port counts as same-site.
   */
  verifiedPost(c: Context) {
    return this.verifiedFrom(c, this.name(SESSION_COOKIE), false);
  }

  /** As verifiedPost, for the operator console's forms and its session. */
  verifiedConsolePost(c: Context) {
    return this.hosted ? this.verifiedFrom(c, this.consoleCookie, true) : this.verifiedPost(c);
  }

  private async verifiedFrom(
    c: Context,
    cookie: string,
    console: boolean,
  ): Promise<{ session: Session; form: Record<string, unknown> } | undefined> {
    const origin = c.req.header('origin');
    if (origin !== undefined && origin !== this.selfOrigin(c)) return undefined;
    const form = await c.req.parseBody({ all: true });
    const csrf = typeof form._csrf === 'string' ? form._csrf : undefined;
    const session = this.sessions.verify(getCookie(c, cookie), csrf);
    return session && (session.console ?? false) === console ? { session, form } : undefined;
  }

  /** The operator console, to an account that isn't an operator (ADR 0022). */
  notAnOperator(c: Context) {
    return c.text(
      'Refused: this account isn’t an operator of this Budd. Operators are added with the budd command on the server.\n',
      403,
    );
  }

  refused(c: Context) {
    return c.text(
      'Refused: this form’s security check failed. Reload the Budd page and try again.\n',
      403,
    );
  }
}

/**
 * Only same-site paths are valid places to return to after signing in. The
 * path is parsed the way a browser would: tabs and newlines are dropped,
 * backslashes become slashes and dot-segments resolve, so `/\t/evil.example`
 * and `/..//evil.example` both become `//evil.example`. The result must stay on
 * Budd's origin and must not start with `//` (a protocol-relative URL).
 */
export function safeReturnPath(raw: string | undefined, fallback = '/ui'): string {
  if (raw === undefined || !raw.startsWith('/')) return fallback;
  const base = 'http://budd.invalid';
  const url = URL.parse(raw, base);
  return url?.origin === base && !url.pathname.startsWith('//')
    ? url.pathname + url.search
    : fallback;
}

/**
 * Per browser session, so one signed-in person (or a script with their
 * cookie) can't keep the instance busy. Without a session a request only
 * redirects to sign-in or is refused, which costs next to nothing.
 */
export function limitPerSession(
  perMin: number,
  clock: () => number,
  sessionOf: (c: Context) => Session | undefined,
): MiddlewareHandler {
  const buckets = new TokenBucketRateLimiter(perMin, 60_000, MAX_SESSIONS);
  return async (c, next) => {
    const session = sessionOf(c);
    if (session && !buckets.tryConsume(session.id, clock())) {
      c.header('Retry-After', '60');
      return c.html(
        messagePage(
          'Too many requests',
          'Nothing changed. Budd is slowing this browser down for a minute: wait, then open the page again.',
        ),
        429,
      );
    }
    return next();
  };
}

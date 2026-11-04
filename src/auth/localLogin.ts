import type { Context, Hono } from 'hono';
import { html } from 'hono/html';
import { durationInWords } from '../config.js';
import { LOGIN_LINK_TTL_MS } from '../domain/auth.js';
import { log } from '../log.js';
import { TokenBucketRateLimiter } from '../ratelimit/TokenBucketRateLimiter.js';
import type { AuthStore } from '../storage/Storage.js';
import {
  localLoginPage,
  loginLinkPage,
  messagePage,
  setupPage,
  type LoginError,
} from '../ui/authPages.js';
import { safeReturnPath, securityHeaders, type Web } from '../ui/web.js';
import { mountLogout } from './logout.js';
import { hashPassword, MIN_PASSWORD_LENGTH, verifyPassword } from './password.js';
import { hashToken, randomToken, safeEqual } from './tokens.js';

/** Password attempts allowed per minute (instance-wide), to slow guessing. */
const LOGIN_ATTEMPTS_PER_MIN = 10;

/**
 * Local mode's UI login (ADR 0010). Until a login exists, Budd prints a
 * one-time setup link at startup; afterwards every UI page needs the username
 * and password.
 */
export class LocalLoginState {
  /** The current setup code, if no login exists yet. Printed in the startup banner. */
  setupCode: string | undefined;
  /** Password attempts, shared by signing in and confirming an erase, so each can't add to the other. */
  readonly passwordAttempts = new TokenBucketRateLimiter(LOGIN_ATTEMPTS_PER_MIN, 60_000);

  async init(auth: AuthStore): Promise<void> {
    this.setupCode = (await auth.getLocalLogin()) ? undefined : randomToken();
  }

  /** After the workspace and its login are erased: a new setup code. */
  restart(): void {
    this.setupCode = randomToken();
  }

  /** The one-time link to create the login, if none exists yet. */
  setupUrl(origin: string): string | undefined {
    return this.setupCode === undefined ? undefined : `${origin}/setup?code=${this.setupCode}`;
  }
}

export function mountLocalLogin(
  app: Hono,
  deps: { auth: AuthStore; web: Web; state: LocalLoginState; clock: () => number },
): void {
  const { auth, web, state, clock } = deps;

  for (const path of ['/setup', '/login', '/login/link', '/logout']) {
    app.use(path, securityHeaders);
  }

  const signInAs = async (c: Context, returnTo: string) => {
    const accountId = await auth.getLocalAccountId();
    if (!accountId) throw new Error('local account missing');
    await auth.recordSignIn(accountId, clock());
    const session = web.sessions.signIn(accountId, undefined);
    web.setSession(c, session);
    return c.redirect(returnTo, 303);
  };

  const noSetup = (c: Context) =>
    c.html(
      state.setupCode === undefined
        ? messagePage('Setup link not valid', 'Budd already has a login. Sign in with it.', {
            href: '/login',
            label: 'Sign in',
          })
        : messagePage(
            'Setup link not valid',
            'This setup link is out of date. Use the newest link printed when Budd started.',
          ),
      400,
    );

  app.get('/setup', (c) => {
    const code = c.req.query('code');
    if (state.setupCode === undefined || code === undefined || !safeEqual(code, state.setupCode)) {
      return noSetup(c);
    }
    return c.html(setupPage({ code, csrf: web.pageSession(c).csrf }));
  });

  app.post('/setup', async (c) => {
    const verified = await web.verifiedPost(c);
    if (!verified) return web.refused(c);
    const { form, session } = verified;
    const code = typeof form.code === 'string' ? form.code : '';
    if (state.setupCode === undefined || !safeEqual(code, state.setupCode)) return noSetup(c);
    const username = typeof form.username === 'string' ? form.username.trim() : '';
    const password = typeof form.password === 'string' ? form.password : '';
    const confirm = typeof form.confirm === 'string' ? form.confirm : '';
    const error =
      username.length === 0 || username.length > 64
        ? 'Choose a username (up to 64 characters).'
        : password.length < MIN_PASSWORD_LENGTH
          ? `The password must be at least ${String(MIN_PASSWORD_LENGTH)} characters.`
          : password !== confirm
            ? 'The two passwords don’t match.'
            : undefined;
    if (error) {
      // An unusable username comes back empty, so the focus lands on it.
      const keep = username.length > 64 ? '' : username;
      return c.html(setupPage({ code, csrf: session.csrf, error, username: keep }), 400);
    }
    const accountId = await auth.getLocalAccountId();
    if (!accountId) throw new Error('local account missing');
    await auth.setLocalLogin({
      accountId,
      username,
      passwordHash: await hashPassword(password),
      now: clock(),
    });
    state.setupCode = undefined; // single use
    log.info('local UI login created', { username });
    return signInAs(c, '/ui');
  });

  app.get('/login', async (c) => {
    const returnTo = safeReturnPath(c.req.query('return'));
    if (web.current(c)?.accountId !== undefined) return c.redirect(returnTo, 302);
    if (!(await auth.getLocalLogin())) {
      return c.html(
        messagePage(
          'Create your login first',
          'Budd has no login yet. Open the setup link printed in the terminal where Budd is running.',
        ),
      );
    }
    return c.html(
      localLoginPage({ csrf: web.pageSession(c).csrf, returnTo, mcpUrl: web.mcpUrl(c) }),
    );
  });

  app.post('/login', async (c) => {
    const verified = await web.verifiedPost(c);
    if (!verified) return web.refused(c);
    const { form, session } = verified;
    const returnTo = safeReturnPath(typeof form.return === 'string' ? form.return : undefined);
    const username = typeof form.username === 'string' ? form.username.trim() : '';
    const retry = (error: LoginError, status: 401 | 429) =>
      c.html(
        localLoginPage({ csrf: session.csrf, returnTo, mcpUrl: web.mcpUrl(c), error, username }),
        status,
      );
    if (!state.passwordAttempts.tryConsume('password', clock())) {
      return retry(LOCKED_OUT, 429);
    }
    const login = await auth.getLocalLogin();
    const password = typeof form.password === 'string' ? form.password : '';
    // Always run the hash, so a wrong username takes as long as a wrong password.
    const ok = await verifyPassword(password, login?.passwordHash ?? 'scrypt$16384$8$1$AA$AA');
    if (!login || !ok || !safeEqual(username, login.username)) {
      return retry({ lead: 'Wrong username or password.' }, 401);
    }
    web.sessions.end(session);
    return signInAs(c, returnTo);
  });

  // `budd login` prints a one-time link here. It isn't limited like passwords
  // are: the code is random, and anything that can run the CLI can read the
  // data directory anyway.
  app.get('/login/link', (c) => {
    const code = c.req.query('code');
    if (code === undefined) return badLink(c);
    return c.html(
      loginLinkPage({
        code,
        csrf: web.pageSession(c).csrf,
        validFor: durationInWords(LOGIN_LINK_TTL_MS),
      }),
    );
  });

  app.post('/login/link', async (c) => {
    const verified = await web.verifiedPost(c);
    if (!verified) return web.refused(c);
    const code = typeof verified.form.code === 'string' ? verified.form.code : '';
    if (!(await auth.redeemLoginLink(hashToken(code), clock()))) return badLink(c);
    log.info('signed in with a budd login link');
    web.sessions.end(verified.session);
    return signInAs(c, '/ui');
  });

  mountLogout(app, web);
}

const LOCKED_OUT: LoginError = {
  lead: 'Too many sign-in attempts. Nothing changed.',
  detail: html`Wait a minute and try again. If it keeps happening, run these in the Budd folder:`,
  list: [
    html`<code class="cmd">npm run budd -- login</code>: a one-time sign-in link`,
    html`<code class="cmd">npm run budd -- connections</code>: your connections, and when each was
      last active`,
    html`<code class="cmd">npm run budd -- block &lt;name&gt;</code>: cuts one off from Budd`,
  ],
  after: 'Something on this computer is trying passwords: find the program and stop it.',
};

const badLink = (c: Context) =>
  c.html(
    messagePage(
      'Sign-in link not valid',
      html`It expired (links work for ${durationInWords(LOGIN_LINK_TTL_MS)}) or was already used.
        For a new one, run <code class="cmd">npm run budd -- login</code> in the Budd folder.`,
      { href: '/login', label: 'Sign in with your password' },
    ),
    400,
  );

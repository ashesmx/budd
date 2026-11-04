import type { Context, Hono } from 'hono';
import { html } from 'hono/html';
import { ulid } from 'ulid';
import { isLoopbackHost, type Config } from '../config.js';
import { SYSTEM_CONNECTION_SLUG } from '../domain/slug.js';
import type { Connection } from '../domain/types.js';
import { clip, log, throttledLog } from '../log.js';
import { GatewayError, type AdminContext, type WorkspaceGateway } from '../storage/gateway.js';
import type { AuthStore, ConsoleStore } from '../storage/Storage.js';
import {
  connectionLimitPage,
  consentPage,
  continuePage,
  landingPage,
  messagePage,
  notConnectedPage,
  takeoverPage,
  type Resume,
} from '../ui/authPages.js';
import { connectionUrl } from '../ui/html.js';
import { ERASE_EXPIRED, eraseWorkspace } from '../ui/erase.js';
import type { AuthorizationRequest, PendingLogin } from '../ui/sessions.js';
import { safeReturnPath, securityHeaders, type Web } from '../ui/web.js';
import {
  CODE_TTL_MS,
  isOurResource,
  redirectHost,
  redirectUriAllowed,
  sameRedirectTarget,
} from './oauth.js';
import { OidcError, type OidcClient, type OidcIdentity } from './oidc.js';
import { mountLogout } from './logout.js';
import { hashToken, newToken, pkceChallenge, randomToken, safeEqual } from './tokens.js';

/** How long ago the person may have signed in at the provider to confirm erasing a workspace. */
const REAUTH_WINDOW_MS = 5 * 60_000;
/** How long after a human blocks a connection an app may take it over (ADR 0011). */
const TAKEOVER_WINDOW_MS = 60 * 60_000;

export interface BrowserAuthDeps {
  config: Config;
  auth: AuthStore;
  /** Who may sign in to the operator console. */
  operators: ConsoleStore;
  gateway: WorkspaceGateway;
  oidc: OidcClient;
  web: Web;
  clock: () => number;
}

/**
 * Hosted mode, in the browser: human sign-in through the identity provider,
 * sign-out, and the OAuth consent screen that turns an MCP client into a
 * connection (§5).
 */
export function mountBrowserAuth(app: Hono, deps: BrowserAuthDeps): void {
  const { config, auth, operators, gateway, oidc, web, clock } = deps;
  const publicUrl = config.hosted?.publicUrl ?? '';
  const logRefusal = throttledLog(60, clock);

  for (const path of [
    '/login',
    '/auth/*',
    '/logout',
    '/authorize',
    '/ui/erase/reauth',
    '/console/login',
  ]) {
    app.use(path, securityHeaders);
  }

  /**
   * Sends the browser to the identity provider. A sign-in always starts from a
   * form POST, so it moves on with a page, not a redirect: the form's CSP
   * (form-action 'self') would block a redirect to the provider. A sign-in
   * that confirms erasing a workspace (`reauth`) asks the provider to
   * authenticate afresh.
   */
  const startSignIn = async (
    c: Context,
    returnTo: string,
    purpose: Pick<PendingLogin, 'reauth' | 'console'> = {},
  ) => {
    const { reauth } = purpose;
    const state = randomToken();
    const nonce = randomToken();
    const codeVerifier = randomToken();
    web.setLoginCookie(
      c,
      web.sessions.startLogin({ state, nonce, codeVerifier, returnTo, ...purpose }),
    );
    try {
      const url = await oidc.authorizationUrl({
        state,
        nonce,
        codeChallenge: pkceChallenge(codeVerifier),
        reauthenticate: reauth !== undefined,
      });
      return await c.html(
        continuePage({
          to: url,
          title: reauth ? 'Sign in again' : 'Signing in',
          message: 'Taking you to sign in…',
        }),
      );
    } catch (err) {
      log.error('sign-in provider unavailable', { error: String(err) });
      return c.html(
        messagePage(
          'Sign-in unavailable',
          'Budd could not reach the sign-in provider. Try again shortly.',
          { href: `/login?return=${encodeURIComponent(returnTo)}`, label: 'Try again' },
        ),
        503,
      );
    }
  };

  /**
   * Signing in. A browser arriving from another site (an MCP client, a link)
   * doesn't send Budd's SameSite=Strict cookie, so the first visit bounces once
   * through Budd's own origin to see whether it is signed in. Someone who isn't
   * sees the landing page, whose button starts the sign-in.
   */
  app.get('/login', async (c) => {
    const returnTo = safeReturnPath(c.req.query('return'));
    if (web.current(c)?.accountId !== undefined) return c.redirect(returnTo, 302);
    if (c.req.query('bounced') === undefined) {
      return c.html(
        continuePage({
          to: `/login?return=${encodeURIComponent(returnTo)}&bounced=1`,
          title: 'Signing in',
          message: 'Checking whether you’re signed in…',
        }),
      );
    }
    return c.html(
      landingPage({
        returnTo,
        providerHost: await oidc.signInHost(),
        domain: oidc.soleDomain,
        mcpUrl: web.mcpUrl(c),
        forApp: new URL(returnTo, publicUrl).pathname === '/authorize',
      }),
    );
  });

  /**
   * Only a click on Budd's own page starts a sign-in. A link or a page on
   * another site could otherwise sign someone in over and over with their live
   * provider session, and each new session signs out their oldest elsewhere.
   * There's no session yet to carry a CSRF token, so the browser's Origin (or
   * Sec-Fetch-Site) must say the form is Budd's.
   */
  const fromOwnPage = (c: Context) => {
    const sameOrigin =
      c.req.header('origin') === web.selfOrigin(c) ||
      c.req.header('sec-fetch-site') === 'same-origin';
    if (!sameOrigin) {
      // Also what someone sees who opens Budd at an address other than PUBLIC_URL.
      logRefusal('warn', 'sign-in refused', {
        reason: 'not from Budd’s own page',
        origin: clip(c.req.header('origin') ?? 'none'),
      });
    }
    return sameOrigin;
  };

  app.post('/login', async (c) => {
    if (!fromOwnPage(c)) return web.refused(c);
    const form = await c.req.parseBody();
    const returnTo = safeReturnPath(typeof form.return === 'string' ? form.return : undefined);
    if (web.current(c)?.accountId !== undefined) {
      return c.html(continuePage({ to: returnTo, title: 'Signed in', message: 'Taking you on…' }));
    }
    return startSignIn(c, returnTo);
  });

  /** The operator console's own sign-in (ADR 0022), from its sign-in page. */
  app.post('/console/login', async (c) => {
    if (!fromOwnPage(c)) return web.refused(c);
    const form = await c.req.parseBody();
    const returnTo = safeReturnPath(
      typeof form.return === 'string' ? form.return : undefined,
      '/console',
    );
    return startSignIn(c, returnTo.startsWith('/console') ? returnTo : '/console', {
      console: true,
    });
  });

  /** The identity provider sends the browser back here. */
  app.get('/auth/callback', async (c) => {
    const pending = web.sessions.takeLogin(web.takeLoginCookie(c));
    const state = c.req.query('state');
    const code = c.req.query('code');
    const retry = { href: '/login', label: 'Sign in again' };
    if (!pending || state === undefined || !safeEqual(state, pending.state)) {
      return c.html(
        messagePage('Sign-in expired', 'That sign-in link is no longer valid.', retry),
        400,
      );
    }
    if (code === undefined) {
      return c.html(messagePage('Sign-in cancelled', 'You didn’t finish signing in.', retry), 400);
    }
    let identity;
    try {
      identity = await oidc.finish({
        code,
        codeVerifier: pending.codeVerifier,
        nonce: pending.nonce,
      });
    } catch (err) {
      if (!(err instanceof OidcError)) throw err;
      logRefusal('warn', 'sign-in refused', { reason: err.code });
      const status = err.code === 'provider_unavailable' ? 503 : 403;
      return c.html(
        messagePage('Couldn’t sign you in', err.message, {
          href: '/login',
          label: 'Try a different account',
        }),
        status,
      );
    }
    if (pending.reauth) return finishErase(c, pending.reauth, identity);
    if (pending.console) return finishConsoleSignIn(c, pending.returnTo, identity);
    const now = clock();
    const result = await auth.signIn({
      issuer: identity.issuer,
      subject: identity.subject,
      email: identity.email,
      name: identity.name,
      picture: identity.picture,
      slugBase: identity.email.split('@')[0] ?? 'workspace',
      now,
    });
    // ADR 0005: a login is audited in every workspace the account belongs to.
    for (const w of result.workspaces) {
      await gateway.appendSystemAudit(w.id, {
        at: now,
        event: 'login',
        actor: 'human',
        connectionId: null,
        detail: { email: identity.email, new_account: result.created },
      });
    }
    await auth.recordSignIn(result.account.id, now);
    log.info('signed in', { email: identity.email, new_account: result.created });
    const session = web.sessions.signIn(result.account.id, result.workspaces[0]?.id);
    web.setSession(c, session);
    return c.html(
      continuePage({ to: pending.returnTo, title: 'Signed in', message: 'Taking you on…' }),
    );
  });

  mountLogout(app, web);

  /** Only an operator's account gets a console session; it can't open the UI. */
  const finishConsoleSignIn = async (c: Context, returnTo: string, identity: OidcIdentity) => {
    const accountId = await auth.findAccountId(identity.issuer, identity.subject);
    if (accountId === undefined || !(await operators.isOperator(accountId))) {
      logRefusal('warn', 'console sign-in refused', {
        reason: accountId === undefined ? 'no account' : 'not an operator',
        account_id: accountId,
      });
      return web.notAnOperator(c);
    }
    await auth.recordSignIn(accountId, clock());
    log.info('signed in to the console', { account_id: accountId });
    const session = web.sessions.signIn(accountId, undefined, { console: true });
    web.setConsoleSession(c, session);
    return c.html(
      continuePage({ to: returnTo, title: 'Signed in', message: 'Opening the console…' }),
    );
  };

  // ---- Erasing a workspace (step 2, hosted mode): prove it's really them by signing in again.

  app.post('/ui/erase/reauth', async (c) => {
    const verified = await web.verifiedPost(c);
    if (!verified) return web.refused(c);
    const { session, form } = verified;
    const nonce = typeof form.nonce === 'string' ? form.nonce : undefined;
    const pending = web.sessions.takePending(session, nonce, 'erase');
    if (!pending || session.accountId === undefined) {
      return c.redirect('/ui/erase?error=confirm_failed', 303);
    }
    // The pending sign-in carries the confirmation from here: used once, and
    // bound to this browser by its cookie and state.
    return startSignIn(c, '/ui', {
      reauth: { sessionId: session.id, workspaceId: pending.workspaceId },
    });
  });

  const finishErase = async (
    c: Context,
    reauth: NonNullable<PendingLogin['reauth']>,
    identity: OidcIdentity,
  ) => {
    const refuse = (reason: string, title: string, message: string) => {
      logRefusal('warn', 'workspace erase refused', { reason });
      return c.html(
        messagePage(title, message, {
          href: '/ui/erase',
          label: 'Start again',
        }),
        403,
      );
    };
    const session = web.sessions.get(reauth.sessionId);
    if (session?.accountId === undefined) {
      return refuse('expired', 'Confirmation expired', ERASE_EXPIRED);
    }
    if ((await auth.findAccountId(identity.issuer, identity.subject)) !== session.accountId) {
      return refuse(
        'other_account',
        'A different account',
        'You signed in as a different account from the one whose workspace you were deleting. Nothing was deleted.',
      );
    }
    // Providers may ignore the request to sign in again; auth_time shows whether they did.
    if (identity.authTime === undefined || identity.authTime < clock() - REAUTH_WINDOW_MS) {
      return refuse(
        'not_reauthenticated',
        'Sign in again first',
        'Your sign-in provider let you through without signing in again, so Budd can’t be sure it’s you. Nothing was deleted. Sign out at your provider (for example, sign out of your Google account), then start again.',
      );
    }
    let ctx: AdminContext;
    try {
      ctx = await gateway.adminForAccount(session.accountId, reauth.workspaceId);
    } catch (err) {
      if (err instanceof GatewayError) {
        return refuse('not_a_member', 'Workspace gone', `${err.message} Nothing was deleted.`);
      }
      throw err;
    }
    await eraseWorkspace(gateway, web, ctx);
    web.clearSession(c);
    return c.html(
      messagePage(
        'Workspace deleted',
        'Your workspace, everything in it and your Budd account are gone, and every app connected to it is signed out. Signing in again starts a new, empty workspace.',
        { href: '/login', label: 'Sign in' },
      ),
    );
  };

  // ---- OAuth authorization endpoint: validate, sign in, ask for consent.

  /** Shown in the browser: never redirect to a URI we haven't verified. */
  const badRequest = (c: Context, message: string, fields?: Record<string, unknown>) => {
    logRefusal('warn', 'authorize refused', { ...fields, reason: message });
    return c.html(messagePage('Can’t connect this app', message), 400);
  };

  /** Where the client hears the human's decision. */
  const clientUrl = (redirectUri: string, params: Record<string, string | undefined>) => {
    const url = new URL(redirectUri);
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined) url.searchParams.set(k, v);
    }
    url.searchParams.set('iss', publicUrl); // RFC 9207: mix-up attack defence
    return url;
  };

  /** After the human's decision, a page (not a redirect, ADR 0014) takes the browser back to the client. */
  const returnToClient = (c: Context, url: URL, outcome = '') => {
    const to = url.toString();
    const host = redirectHost(url);
    // An app-specific scheme opens the app and leaves this page on screen.
    return c.html(
      ['http:', 'https:'].includes(url.protocol)
        ? continuePage({
            to,
            title: 'Returning to the app',
            message: html`${outcome} Returning you to <code>${host}</code>…`,
          })
        : continuePage({
            to,
            title: 'Opening the app',
            message: html`${outcome} Budd is sending you back to the app (<code>${host}</code>). If
            your browser asks, choose to open it. Once the app is open, you can close this tab.`,
            link: { lead: 'Nothing happened?', label: 'Open the app' },
          }),
    );
  };

  app.get('/authorize', async (c) => {
    const q = c.req.query();
    const client = q.client_id === undefined ? undefined : await auth.getClient(q.client_id);
    if (!client) {
      return badRequest(c, 'This app isn’t registered with Budd. Ask it to connect again.', {
        client_id: clip(q.client_id),
      });
    }
    const redirectUri =
      q.redirect_uri ?? (client.redirectUris.length === 1 ? client.redirectUris[0] : undefined);
    if (redirectUri === undefined || !redirectUriAllowed(client.redirectUris, redirectUri)) {
      return badRequest(c, 'This app asked to return to an address it didn’t register.', {
        client_id: client.clientId,
        redirect_uri: clip(redirectUri, 200),
      });
    }
    // Registration is open, so a registered redirect URI proves nothing: until a
    // human has acted on the consent screen, errors are shown here rather than
    // redirected, or Budd would be an open redirector (RFC 9700 §4.11.2).
    const fail = (error: string, description: string) =>
      badRequest(c, `${description} (${error})`, { client_id: client.clientId });
    if (q.response_type !== 'code')
      return fail('unsupported_response_type', 'Use response_type=code.');
    if (
      q.code_challenge === undefined ||
      !/^[A-Za-z0-9_-]{43,128}$/.test(q.code_challenge) ||
      q.code_challenge_method !== 'S256'
    ) {
      return fail('invalid_request', 'PKCE with code_challenge_method=S256 is required.');
    }
    if (q.resource !== undefined && !isOurResource(q.resource, publicUrl)) {
      return fail('invalid_target', 'This server only authorizes access to its own MCP endpoint.');
    }

    const session = web.current(c);
    if (session?.accountId === undefined) {
      const url = new URL(c.req.url);
      return c.redirect(`/login?return=${encodeURIComponent(url.pathname + url.search)}`, 302);
    }
    const account = await auth.getAccount(session.accountId);
    const workspaces = await auth.listWorkspacesForAccount(session.accountId);
    if (!account || workspaces.length === 0) return badRequest(c, 'Your account has no workspace.');

    const request: AuthorizationRequest = {
      clientId: client.clientId,
      redirectUri,
      state: q.state,
      codeChallenge: q.code_challenge,
      scope: q.scope,
    };
    const connections = new Map<string, string | undefined>();
    let attachable: Connection[] = [];
    let resume: Resume | undefined;
    let full = false;
    for (const w of workspaces) {
      const grant = await auth.getGrant(client.clientId, w.id);
      const ctx = await gateway.adminForAccount(account.id, w.id);
      const store = await gateway.forAdmin(ctx);
      if (grant) {
        connections.set(w.id, (await store.getConnectionById(grant.connectionId))?.slug);
      } else if (workspaces.length === 1) {
        // A client that registered again (new client_id) can take over the
        // connection it had before (ADR 0011), but only one the human has
        // blocked in Budd first. Blocking signs out the app that held it, and
        // it takes someone signed in to Budd: a link from someone else can't
        // do it. Never a connection made for an API key (ADR 0016), and only
        // one whose app returned to the same place: registration is open, so
        // anyone can call their client "Claude", but only the real app
        // receives codes at Claude's redirect URI.
        const approved = await auth.approvedRedirectUris(w.id);
        full = await store.isFull();
        const sameTarget = (x: Connection) =>
          (approved.get(x.id) ?? []).some((uri) => sameRedirectTarget(uri, redirectUri));
        const apps = (await store.listConnections()).filter(
          (x) => x.kind === 'app' && x.archivedAt === null && x.slug !== SYSTEM_CONNECTION_SLUG,
        );
        // Blocked recently, and before this app registered: a link someone made
        // earlier and sent the person can't qualify, even if they block it now.
        const handedOver = (x: Connection) =>
          x.status === 'blocked' &&
          x.blockedAt !== null &&
          x.blockedAt < client.createdAt &&
          clock() - x.blockedAt < TAKEOVER_WINDOW_MS;
        attachable = apps.filter((x) => handedOver(x) && sameTarget(x));
        // Said when it's likely what the person expected: a connection with the app's own name.
        const named = apps.find((x) => x.slug === client.slugBase && !attachable.includes(x));
        if (named) resume = { slug: named.slug, blockFirst: sameTarget(named) };
      }
    }
    const nonce = web.sessions.addPending(session, {
      kind: 'authorize',
      request,
      workspaceIds: workspaces.map((w) => w.id),
      attachable: attachable.map((x) => x.id),
    });
    const target = new URL(redirectUri);
    return c.html(
      consentPage({
        clientName: client.clientName,
        redirectHost: redirectHost(target),
        loopback:
          target.protocol === 'http:' && isLoopbackHost(target.hostname)
            ? client.redirectUris.includes(redirectUri)
              ? 'same-port'
              : 'other-port'
            : undefined,
        workspaces,
        connections,
        attachable,
        resume,
        full,
        slugBase: client.slugBase,
        nonce,
        csrf: session.csrf,
        email: account.email ?? '',
      }),
    );
  });

  app.post('/authorize', async (c) => {
    const verified = await web.verifiedPost(c);
    if (!verified) return web.refused(c);
    const { session, form } = verified;
    const nonce = typeof form.nonce === 'string' ? form.nonce : undefined;
    const pending = web.sessions.takePending(session, nonce, 'authorize');
    if (!pending || session.accountId === undefined) {
      return badRequest(c, 'That approval has expired. Go back to the app and connect again.');
    }
    const { request } = pending;
    // Both forms come down to one choice: deny, a new connection, or an existing one's id. The
    // takeover page's buttons name it in one field; anything unexpected there denies.
    const takeoverStep = pending.takeover !== undefined;
    const choice = takeoverStep
      ? form.choice === 'takeover'
        ? pending.takeover
        : form.choice === 'new'
          ? 'new'
          : 'deny'
      : form.decision !== 'approve'
        ? 'deny'
        : typeof form.connection === 'string'
          ? form.connection
          : 'new';
    const approved = choice !== 'deny';
    if (!approved) {
      log.info('app denied', { client_id: request.clientId });
      return returnToClient(
        c,
        clientUrl(request.redirectUri, {
          error: 'access_denied',
          error_description: 'The user declined.',
          state: request.state,
        }),
        'You declined, so nothing was connected.',
      );
    }
    const workspaceId = typeof form.workspace === 'string' ? form.workspace : '';
    if (!pending.workspaceIds.includes(workspaceId)) {
      return badRequest(c, 'Choose one of your workspaces.');
    }
    const client = await auth.getClient(request.clientId);
    if (!client) return badRequest(c, 'This app is no longer registered.');
    const now = clock();
    const ctx = await gateway.adminForAccount(session.accountId, workspaceId);
    const store = await gateway.forAdmin(ctx);

    let grant = await auth.getGrant(client.clientId, workspaceId);
    let how: 'existing' | 'attached' | 'new' = 'existing';
    let slug: string | undefined;
    if (grant) {
      const connection = await store.getConnectionById(grant.connectionId);
      if (!connection) {
        return badRequest(
          c,
          'This app’s connection no longer exists. Go back to the app and connect again.',
        );
      }
      slug = connection.slug;
      if (connection.status !== 'active') {
        const archived = connection.archivedAt !== null;
        log.warn('authorize refused', {
          client_id: client.clientId,
          connection: slug,
          reason: archived ? 'archived' : 'blocked',
        });
        // The person can fix this in Budd, so the page stays and says how.
        return c.html(
          notConnectedPage({
            clientName: client.clientName,
            connection: slug,
            workspace: ctx.workspace.slug,
            archived,
            connectionUrl:
              workspaceId === (session.workspaceId ?? pending.workspaceIds[0])
                ? connectionUrl(slug)
                : undefined,
            returnUrl: clientUrl(request.redirectUri, {
              error: 'access_denied',
              error_description: archived
                ? 'This connection has been archived in Budd. Restore and unblock it in the Budd UI first.'
                : 'This connection has been blocked in Budd. Unblock it in the Budd UI first.',
              state: request.state,
            }).toString(),
          }),
          403,
        );
      }
    } else {
      const attachTo = choice === 'new' ? undefined : choice;
      let connection: Connection;
      if (attachTo !== undefined) {
        // Only a connection the human was shown, still usable now.
        const existing = pending.attachable.includes(attachTo)
          ? await store.getConnectionById(attachTo)
          : undefined;
        if (existing?.status !== 'blocked' || existing.archivedAt !== null) {
          return badRequest(
            c,
            'That connection can no longer be chosen. Go back to the app and connect again.',
          );
        }
        if (!takeoverStep) {
          // Ask once more, naming what changes hands; that page approves this connection only.
          return c.html(
            takeoverPage({
              clientName: client.clientName,
              connection: existing,
              workspaceId,
              nonce: web.sessions.addPending(session, {
                ...pending,
                workspaceIds: [workspaceId],
                takeover: existing.id,
              }),
              csrf: session.csrf,
            }),
          );
        }
        // Blocking revoked the old app's tokens; any issued since go too, and so
        // does its approval, so it can't come straight back once unblocked.
        const revoked = (await auth.revokeConnection(workspaceId, existing.id, now)).tokens;
        const grants = await auth.deleteGrants(workspaceId, existing.id);
        // The human confirmed it on the takeover page, which also serves as the
        // confirmation unblocking asks for. False if another takeover won the race.
        if (
          !(await store.setConnectionStatus({ connectionId: existing.id, status: 'active', now }))
        ) {
          return badRequest(
            c,
            'That connection can no longer be chosen. Go back to the app and connect again.',
          );
        }
        connection = { ...existing, status: 'active' };
        await gateway.appendSystemAudit(workspaceId, {
          at: now,
          event: 'connection_attached',
          actor: 'human',
          connectionId: connection.id,
          detail: {
            connection: connection.slug,
            client_id: client.clientId,
            client_name: client.clientName,
            tokens_revoked: revoked,
            grants_removed: grants,
          },
        });
        how = 'attached';
      } else {
        const registered = await store.registerConnection({
          slugBase: client.slugBase,
          reserved: [SYSTEM_CONNECTION_SLUG, ctx.workspace.slug],
          detail: { via: 'oauth', client_id: client.clientId, client_name: client.clientName },
          now,
        });
        if (registered === 'limit') {
          logRefusal('warn', 'authorize refused', {
            client_id: client.clientId,
            reason: 'connection_limit',
          });
          return c.html(
            connectionLimitPage({
              clientName: client.clientName,
              workspace: ctx.workspace.slug,
              returnUrl: clientUrl(request.redirectUri, {
                error: 'access_denied',
                error_description:
                  'This Budd workspace already has the most connections it may have. Archive one in the Budd UI first.',
                state: request.state,
              }).toString(),
            }),
            403,
          );
        }
        connection = registered;
        how = 'new';
      }
      slug = connection.slug;
      grant = {
        id: ulid(now),
        clientId: client.clientId,
        workspaceId,
        connectionId: connection.id,
        accountId: session.accountId,
        createdAt: now,
      };
      await auth.createGrant(grant);
    }
    const code = newToken('budd_code');
    await auth.createCode({
      codeHash: hashToken(code),
      grantId: grant.id,
      redirectUri: request.redirectUri,
      codeChallenge: request.codeChallenge,
      familyId: ulid(now),
      expiresAt: now + CODE_TTL_MS,
    });
    log.info('app authorized', {
      client_id: client.clientId,
      client_name: client.clientName,
      workspace: ctx.workspace.slug,
      connection: slug,
      how,
    });
    return returnToClient(c, clientUrl(request.redirectUri, { code, state: request.state }));
  });
}

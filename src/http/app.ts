import { Hono, type Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { HTTPException } from 'hono/http-exception';
import type { Admin } from '../admin/Admin.js';
import type { Bus } from '../bus/Bus.js';
import type { EventBus } from '../events/EventBus.js';
import type { Config } from '../config.js';
import type { WorkspaceGateway } from '../storage/gateway.js';
import type { Storage } from '../storage/Storage.js';
import { BUDD_PROTOCOL_VERSION, BUDD_VERSION } from '../version.js';
import { localGuard } from './localGuard.js';
import { mountMcp } from './mcpRoute.js';
import { mountUi } from '../ui/routes.js';
import { mountConsole } from '../ui/consoleRoutes.js';
import type { WakeUps } from '../wakeups/WakeUps.js';
import type { ConnectionKeys } from '../admin/keys.js';
import { SECURITY_HEADERS, Web } from '../ui/web.js';
import { messagePage } from '../ui/authPages.js';
import { log } from '../log.js';
import { mountBrowserAuth } from '../auth/browser.js';
import { mountOAuth } from '../auth/oauth.js';
import { LocalLoginState, mountLocalLogin } from '../auth/localLogin.js';
import type { OidcClient } from '../auth/oidc.js';
import { mountRateLimits } from './rateLimits.js';

export interface AppDeps {
  config: Config;
  storage: Storage;
  gateway: WorkspaceGateway;
  bus: Bus;
  admin: Admin;
  /** Hosted mode: connections with API keys. */
  keys?: ConnectionKeys | undefined;
  events: EventBus;
  clock: () => number;
  /** Aborted when the server shuts down, so long-lived streams end promptly. */
  shutdown: AbortSignal;
  /** Hosted mode: human sign-in. */
  oidc?: OidcClient | undefined;
  /** Local mode: the UI login's setup state. */
  localLogin?: LocalLoginState | undefined;
  /** Undefined when WAKE_UPS=off. */
  wakeUps?: WakeUps | undefined;
}

/**
 * Request bodies are capped before anything reads them. An MCP request carries
 * at most one message plus JSON-RPC framing; JSON escaping can grow a body up
 * to six-fold (`\u0001`), but clients escape little, so four times the message
 * limit leaves room. Forms and OAuth requests are tiny.
 */
const mcpBodyLimit = (config: Config) => 4 * config.limits.maxMessageBytes + 64 * 1024;
const OTHER_BODY_LIMIT = 64 * 1024;
/**
 * Registration is unauthenticated; real client metadata is well under 2 KiB.
 * Room for the largest registration Budd accepts (5 redirect URIs of 2,048
 * characters) plus the other fields, so the handler can say what's wrong.
 */
const REGISTER_BODY_LIMIT = 16 * 1024;

export function createApp(deps: AppDeps): Hono {
  const { config, storage } = deps;
  const app = new Hono();

  if (config.mode === 'local') app.use('*', localGuard());
  // Over https, tell browsers never to use plain http for this host (RFC 6797).
  if (config.hosted?.publicUrl.startsWith('https:')) {
    app.use('*', async (c, next) => {
      await next();
      c.header('Strict-Transport-Security', 'max-age=31536000');
    });
  }
  // Before the body limits, so oversized requests count against the address too.
  if (config.mode === 'hosted') mountRateLimits(app, config, deps.clock);
  const tooLarge = { onError: (c: Context) => c.text('Request body too large.\n', 413) };
  const mcpLimit = bodyLimit({ maxSize: mcpBodyLimit(config), ...tooLarge });
  app.use('/mcp', mcpLimit);
  app.use('/mcp/*', mcpLimit);
  // Everything else that accepts a body: UI forms, sign-in and OAuth endpoints.
  for (const path of [
    '/ui/*',
    '/authorize',
    '/token',
    '/revoke',
    '/login',
    '/login/link',
    '/setup',
    '/logout',
    '/console',
    '/console/*',
  ]) {
    app.use(path, bodyLimit({ maxSize: OTHER_BODY_LIMIT, ...tooLarge }));
  }
  app.use('/register', bodyLimit({ maxSize: REGISTER_BODY_LIMIT, ...tooLarge }));

  app.get('/health', async (c) => {
    const { ok } = await storage.health();
    return c.json(
      {
        status: ok ? 'ok' : 'degraded',
        mode: config.mode,
        version: BUDD_VERSION,
        protocol: BUDD_PROTOCOL_VERSION,
      },
      ok ? 200 : 503,
    );
  });

  const web = new Web(config, deps.clock);
  const auth = storage.auth;
  if (config.mode === 'hosted') {
    if (!deps.oidc) throw new Error('hosted mode needs an OIDC client');
    mountOAuth(app, {
      config,
      auth,
      gateway: deps.gateway,
      clock: deps.clock,
    });
    mountBrowserAuth(app, {
      config,
      auth,
      operators: storage.console,
      gateway: deps.gateway,
      oidc: deps.oidc,
      web,
      clock: deps.clock,
    });
  }
  if (config.mode === 'local') {
    if (!deps.localLogin) throw new Error('local mode needs its login state');
    mountLocalLogin(app, { auth, web, state: deps.localLogin, clock: deps.clock });
  }
  mountMcp(app, { ...deps, auth });
  mountUi(app, { ...deps, auth, console: storage.console, web });
  mountConsole(app, {
    config,
    auth,
    console: storage.console,
    web,
    clock: deps.clock,
    startedAt: deps.clock(),
  });

  const isMcp = (c: Context) => c.req.path === '/mcp' || c.req.path.startsWith('/mcp/');
  // Pages for browsers; machines (OAuth clients, metadata lookups) get JSON they can parse.
  const wantsPage = (c: Context) =>
    !isMcp(c) && (c.req.header('accept') ?? '').includes('text/html');
  app.notFound((c) =>
    wantsPage(c)
      ? c.html(
          messagePage('Page not found', 'There’s nothing at this address.', {
            href: '/ui',
            label: 'Open Connections',
          }),
          404,
          SECURITY_HEADERS,
        )
      : isMcp(c)
        ? c.json({ jsonrpc: '2.0', error: { code: -32601, message: 'Not found.' }, id: null }, 404)
        : c.json({ error: 'not_found' }, 404),
  );
  // One JSON line per failure, never a stack trace on stdout. A full disk shows as SQLITE_FULL.
  app.onError((err, c) => {
    if (err instanceof HTTPException) return err.getResponse();
    const code = (err as { code?: unknown }).code;
    log.error('request failed', {
      path: c.req.path,
      error: err.message,
      ...(typeof code === 'string' ? { code } : {}),
    });
    return wantsPage(c)
      ? c.html(
          messagePage('Something went wrong', 'Budd couldn’t finish that. Try again in a moment.'),
          500,
          SECURITY_HEADERS,
        )
      : isMcp(c)
        ? c.json(
            {
              jsonrpc: '2.0',
              error: { code: -32603, message: 'Budd failed; try again later.' },
              id: null,
            },
            500,
          )
        : c.json({ error: 'server_error' }, 500);
  });

  return app;
}

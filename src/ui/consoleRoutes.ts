import type { Context, Hono } from 'hono';
import { html } from 'hono/html';
import { hashToken } from '../auth/tokens.js';
import { durationInWords, type Config } from '../config.js';
import { OPERATOR_LINK_TTL_MS } from '../domain/auth.js';
import { log } from '../log.js';
import type { AuthStore, ConsoleStore } from '../storage/Storage.js';
import { DAY_MS } from '../sweeper/usage.js';
import { BUDD_VERSION } from '../version.js';
import { accountMenu } from './accountMenu.js';
import { messagePage } from './authPages.js';
import {
  ACCOUNT_SORTS,
  accountsPage,
  consoleLayout,
  consoleSignInPage,
  enrolPage,
  operatorsPage,
  overviewPage,
  PERIODS,
  provider,
  environmentPage,
  WORKSPACE_SORTS,
  workspacePage,
  workspacesPage,
  type ConsoleSection,
} from './consolePages.js';
import { Params } from './filters.js';
import { sortOf, type Html } from './html.js';
import { limitPerSession, securityHeaders, type Web } from './web.js';

export interface ConsoleDeps {
  config: Config;
  auth: AuthStore;
  console: ConsoleStore;
  web: Web;
  clock: () => number;
  /** When this Budd started, for Overview. */
  startedAt: number;
}

/**
 * The operator console (ADR 0022): read-only pages about the whole instance,
 * from the control database only. In hosted mode it has its own sign-in and
 * session, for operators only; in local mode the one login is the operator.
 */
export function mountConsole(app: Hono, deps: ConsoleDeps): void {
  const { config, auth, web, clock } = deps;
  const store = deps.console;
  const menuDeps = { web, auth, operators: store };
  const { limits } = config;

  app.use('/console', securityHeaders);
  app.use('/console/*', securityHeaders);

  const limitSession = limitPerSession(limits.uiRatePerMin, clock, (c) => web.consoleSession(c));
  app.use('/console', limitSession);
  app.use('/console/*', limitSession);

  /** A console page, for operators only, signing in first if needed. */
  const consolePage =
    (
      section: ConsoleSection,
      handler: (
        c: Context,
        params: Params,
        accountId: string,
      ) => Promise<{ title: string; body: Html; status?: 404 }>,
    ) =>
    async (c: Context) => {
      const session = web.consoleSession(c);
      if (session?.accountId === undefined) {
        const url = new URL(c.req.url);
        const returnTo = url.pathname + url.search;
        return config.hosted
          ? c.html(consoleSignInPage(returnTo, provider(config.hosted.oidcIssuer)))
          : c.redirect(`/login?return=${encodeURIComponent(returnTo)}`, 302);
      }
      const menu = await accountMenu(
        c,
        menuDeps,
        session,
        await auth.getAccount(session.accountId),
      );
      if (!menu.operator) {
        web.endConsoleSession(c);
        return web.notAnOperator(c);
      }
      const [{ title, body, status }, [workspace]] = await Promise.all([
        handler(c, new Params(c.req.query()), session.accountId),
        auth.listWorkspacesForAccount(session.accountId),
      ]);
      return c.html(
        consoleLayout({
          title,
          active: section,
          host: new URL(web.selfOrigin(c)).host,
          workspace: workspace?.slug ?? '',
          account: menu.profile,
          body,
        }),
        status ?? 200,
      );
    };

  /** A week unless asked for more: quicker to read, and enough to see a trend. */
  const periodOf = (params: Params) => params.pick('period', PERIODS) ?? '7d';

  /** Local mode's one login is the operator, though it isn't in the operators table. */
  const accounts = async () =>
    (await store.accounts()).map((a) => (web.hosted ? a : { ...a, operator: true }));

  const signInRule = (): string | undefined => {
    const hosted = config.hosted;
    if (!hosted) return undefined;
    const rule =
      hosted.allowedEmails.length > 0 || hosted.allowedHd.length > 0
        ? 'listed people and domains only'
        : 'anyone the provider accepts';
    return `${provider(hosted.oidcIssuer)}, ${rule}`;
  };

  app.get(
    '/console',
    consolePage('overview', async (c, params) => {
      const now = clock();
      const period = periodOf(params);
      const [all, workspaces, operators, total, measuredAt] = await Promise.all([
        accounts(),
        store.workspaces(now),
        store.listOperators(),
        store.totalMessages(now - PERIODS[period]),
        store.lastUsageHour(),
      ]);
      return {
        title: 'Overview',
        body: overviewPage({
          instance: {
            version: BUDD_VERSION,
            mode: config.mode,
            address: web.selfOrigin(c),
            startedAt: deps.startedAt,
            signIn: signInRule(),
            wakeUps: config.wakeUps
              ? config.wakeUpHosts.includes('*')
                ? 'On, to any public host'
                : `On, to ${String(config.wakeUpHosts.length)} allowed hosts`
              : 'Off',
            measuredAt,
          },
          accounts: all,
          workspaces,
          operators: web.hosted ? operators.length : 1,
          total,
          limits,
          period,
          now,
        }),
      };
    }),
  );

  app.get(
    '/console/workspaces',
    consolePage('workspaces', async (c, params) => {
      const now = clock();
      // Largest first, until another order is chosen.
      const sort = sortOf(c.req.query(), WORKSPACE_SORTS, 'messages', 'desc');
      const today = Math.floor(now / DAY_MS) * DAY_MS;
      const midnights = Array.from({ length: 30 }, (_, i) => today - (29 - i) * DAY_MS);
      const [workspaces, daily] = await Promise.all([
        store.workspaces(now),
        store.dailyMessages(midnights),
      ]);
      return {
        title: 'Workspaces',
        body: workspacesPage({
          workspaces,
          daily,
          limits,
          sort,
          sortLink: (changes) => params.link('/console/workspaces', changes),
        }),
      };
    }),
  );

  app.get(
    '/console/workspaces/:id',
    consolePage('workspaces', async (c, params) => {
      const now = clock();
      const period = periodOf(params);
      const workspace = await store.workspace(c.req.param('id') ?? '', now);
      if (!workspace) return { title: 'Workspace not found', body: workspaceNotFound, status: 404 };
      const [all, keys, usage] = await Promise.all([
        accounts(),
        store.keys(workspace.id),
        store.usage(workspace.id, now - PERIODS[period]),
      ]);
      return {
        title: workspace.id,
        body: workspacePage({
          workspace,
          accounts: all.filter((a) => a.workspaceIds.includes(workspace.id)),
          keys,
          usage,
          limits,
          period,
          now,
        }),
      };
    }),
  );

  app.get(
    '/console/accounts',
    consolePage('accounts', async (c, params, me) => ({
      title: 'Accounts',
      body: accountsPage({
        accounts: await accounts(),
        me,
        // Most recently signed in first, until another order is chosen.
        sort: sortOf(c.req.query(), ACCOUNT_SORTS, 'signin', 'desc'),
        sortLink: (changes) => params.link('/console/accounts', changes),
      }),
    })),
  );

  app.get(
    '/console/environment',
    consolePage('environment', () =>
      Promise.resolve({ title: 'Environment', body: environmentPage(config.settings) }),
    ),
  );

  app.get(
    '/console/operators',
    consolePage('operators', async (_c, _params, me) => ({
      title: 'Operators',
      body: operatorsPage({ operators: await store.listOperators(), me, hosted: web.hosted }),
    })),
  );

  /** Signing out of the console signs out of the UI too: they share one menu. */
  app.post('/console/logout', async (c) => {
    const verified = await web.verifiedConsolePost(c);
    if (!verified) {
      // Most likely a console tab left open past the console's hour.
      return web.consoleSession(c)
        ? web.refused(c)
        : c.html(
            messagePage(
              'Console session ended',
              'Your console session had already ended. To sign out of Budd too, use Sign out in your workspace.',
              { href: '/ui', label: 'Open your workspace' },
            ),
          );
    }
    web.sessions.end(verified.session);
    web.endConsoleSession(c);
    const ui = web.current(c);
    if (ui) web.sessions.end(ui);
    web.clearSession(c);
    return c.html(
      messagePage('Signed out', 'You have signed out of Budd and its console.', {
        href: '/login',
        label: 'Sign in',
      }),
    );
  });

  if (!web.hosted) return;

  // ---- Becoming an operator, with the one-time link `budd operator` prints.

  const badLink = (c: Context) =>
    c.html(
      messagePage(
        'Operator link not valid',
        `It expired (links work for ${durationInWords(OPERATOR_LINK_TTL_MS)}) or was already used. Ask whoever runs the server for a new one.`,
        { href: '/ui', label: 'Open your workspace' },
      ),
      400,
    );

  /** Doesn't say whose it is: the link may have reached the wrong person. */
  const wrongAccount = (c: Context, accountId: string) => {
    log.warn('operator link refused', { reason: 'another account', account_id: accountId });
    return c.html(
      messagePage(
        'Operator link is for another account',
        'This link was made for a different email address. Sign out and sign in with that one, or ask whoever runs the server for a link for this account.',
        { href: '/ui', label: 'Open your workspace' },
      ),
      403,
    );
  };

  /** The signed-in account's email, as the link stores it. */
  const emailOf = async (accountId: string) =>
    (await auth.getAccount(accountId))?.email?.toLowerCase();

  app.get('/console/enrol', async (c) => {
    const code = c.req.query('code') ?? '';
    const session = web.current(c);
    if (session?.accountId === undefined) {
      return c.redirect(`/login?return=${encodeURIComponent(`/console/enrol?code=${code}`)}`, 302);
    }
    if (await store.isOperator(session.accountId)) return c.redirect('/console', 302);
    const linkEmail = await store.operatorLinkEmail(hashToken(code), clock());
    if (linkEmail === undefined) return badLink(c);
    if ((await emailOf(session.accountId)) !== linkEmail) {
      return wrongAccount(c, session.accountId);
    }
    return c.html(enrolPage({ code, csrf: session.csrf, who: linkEmail }));
  });

  app.post('/console/enrol', async (c) => {
    const verified = await web.verifiedPost(c);
    if (!verified?.session.accountId) return web.refused(c);
    const { accountId } = verified.session;
    const codeHash = hashToken(typeof verified.form.code === 'string' ? verified.form.code : '');
    if (!(await store.redeemOperatorLink(codeHash, (await emailOf(accountId)) ?? '', clock()))) {
      // Someone else's link isn't used up by trying it.
      return (await store.operatorLinkEmail(codeHash, clock())) === undefined
        ? badLink(c)
        : wrongAccount(c, accountId);
    }
    await store.addOperator(accountId, clock());
    log.info('operator added', { account_id: accountId });
    return c.redirect('/console', 303);
  });
}

const workspaceNotFound: Html = html`<div class="page-head">
    <h1>Workspace not found</h1>
  </div>
  <p>There’s no workspace with that ID: it may have been erased.</p>
  <p><a href="/console/workspaces">All workspaces</a></p>`;

import { createHash } from 'node:crypto';
import type { Context, Hono } from 'hono';
import { html } from 'hono/html';
import { streamSSE } from 'hono/streaming';
import { isValid as isUlid } from 'ulid';
import { AdminError, type Admin } from '../admin/Admin.js';
import type { ConnectionKeys } from '../admin/keys.js';
import type { LocalLoginState } from '../auth/localLogin.js';
import { verifyPassword } from '../auth/password.js';
import { durationInWords, type Config } from '../config.js';
import { SYSTEM_CONNECTION_SLUG } from '../domain/slug.js';
import type { Connection, HistoryItem } from '../domain/types.js';
import type { EventBus } from '../events/EventBus.js';
import type { AuthStore, ConsoleStore } from '../storage/Storage.js';
import { GatewayError, type AdminContext, type WorkspaceGateway } from '../storage/gateway.js';
import { CSS, JS } from './assets.js';
import type { ConnectionOverview } from '../admin/Admin.js';
import { auditFilters, auditPage } from './auditPage.js';
import { inUse } from './connectionMap.js';
import { messagePage } from './authPages.js';
import {
  CARD_WINDOW,
  CONNECTION_SORTS,
  connectionCard,
  connectionFilters,
  connectionPage,
  MAILBOX_SORTS,
  mailboxPage,
  failingWakeUps,
  MAP_WINDOWS,
  mailboxCard,
  mapIsDefault,
  mapPage,
  NEW_CONNECTION_URL,
  newConnectionPage,
  notFoundPage,
  tablePage,
  type Confirm,
  type Flash,
  type KeyStatus,
} from './connectionPages.js';
import { ERASE_EXPIRED_REASON, eraseWorkspace } from './erase.js';
import { findBar, Params, UTC_NOTE, type MailboxChoices } from './filters.js';
import {
  connectionUrl,
  mailboxUrl,
  type Html,
  matching as matchCount,
  PAGE_SIZE,
  plural,
  sortOf,
} from './html.js';
import { LOGO_FILES } from './logo.js';
import { keyShownPage } from './keyPages.js';
import { BUDD_VERSION } from '../version.js';
import { accountMenu } from './accountMenu.js';
import { layout, type Section } from './layout.js';
import {
  DEFAULT_WINDOW,
  messageFilters,
  messagesPage,
  threadsPage,
  type ThreadView,
} from './messagePages.js';
import { type Pending, type Session } from './sessions.js';
import { erasePage, settingsPage, type EraseStep } from './settingsPages.js';
import { wakeUpForm, wakeUpSection } from './wakeUpPages.js';
import { RETRY_INTERVALS, type RetryInterval, type WakeUps } from '../wakeups/WakeUps.js';
import { limitPerSession, securityHeaders, type Web } from './web.js';

export interface UiDeps {
  config: Config;
  gateway: WorkspaceGateway;
  admin: Admin;
  /** Hosted mode: connections with API keys (ADR 0016). */
  keys?: ConnectionKeys | undefined;
  auth: AuthStore;
  /** Who may open the operator console, for its menu item. */
  console: ConsoleStore;
  events: EventBus;
  clock: () => number;
  shutdown: AbortSignal;
  web: Web;
  /** Local mode: the UI login's setup state, renewed when the workspace is erased. */
  localLogin?: LocalLoginState | undefined;
  /** Wake-ups (ADR 0019); undefined when WAKE_UPS=off, which hides them. */
  wakeUps?: WakeUps | undefined;
}

const HEARTBEAT_MS = 25_000;
/** How long after creating a key connection a resent form explains where its key went. */
const RECENT_KEY_CONNECTION_MS = 10 * 60_000;

/**
 * The UI (§15). Every page needs a signed-in account: the local login in local
 * mode (ADR 0010, on top of the loopback and Host/Origin checks), or an
 * identity-provider sign-in in hosted mode, which shows only that account's
 * workspace.
 */
export function mountUi(app: Hono, deps: UiDeps): void {
  const { config, gateway, admin, keys, auth, events, clock, shutdown, web, localLogin, wakeUps } =
    deps;
  const menuDeps = { web, auth, operators: deps.console };

  app.get('/', (c) => c.redirect('/ui', 302));
  app.use('/ui', securityHeaders);
  app.use('/ui/*', securityHeaders);

  // The browser keeps these but checks they're current on every page, so an upgrade shows at once.
  const asset = (body: string, type: string) => {
    const etag = `"${createHash('sha256').update(body).digest('base64url').slice(0, 16)}"`;
    return (c: Context) =>
      c.req.header('if-none-match') === etag
        ? c.body(null, 304, { ETag: etag, 'Cache-Control': 'no-cache' })
        : c.body(body, 200, { 'Content-Type': type, ETag: etag, 'Cache-Control': 'no-cache' });
  };
  app.get('/ui/app.css', asset(CSS, 'text/css; charset=utf-8'));
  app.get('/ui/app.js', asset(JS, 'text/javascript; charset=utf-8'));
  for (const [name, svg] of LOGO_FILES) app.get(`/ui/logo/${name}`, asset(svg, 'image/svg+xml'));

  // Registered after the stylesheet, script and logos, which don't count.
  const limitSession = limitPerSession(config.limits.uiRatePerMin, clock, (c) => web.current(c));
  app.use('/ui', limitSession);
  app.use('/ui/*', limitSession);

  /** The workspace this browser session administers, or undefined if it must sign in. */
  const adminFor = async (session: Session): Promise<AdminContext | undefined> => {
    if (session.accountId === undefined) return undefined;
    if (!web.hosted) {
      // Local mode: signed in with the local login (ADR 0010).
      return session.accountId === (await auth.getLocalAccountId())
        ? gateway.adminLocal(clock())
        : undefined;
    }
    const workspaces = await auth.listWorkspacesForAccount(session.accountId);
    const workspace = workspaces.find((w) => w.id === session.workspaceId) ?? workspaces[0];
    if (!workspace) return undefined;
    try {
      return await gateway.adminForAccount(session.accountId, workspace.id);
    } catch (err) {
      if (err instanceof GatewayError) return undefined;
      throw err;
    }
  };

  const signIn = (c: Context) => {
    const url = new URL(c.req.url);
    return c.redirect(`/login?return=${encodeURIComponent(url.pathname + url.search)}`, 302);
  };

  const flashFrom = (c: Context): Flash => ({
    done: c.req.query('done'),
    error: c.req.query('error'),
  });

  const render = async (
    c: Context,
    session: Session,
    ctx: AdminContext,
    page: {
      title: string;
      active?: Section;
      live: boolean;
      pinned?: boolean;
      body: ReturnType<typeof layout>;
      status?: 200 | 400 | 401 | 404 | 429;
    },
  ) => {
    const menu = await accountMenu(c, menuDeps, session, await signedInAccount(session));
    return c.html(
      layout({
        ...page,
        workspace: ctx.workspace.slug,
        operator: menu.operator,
        account: menu.profile,
      }),
      page.status ?? 200,
    );
  };

  /** The account behind this session: the signed-in one, or local mode's own. */
  const signedInAccount = async (session: Session) => {
    const id = web.hosted ? session.accountId : await auth.getLocalAccountId();
    return id === undefined ? undefined : auth.getAccount(id);
  };

  /** The card a click on the map opens: a connection (`slug`) or one of its mailboxes (`slug/handle`). */
  const mapCard = async (
    ctx: AdminContext,
    shown: ConnectionOverview[],
    address: string,
    link: (changes: Record<string, string | undefined>) => string,
  ): Promise<Html | undefined> => {
    const [slug = '', handle] = address.split('/');
    const connection = shown.find((x) => x.slug === slug);
    if (!connection) return undefined;
    const close = link({ card: undefined });
    if (handle === undefined) {
      const stats = await admin.mailboxStats(ctx, slug, CARD_WINDOW.ms);
      return connectionCard({
        connection,
        stats,
        close,
        focus: link({ card: undefined, focus: slug }),
      });
    }
    if (!inUse(connection).some((m) => m.handle === handle)) return undefined;
    const [stats, routes, wakeUp] = await Promise.all([
      admin.mailboxStats(ctx, slug, CARD_WINDOW.ms),
      admin.routes(ctx, CARD_WINDOW.ms),
      wakeUps?.view(ctx, slug, handle),
    ]);
    return mailboxCard({
      connection,
      handle,
      stats: stats.find((x) => x.handle === handle),
      routes,
      wakeUp,
      close,
    });
  };

  /** A GET page: resolves the session and workspace, or sends the browser to sign in. */
  const page =
    (handler: (c: Context, session: Session, ctx: AdminContext) => Promise<Response>) =>
    async (c: Context) => {
      // Sessions start at sign-in; an anonymous visitor gets none, so a flood
      // of visits can't evict signed-in users.
      const session = web.current(c);
      const ctx = session && (await adminFor(session));
      if (!session || !ctx) return signIn(c);
      return handler(c, session, ctx);
    };

  /** Map | Table: the map once there are two mailboxes to show, else the table. */
  app.get(
    '/ui',
    page(async (c, session, ctx) => {
      const connections = await admin.overview(ctx);
      const current = connections.filter((x) => x.archivedAt === null);
      const flash = flashFrom(c);
      const mcpUrl = web.mcpUrl(c);
      const states = await wakeUps?.states(ctx);
      const failing = failingWakeUps(connections, states);
      const p = new Params(c.req.query());
      const view =
        p.pick('view', { map: true, table: true }) ?? (mapIsDefault(current) ? 'map' : 'table');
      if (view === 'map') {
        const known = (slug: string) => current.some((x) => x.slug === slug);
        const window = p.pick('msgs', MAP_WINDOWS);
        const focus = p.take('focus', known);
        const card = p.take('card', (v) => known(v.split('/')[0] ?? ''));
        const link = (changes: Record<string, string | undefined>) =>
          p.link('/ui', { view: 'map', ...changes });
        // app.js opening a card over the map it already shows: just the card.
        if (card && c.req.header('x-budd-part') === 'card') {
          const only = await mapCard(ctx, current, card, link);
          return only ? c.html(only) : c.notFound();
        }
        const [routes, shownCard] = await Promise.all([
          window && admin.routes(ctx, MAP_WINDOWS[window].ms),
          card ? mapCard(ctx, current, card, link) : undefined,
        ]);
        return render(c, session, ctx, {
          title: 'Connections',
          active: 'connections',
          live: true,
          body: mapPage({
            connections: current,
            flash,
            mcpUrl,
            failing,
            link,
            window,
            routes,
            wakeUps: states,
            focus,
            card: shownCard,
            retentionMs: config.ttl.retentionMs,
          }),
        });
      }
      const sort = sortOf(c.req.query(), CONNECTION_SORTS, 'name');
      const found = connectionFilters(p);
      const shown = connections.filter(found.matches);
      return render(c, session, ctx, {
        title: 'Connections',
        active: 'connections',
        live: true,
        body: tablePage({
          connections: shown,
          find: findBar({
            path: '/ui',
            params: p,
            search: { label: 'Search connections', placeholder: 'Name, label or mailbox' },
            fields: found.fields,
            hidden: ['view'],
            applied: found.applied,
            summary: matchCount(shown.length, 'connection', 'connections', found.applied > 0),
          }),
          sort,
          sortLink: (changes) => p.link('/ui', changes),
          filtered: found.applied > 0,
          failing,
          flash,
          mcpUrl,
        }),
      });
    }),
  );

  /** Where a human connects another app, or (hosted) makes a connection with an API key. */
  app.get(
    NEW_CONNECTION_URL,
    page(async (c, session, ctx) =>
      render(c, session, ctx, {
        title: 'New connection',
        active: 'connections',
        live: false,
        body: newConnectionPage({
          mcpUrl: web.mcpUrl(c),
          keyForm: keys && { csrf: session.csrf, full: await admin.isFull(ctx) },
        }),
      }),
    ),
  );
  /** Adding an API-key agent had a page of its own. */
  app.get('/ui/add-agent', (c) => c.redirect(NEW_CONNECTION_URL, 301));

  const keyStatus = async (ctx: AdminContext, connection: Connection): Promise<KeyStatus> => {
    const key = await keys?.current(ctx, connection);
    if (!key) return null;
    return {
      ...key,
      createdBy: (await auth.getAccount(key.accountId))?.email ?? null,
      idleExpiry: durationInWords(config.keyIdleExpiryMs),
    };
  };

  const notFound = (c: Context, session: Session, ctx: AdminContext, body: Html) =>
    render(c, session, ctx, {
      title: 'Not found',
      active: 'connections',
      live: false,
      body,
      status: 404,
    });

  /** The confirm dialog a redirect after POST asked for, if its nonce is still pending here. */
  const confirmFor = (
    session: Session,
    slug: string,
    nonce: string | undefined,
  ): Confirm | undefined => {
    const pending: Pending | undefined = web.sessions.peekPending(session, nonce);
    if (!nonce || pending === undefined || !('slug' in pending) || pending.slug !== slug)
      return undefined;
    const base = { slug, nonce, csrf: session.csrf };
    return pending.kind === 'policy'
      ? { ...base, kind: 'policy', preview: pending.preview }
      : { ...base, kind: pending.kind };
  };

  app.get(
    '/ui/connections/:slug',
    page(async (c, session, ctx) => {
      const slug = c.req.param('slug') ?? '';
      const all = await admin.overview(ctx, { activityOf: slug });
      const connection = all.find((x) => x.slug === slug);
      if (!connection) return notFound(c, session, ctx, notFoundPage(slug));
      const url = connectionUrl(slug);
      const sort = sortOf(c.req.query(), MAILBOX_SORTS, 'mailbox');
      return render(c, session, ctx, {
        title: slug,
        active: 'connections',
        live: false,
        body: connectionPage({
          connection,
          // Archived connections can't send, so they aren't offered unless already allowed.
          others: all
            .filter((x) => x.archivedAt === null || connection.policy.allowed.includes(x.slug))
            .map((x) => x.slug)
            .filter((s) => s !== slug),
          csrf: session.csrf,
          flash: flashFrom(c),
          confirm: confirmFor(session, slug, c.req.query('confirm')),
          key: keys && connection.kind === 'key' ? await keyStatus(ctx, connection) : undefined,
          sort,
          sortLink: ({ sort, dir }) => `${url}?sort=${sort}&dir=${dir}`,
          wakeUps: await wakeUps?.states(ctx),
          now: clock(),
        }),
      });
    }),
  );

  app.get(
    '/ui/connections/:slug/mailboxes/:handle',
    page(async (c, session, ctx) => {
      const slug = c.req.param('slug') ?? '';
      const name = c.req.param('handle') ?? '';
      const connection = (await admin.overview(ctx, { activityOf: slug })).find(
        (x) => x.slug === slug,
      );
      const mailbox = connection?.mailboxes.find((m) => m.handle === name);
      if (!connection || !mailbox) {
        return notFound(c, session, ctx, notFoundPage(`${slug}/${name}`, 'mailbox'));
      }
      const filter = { connectionId: connection.id, handle: name };
      const { items, matching } = await admin.history(ctx, { limit: 1, filter });
      return render(c, session, ctx, {
        title: `${slug}/${name}`,
        active: 'connections',
        live: true,
        body: mailboxPage({
          connection,
          mailbox,
          newest: items[0],
          messages: matching,
          csrf: session.csrf,
          flash: flashFrom(c),
          wakeUp:
            wakeUps &&
            wakeUpSection({
              slug,
              handle: name,
              wakeUp: await wakeUps.view(ctx, slug, name),
              paused: connection.status === 'blocked',
              csrf: session.csrf,
            }),
        }),
      });
    }),
  );

  /** The policy used to have a page of its own; old links land on its section now. */
  app.get(
    '/ui/connections/:slug/policy',
    page((c) =>
      Promise.resolve(c.redirect(`${connectionUrl(c.req.param('slug') ?? '')}#policy`, 301)),
    ),
  );

  /** What the Mailbox filters offer: each connection with its mailboxes, and Budd's own notices. */
  const mailboxChoices = async (ctx: AdminContext, overview?: ConnectionOverview[]) => {
    const all = await admin.connections(ctx);
    const known = overview ?? (await admin.overview(ctx));
    return all.map((x): MailboxChoices => ({
      id: x.id,
      slug: x.slug,
      mailboxes: known.find((k) => k.id === x.id)?.mailboxes ?? [],
    }));
  };

  /** The most messages one Threads page holds, however wide its window. */
  const THREADS_CAP = 500;

  app.get(
    '/ui/messages',
    page(async (c, session, ctx) => {
      const path = '/ui/messages';
      const p = new Params(c.req.query());
      const view = p.pick('view', { list: true, threads: true }) === 'list' ? 'list' : 'threads';
      const before = view === 'list' ? p.take('before', isUlid) : undefined;
      const threadId = view === 'threads' ? p.take('thread', isUlid) : undefined;
      const found = messageFilters(p, await mailboxChoices(ctx), clock());
      // A thread opened by link is shown whole, whatever the window.
      const filter = threadId
        ? { ...found.filter, threadId, since: undefined, until: undefined }
        : found.filter;
      const any = (await admin.messages(ctx, { limit: 1 })).length > 0;
      const find = (summary: Html | string) =>
        findBar({
          path,
          params: p,
          search: { label: 'Search messages', placeholder: 'Search subject and text' },
          fields: found.fields,
          hidden: ['view', 'thread'],
          applied: found.applied,
          summary: html`${summary}${UTC_NOTE}`,
        });
      const shared = {
        path,
        params: p,
        filtered: found.applied > 0,
        windowSet: found.windowSet,
        any,
        retention: durationInWords(config.ttl.retentionMs),
      };

      if (view === 'list') {
        const { items, matching } = await admin.history(ctx, {
          limit: PAGE_SIZE,
          beforeId: before,
          filter,
        });
        const last = items.at(-1);
        return render(c, session, ctx, {
          title: 'Messages',
          active: 'messages',
          live: true,
          body: messagesPage({
            ...shared,
            items,
            find: find(matchCount(matching, 'message', 'messages', found.applied > 0)),
            older:
              items.length >= PAGE_SIZE && last
                ? p.link(path, { before: last.message.id })
                : undefined,
            newest: before ? p.link(path, { before: undefined }) : undefined,
          }),
        });
      }

      // Threads: the window's messages, newest first, grouped by thread.
      const fetched = await admin.messages(ctx, { limit: THREADS_CAP + 1, filter });
      const byThread = new Map<string, HistoryItem[]>();
      for (const item of fetched.slice(0, THREADS_CAP)) {
        const id = item.message.threadId;
        byThread.set(id, [...(byThread.get(id) ?? []), item]);
      }
      const heads = new Map(
        (await admin.threadHeads(ctx, [...byThread.keys()])).map((h) => [
          h.first.message.threadId,
          h,
        ]),
      );
      const threads = [...byThread].flatMap(([id, inWindow]): ThreadView[] => {
        const head = heads.get(id);
        if (!head) return [];
        const replies = inWindow.filter((i) => i.message.id !== head.first.message.id).reverse();
        return [{ first: head.first, replies, hidden: head.messages - 1 - replies.length }];
      });
      return render(c, session, ctx, {
        title: 'Messages',
        active: 'messages',
        live: true,
        body: threadsPage({
          ...shared,
          threads,
          open: threadId,
          capped: fetched.length > THREADS_CAP ? THREADS_CAP : undefined,
          find: find(
            `${plural(threads.length, 'thread')} with messages ${threadId ? 'in this thread' : found.windowSet ? 'in this window' : `in the last ${DEFAULT_WINDOW}`}.`,
          ),
        }),
      });
    }),
  );

  app.get(
    '/ui/audit',
    page(async (c, session, ctx) => {
      const path = '/ui/audit';
      const p = new Params(c.req.query());
      const before = Number(p.take('before', (v) => /^\d{1,16}$/.test(v)));
      const overview = await admin.overview(ctx);
      const found = auditFilters(
        p,
        await mailboxChoices(ctx, overview),
        await admin.auditRange(ctx),
      );
      const { rows, matching } = await admin.auditPage(ctx, {
        limit: PAGE_SIZE,
        beforeId: before > 0 ? before : undefined,
        filter: found.filter,
      });
      const last = rows.at(-1);
      return render(c, session, ctx, {
        title: 'Audit log',
        active: 'audit',
        live: true,
        pinned: true,
        body: auditPage({
          rows,
          slugs: new Set(overview.map((x) => x.slug)),
          filtered: found.applied > 0,
          find: findBar({
            path,
            params: p,
            search: {
              label: 'Search the audit log',
              placeholder: 'A handle, message id or reason',
            },
            fields: found.fields,
            applied: found.applied,
            summary: html`${matchCount(matching, 'entry', 'entries', found.applied > 0)}.${found.shown ? UTC_NOTE : ''}`,
          }),
          older:
            rows.length >= PAGE_SIZE && last
              ? p.link(path, { before: String(last.id) })
              : undefined,
          newest: before > 0 ? p.link(path, { before: undefined }) : undefined,
        }),
      });
    }),
  );

  app.get(
    '/ui/settings',
    page(async (c, session, ctx) => {
      const connections = await admin.overview(ctx);
      const signedIn = await signedInAccount(session);
      const account = web.hosted
        ? signedIn && {
            email: signedIn.email ?? '',
            provider: config.hosted ? new URL(config.hosted.oidcIssuer).host : '',
          }
        : { username: (await auth.getLocalLogin())?.username ?? '' };
      return render(c, session, ctx, {
        title: 'Settings',
        active: 'settings',
        live: false,
        body: settingsPage({
          workspace: ctx.workspace.slug,
          mode: config.mode,
          retention: durationInWords(config.ttl.retentionMs),
          deliveryTtl: durationInWords(config.ttl.deliveryMs),
          connections: {
            active: connections.filter((x) => x.archivedAt === null).length,
            archived: connections.filter((x) => x.archivedAt !== null).length,
          },
          account,
          theme: signedIn?.theme ?? 'system',
          csrf: session.csrf,
          version: BUDD_VERSION,
          saved: c.req.query('done') === 'saved',
        }),
      });
    }),
  );

  /** Settings were four pages; each is a section of the one page now. */
  const OLD_SETTINGS = {
    preferences: 'appearance',
    account: 'account',
    workspace: 'workspace',
    about: 'about',
  };
  for (const [old, section] of Object.entries(OLD_SETTINGS)) {
    app.get(`/ui/settings/${old}`, (c) => c.redirect(`/ui/settings#${section}`, 301));
  }

  // ---- Writes. Every POST needs a same-origin request, the session cookie and its CSRF token.

  /** A form POST: verified, signed in (hosted), and for this session's workspace. */
  const action =
    (
      handler: (
        c: Context,
        session: Session,
        ctx: AdminContext,
        form: Record<string, unknown>,
      ) => Promise<Response>,
    ) =>
    async (c: Context) => {
      const verified = await web.verifiedPost(c);
      if (!verified) return web.refused(c);
      const ctx = await adminFor(verified.session);
      if (!ctx) return web.refused(c);
      try {
        return await handler(c, verified.session, ctx, verified.form);
      } catch (err) {
        if (err instanceof AdminError) {
          // Back to the connection or mailbox the person was working on, unless that's what went missing.
          const slug = c.req.param('slug');
          const handle = c.req.param('handle');
          const back =
            slug && handle && err.code !== 'unknown_mailbox' && err.code !== 'unknown_connection'
              ? mailboxUrl(slug, handle)
              : slug && err.code !== 'unknown_connection'
                ? connectionUrl(slug)
                : '/ui';
          return c.redirect(`${back}?error=${err.code}`, 303);
        }
        throw err;
      }
    };

  app.post(
    '/ui/settings/preferences',
    action(async (c, session, _ctx, form) => {
      const theme = form.theme;
      if (theme !== 'system' && theme !== 'light' && theme !== 'dark') {
        return c.text('Choose a theme.\n', 400);
      }
      const account = await signedInAccount(session);
      if (!account) return web.refused(c);
      await auth.setTheme(account.id, theme);
      return c.redirect('/ui/settings?done=saved#appearance', 303);
    }),
  );

  const done = (c: Context, code: string, slug: string) =>
    c.redirect(`${connectionUrl(slug)}?done=${code}`, 303);

  /** After a POST that needs confirming, the connection's page shows the dialog: reloading it is safe. */
  const confirmStep = (c: Context, slug: string, nonce: string) =>
    c.redirect(`${connectionUrl(slug)}?confirm=${nonce}`, 303);

  app.post(
    '/ui/connections/:slug/block',
    action(async (c, _s, ctx) => {
      const slug = c.req.param('slug') ?? '';
      await admin.block(ctx, slug);
      return done(c, 'blocked', slug);
    }),
  );

  /** Archiving blocks the connection too; restoring leaves it blocked (ADR 0011). */
  app.post(
    '/ui/connections/:slug/archive',
    action(async (c, _s, ctx) => {
      const slug = c.req.param('slug') ?? '';
      await admin.archive(ctx, slug);
      return done(c, 'archived', slug);
    }),
  );

  app.post(
    '/ui/connections/:slug/restore',
    action(async (c, _s, ctx) => {
      const slug = c.req.param('slug') ?? '';
      await admin.restore(ctx, slug);
      return done(c, 'restored', slug);
    }),
  );

  /** Unblocking lets a connection back in, so it is confirmed like a widening. */
  app.post(
    '/ui/connections/:slug/unblock',
    action((c, session) => {
      const slug = c.req.param('slug') ?? '';
      const nonce = web.sessions.addPending(session, { kind: 'unblock', slug });
      return Promise.resolve(confirmStep(c, slug, nonce));
    }),
  );

  app.post(
    '/ui/connections/:slug/unblock/confirm',
    action(async (c, session, ctx, form) => {
      const slug = c.req.param('slug') ?? '';
      const nonce = typeof form.nonce === 'string' ? form.nonce : undefined;
      const pending = web.sessions.takePending(session, nonce, 'unblock');
      if (pending?.slug !== slug) {
        return c.redirect(`${connectionUrl(slug)}?error=confirm_failed`, 303);
      }
      await admin.unblock(ctx, slug, { confirmed: true });
      return done(c, 'unblocked', slug);
    }),
  );

  if (wakeUps) mountWakeUpRoutes(wakeUps);

  /** A mailbox's wake-up: set up or changed on its own page, tested and turned off from the mailbox's. */
  function mountWakeUpRoutes(wakeUps: WakeUps) {
    const PATH = '/ui/connections/:slug/mailboxes/:handle/wake-up';
    const where = (c: Context) => ({
      slug: c.req.param('slug') ?? '',
      handle: c.req.param('handle') ?? '',
    });
    const showForm = async (
      c: Context,
      session: Session,
      ctx: AdminContext,
      error?: {
        message: string;
        typed: {
          url: string;
          retryInterval: RetryInterval;
          maxRetries: number;
          token: boolean;
          signingSecret: boolean;
        };
      },
    ) => {
      const { slug, handle } = where(c);
      const connection = (await admin.overview(ctx)).find((x) => x.slug === slug);
      const mailbox = connection?.mailboxes.find((m) => m.handle === handle);
      if (!connection || !mailbox) {
        return notFound(c, session, ctx, notFoundPage(`${slug}/${handle}`, 'mailbox'));
      }
      // Archived, here by Back or an old link: its page says so, and how to restore it.
      if (connection.archivedAt !== null || mailbox.archivedAt !== null) {
        return c.redirect(`${mailboxUrl(slug, handle)}?error=archived_mailbox`, 303);
      }
      return render(c, session, ctx, {
        title: `Wake-up for ${slug}/${handle}`,
        active: 'connections',
        live: false,
        status: error ? 400 : 200,
        body: wakeUpForm({
          slug,
          handle,
          current: await wakeUps.view(ctx, slug, handle),
          csrf: session.csrf,
          hosts: wakeUps.hosts,
          error: error?.message,
          typed: error?.typed,
        }),
      });
    };

    app.get(
      PATH,
      page((c, session, ctx) => showForm(c, session, ctx)),
    );

    app.post(
      PATH,
      action(async (c, session, ctx, form) => {
        const { slug, handle } = where(c);
        const text = (name: string) => (typeof form[name] === 'string' ? form[name] : '');
        const retryInterval: RetryInterval = Object.hasOwn(RETRY_INTERVALS, text('interval'))
          ? (text('interval') as RetryInterval)
          : '15m';
        const maxRetries = /^\d$/.test(text('retries')) ? Number(text('retries')) : -1;
        try {
          await wakeUps.set(ctx, slug, handle, {
            url: text('url'),
            token: text('token'),
            noToken: text('no_token') === '1',
            signingSecret: text('signing_secret'),
            noSigning: text('no_signing') === '1',
            retryInterval,
            maxRetries,
          });
        } catch (err) {
          if (!(err instanceof AdminError) || err.code !== 'invalid_input') throw err;
          return showForm(c, session, ctx, {
            message: err.message,
            typed: {
              url: text('url'),
              retryInterval,
              maxRetries: Math.max(0, maxRetries),
              token: text('token') !== '',
              signingSecret: text('signing_secret') !== '',
            },
          });
        }
        return c.redirect(`${mailboxUrl(slug, handle)}?done=wake_up_set#wake-up`, 303);
      }),
    );

    app.post(
      `${PATH}/remove`,
      action(async (c, _s, ctx) => {
        const { slug, handle } = where(c);
        await wakeUps.remove(ctx, slug, handle);
        return c.redirect(`${mailboxUrl(slug, handle)}?done=wake_up_removed#wake-up`, 303);
      }),
    );

    app.post(
      `${PATH}/test`,
      action(async (c, _s, ctx) => {
        const { slug, handle } = where(c);
        const outcome = await wakeUps.test(ctx, slug, handle);
        const result = outcome.ok ? 'done=wake_up_tested' : 'error=wake_up_failed';
        return c.redirect(`${mailboxUrl(slug, handle)}?${result}#wake-up`, 303);
      }),
    );
  }

  /** Archiving a mailbox and restoring it: both reversible, so one click (design README). */
  for (const [verb, done] of [
    ['archive', 'mailbox_archived'],
    ['restore', 'mailbox_restored'],
  ] as const) {
    app.post(
      `/ui/connections/:slug/mailboxes/:handle/${verb}`,
      action(async (c, _s, ctx) => {
        const slug = c.req.param('slug') ?? '';
        const handle = c.req.param('handle') ?? '';
        if (verb === 'archive') await admin.archiveMailbox(ctx, slug, handle);
        else await admin.restoreMailbox(ctx, slug, handle);
        return c.redirect(`${mailboxUrl(slug, handle)}?done=${done}`, 303);
      }),
    );
  }

  app.post(
    '/ui/connections/:slug/label',
    action(async (c, _s, ctx, form) => {
      const slug = c.req.param('slug') ?? '';
      await admin.relabel(ctx, slug, typeof form.label === 'string' ? form.label : '');
      return done(c, 'relabelled', slug);
    }),
  );

  // ---- Connections with API keys (hosted mode, ADR 0016).

  if (keys) mountKeyRoutes(keys);

  function mountKeyRoutes(keys: ConnectionKeys) {
    const keyShown = (
      c: Context,
      session: Session,
      ctx: AdminContext,
      shown: { slug: string; key: string; replaced: boolean },
    ) =>
      render(c, session, ctx, {
        title: `Key for ${shown.slug}`,
        active: 'connections',
        live: false,
        body: keyShownPage({ ...shown, mcpUrl: web.mcpUrl(c) }),
      });

    app.post(
      NEW_CONNECTION_URL,
      action(async (c, session, ctx, form) => {
        if (session.accountId === undefined) return web.refused(c);
        const name = typeof form.name === 'string' ? form.name : '';
        const label = typeof form.label === 'string' ? form.label : '';
        try {
          const created = await keys.create(ctx, session.accountId, { name, label });
          return await keyShown(c, session, ctx, {
            slug: created.connection.slug,
            key: created.key,
            replaced: false,
          });
        } catch (err) {
          if (!(err instanceof AdminError)) throw err;
          // Sending the form again (a reload) finds the name taken: the key was shown once already.
          const taken = (await admin.connections(ctx)).find(
            (x) => x.slug === name.trim().toLowerCase(),
          );
          const justMade =
            taken?.kind === 'key' && taken.createdAt > clock() - RECENT_KEY_CONNECTION_MS;
          return render(c, session, ctx, {
            title: 'New connection',
            active: 'connections',
            live: false,
            status: 400,
            body: newConnectionPage({
              mcpUrl: web.mcpUrl(c),
              keyForm: {
                csrf: session.csrf,
                name,
                label,
                error: justMade
                  ? `${err.message} If you just created it, its key was shown once: open ${taken.slug} and replace its key.`
                  : err.message,
                nameInvalid: err.code !== 'connection_limit',
                full: false,
              },
            }),
          });
        }
      }),
    );

    /** Gives a key connection a key: at once if it has none, after a confirm if that replaces one. */
    app.post(
      '/ui/connections/:slug/key',
      action(async (c, session, ctx) => {
        const slug = c.req.param('slug') ?? '';
        if (session.accountId === undefined) return web.refused(c);
        if (await keys.hasKey(ctx, slug)) {
          const nonce = web.sessions.addPending(session, { kind: 'rotate', slug });
          return confirmStep(c, slug, nonce);
        }
        const key = await keys.rotate(ctx, session.accountId, slug);
        return keyShown(c, session, ctx, { slug, key, replaced: false });
      }),
    );

    app.post(
      '/ui/connections/:slug/key/confirm',
      action(async (c, session, ctx, form) => {
        const slug = c.req.param('slug') ?? '';
        if (session.accountId === undefined) return web.refused(c);
        const nonce = typeof form.nonce === 'string' ? form.nonce : undefined;
        const pending = web.sessions.takePending(session, nonce, 'rotate');
        if (pending?.slug !== slug) {
          return c.redirect(`${connectionUrl(slug)}?error=confirm_failed`, 303);
        }
        const key = await keys.rotate(ctx, session.accountId, slug);
        return keyShown(c, session, ctx, { slug, key, replaced: true });
      }),
    );

    app.post(
      '/ui/connections/:slug/key/revoke',
      action(async (c, _s, ctx) => {
        const slug = c.req.param('slug') ?? '';
        return (await keys.revoke(ctx, slug))
          ? done(c, 'key_revoked', slug)
          : c.redirect(`${connectionUrl(slug)}?error=no_key`, 303);
      }),
    );
  }

  /**
   * Step 1 of a policy change. Narrowing applies at once. Widening only records
   * a pending change and shows a confirm dialog carrying a one-time nonce bound
   * to this session, so no single request can widen a policy (§9).
   */
  app.post(
    '/ui/connections/:slug/policy',
    action(async (c, session, ctx, form) => {
      const slug = c.req.param('slug') ?? '';
      const mode = form.mode;
      if (mode !== 'all' && mode !== 'allowlist') return c.text('Choose a mode.\n', 400);
      const raw = form.allowed;
      const allowed = (Array.isArray(raw) ? raw : raw === undefined ? [] : [raw]).filter(
        (v): v is string => typeof v === 'string',
      );
      const preview = await admin.previewPolicy(ctx, slug, { mode, allowed });
      if (!preview.changed) return done(c, 'policy_unchanged', slug);
      if (!preview.widened) {
        await admin.setPolicy(ctx, slug, preview.after);
        return done(c, 'policy_saved', slug);
      }
      const nonce = web.sessions.addPending(session, { kind: 'policy', slug, preview });
      return confirmStep(c, slug, nonce);
    }),
  );

  /** Step 2: the human confirmed in the dialog. Applies exactly the change they saw. */
  app.post(
    '/ui/connections/:slug/policy/confirm',
    action(async (c, session, ctx, form) => {
      const slug = c.req.param('slug') ?? '';
      const policyUrl = connectionUrl(slug);
      const nonce = typeof form.nonce === 'string' ? form.nonce : undefined;
      const pending = web.sessions.takePending(session, nonce, 'policy');
      if (pending?.slug !== slug) return c.redirect(`${policyUrl}?error=confirm_failed`, 303);
      const now = await admin.previewPolicy(ctx, slug, pending.preview.after);
      if (JSON.stringify(now.before) !== JSON.stringify(pending.preview.before)) {
        return c.redirect(`${policyUrl}?error=policy_changed`, 303);
      }
      await admin.setPolicy(ctx, slug, pending.preview.after, { confirmed: true });
      return done(c, 'widened', slug);
    }),
  );

  // ---- Erasing the workspace: type its name, then prove it's really them.

  const showErase = async (
    c: Context,
    session: Session,
    ctx: AdminContext,
    step: EraseStep,
    status?: 400 | 401 | 429,
  ) =>
    render(c, session, ctx, {
      title: 'Delete workspace',
      active: 'settings',
      live: false,
      status,
      body: erasePage({
        workspace: ctx.workspace.slug,
        mode: config.mode,
        connections: (await admin.connections(ctx))
          .map((x) => x.slug)
          .filter((s) => s !== SYSTEM_CONNECTION_SLUG),
        csrf: session.csrf,
        step,
      }),
    });

  app.get(
    '/ui/erase',
    page((c, session, ctx) =>
      showErase(c, session, ctx, {
        kind: 'name',
        error: c.req.query('error') === 'confirm_failed' ? ERASE_EXPIRED_REASON : undefined,
      }),
    ),
  );

  /** Step 1: the name typed matches. Step 2 is the password (local) or signing in again (hosted). */
  app.post(
    '/ui/erase',
    action(async (c, session, ctx, form) => {
      const typed = typeof form.confirm === 'string' ? form.confirm.trim() : '';
      if (typed !== ctx.workspace.slug) {
        const error = html`That isn't the workspace name. Type
          <code>${ctx.workspace.slug}</code> exactly.`;
        return showErase(c, session, ctx, { kind: 'name', error }, 400);
      }
      const nonce = web.sessions.addPending(session, {
        kind: 'erase',
        workspaceId: ctx.workspace.id,
      });
      return showErase(c, session, ctx, { kind: web.hosted ? 'reauth' : 'password', nonce });
    }),
  );

  /** Step 2, local mode: the UI password. Hosted mode signs in again instead (auth/browser.ts). */
  app.post(
    '/ui/erase/confirm',
    action(async (c, session, ctx, form) => {
      if (!localLogin) return web.refused(c);
      const nonce = typeof form.nonce === 'string' ? form.nonce : undefined;
      const pending = web.sessions.takePending(session, nonce, 'erase');
      if (pending?.workspaceId !== ctx.workspace.id) {
        return showErase(c, session, ctx, { kind: 'name', error: ERASE_EXPIRED_REASON }, 400);
      }
      const retry = (error: Html | string, status: 401 | 429) =>
        showErase(
          c,
          session,
          ctx,
          { kind: 'password', nonce: web.sessions.addPending(session, pending), error },
          status,
        );
      if (!localLogin.passwordAttempts.tryConsume('password', clock())) {
        return retry('Too many attempts. Wait a minute and try again.', 429);
      }
      const login = await auth.getLocalLogin();
      const password = typeof form.password === 'string' ? form.password : '';
      if (!login || !(await verifyPassword(password, login.passwordHash))) {
        return retry(
          html`Wrong password. Forgot it? Stop Budd, run
            <code class="cmd">npm run budd -- reset-login</code>, and start Budd again.`,
          401,
        );
      }
      await eraseWorkspace(gateway, web, ctx);
      web.clearSession(c);
      await gateway.adminLocal(clock()); // creates the new, empty workspace
      localLogin.restart();
      const setupUrl = localLogin.setupUrl(web.selfOrigin(c)) ?? '/setup';
      console.log(`\n  Workspace erased. Create a new UI login:  ${setupUrl}\n`);
      return c.html(
        messagePage(
          'Workspace deleted',
          'Budd erased the workspace and its login, and started a new, empty workspace. Create a login for it to use the UI again. The link is also printed in the terminal where Budd is running.',
          { href: setupUrl, label: 'Create a new login' },
        ),
      );
    }),
  );

  /** Server-sent events: "something changed" pings that make live pages refresh. */
  app.get('/ui/events', async (c) => {
    const session = web.current(c);
    const ctx = session && (await adminFor(session));
    if (!ctx) return c.text('Sign in first.\n', 401);
    // nginx buffers event streams by default, which would stall live updates.
    c.header('X-Accel-Buffering', 'no');
    return streamSSE(c, async (stream) => {
      const unsubscribe = events.subscribe(ctx.workspace.id, (e) => {
        void stream.writeSSE({ event: 'change', data: JSON.stringify({ kind: e.kind }) });
      });
      let end!: () => void;
      // Ends when the browser goes away, Budd shuts down (else shutdown would
      // hang), or the session ends: signed out, timed out or over its stream cap.
      const ended = new Promise<void>((resolve) => {
        end = () => {
          shutdown.removeEventListener('abort', end);
          resolve();
        };
      });
      const release = web.sessions.openStream(session, end);
      stream.onAbort(end);
      shutdown.addEventListener('abort', end);
      if (shutdown.aborted) end();
      const heartbeat = setInterval(() => {
        if (web.sessions.isLive(session)) void stream.write(': ping\n\n');
        else end();
      }, HEARTBEAT_MS);
      await stream.writeSSE({ event: 'ready', data: '{}' });
      await ended;
      clearInterval(heartbeat);
      release();
      unsubscribe();
    });
  });
}

import { html } from 'hono/html';
import { CSS_URL, JS_URL } from './assets.js';
import type { Theme } from '../domain/auth.js';
import { csrfField, ICONS, type Html } from './html.js';
import { favicon, wordmarkFor } from './logo.js';

/** The header's sections; `settings` is the profile menu's page. */
export type Section = 'connections' | 'messages' | 'audit' | 'settings';

/** Who is signed in, for the profile menu. */
export interface Profile {
  /** Their name from the sign-in provider, else their email or the local username. */
  name: string;
  /** An https picture URL from the sign-in provider, if any. */
  picture: string | null;
  theme: Theme;
  csrf: string;
}

/** A workspace page: the app header and the page. */
export function layout(opts: {
  title: string;
  active?: Section | undefined;
  live: boolean;
  workspace: string;
  account?: Profile | undefined;
  /** Shows Console in the account menu. */
  operator?: boolean | undefined;
  /** Long lists (messages, audit log): on big screens the header and filters stay put while the list scrolls. */
  pinned?: boolean | undefined;
  body: Html;
}): Html {
  const link = (href: string, key: Section, label: string) =>
    html`<a href="${href}" ${opts.active === key ? html`aria-current="page"` : ''}>${label}</a>`;
  return page({
    title: `${opts.title} · Budd`,
    theme: opts.account?.theme,
    pinned: opts.pinned,
    header: html`<header class="app-header">
      <a class="brand" href="/ui">${wordmarkFor(opts.account?.theme)}</a>
      <nav aria-label="Sections">
        ${link('/ui', 'connections', 'Connections')} ${link('/ui/messages', 'messages', 'Messages')}
        ${link('/ui/audit', 'audit', 'Audit log')}
      </nav>
      <div class="end">
        ${opts.live ? html`<span class="live" hidden>Live</span>` : ''}
        ${
          opts.account
            ? profileMenu(opts.account, opts.workspace, {
                active: opts.active === 'settings' ? 'settings' : undefined,
                operator: opts.operator ?? false,
              })
            : ''
        }
      </div>
    </header>`,
    main: html`<main ${opts.live ? html`data-live` : ''}>${opts.body}</main>`,
  });
}

/** The document around a workspace or console page. */
export function page(opts: {
  title: string;
  theme: Theme | undefined;
  pinned?: boolean | undefined;
  header: Html;
  main: Html;
}): Html {
  return html`<!doctype html>
    <html
      lang="en"
      ${opts.theme && opts.theme !== 'system' ? html`data-theme="${opts.theme}"` : ''}
    >
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>${opts.title}</title>
        ${favicon}
        <link rel="stylesheet" href="${CSS_URL}" />
        <script src="${JS_URL}" defer></script>
      </head>
      <body ${opts.pinned ? html`class="pinned"` : ''}>
        ${opts.header} ${opts.main}
      </body>
    </html>`;
}

/**
 * The signed-in person's picture (or initial) and name, opening a menu: the
 * workspace (back to its pages), Settings, the operator console for
 * operators, and Sign out. The console shows the same menu, signing out
 * through its own form. A <details>, so it works without JS.
 */
export function profileMenu(
  p: Profile,
  workspace: string,
  opts: { active: 'settings' | 'console' | undefined; operator: boolean; logout?: string },
) {
  const current = (page: 'settings' | 'console') =>
    opts.active === page ? html`aria-current="page"` : '';
  return html`<details class="profile" data-menu>
    <summary
      aria-label="${p.name}: workspace, settings${opts.operator ? ', console' : ''} and sign out"
    >
      ${
        p.picture
          ? html`<img
              class="avatar"
              src="${p.picture}"
              alt=""
              referrerpolicy="no-referrer"
              data-initial="${initial(p.name)}"
            />`
          : html`<span class="avatar initial" aria-hidden="true">${initial(p.name)}</span>`
      }
      <span class="who">${p.name}</span>
    </summary>
    <div class="menu">
      <p class="menu-workspace">
        <span class="label">Workspace</span><a class="name" href="/ui">${workspace}</a>
      </p>
      <nav aria-label="Account">
        <a href="/ui/settings" ${current('settings')}>Settings</a>
        ${
          !opts.operator
            ? ''
            : opts.active === 'console'
              ? html`<a href="/console" ${current('console')}>Console</a>`
              : html`<a class="out" href="/console" target="_blank" title="Opens in a new tab"
                  ><span class="lead">Console</span>${ICONS.newTab}<span class="sr-only">
                    (opens in a new tab)</span
                  ></a
                >`
        }
      </nav>
      <form method="post" action="${opts.logout ?? '/logout'}">
        ${csrfField(p.csrf)}
        <button class="btn quiet">Sign out</button>
      </form>
    </div>
  </details>`;
}

const initial = (name: string) => (name.trim()[0] ?? '?').toUpperCase();

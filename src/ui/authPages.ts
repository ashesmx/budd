import { html } from 'hono/html';
import { CSS_URL, JS_URL } from './assets.js';
import type { Connection, Workspace } from '../domain/types.js';
import { connectionUrl, notice, type Html } from './html.js';
import { favicon, wordmark, wordmarkFor } from './logo.js';

/** A standalone page (no navigation): sign-in, sign-out, consent, errors. */
export function plainPage(
  title: string,
  body: Html,
  {
    width = 'narrow',
    refreshTo,
    console = false,
  }: { width?: 'narrow' | 'wide'; refreshTo?: string; console?: boolean } = {},
): Html {
  return html`<!doctype html>
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        ${
          refreshTo === undefined
            ? ''
            : html`<meta http-equiv="refresh" content="0;url=${refreshTo}" />`
        }
        <title>${title} · Budd${console ? ' console' : ''}</title>
        ${favicon}
        <link rel="stylesheet" href="${CSS_URL}" />
        <script src="${JS_URL}" defer></script>
      </head>
      <body class="standalone">
        ${
          console
            ? html`<header class="app-header op-header">
                <div class="id">
                  <span class="brand"
                    >${wordmarkFor('dark')}<span class="op-tag">Console</span></span
                  >
                </div>
              </header>`
            : html`<header class="app-header">
                <div class="id"><span class="brand">${wordmark}</span></div>
              </header>`
        }
        <main class="${width}">${body}</main>
      </body>
    </html>`;
}

/**
 * A page that moves the browser on to `to` from Budd's own origin, as a fresh
 * navigation. Used after a cross-site arrival (from the identity provider or
 * an MCP client), so the next request carries Budd's SameSite=Strict session
 * cookie, and after a form POST that leads off-site, which `form-action 'self'`
 * would block as a redirect (ADR 0014).
 */
export const continuePage = (opts: {
  to: string;
  title: string;
  message: Html | string;
  link?: { lead: string; label: string };
}) =>
  plainPage(
    opts.title,
    html`<h1>${opts.title}</h1>
      <p>${opts.message}</p>
      <p>${opts.link?.lead ?? ''} <a href="${opts.to}">${opts.link?.label ?? 'Continue'}</a></p>`,
    { refreshTo: opts.to },
  );

/** Approved, but the app's connection is blocked or archived: what to fix, and where. */
export function notConnectedPage(opts: {
  clientName: string | null;
  connection: string;
  workspace: string;
  archived: boolean;
  /** Unset when the UI would open another workspace, which has no switcher yet. */
  connectionUrl: string | undefined;
  returnUrl: string;
}): Html {
  const name = html`<code>${opts.connection}</code>`;
  const state = opts.archived ? 'archived' : 'blocked';
  return plainPage(
    'Not connected',
    html`<div class="page-head">
        <h1>${opts.clientName ? html`<q>${opts.clientName}</q>` : 'This app'} wasn’t connected</h1>
      </div>
      ${notice(
        'bad',
        `Its connection is ${state}.`,
        html`Budd didn’t let it back into workspace <code>${opts.workspace}</code>. Nothing changed.`,
      )}
      <p>
        To connect it,
        ${opts.archived ? html`restore ${name}, then unblock it,` : html`unblock ${name}`}
        ${
          opts.connectionUrl === undefined
            ? html`under Connections in workspace <code>${opts.workspace}</code>`
            : 'on its page in Budd'
        },
        then go back to the app and connect again.
      </p>
      <p class="actions">
        ${
          opts.connectionUrl === undefined
            ? ''
            : html`<a class="btn primary" href="${opts.connectionUrl}"
                >Open connection ${opts.connection}</a
              >`
        }
        <a class="btn" href="${opts.returnUrl}">Return to the app</a>
      </p>`,
  );
}

/** A new app would take the workspace over its connection cap. */
export function connectionLimitPage(opts: {
  clientName: string | null;
  workspace: string;
  returnUrl: string;
}): Html {
  return plainPage(
    'Not connected',
    html`<div class="page-head">
        <h1>${opts.clientName ? html`<q>${opts.clientName}</q>` : 'This app'} wasn’t connected</h1>
      </div>
      ${notice(
        'bad',
        'Workspace full.',
        html`Workspace <code>${opts.workspace}</code> already has the most connections it may have.
          Nothing changed.`,
      )}
      <p>
        To connect it, archive a connection you no longer use under Connections, then go back to the
        app and connect again.
      </p>
      <p class="actions">
        <a class="btn primary" href="/ui">Open Connections</a>
        <a class="btn" href="${opts.returnUrl}">Return to the app</a>
      </p>`,
  );
}

export const messagePage = (
  title: string,
  message: string | Html,
  link?: { href: string; label: string },
) =>
  plainPage(
    title,
    html`<h1>${title}</h1>
      <p>${message}</p>
      ${link ? html`<p class="actions"><a class="btn primary" href="${link.href}">${link.label}</a></p>` : ''}`,
  );

/** A connection with the app's name that the consent screen doesn't offer, and why. */
export interface Resume {
  slug: string;
  /** Its app returns to the same place, so blocking it in Budd would offer it. */
  blockFirst: boolean;
}

export function consentPage(opts: {
  clientName: string | null;
  redirectHost: string;
  /**
   * Set when the app returns to this computer (http on loopback). Any program
   * here can listen there, so the screen warns (MCP authorization spec);
   * `other-port` means the port differs from the one the app registered.
   */
  loopback?: 'same-port' | 'other-port' | undefined;
  workspaces: Workspace[];
  connections: Map<string, string | undefined>;
  /** Connections the app may take over instead of getting a new one (ADR 0011). */
  attachable: Connection[];
  /** A connection with the app's name that isn't offered, and whether blocking it would be. */
  resume?: Resume | undefined;
  /** The workspace has no room for a new connection, so only a takeover can be approved. */
  full?: boolean;
  slugBase: string;
  nonce: string;
  csrf: string;
  email: string;
}): Html {
  const name = opts.clientName ?? 'An unnamed app';
  const only = opts.workspaces.length === 1 ? opts.workspaces[0] : undefined;
  const existing = only ? opts.connections.get(only.id) : undefined;
  const full = !existing && opts.full === true;
  const blocked = full && opts.attachable.length === 0;
  return plainPage(
    'Connect an app',
    html`<div class="page-head">
        <h1>Connect <q>${name}</q> to Budd?</h1>
        <p class="lede">
          <span class="tag unverified">unverified</span> The app chose this name itself; Budd can't
          check it. After you decide, you'll go back to <code>${opts.redirectHost}</code>.
        </p>
      </div>
      ${
        opts.loopback
          ? notice(
              'warn',
              'Check first.',
              html`This app returns to a program on your own computer. Approve only if you started
              connecting an app just now.
              ${
                opts.loopback === 'other-port'
                  ? html`It registered a different port, which apps that pick a free port each time
                    do, but so could another program pretending to be it.`
                  : ''
              }`,
            )
          : ''
      }
      ${
        full
          ? notice(
              blocked ? 'bad' : 'warn',
              'Workspace full.',
              html`Workspace <code>${only?.slug ?? ''}</code> already has the most connections it
                may have, so
                ${blocked ? 'this app can’t be added' : 'it can only take over one below'}.
                ${
                  opts.resume?.blockFirst
                    ? ''
                    : 'To add it, archive a connection you no longer use under Connections, then connect the app again.'
                }`,
            )
          : ''
      }
      <p ${blocked ? 'hidden' : ''}>
        If you approve, it can send and read messages in your workspace as one connection.
        ${
          existing
            ? html`It will use its existing connection <code>${existing}</code>.`
            : opts.attachable.length > 0
              ? html`Choose below whether it gets a new connection or takes over one it had before.`
              : html`It will be added as a new connection named <code>${opts.slugBase}</code> (with
                  a number added if that name is taken).`
        }
        New connections accept messages from no one until you change their policy.
      </p>
      ${
        !existing && opts.resume
          ? html`<p class="muted">
              ${
                opts.resume.blockFirst
                  ? html`To use your existing connection <code>${opts.resume.slug}</code> instead,
                      <a href="${connectionUrl(opts.resume.slug)}">block it in Budd</a> (this signs
                      out the app using it), then, within the hour, start connecting again from the
                      app itself, not from a link.`
                  : html`It can’t take over <code>${opts.resume.slug}</code>: that connection
                      belongs to an app that returns to a different address.`
              }
            </p>`
          : ''
      }
      <form method="post" action="/authorize">
        <input type="hidden" name="_csrf" value="${opts.csrf}" />
        <input type="hidden" name="nonce" value="${opts.nonce}" />
        ${
          existing || opts.attachable.length === 0
            ? ''
            : html`<fieldset>
                <legend>Which connection should it use?</legend>
                ${
                  full
                    ? ''
                    : html`<label class="choice"
                        ><input type="radio" name="connection" value="new" checked /> A new
                        connection, <code>${opts.slugBase}</code></label
                      >`
                }
                ${opts.attachable.map(
                  (x) =>
                    html`<label class="choice"
                      ><input
                        type="radio"
                        name="connection"
                        value="${x.id}"
                        ${full ? 'required' : ''}
                      />
                      Existing
                      <code>${x.slug}</code>${
                        x.label ? html` <span class="muted">(${x.label})</span>` : ''
                      }</label
                    >`,
                )}
                <p class="hint">
                  These are connections you blocked. Pick one only if this is the same app
                  connecting again (for example, after you removed and re-added it). It takes over
                  that connection's name, policy and mailboxes, and the connection is unblocked.
                  Budd can’t check that it is the same app.
                </p>
              </fieldset>`
        }
        ${
          only
            ? html`<input type="hidden" name="workspace" value="${only.id}" />`
            : html`<fieldset>
                <legend>Which workspace should it join?</legend>
                ${opts.workspaces.map(
                  (w, i) =>
                    html`<label class="choice"
                      ><input
                        type="radio"
                        name="workspace"
                        value="${w.id}"
                        ${i === 0 ? 'checked' : ''}
                      />
                      <code>${w.slug}</code>${
                        opts.connections.get(w.id)
                          ? html` (existing connection <code>${opts.connections.get(w.id)}</code>)`
                          : ''
                      }</label
                    >`,
                )}
              </fieldset>`
        }
        <div class="actions">
          ${
            blocked
              ? html`<a class="btn primary" href="/ui">Open Connections</a>
                  <button name="decision" value="deny">Return to the app</button>`
              : html`<button class="later" name="decision" value="deny" autofocus>Deny</button>
                  <button class="btn primary" name="decision" value="approve">Approve</button>`
          }
          <span class="aside muted"
            >${only ? html`Workspace <code>${only.slug}</code> · ` : ''}signed in as
            ${opts.email}</span
          >
        </div>
      </form>`,
    { width: 'wide' },
  );
}

/**
 * The second step before an app takes over an existing connection (ADR 0011):
 * it says what the app gets and who loses access, because Budd can't check it's
 * the same app.
 */
export function takeoverPage(opts: {
  clientName: string | null;
  connection: Connection;
  workspaceId: string;
  nonce: string;
  csrf: string;
}): Html {
  const name = opts.clientName ?? 'this unnamed app';
  const slug = opts.connection.slug;
  return plainPage(
    'Take over a connection',
    html`<div class="page-head">
        <h1>Give <code>${slug}</code> to <q>${name}</q>?</h1>
        <p class="lede">
          Do this only if it's the same app connecting again, for example after you removed and
          re-added it. Budd can't check that it is.
        </p>
      </div>
      ${notice(
        'warn',
        'Check first.',
        html`<q>${name}</q> will act as <code>${slug}</code>: it can read the unread messages
          waiting in <code>${slug}</code>'s mailboxes, new messages to them go to it, and it gets
          its contact policy. <code>${slug}</code> is blocked: giving it to <q>${name}</q> unblocks
          it, so other connections can message it again as its policy allows.`,
      )}
      <form method="post" action="/authorize">
        <input type="hidden" name="_csrf" value="${opts.csrf}" />
        <input type="hidden" name="nonce" value="${opts.nonce}" />
        <input type="hidden" name="workspace" value="${opts.workspaceId}" />
        <div class="actions">
          <button class="later" name="choice" value="deny" autofocus>Deny</button>
          <button class="btn primary" name="choice" value="new">Give it a new connection</button>
          <button class="btn danger" name="choice" value="takeover">Give ${slug} to ${name}</button>
        </div>
      </form>`,
    { width: 'wide' },
  );
}

export function setupPage(opts: {
  code: string;
  csrf: string;
  error?: string | undefined;
  username?: string;
}): Html {
  return plainPage(
    'Create your login',
    html`<h1>Create your Budd login</h1>
      <p class="lede">
        The Budd UI controls who your AI apps may message, so it needs a login. Choose a username
        and a password of at least 8 characters. You'll use them to sign in to this page from now
        on.
      </p>
      ${opts.error ? notice('bad', opts.error) : ''}
      <form method="post" action="/setup" class="below">
        <input type="hidden" name="_csrf" value="${opts.csrf}" />
        <input type="hidden" name="code" value="${opts.code}" />
        <div class="field">
          <label for="username">Username</label>
          <input
            id="username"
            type="text"
            name="username"
            autocomplete="username"
            value="${opts.username ?? ''}"
            ${opts.error && !opts.username ? 'autofocus' : ''}
            required
          />
        </div>
        <div class="field">
          <label for="password">Password</label>
          <input
            id="password"
            type="password"
            name="password"
            ${opts.error && opts.username ? 'autofocus' : ''}
            autocomplete="new-password"
            minlength="8"
            required
          />
          <span class="hint">At least 8 characters.</span>
        </div>
        <div class="field">
          <label for="confirm">Password again</label>
          <input
            id="confirm"
            type="password"
            name="confirm"
            autocomplete="new-password"
            minlength="8"
            required
          />
        </div>
        <button class="btn primary">Create login</button>
      </form>`,
  );
}

const signInHead = html`<div class="page-head">
  <h1>Sign in to Budd</h1>
  <p class="lede">
    Budd lets your AI apps message each other. Sign in to see the apps connected to your workspace,
    their messages, and who may message whom.
  </p>
</div>`;

/** For someone who found Budd's address: how an app connects, without signing in. */
const connectingAnApp = (mcpUrl: string, hosted: boolean) =>
  html`<section>
    <h2>Connecting an AI app?</h2>
    <p>
      Add Budd to the app as an MCP server at <code>${mcpUrl}</code>${
        hosted
          ? '.'
          : html`, where <code>&lt;name&gt;</code> is a name you choose for the app, such as
              <code>claude-desktop</code>.`
      }
    </p>
    <p class="muted">
      ${
        hosted
          ? 'The app then opens Budd in your browser, so you can sign in and approve it.'
          : 'The app appears under Connections the first time it calls Budd.'
      }
    </p>
  </section>`;

/** Hosted mode's landing page: nothing happens until the person chooses to sign in. */
export function landingPage(opts: {
  returnTo: string;
  providerHost: string;
  /** Only a domain the provider redirect already names (`hd`), never a list. */
  domain: string | undefined;
  mcpUrl: string;
  /** On the way to an app's consent screen: the page says so, and skips how to connect one. */
  forApp: boolean;
}): Html {
  return plainPage(
    'Sign in',
    html`${
        opts.forApp
          ? html`<div class="page-head">
              <h1>Sign in to Budd</h1>
              <p class="lede">
                An app wants to connect to your Budd workspace. Sign in, then approve or deny it.
              </p>
            </div>`
          : signInHead
      }
      <form method="post" action="/login" class="actions">
        <input type="hidden" name="return" value="${opts.returnTo}" />
        <button class="btn primary">Sign in</button>
        <span class="muted"
          >You’ll sign in at <code>${opts.providerHost}</code>${
            opts.domain === undefined ? '' : html` with your <code>${opts.domain}</code> account`
          }.</span
        >
      </form>
      <p class="muted">New to Budd? Signing in creates your own workspace.</p>
      ${opts.forApp ? '' : connectingAnApp(opts.mcpUrl, true)}`,
  );
}

/** Why signing in failed, as a notice: a lead, then what to do. */
export interface LoginError {
  lead: string;
  detail?: Html;
  /** Steps to try, shown under the notice. */
  list?: Html[];
  after?: string;
}

export function localLoginPage(opts: {
  csrf: string;
  returnTo: string;
  mcpUrl: string;
  error?: LoginError | undefined;
  username?: string;
}): Html {
  return plainPage(
    'Sign in',
    html`${signInHead} ${opts.error ? notice('bad', opts.error.lead, opts.error.detail) : ''}
      ${
        opts.error?.list
          ? html`<ul>
              ${opts.error.list.map((item) => html`<li>${item}</li>`)}
            </ul>`
          : ''
      }
      ${opts.error?.after ? html`<p>${opts.error.after}</p>` : ''}
      <form method="post" action="/login">
        <input type="hidden" name="_csrf" value="${opts.csrf}" />
        <input type="hidden" name="return" value="${opts.returnTo}" />
        <div class="field">
          <label for="username">Username</label>
          <input
            id="username"
            type="text"
            name="username"
            autocomplete="username"
            value="${opts.username ?? ''}"
            required
          />
        </div>
        <div class="field">
          <label for="password">Password</label>
          <input
            id="password"
            type="password"
            name="password"
            ${opts.error ? 'autofocus' : ''}
            autocomplete="current-password"
            required
          />
        </div>
        <button class="btn primary">Sign in</button>
      </form>
      <p class="muted below">
        Forgot it? Stop Budd, run <code class="cmd">npm run budd -- reset-login</code>, and start
        Budd again: it prints a link to create a new login.
      </p>
      ${connectingAnApp(opts.mcpUrl, false)}`,
  );
}

/** Local mode: the page a `budd login` link opens. Signing in takes a click, so a link preview can't use it up. */
export function loginLinkPage(opts: { code: string; csrf: string; validFor: string }): Html {
  return plainPage(
    'Sign in',
    html`<div class="page-head">
        <h1>Sign in to Budd</h1>
        <p class="lede">
          This link from <code class="cmd">npm run budd -- login</code> signs you in once, within
          ${opts.validFor} of making it.
        </p>
      </div>
      <form method="post" action="/login/link">
        <input type="hidden" name="_csrf" value="${opts.csrf}" />
        <input type="hidden" name="code" value="${opts.code}" />
        <button class="btn primary">Sign in</button>
      </form>`,
  );
}

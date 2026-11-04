import { html } from 'hono/html';
import type { Theme } from '../domain/auth.js';
import { crumbs, csrfField, list, notice, plural, type Html } from './html.js';

const THEMES: [Theme, string][] = [
  ['system', 'Same as this device'],
  ['light', 'Light'],
  ['dark', 'Dark'],
];

/** Everything a person can see or change about their account and this workspace, on one page. */
export function settingsPage(opts: {
  workspace: string;
  mode: 'local' | 'hosted';
  retention: string;
  deliveryTtl: string;
  connections: { active: number; archived: number };
  /** Hosted: the email and the identity provider's host. Local: the UI login's username. */
  account: { email: string; provider: string } | { username: string } | undefined;
  theme: Theme;
  csrf: string;
  version: string;
  saved?: boolean | undefined;
}): Html {
  const { account } = opts;
  return html`<div class="page-head">
      <h1>Settings</h1>
      <p class="lede">
        Your account and this workspace. Settings for the whole of Budd are in its
        <code>.env</code> file, which whoever runs Budd controls.
      </p>
    </div>
    ${opts.saved ? notice('ok', 'Saved.', 'Your theme applies on every device you sign in on.') : ''}
    <section class="group" id="appearance">
      <h2>Appearance</h2>
      <form class="item block" method="post" action="/ui/settings/preferences">
        ${csrfField(opts.csrf)}
        <fieldset>
          <legend>Theme, saved to your account</legend>
          ${THEMES.map(
            ([value, text]) =>
              html`<label class="choice"
                ><input
                  type="radio"
                  name="theme"
                  value="${value}"
                  ${opts.theme === value ? 'checked' : ''}
                />
                ${text}</label
              >`,
          )}
        </fieldset>
        <button class="btn primary">Save theme</button>
      </form>
    </section>

    <section class="group" id="account">
      <h2>Your account</h2>
      <div class="item">
        <dl class="facts">
          ${
            account === undefined
              ? ''
              : 'email' in account
                ? html`<dt>Signed in as</dt>
                    <dd>${account.email}</dd>
                    <dt>Through</dt>
                    <dd><code>${account.provider}</code></dd>`
                : html`<dt>Username</dt>
                    <dd>${account.username}</dd>`
          }
        </dl>
      </div>
    </section>

    <section class="group" id="workspace">
      <h2>Workspace</h2>
      <div class="item">
        <dl class="facts">
          <dt>Name</dt>
          <dd><code>${opts.workspace}</code></dd>
          <dt>Unread messages expire after</dt>
          <dd>${opts.deliveryTtl}, unless the sender chose otherwise</dd>
          <dt>Messages kept for</dt>
          <dd>${opts.retention}</dd>
          <dt>Connections</dt>
          <dd>
            <a href="/ui?view=table">${plural(opts.connections.active, 'connection')}</a>${
              opts.connections.archived > 0 ? html`, and ${opts.connections.archived} archived` : ''
            }
          </dd>
        </dl>
      </div>
    </section>

    <section class="group" id="about">
      <h2>About Budd</h2>
      <div class="item">
        <dl class="facts">
          <dt>Version</dt>
          <dd><code>${opts.version}</code></dd>
          <dt>Mode</dt>
          <dd>
            ${
              opts.mode === 'hosted'
                ? "Hosted: people sign in with this Budd's sign-in provider"
                : 'Local: Budd runs on this computer for you alone'
            }
          </dd>
        </dl>
      </div>
    </section>

    <section class="group danger">
      <h2>Can't be undone</h2>
      <div class="item">
        <div class="what">
          <strong>Delete this workspace</strong>
          <p>
            Deletes its connections, messages and audit log, and signs out every connected app.
            ${opts.mode === 'hosted' ? 'It deletes your Budd account too.' : 'Budd then starts a new, empty workspace.'}
          </p>
        </div>
        <a class="btn danger" href="/ui/erase">Delete workspace…</a>
      </div>
    </section>`;
}

/** Where the human is in erasing the workspace; each step can carry an error. */
export type EraseStep = { error?: Html | string | undefined } & (
  { kind: 'name' } | { kind: 'password' | 'reauth'; nonce: string }
);

export function erasePage(opts: {
  workspace: string;
  mode: 'local' | 'hosted';
  connections: string[];
  csrf: string;
  step: EraseStep;
}): Html {
  const { workspace, mode, connections, csrf, step } = opts;
  const nonceField =
    step.kind === 'name' ? '' : html`<input type="hidden" name="nonce" value="${step.nonce}" />`;
  const cancel = html`<a class="btn quiet" href="/ui/settings">Cancel</a>`;
  const backups =
    mode === 'hosted'
      ? "Backups taken before now still contain this workspace, and Budd's logs keep your email until they rotate."
      : 'Backups taken before now still contain this workspace.';
  return html`${crumbs(['Settings', '/ui/settings'], 'Delete workspace')}
    <div class="page-head">
      <h1>Delete workspace <code>${workspace}</code></h1>
      <p class="lede">
        ${
          step.kind === 'name'
            ? 'Step 1 of 2: confirm which workspace.'
            : "Step 2 of 2: you typed the name; now prove it's you."
        }
      </p>
    </div>
    ${step.error ? notice('bad', 'Nothing was deleted.', step.error) : ''}
    <section class="group danger">
      <h2>This can't be undone</h2>
      <div class="item block">
        <p>Deleting it removes:</p>
        <ul>
          <li>
            ${
              connections.length === 0
                ? 'its connections (there are none yet)'
                : html`its ${plural(connections.length, 'connection')}: ${list(connections)}`
            }
          </li>
          <li>every message and the whole audit log</li>
          ${
            mode === 'hosted'
              ? html`<li>the sign-in of every app connected to it, so they stop working at once</li>
                  <li>your Budd account. Signing in again starts a new, empty workspace.</li>`
              : html`<li>
                  the UI login. Budd starts a new, empty workspace, and you create a new login. Apps
                  that use their MCP address again come back as new connections.
                </li>`
          }
        </ul>
        <p class="muted">${backups} Ask whoever runs Budd to delete them if they must go too.</p>
      </div>
      ${
        step.kind === 'name'
          ? html`<form class="item block" method="post" action="/ui/erase">
              ${csrfField(csrf)}
              <div class="field">
                <label for="confirm"
                  >To confirm, type the workspace name, <code>${workspace}</code></label
                >
                <input id="confirm" type="text" name="confirm" autocomplete="off" required />
              </div>
              <div class="actions">
                <button class="btn danger">Next: prove it's you…</button>
                ${cancel}
              </div>
            </form>`
          : step.kind === 'password'
            ? html`<form class="item block" method="post" action="/ui/erase/confirm">
                ${csrfField(csrf)} ${nonceField}
                <div class="field">
                  <label for="password">To prove it's you, enter your Budd password</label>
                  <input
                    id="password"
                    type="password"
                    name="password"
                    autocomplete="current-password"
                    required
                  />
                </div>
                <div class="actions">
                  <button class="btn destroy">Delete workspace</button>
                  ${cancel}
                </div>
              </form>`
            : html`<form class="item block" method="post" action="/ui/erase/reauth">
                ${csrfField(csrf)} ${nonceField}
                <p>
                  Sign in again with your sign-in provider. Budd deletes the workspace as soon as
                  you have.
                </p>
                <div class="actions">
                  <button class="btn destroy">Sign in again and delete</button>
                  ${cancel}
                </div>
              </form>`
      }
    </section>`;
}

import { html } from 'hono/html';
import {
  MAX_RETRIES,
  RETRY_INTERVALS,
  type RetryInterval,
  type WakeUpView,
} from '../wakeups/WakeUps.js';
import {
  connectionUrl,
  crumbs,
  csrfField,
  list,
  mailboxUrl,
  notice,
  plural,
  time,
  type Html,
} from './html.js';

const INTERVAL_WORDS: Record<RetryInterval, string> = {
  '5m': '5 minutes',
  '15m': '15 minutes',
  '1h': 'hour',
};

const wakeUpUrl = (slug: string, handle: string) => `${mailboxUrl(slug, handle)}/wake-up`;

/** The mailbox page's Wake-up section: off, with a way to set one up, or what it does and how it last went. */
export function wakeUpSection(opts: {
  slug: string;
  handle: string;
  wakeUp: WakeUpView | undefined;
  /** Its connection is blocked: Budd won't wake it until it's unblocked. */
  paused: boolean;
  csrf: string;
}): Html {
  const { slug, handle, wakeUp: w, csrf } = opts;
  const url = wakeUpUrl(slug, handle);
  if (!w) {
    return html`<section class="group" id="wake-up">
      <h2>Wake-up</h2>
      <div class="item">
        <div class="what">
          <strong>Off</strong>
          <p>
            Budd can tell this agent's platform when the mailbox has mail, so the agent needn't keep
            checking. Works with Claude Code routines, Grok Bot and Multica.
          </p>
        </div>
        <a class="btn" href="${url}">Set up a wake-up…</a>
      </div>
    </section>`;
  }
  return html`<section class="group" id="wake-up">
    <h2>Wake-up</h2>
    ${
      w.unreadable
        ? html`<div class="item">
            ${notice(
              'warn',
              'Enter the wake-up again.',
              "Budd can't read the saved address, token or signing secret, so it isn't sending wake-ups. This happens after restoring only part of a backup, or if BUDD_SECRET_KEY changed: if Budd won't save, ask whoever runs it.",
              { live: false },
            )}
          </div>`
        : w.hostNotAllowed
          ? html`<div class="item">
              ${notice(
                'warn',
                'Not sending.',
                html`Budd no longer sends wake-ups to <code>${w.host}</code>. Change the address, or
                  ask whoever runs Budd to add it to <code>WAKE_UP_HOSTS</code>.`,
                { live: false },
              )}
            </div>`
          : opts.paused
            ? html`<div class="item">
                ${notice(
                  'warn',
                  'Paused.',
                  html`<code>${slug}</code> is blocked, so Budd doesn't wake it. Unblock it to
                    resume.`,
                  { live: false },
                )}
              </div>`
            : ''
    }
    <div class="item">
      <div class="what">
        <strong>${wakeUpState(w, opts.paused)}: wakes <code>${w.host}</code></strong>
        <p>
          ${
            w.tokenHint === null
              ? 'With no token'
              : w.tokenHint === ''
                ? 'With a token'
                : html`With the token ending <code>${w.tokenHint}</code>`
          }${w.signed ? ', signed' : ', not signed'}.
          ${
            w.maxRetries === 0
              ? 'No retries.'
              : html`If the mail is still unread, it tries again every
                ${INTERVAL_WORDS[w.retryInterval]}, up to ${plural(w.maxRetries, 'time')}.`
          }
        </p>
        <p>${lastResult(w)}</p>
      </div>
      <div class="actions">
        ${
          // A test can't get through until the notice above is dealt with.
          w.unreadable || w.hostNotAllowed
            ? ''
            : html`<form method="post" action="${url}/test">
                ${csrfField(csrf)}
                <button>Send a test wake-up</button>
              </form>`
        }
        <a class="btn" href="${url}">Change…</a>
      </div>
    </div>
    <div class="item">
      <div class="what">
        <strong>Turn it off</strong>
        <p>The agent finds its mail only when it checks.</p>
      </div>
      <form method="post" action="${url}/remove">
        ${csrfField(csrf)}
        <button class="btn danger">Turn off the wake-up</button>
      </form>
    </div>
  </section>`;
}

/** One word for where it stands, the same as on Connections. */
export const wakeUpState = (w: WakeUpView, paused: boolean) =>
  paused ? 'Paused' : w.unreadable || w.hostNotAllowed || w.lastOk === false ? 'Failing' : 'On';

/** The latest wake-up's result, said as what it means: a dot and a word, never colour alone. */
function lastResult(w: WakeUpView): Html {
  if (w.lastAt === null) return html`Not used yet.`;
  const when = time(w.lastAt);
  const status = w.lastStatus ?? '';
  if (w.lastOk) {
    return html`<span class="status active">Worked</span> ${when}: the platform accepted it
      (${status}).`;
  }
  const why = /^HTTP 40[13]/.test(status)
    ? `the platform refused it: check the ${w.signed ? 'token and signing secret' : 'token'}`
    : /^HTTP 404/.test(status)
      ? "the platform doesn't know that address: check it"
      : /^HTTP 429/.test(status)
        ? 'the platform is limiting how often it can be woken'
        : /^HTTP/.test(status)
          ? `the platform answered ${status}`
          : status.replace(/^(failed|refused|not sent): /, '');
  return html`<span class="status failed">Failed</span> ${when}: ${why}.`;
}

/** The secrets typed into a form that failed, which aren't shown back. */
function retype(typed: { token: boolean; signingSecret: boolean } | undefined): Html | '' {
  const what = [typed?.token && 'token', typed?.signingSecret && 'signing secret'].filter(Boolean);
  return what.length === 0
    ? ''
    : html` <span id="retype">Enter the ${what.join(' and ')} again.</span>`;
}

/** Setting up or changing a wake-up. The address and token are never shown back. */
export function wakeUpForm(opts: {
  slug: string;
  handle: string;
  current: WakeUpView | undefined;
  csrf: string;
  /** WAKE_UP_HOSTS: ['*'] for any public host. */
  hosts: readonly string[];
  error?: string | undefined;
  /** What was typed, kept when saving fails (never the token or secret). */
  typed?:
    | {
        url: string;
        retryInterval: RetryInterval;
        maxRetries: number;
        token: boolean;
        signingSecret: boolean;
      }
    | undefined;
}): Html {
  const { slug, handle, current, typed } = opts;
  const address = `${slug}/${handle}`;
  const interval = typed?.retryInterval ?? current?.retryInterval ?? '15m';
  const retries = typed?.maxRetries ?? current?.maxRetries ?? 3;
  return html`${crumbs(
      ['Connections', '/ui'],
      [slug, connectionUrl(slug)],
      [handle, mailboxUrl(slug, handle)],
      'Wake-up',
    )}
    <div class="page-head">
      <h1>Wake-up for <code>${address}</code></h1>
      <p class="lede">
        When this mailbox has unread mail, Budd sends a short request to an address your agent's
        platform gives you, then waits until the mail is read, unless you choose to try again below.
        It says which mailbox, never what the mail says.
      </p>
    </div>
    ${
      opts.error
        ? notice(
            'bad',
            'Nothing was saved.',
            html`<span id="url-error">${opts.error}</span>${retype(typed)}`,
          )
        : ''
    }
    <section class="group">
      <h2>Where to find the address</h2>
      <div class="item block">
        <ul>
          <li>
            <strong>Claude Code routines</strong>: add an API trigger to the routine; paste its
            <code>…/fire</code> URL here and its token below.
          </li>
          <li>
            <strong>Grok Bot</strong>: add a webhook trigger; paste its URL and its
            <code>crsr_…</code> token.
          </li>
          <li>
            <strong>Multica Autopilot</strong>: add a webhook trigger with a signing secret; paste
            its URL here and the secret under Signing secret. Leave the token empty: the URL carries
            its own.
          </li>
        </ul>
      </div>
    </section>
    <section class="group">
      <h2>${current ? 'Change the wake-up' : 'Set up the wake-up'}</h2>
      <form class="item block" method="post" action="${wakeUpUrl(slug, handle)}">
        ${csrfField(opts.csrf)}
        <div class="field">
          <label for="url">Address</label>
          <input
            id="url"
            type="url"
            name="url"
            value="${typed?.url ?? ''}"
            placeholder="https://"
            autocomplete="off"
            spellcheck="false"
            ${current ? '' : 'required'}
            aria-describedby="url-hint${opts.error ? ' url-error' : ''}"
            ${opts.error ? html`aria-invalid="true"` : ''}
          />
          <span class="hint" id="url-hint"
            >${
              current
                ? html`Leave it empty to keep the current one, at <code>${current.host}</code>.`
                : 'It must start with https:// and be on the public internet.'
            }
            Budd stores it encrypted and never shows it again.
            ${
              opts.hosts.includes('*')
                ? ''
                : html`Budd only sends wake-ups to ${list([...opts.hosts])}.`
            }</span
          >
        </div>
        <div class="field">
          <label for="token"
            >Token <span class="muted">(if your platform gave you one)</span></label
          >
          <input
            id="token"
            type="password"
            name="token"
            autocomplete="off"
            spellcheck="false"
            aria-describedby="token-hint${typed?.token ? ' retype' : ''}"
          />
          <span class="hint" id="token-hint"
            >Sent as <code>Authorization: Bearer …</code>.
            ${
              current?.tokenHint
                ? html`Leave it empty to keep the one ending <code>${current.tokenHint}</code>,
                    while the address stays the same.`
                : current?.tokenHint === ''
                  ? 'Leave it empty to keep the current one, while the address stays the same.'
                  : ''
            }
            Budd stores it encrypted and never shows it again.</span
          >
        </div>
        ${
          current && current.tokenHint !== null
            ? html`<label class="choice"
                ><input type="checkbox" name="no_token" value="1" /> Don't send a token, even if one
                is typed above</label
              >`
            : ''
        }
        <div class="field">
          <label for="signing_secret"
            >Signing secret <span class="muted">(if your platform checks signatures)</span></label
          >
          <input
            id="signing_secret"
            type="password"
            name="signing_secret"
            autocomplete="off"
            spellcheck="false"
            aria-describedby="signing-hint${typed?.signingSecret ? ' retype' : ''}"
          />
          <span class="hint" id="signing-hint"
            >Budd signs each wake-up with it, so knowing the address isn't enough to wake your
            agent. Sent both as <code>X-Hub-Signature-256</code>, the way GitHub does it, and as
            Standard Webhooks (<code>webhook-signature</code>), the way Grok does.
            ${
              current?.signed
                ? 'Leave it empty to keep the current one, while the address stays the same.'
                : ''
            }
            Budd stores it encrypted and never shows it again.</span
          >
        </div>
        ${
          current?.signed
            ? html`<label class="choice"
                ><input type="checkbox" name="no_signing" value="1" /> Don't sign, even if a secret
                is typed above</label
              >`
            : ''
        }
        <fieldset>
          <legend>If the mail is still unread</legend>
          <div class="inline-form">
            <label for="retries">Retries</label>
            <select id="retries" name="retries">
              ${Array.from(
                { length: MAX_RETRIES + 1 },
                (_, n) =>
                  html`<option value="${n}" ${n === retries ? 'selected' : ''}>
                    ${n === 0 ? 'None' : String(n)}
                  </option>`,
              )}
            </select>
            <label for="interval">one every</label>
            <select id="interval" name="interval">
              ${(Object.keys(RETRY_INTERVALS) as RetryInterval[]).map(
                (k) =>
                  html`<option value="${k}" ${k === interval ? 'selected' : ''}>
                    ${INTERVAL_WORDS[k]}
                  </option>`,
              )}
            </select>
          </div>
          <span class="hint">If the agent also checks on its own, choose None.</span>
        </fieldset>
        <div class="actions">
          <button class="btn primary">Save the wake-up</button>
          <a class="btn quiet" href="${mailboxUrl(slug, handle)}">Cancel</a>
        </div>
      </form>
    </section>`;
}

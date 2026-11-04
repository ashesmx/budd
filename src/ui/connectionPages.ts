import { html } from 'hono/html';
import {
  CONNECTION_LIMIT_MESSAGE,
  type ConnectionOverview,
  type PolicyPreview,
  type RouteCount,
} from '../admin/Admin.js';
import { isValidSlug, SLUG_RULES } from '../domain/slug.js';
import type { ConnectionKey } from '../domain/auth.js';
import type { Connection, HistoryItem } from '../domain/types.js';
import { durationInWords } from '../config.js';
import type { MailboxStats } from '../storage/Storage.js';
import type { WakeUpStates, WakeUpView } from '../wakeups/WakeUps.js';
import { wakeUpState } from './wakeUpPages.js';
import { connectionMap, inUse, talkWords } from './connectionMap.js';
import { countApplied, MAX_SEARCH, type Field, type Params } from './filters.js';
import {
  auditUrl,
  compare,
  connectionUrl,
  crumbs,
  csrfField,
  handle,
  ICONS,
  iconLink,
  list,
  mailbox,
  mailboxUrl,
  messagesUrl,
  nameMenu,
  notice,
  plural,
  sortHeading,
  time,
  unverifiedInfo,
  type Html,
} from './html.js';

/** Outcomes a redirect can report, by `?done=` and `?error=` key: a lead and the detail. */
const DONE: Record<string, (slug: string, keyed: boolean) => [string, string]> = {
  blocked: (s, keyed) => [
    `Blocked ${s}.`,
    `Its tool calls now fail and nobody can message it${keyed ? ', and its API key is revoked' : ''}. Unblock it below to let it back in.`,
  ],
  unblocked: (s, keyed) => [
    `Unblocked ${s}.`,
    keyed
      ? 'Its old key stays revoked: give it a new key below.'
      : 'Its old tokens stay revoked, so the app must connect and authorize again.',
  ],
  archived: (s, keyed) => [
    `Archived ${s}.`,
    `It is blocked, its ${keyed ? 'API key is' : 'tokens are'} revoked, and its history is kept. Restore it if you need it again.`,
  ],
  key_revoked: (s) => [
    `Revoked the key for ${s}.`,
    'Its agent can no longer use Budd. Give it a new key when you want it back.',
  ],
  restored: (s) => [`Restored ${s}.`, 'It is still blocked; unblock it when you want it back.'],
  relabelled: (s) => [`Saved the label for ${s}.`, ''],
  policy_saved: (s) => [`Saved who may message ${s}.`, ''],
  policy_unchanged: (s) => ['No change.', `Who may message ${s} is the same as before.`],
  widened: (s) => ['Confirmed.', `More connections may now message ${s}.`],
  mailbox_archived: (s) => [
    `Archived ${s}.`,
    'It takes no new mail and no agent can use it. Its history is kept: restore it if you need it again.',
  ],
  mailbox_restored: (s) => [`Restored ${s}.`, 'Its agents can use it again.'],
  wake_up_set: (s) => [
    `Saved the wake-up for ${s}.`,
    'Budd wakes it when new mail arrives, and shortly for mail already unread. Send a test wake-up to check the address works.',
  ],
  wake_up_removed: (s) => [
    `Turned off the wake-up for ${s}.`,
    "Its agent finds its mail only when it checks. To turn it back on, set it up again with the address and token from the agent's platform.",
  ],
  wake_up_tested: (s) => [`The test wake-up for ${s} worked.`, 'The platform accepted it.'],
};
const ERRORS: Record<string, string> = {
  confirm_failed:
    'That confirmation is no longer valid: it expired, was already used, or came from another browser session. Make the change again.',
  policy_changed: 'The policy changed after you started. Review it and make the change again.',
  unknown_connection: 'That connection no longer exists.',
  archived: 'That connection is archived. Restore it first.',
  invalid_input: 'A label can be at most 80 characters.',
  blocked: 'That connection is blocked. Unblock it first.',
  no_key: 'It has no key to revoke.',
  connection_limit: CONNECTION_LIMIT_MESSAGE,
  unknown_mailbox: 'That mailbox no longer exists.',
  archived_mailbox: 'That mailbox is archived. Restore it first.',
  wake_up_failed:
    "The test wake-up didn't get through. Its result is under Wake-up: check the address, token and signing secret, then send a test again.",
  test_too_soon: 'Wait a moment before sending another test wake-up.',
  mailbox_limit:
    'Its connection already uses the most mailboxes it may have. Archive another of its mailboxes first.',
};

export interface Flash {
  done?: string | undefined;
  error?: string | undefined;
}

/** `slug` is the connection the page is about, never a query parameter: links can't put words in Budd's mouth. */
export function flash(f: Flash, slug = '', keyed = false) {
  // Own keys only: `?done=__proto__` must not reach Object.prototype.
  const done = f.done !== undefined && Object.hasOwn(DONE, f.done) ? DONE[f.done] : undefined;
  const error =
    f.error !== undefined && Object.hasOwn(ERRORS, f.error) ? ERRORS[f.error] : undefined;
  return html`${done ? notice('ok', ...done(slug, keyed)) : ''}${
    error ? notice('bad', 'Nothing changed.', error) : ''
  }`;
}

const status = (c: Connection) =>
  c.archivedAt !== null
    ? html`<span class="status archived">Archived</span>`
    : html`<span class="status ${c.status}">${c.status === 'active' ? 'Active' : 'Blocked'}</span>`;

const policySummary = (p: ConnectionOverview['policy']) =>
  p.mode === 'all'
    ? html`Everyone`
    : p.allowed.length === 0
      ? html`<span class="muted">Nobody else</span>`
      : html`Only ${list(p.allowed)}`;

/** Where a human adds a connection. Not under /ui/connections/, where any name is a slug. */
export const NEW_CONNECTION_URL = '/ui/new';

const keyTag = (c: Connection) => (c.kind === 'key' ? html` <span class="tag">API key</span>` : '');

const badge = (n: number, mailboxAddress?: string) =>
  n > 0
    ? html`<span class="badge" ${mailboxAddress ? html`data-unread="${mailboxAddress}"` : ''}
        >${n}<span class="sr-only"> unread</span></span
      >`
    : '';

const newButton = html`<a class="btn primary" href="${NEW_CONNECTION_URL}">New connection</a>`;

/** Map | Table: two views of the same connections. */
const viewSwitch = (current: 'map' | 'table') =>
  html`<nav class="switch" aria-label="View">
    <a href="/ui?view=map" ${current === 'map' ? html`aria-current="page"` : ''}>Map</a
    ><a href="/ui?view=table" ${current === 'table' ? html`aria-current="page"` : ''}>Table</a>
  </nav>`;

const connectionsHead = (current: 'map' | 'table', lede: Html | string) =>
  html`<div class="page-head head-row">
    <div>
      <h1>Connections</h1>
      <p class="lede">${lede}</p>
    </div>
    <div class="head-actions">${viewSwitch(current)} ${newButton}</div>
  </div>`;

/** Said wherever there are no connections yet. */
const noConnections = (mcpUrl: string) =>
  html`<p class="empty">
    No connections yet. Add Budd to an AI app as an MCP server at <code>${mcpUrl}</code>, and it
    appears here when it first connects. <a href="${NEW_CONNECTION_URL}">How to connect an app</a>.
  </p>`;

const wakeUpCell = (state: 'on' | 'failing' | undefined, blocked: boolean) =>
  state === undefined
    ? html`<span class="muted">Off</span>`
    : blocked
      ? 'Paused'
      : state === 'failing'
        ? html`<span class="status failing">Failing</span>`
        : 'On';

/**
 * Said at the top of Connections while any wake-up is failing, so an
 * agent that's gone quiet doesn't go unnoticed. Blocked connections are paused, not failing.
 */
export function failingWakeUps(
  connections: ConnectionOverview[],
  states: WakeUpStates | undefined,
): Html | '' {
  if (!states) return '';
  const failing = connections.flatMap((c) =>
    c.archivedAt !== null || c.status === 'blocked'
      ? []
      : inUse(c)
          .filter((m) => states.get(`${c.id}/${m.handle}`) === 'failing')
          .map((m) => ({ slug: c.slug, handle: m.handle })),
  );
  if (failing.length === 0) return '';
  const links = failing.map(
    (m, i) =>
      html`${i > 0 ? ', ' : ''}<a href="${mailboxUrl(m.slug, m.handle)}#wake-up"
          ><code>${m.slug}/${m.handle}</code></a
        >`,
  );
  return failing.length === 1
    ? notice(
        'warn',
        'A wake-up is failing.',
        html`Its agent won't hear about new mail until it's fixed. Open ${links} to see why.`,
        { live: false },
      )
    : notice(
        'warn',
        'Some wake-ups are failing.',
        html`Their agents won't hear about new mail until they're fixed. Open each to see why:
        ${links}.`,
        { live: false },
      );
}

/** How far back the map's message routes go. */
export const MAP_WINDOWS = {
  '1d': { ms: 86_400_000, label: 'Last day', words: 'day' },
  '7d': { ms: 7 * 86_400_000, label: '7 days', words: '7 days' },
  '30d': { ms: 30 * 86_400_000, label: '30 days', words: '30 days' },
} as const;
export type MapWindow = keyof typeof MAP_WINDOWS;

/** What the cards count: the last week. */
export const CARD_WINDOW = MAP_WINDOWS['7d'];

/** Connections opens on the map once there are two connections to draw, else on the table. */
export const mapIsDefault = (current: ConnectionOverview[]) => current.length >= 2;

/** Who can message whom, with each connection's mailboxes and, if asked, the messages they sent. */
export function mapPage(opts: {
  /** Current connections: archived ones aren't drawn. */
  connections: ConnectionOverview[];
  flash: Flash;
  mcpUrl: string;
  /** The failing wake-ups notice (failingWakeUps). */
  failing?: Html | '';
  /** This map's address with some of its settings changed. */
  link: (changes: Record<string, string | undefined>) => string;
  window?: MapWindow | undefined;
  routes?: RouteCount[] | undefined;
  wakeUps?: WakeUpStates | undefined;
  focus?: string | undefined;
  /** An open connection or mailbox card (connectionCard, mailboxCard). */
  card?: Html | undefined;
  retentionMs: number;
}): Html {
  const window = opts.window && MAP_WINDOWS[opts.window];
  const switchLink = (key: MapWindow | undefined, label: string) =>
    html`<a
      href="${opts.link({ msgs: key, card: undefined })}"
      ${key === opts.window ? html`aria-current="page"` : ''}
      >${label}</a
    >`;
  const bar = html`<div class="map-bar">
    <div class="map-ctl">
      <span class="lbl" id="msgs-lbl">Messages sent</span>
      <nav class="switch" aria-labelledby="msgs-lbl">
        ${switchLink(undefined, 'Off')}${(Object.keys(MAP_WINDOWS) as MapWindow[]).map((k) =>
          switchLink(k, MAP_WINDOWS[k].label),
        )}
      </nav>
    </div>
    ${
      opts.connections.length >= 3
        ? html`<form method="get" action="/ui" class="map-ctl">
            <input type="hidden" name="view" value="map" />
            ${opts.window ? html`<input type="hidden" name="msgs" value="${opts.window}" />` : ''}
            <label class="lbl" for="focus">Focus on</label>
            <select id="focus" name="focus">
              <option value="">Everyone</option>
              ${opts.connections.map(
                (c) =>
                  html`<option value="${c.slug}" ${c.slug === opts.focus ? 'selected' : ''}>
                    ${c.slug}
                  </option>`,
              )}
            </select>
            <button class="btn">Show</button>
          </form>`
        : ''
    }
  </div>`;
  const wider = (Object.keys(MAP_WINDOWS) as MapWindow[]).filter(
    (k) => window && MAP_WINDOWS[k].ms > window.ms,
  );
  const none = window
    ? html`No messages in the last
      ${window.words}.${
        wider.length === 0
          ? ''
          : html` Try
            ${wider.map(
              (k, i) =>
                html`${i > 0 ? ' or ' : ''}<a href="${opts.link({ msgs: k, card: undefined })}"
                    >${MAP_WINDOWS[k].words}</a
                  >`,
            )}.`
      }`
    : '';
  return html`${connectionsHead(
    'map',
    "Who can message whom, from each connection's contact policy. Its own mailboxes can always message each other.",
  )}
  ${flash({ error: opts.flash.error })} ${opts.failing ?? ''}
  ${
    opts.connections.length === 0
      ? noConnections(opts.mcpUrl)
      : opts.connections.length === 1
        ? html`<p class="empty">
            Only
            <a href="${connectionUrl(opts.connections[0]?.slug ?? '')}"
              >${opts.connections[0]?.slug}</a
            >
            is connected, so there's nothing to map yet. Connect another app to see who can message
            whom.
          </p>`
        : html`${bar}
            ${connectionMap({
              connections: opts.connections,
              cardLink: (address) => opts.link({ card: address }),
              messages: window && { routes: opts.routes ?? [], window: window.words, none },
              wakeUps: opts.wakeUps,
              focus: opts.focus,
            })}
            <p class="hint map-hint" id="map-help">
              Point at a ${window ? 'route or ' : ''}mailbox to see what it means, and open a
              connection or mailbox for a summary.
              ${
                window && window.ms > opts.retentionMs
                  ? `Budd keeps messages for ${durationInWords(opts.retentionMs)}, so older ones aren't counted.`
                  : ''
              }
            </p>
            ${opts.card ?? ''}`
  }`;
}

/** A card's header: its name, links to its pages, and Close. */
const cardHead = (opts: {
  title: Html;
  status?: Html | undefined;
  page: [string, string];
  messages: [string, string];
  audit: [string, string];
  close: string;
}) =>
  html`<div class="card-head">
    <h2 id="card-title">${opts.title}</h2>
    ${opts.status ?? ''}
    <div class="tools">
      ${iconLink(opts.page[0], ICONS.settings, opts.page[1])}${iconLink(
        opts.messages[0],
        ICONS.mail,
        opts.messages[1],
      )}${iconLink(opts.audit[0], ICONS.log, opts.audit[1])}<a
        class="icon-btn"
        href="${opts.close}"
        data-card-close
        aria-label="Close"
        title="Close"
        >${ICONS.close}</a
      >
    </div>
  </div>`;

const count = (n: number) => html`<span class="num">${n.toLocaleString('en')}</span>`;

/** A connection opened on the map: what it is, who it hears from, and its last week. */
export function connectionCard(opts: {
  connection: ConnectionOverview;
  stats: MailboxStats[];
  close: string;
  focus: string;
}): Html {
  const c = opts.connection;
  const mailboxes = inUse(c);
  const sent = opts.stats.reduce((n, s) => n + s.sent, 0);
  const received = opts.stats.reduce((n, s) => n + s.received, 0);
  return html`<dialog class="card" data-card open aria-labelledby="card-title">
    ${cardHead({
      title: html`${c.slug}`,
      status: status(c),
      page: [connectionUrl(c.slug), `Open ${c.slug}'s page`],
      messages: [messagesUrl(c.slug), `${c.slug}'s messages`],
      audit: [auditUrl(c.slug), `${c.slug}'s audit log`],
      close: opts.close,
    })}
    <dl class="facts">
      ${
        c.label
          ? html`<dt>Label</dt>
              <dd>${c.label}</dd>`
          : ''
      }
      <dt>Signs in</dt>
      <dd>${c.kind === 'key' ? 'With an API key' : 'With its app'}</dd>
      <dt>Last active</dt>
      <dd>${time(c.lastSeenAt)}</dd>
      <dt>Mailboxes</dt>
      <dd>
        ${
          mailboxes.length === 0
            ? html`<span class="muted">None yet</span>`
            : mailboxes.map(
                (m, i) =>
                  html`${i > 0 ? ' ' : ''}<a href="${mailboxUrl(c.slug, m.handle)}"
                      ><code>${m.handle}</code></a
                    >`,
              )
        }
      </dd>
      <dt>Accepts messages from</dt>
      <dd>${policySummary(c.policy)}</dd>
      <dt>Last ${CARD_WINDOW.words}</dt>
      <dd>${count(sent)} sent, ${count(received)} received</dd>
      <dt>Unread now</dt>
      <dd>${count(mailboxes.reduce((n, m) => n + m.unread, 0))}</dd>
    </dl>
    <p class="card-foot"><a href="${opts.focus}">Focus the map on ${c.slug}</a></p>
  </dialog>`;
}

/** A mailbox opened on the map: its last week, its latest mail and its wake-up. */
export function mailboxCard(opts: {
  connection: ConnectionOverview;
  handle: string;
  stats: MailboxStats | undefined;
  /** The routes its messages took in the card's window. */
  routes: RouteCount[];
  wakeUp: WakeUpView | undefined;
  close: string;
}): Html {
  const { connection: c, handle: h, stats: s, wakeUp: w } = opts;
  const address = `${c.slug}/${h}`;
  const talks = new Map<string, { other: string; sent: number; received: number }>();
  for (const r of opts.routes) {
    const other = r.from === address ? r.to : r.to === address ? r.from : undefined;
    if (!other || other === address) continue;
    const t = talks.get(other) ?? { other, sent: 0, received: 0 };
    if (r.from === address) t.sent += r.messages;
    else t.received += r.messages;
    talks.set(other, t);
  }
  const unread = inUse(c).find((m) => m.handle === h)?.unread ?? 0;
  const state = w && wakeUpState(w, c.status === 'blocked');
  return html`<dialog class="card" data-card open aria-labelledby="card-title">
    ${cardHead({
      title: html`${c.slug}/<wbr />${h}`,
      page: [mailboxUrl(c.slug, h), `Open ${c.slug}/${h}'s page`],
      messages: [messagesUrl(c.slug, h), `${c.slug}/${h}'s messages`],
      audit: [auditUrl(c.slug, h), `${c.slug}/${h}'s audit log`],
      close: opts.close,
    })}
    <dl class="facts">
      <dt>Last ${CARD_WINDOW.words}</dt>
      <dd>${count(s?.sent ?? 0)} sent, ${count(s?.received ?? 0)} received</dd>
      ${
        talks.size === 0
          ? ''
          : html`<dt>Messages with</dt>
              <dd>
                ${talkWords(
                  [...talks.values()].sort((x, y) => y.sent + y.received - (x.sent + x.received)),
                )}.
              </dd>`
      }
      <dt>Unread now</dt>
      <dd>
        ${count(unread)}${s?.oldestUnreadAt ? html`, the oldest from ${time(s.oldestUnreadAt)}` : ''}
      </dd>
      <dt>Last received</dt>
      <dd>${time(s?.lastReceivedAt ?? null)}</dd>
      <dt>Last read</dt>
      <dd>${time(s?.lastReadAt ?? null)}</dd>
      <dt>Last sent</dt>
      <dd>${time(s?.lastSentAt ?? null)}</dd>
      <dt>Expired</dt>
      <dd>${count(s?.expired ?? 0)} in the last ${CARD_WINDOW.words}</dd>
      <dt>Wake-up</dt>
      <dd>
        ${
          w
            ? html`${
                  state === 'Failing' ? html`<span class="status failing">Failing</span>` : state
                }:
                wakes
                <code>${w.host}</code>${w.lastAt === null ? '' : html`, woken ${time(w.lastAt)}`}.
                <a href="${mailboxUrl(c.slug, h)}#wake-up">Details</a>`
            : html`<span class="muted">Off</span>`
        }
      </dd>
    </dl>
  </dialog>`;
}

export const CONNECTION_SORTS = ['name', 'status', 'seen'] as const;
export type ConnectionSort = { by: (typeof CONNECTION_SORTS)[number]; dir: 'asc' | 'desc' };

const STATUSES = {
  current: 'Not archived',
  active: 'Active',
  blocked: 'Blocked',
  archived: 'Archived',
  any: 'Any',
} as const;
type StatusFilter = keyof typeof STATUSES;

/** The table's search and filters, read from its query string. */
export function connectionFilters(p: Params) {
  const statusChoice = p.pick('status', STATUSES) ?? 'current';
  const text = p.take('q', (v) => v.length <= MAX_SEARCH)?.toLowerCase();
  const unread = p.take('unread', (v) => v === '1') !== undefined;
  const matches = (c: ConnectionOverview) =>
    statusMatches(c, statusChoice) &&
    (!unread || inUse(c).some((m) => m.unread > 0)) &&
    (text === undefined ||
      c.slug.includes(text) ||
      (c.label ?? '').toLowerCase().includes(text) ||
      inUse(c).some((m) => m.handle.includes(text)));
  const fields: Field[] = [
    {
      label: 'Status',
      control: html`<select name="status">
        ${Object.entries(STATUSES).map(
          ([k, v]) =>
            html`<option
              value="${k === 'current' ? '' : k}"
              ${k === statusChoice ? 'selected' : ''}
            >
              ${v}
            </option>`,
        )}
      </select>`,
    },
    {
      tick: html`<input type="checkbox" name="unread" value="1" ${unread ? 'checked' : ''} /> Has
        unread mail`,
    },
  ];
  const applied = countApplied([
    statusChoice === 'current' ? undefined : statusChoice,
    unread,
    text,
  ]);
  return {
    matches,
    fields,
    applied,
  };
}

const statusMatches = (c: ConnectionOverview, s: StatusFilter) =>
  s === 'any' ||
  (s === 'current' && c.archivedAt === null) ||
  (s === 'archived' && c.archivedAt !== null) ||
  (c.archivedAt === null && c.status === s);

const sortKey = (c: ConnectionOverview, by: ConnectionSort['by']) =>
  by === 'name'
    ? c.slug
    : by === 'seen'
      ? c.lastSeenAt
      : c.archivedAt !== null
        ? 'c-archived'
        : c.status === 'active'
          ? 'a-active'
          : 'b-blocked';

/** Every connection in a table, found and sorted. */
export function tablePage(opts: {
  connections: ConnectionOverview[];
  find: Html;
  sort: ConnectionSort;
  sortLink: (changes: { sort: string; dir: string }) => string;
  filtered: boolean;
  flash: Flash;
  mcpUrl: string;
  failing?: Html | '';
}): Html {
  const { sort } = opts;
  const rows = [...opts.connections].sort(
    (a, b) =>
      compare(sortKey(a, sort.by), sortKey(b, sort.by), sort.dir) || a.slug.localeCompare(b.slug),
  );
  return html`${connectionsHead(
    'table',
    html`Each app or agent that uses Budd is a connection. Its agents each have a mailbox,
      <code>connection/handle</code>.`,
  )}
  ${flash({ error: opts.flash.error })} ${opts.failing ?? ''} ${opts.find}
  ${
    rows.length === 0
      ? opts.filtered
        ? html`<p class="empty">No connections match.</p>`
        : noConnections(opts.mcpUrl)
      : html`<div class="table-wrap overlays">
          <table class="stack">
            <thead>
              <tr>
                ${sortHeading('Connection', 'name', sort, opts.sortLink)}
                <th>Mailboxes ${unverifiedInfo('mailboxes-note')}</th>
                ${sortHeading('Status', 'status', sort, opts.sortLink)}
                <th>Contact policy</th>
                ${sortHeading('Last seen', 'seen', sort, opts.sortLink)}
              </tr>
            </thead>
            <tbody>
              ${rows.map(
                (c) =>
                  html`<tr id="c-${c.slug}">
                    <td>
                      <a class="row-title" href="${connectionUrl(c.slug)}"><code>${c.slug}</code></a
                      >${keyTag(c)}${c.label ? html`<div class="muted">${c.label}</div>` : ''}
                    </td>
                    <td>
                      <span class="phone-only cell-label">Mailboxes</span>${
                        inUse(c).length === 0
                          ? html`<span class="muted">None yet</span>`
                          : html`<ul class="mailboxes">
                              ${inUse(c).map(
                                (m) =>
                                  html`<li>
                                    <a href="${mailboxUrl(c.slug, m.handle)}"
                                      >${mailbox(m.handle)}</a
                                    >
                                    ${badge(m.unread, `${c.slug}/${m.handle}`)}
                                  </li>`,
                              )}
                            </ul>`
                      }
                    </td>
                    <td data-label="Status">
                      ${status(c)}${
                        c.hasLiveTokens !== false || c.archivedAt !== null
                          ? ''
                          : c.kind === 'key'
                            ? html`<div class="muted">No working key</div>`
                            : html`<div class="muted">No app signed in</div>`
                      }
                    </td>
                    <td data-label="Contact policy">${policySummary(c.policy)}</td>
                    <td data-label="Last seen">${time(c.lastSeenAt)}</td>
                  </tr>`,
              )}
            </tbody>
          </table>
        </div>`
  }`;
}

/** A change the human must confirm in a dialog, carrying its one-time nonce. */
export type Confirm = { slug: string; nonce: string; csrf: string } & (
  { kind: 'policy'; preview: PolicyPreview } | { kind: 'unblock' } | { kind: 'rotate' }
);

/** A key connection's current API key: never the key itself, which only its creator saw. */
export type KeyStatus =
  | (Pick<ConnectionKey, 'createdAt' | 'hint' | 'lastUsedAt' | 'expiresAt'> & {
      /** Who made it: the key stops working if they leave the workspace. */
      createdBy: string | null;
      /** How long unused before a key stops working (KEY_IDLE_EXPIRY), in words. */
      idleExpiry: string;
    })
  | null;

export const MAILBOX_SORTS = ['mailbox', 'unread', 'activity'] as const;
export type MailboxSort = { by: (typeof MAILBOX_SORTS)[number]; dir: 'asc' | 'desc' };

/** A connection's mailboxes: each opens its page, and its messages and audit log are a click away. */
function mailboxTable(
  c: ConnectionOverview,
  sort: MailboxSort,
  sortLink: (changes: { sort: string; dir: string }) => string,
  /** Each mailbox with a wake-up; undefined when wake-ups are off. */
  wakeUps: WakeUpStates | undefined,
) {
  const archived = c.mailboxes.filter((m) => m.archivedAt !== null);
  const archivedLine =
    archived.length === 0
      ? ''
      : html`<p class="hint archived-line">
          Archived:
          ${archived.map(
            (m, i) =>
              html`${i > 0 ? ', ' : ''}<a href="${mailboxUrl(c.slug, m.handle)}"
                  >${mailbox(m.handle)}</a
                >`,
          )}
        </p>`;
  if (inUse(c).length === 0) {
    return html`${archivedLine}
      <p class="item empty">
        None yet. A mailbox appears when an agent on <code>${c.slug}</code> claims a handle, or
        first sends or checks for messages with it.
      </p>`;
  }
  const key = (m: ConnectionOverview['mailboxes'][number]) =>
    sort.by === 'mailbox' ? m.handle : sort.by === 'unread' ? m.unread : m.lastMessageAt;
  const rows = inUse(c).sort(
    (a, b) => compare(key(a), key(b), sort.dir) || a.handle.localeCompare(b.handle),
  );
  return html`<div class="table-wrap">
      <table class="stack">
        <thead>
          <tr>
            ${sortHeading('Mailbox', 'mailbox', sort, sortLink)}
            ${sortHeading('Unread', 'unread', sort, sortLink)}
            ${sortHeading('Last activity', 'activity', sort, sortLink)}
            ${wakeUps ? html`<th>Wake-up</th>` : ''}
            <th><span class="sr-only">Its messages and audit log</span></th>
          </tr>
        </thead>
        <tbody>
          ${rows.map(
            (m) =>
              html`<tr>
                <td>
                  <a class="row-title" href="${mailboxUrl(c.slug, m.handle)}"
                    >${mailbox(m.handle)}</a
                  >
                </td>
                <td data-label="Unread">
                  ${m.unread > 0 ? badge(m.unread, `${c.slug}/${m.handle}`) : html`<span class="muted">None</span>`}
                </td>
                <td data-label="Last activity">${time(m.lastMessageAt)}</td>
                ${
                  wakeUps
                    ? html`<td data-label="Wake-up">
                        ${wakeUpCell(wakeUps.get(`${c.id}/${m.handle}`), c.status === 'blocked')}
                      </td>`
                    : ''
                }
                <td class="row-actions">
                  ${iconLink(messagesUrl(c.slug, m.handle), ICONS.mail, `Messages of ${m.handle}`)}
                  ${iconLink(auditUrl(c.slug, m.handle), ICONS.log, `Audit log of ${m.handle}`)}
                </td>
              </tr>`,
          )}
        </tbody>
      </table>
    </div>
    ${archivedLine}`;
}

export function connectionPage(opts: {
  connection: ConnectionOverview;
  /** The connections it could accept messages from. */
  others: string[];
  csrf: string;
  flash: Flash;
  confirm?: Confirm | undefined;
  /** Set for a key connection (ADR 0016): its current key, or null if it has none. */
  key?: KeyStatus | undefined;
  sort: MailboxSort;
  sortLink: (changes: { sort: string; dir: string }) => string;
  wakeUps?: WakeUpStates | undefined;
  now: number;
}): Html {
  const { connection: c, csrf, confirm } = opts;
  const url = connectionUrl(c.slug);
  const archived = c.archivedAt !== null;
  const mailboxes = html`<section class="group">
    <h2>Mailboxes ${unverifiedInfo('mailboxes-note')}</h2>
    ${mailboxTable(c, opts.sort, opts.sortLink, opts.wakeUps)}
  </section>`;
  return html`${crumbs(['Connections', '/ui'], c.slug)}
    <div class="page-head">
      ${nameMenu({
        name: html`<code>${c.slug}</code>`,
        what: 'connection',
        messages: messagesUrl(c.slug),
        audit: auditUrl(c.slug),
        after: status(c),
      })}
      <div class="meta">
        ${archived ? (c.label ? html`<span>${c.label}</span>` : '') : labelEditor(c, csrf)}
        <span>${c.kind === 'key' ? html`Uses an API key` : 'Signs in as an app'}</span>
        <span>${c.kind === 'key' ? 'Created' : 'Connected'} ${time(c.createdAt)}</span>
        <span>Last seen ${time(c.lastSeenAt)}</span>
      </div>
    </div>
    ${
      // The standing notice below already says it was archived.
      flash(
        opts.flash.done === 'archived' ? { error: opts.flash.error } : opts.flash,
        c.slug,
        c.kind === 'key',
      )
    }
    ${
      archived
        ? html`<div class="notice warn restore">
              <p>
                <strong>Archived ${time(c.archivedAt)}.</strong> It's blocked and hidden from the
                list; nothing here can change until you restore it. Its history is kept.
              </p>
              <form method="post" action="${url}/restore">
                ${csrfField(csrf)}
                <button>Restore ${c.slug}</button>
              </form>
            </div>
            <div class="frozen">
              ${mailboxes}
              <section class="group">
                <h2>Contact policy</h2>
                <p class="item block">Accepts messages from: ${policySummary(c.policy)}</p>
              </section>
            </div>`
        : html`${mailboxes} ${policyGroup(c, opts.others, csrf)}
          ${opts.key === undefined ? '' : keyGroup(c, opts.key, csrf, opts.now)}
          ${accessGroup(c, csrf)}`
    }
    ${confirm ? confirmDialog(confirm) : ''}`;
}

/** The label, edited where it's shown. A <details>, so it works without JS. */
const labelEditor = (c: ConnectionOverview, csrf: string) =>
  html`<span
    >${c.label ? html`${c.label} · ` : ''}
    <details class="edit" id="edit-label">
      <summary>${c.label ? 'Edit label' : 'Add a label'}</summary>
      <form class="inline-form" method="post" action="${connectionUrl(c.slug)}/label">
        ${csrfField(csrf)}
        <label for="label">Label</label>
        <input
          id="label"
          type="text"
          name="label"
          value="${c.label ?? ''}"
          maxlength="80"
          aria-describedby="label-hint"
        />
        <button>Save label</button>
        <span class="hint" id="label-hint"
          >Only you see it. Agents still see <code>${c.slug}</code>.</span
        >
      </form>
    </details></span
  >`;

function policyGroup(c: ConnectionOverview, others: string[], csrf: string) {
  const allowed = new Set(c.policy.allowed);
  return html`<section class="group" id="policy">
    <h2>Contact policy</h2>
    <form class="item block" method="post" action="${connectionUrl(c.slug)}/policy">
      ${csrfField(csrf)}
      <p class="muted">
        Who may message it. Its own mailboxes can always message each other. Narrowing takes effect
        when you save; letting more in asks you to confirm first. Agents can only narrow their own.
      </p>
      <fieldset>
        <legend>Accept messages from</legend>
        <label class="choice"
          ><input
            type="radio"
            name="mode"
            value="allowlist"
            ${c.policy.mode === 'allowlist' ? 'checked' : ''}
          />
          Only the connections ticked below</label
        >
        <div class="choices">
          ${
            others.length === 0
              ? html`<p class="muted">There are no other connections yet.</p>`
              : others.map(
                  (o) =>
                    html`<label class="choice"
                      ><input
                        type="checkbox"
                        name="allowed"
                        value="${o}"
                        ${allowed.has(o) ? 'checked' : ''}
                      />
                      <code>${o}</code></label
                    >`,
                )
          }
        </div>
        <label class="choice"
          ><input
            type="radio"
            name="mode"
            value="all"
            ${c.policy.mode === 'all' ? 'checked' : ''}
          />
          Every connection in this workspace</label
        >
      </fieldset>
      <button class="btn primary">Save contact policy</button>
    </form>
  </section>`;
}

function accessGroup(c: ConnectionOverview, csrf: string) {
  const url = connectionUrl(c.slug);
  const blocked = c.status === 'blocked';
  return html`<section class="group">
    <h2>Access</h2>
    <div class="item">
      <div class="what">
        ${
          blocked
            ? html`<strong>Unblock</strong>
                <p>Lets its agents use Budd again. You confirm it first.</p>`
            : html`<strong>Block</strong>
                <p>
                  Its tool calls fail and nobody can message it. You can unblock it
                  later${c.kind === 'key' ? html`, but blocking revokes its key: give it a new one after` : ''}.
                </p>`
        }
      </div>
      <form method="post" action="${url}/${blocked ? 'unblock' : 'block'}">
        ${csrfField(csrf)}
        ${blocked ? html`<button>Unblock ${c.slug}…</button>` : html`<button class="btn danger">Block ${c.slug}</button>`}
      </form>
    </div>
    <div class="item">
      <div class="what">
        <strong>Archive</strong>
        <p>
          Blocks it, ${c.kind === 'key' ? 'revokes its API key' : 'signs out every app using it'},
          and hides it from the list. Its history is kept, and you can restore it.
        </p>
      </div>
      <form method="post" action="${url}/archive">
        ${csrfField(csrf)}
        <button class="btn danger">Archive ${c.slug}</button>
      </form>
    </div>
  </section>`;
}

/** A key connection's API key: when it was made and last used, and replacing or revoking it. */
function keyGroup(c: ConnectionOverview, key: KeyStatus, csrf: string, now: number) {
  const url = connectionUrl(c.slug);
  return html`<section class="group" id="key">
    <h2>API key</h2>
    ${
      c.status === 'blocked'
        ? html`<div class="item">
            <p class="muted">Blocking revoked its key. Unblock it, then give it a new one.</p>
          </div>`
        : key === null
          ? html`<div class="item">
              <div class="what">
                <strong>No key</strong>
                <p>Its agent can't use Budd until you give it a key.</p>
              </div>
              <form method="post" action="${url}/key">
                ${csrfField(csrf)}
                <button class="btn primary">Give ${c.slug} a key</button>
              </form>
            </div>`
          : key.expiresAt <= now
            ? html`<div class="item">
                <div class="what">
                  <strong>Expired key <code>budd_key_…${key.hint}</code></strong>
                  <p>
                    It stopped working ${time(key.expiresAt)}, after ${key.idleExpiry} unused. Give
                    its agent a new key: its messages, mailboxes and policy are kept.
                  </p>
                </div>
                <form method="post" action="${url}/key">
                  ${csrfField(csrf)}
                  <button class="btn primary">Give ${c.slug} a new key</button>
                </form>
              </div>`
            : html`<div class="item">
                  <div class="what">
                    <strong>Current key <code>budd_key_…${key.hint}</code></strong>
                    <p>
                      Made${key.createdBy ? html` by ${key.createdBy}` : ''} ${time(key.createdAt)},
                      ${key.lastUsedAt === null ? 'not used yet' : html`last used ${time(key.lastUsedAt)}`}.
                      Budd doesn't keep a copy, so it can't show it again.
                    </p>
                    <p class="muted">
                      It stops working ${time(key.expiresAt)} if it isn't used before then. Keys
                      stop after ${key.idleExpiry} unused.
                    </p>
                  </div>
                  <form method="post" action="${url}/key">
                    ${csrfField(csrf)}
                    <button>Replace the key…</button>
                  </form>
                </div>
                <div class="item">
                  <div class="what">
                    <strong>Revoke</strong>
                    <p>
                      Its agent can't use Budd until you give it a new key. Its messages, mailboxes
                      and policy are kept.
                    </p>
                  </div>
                  <form method="post" action="${url}/key/revoke">
                    ${csrfField(csrf)}
                    <button class="btn danger">Revoke the key</button>
                  </form>
                </div>`
    }
  </section>`;
}

function confirmDialog(confirm: Confirm) {
  const { slug } = confirm;
  const url = connectionUrl(slug);
  if (confirm.kind === 'rotate') {
    return dialog(
      confirm,
      html`Replace the key for <code>${slug}</code>?`,
      html`<p>
        The current key stops working at once. Its agent can't use Budd until it has the new one.
      </p>`,
      `${url}/key/confirm`,
      `Replace the key for ${slug}`,
      'danger',
    );
  }
  const added = confirm.kind === 'policy' ? confirm.preview.added : [];
  const [title, body, action, label] =
    confirm.kind === 'policy'
      ? [
          html`Let more connections message <code>${slug}</code>?`,
          html`<p>
              This lets
              ${
                confirm.preview.added.includes('everyone')
                  ? html`<strong>every connection in this workspace</strong>`
                  : list(confirm.preview.added)
              }
              send messages to <code>${slug}</code>.
            </p>
            <p class="muted">
              Agents on those connections could then send it requests. Their content is untrusted,
              and their handles are unverified. Only do this if you meant to.
            </p>`,
          `${url}/policy/confirm`,
          added.includes('everyone')
            ? `Let everyone message ${slug}`
            : added.length === 1
              ? `Let ${added[0] ?? ''} message ${slug}`
              : `Let ${String(added.length)} connections message ${slug}`,
        ]
      : [
          html`Unblock <code>${slug}</code>?`,
          html`<p>
              Agents on <code>${slug}</code> will be able to use Budd again, and connections that
              its policy allows can message it.
            </p>
            <p class="muted">
              Only unblock it if you trust whatever is behind this connection now.
            </p>`,
          `${url}/unblock/confirm`,
          `Unblock ${slug}`,
        ];
  return dialog(confirm, title, body, action, label);
}

function dialog(
  confirm: Confirm,
  title: Html,
  body: Html,
  action: string,
  label: string,
  tone: 'primary' | 'danger' = 'primary',
) {
  const url = connectionUrl(confirm.slug);
  return html`<dialog open data-confirm aria-labelledby="confirm-title">
    <h2 id="confirm-title">${title}</h2>
    ${body}
    <form method="post" action="${action}" class="actions">
      ${csrfField(confirm.csrf)}
      <input type="hidden" name="nonce" value="${confirm.nonce}" />
      <button class="btn ${tone}">${label}</button>
      <a class="btn quiet" href="${url}" data-cancel>Cancel</a>
    </form>
  </dialog>`;
}

/** One mailbox: a summary of its mail, not a list of it. */
export function mailboxPage(opts: {
  connection: ConnectionOverview;
  mailbox: ConnectionOverview['mailboxes'][number];
  /** Its newest message, sent or received, and how many it has. */
  newest: HistoryItem | undefined;
  messages: number;
  csrf: string;
  flash: Flash;
  /** The Wake-up section, unless wake-ups are off (WAKE_UPS). */
  wakeUp?: Html | undefined;
}): Html {
  const { connection: c, mailbox: m, newest, csrf } = opts;
  const url = mailboxUrl(c.slug, m.handle);
  const address = `${c.slug}/${m.handle}`;
  return html`${crumbs(['Connections', '/ui'], [c.slug, connectionUrl(c.slug)], m.handle)}
    <div class="page-head">
      ${nameMenu({
        name: html`<code>${m.handle}</code>`,
        what: 'mailbox',
        messages: messagesUrl(c.slug, m.handle),
        audit: auditUrl(c.slug, m.handle),
        after: html`${m.archivedAt !== null ? html`<span class="status archived">Archived</span>` : ''}${badge(m.unread)}`,
      })}
      <div class="meta">
        <span>Mailbox <code>${c.slug}/${m.handle}</code> ${unverifiedInfo('mailbox-note')}</span>
        <span>First used ${time(m.firstSeenAt)}</span>
        <span>Last read ${time(m.lastReadAt)}</span>
      </div>
    </div>
    ${
      // The standing notice below already says it was archived.
      flash(
        opts.flash.done === 'mailbox_archived' ? { error: opts.flash.error } : opts.flash,
        address,
      )
    }
    ${
      c.archivedAt !== null
        ? notice(
            'warn',
            'Its connection is archived,',
            html`so this mailbox takes no mail. Restore
              <a href="${connectionUrl(c.slug)}"><code>${c.slug}</code></a> to use it.`,
          )
        : ''
    }
    ${
      m.archivedAt !== null && c.archivedAt === null
        ? html`<div class="notice warn restore">
            <p>
              <strong>Archived ${time(m.archivedAt)}.</strong> It takes no new mail and no agent can
              use it. Its history is kept.
            </p>
            <form method="post" action="${url}/restore">
              ${csrfField(csrf)}
              <button>Restore ${address}</button>
            </form>
          </div>`
        : ''
    }
    <section class="group${m.archivedAt !== null || c.archivedAt !== null ? ' frozen' : ''}">
      <h2>Mail</h2>
      <div class="item">
        <div class="what">
          <strong>${m.unread > 0 ? plural(m.unread, 'unread message') : 'Nothing unread'}</strong>
          ${
            newest
              ? html`<p>
                  Newest:
                  <span class="subject">${newest.message.subject ?? '(no subject)'}</span> from
                  ${handle(newest.message.fromConnectionSlug, newest.message.fromHandle)},
                  ${time(newest.message.createdAt)}.
                  <a href="${messagesUrl(c.slug, m.handle)}"
                    >${plural(opts.messages, 'message')} in all</a
                  >.
                </p>`
              : html`<p>No messages yet.</p>`
          }
        </div>
      </div>
    </section>
    ${m.archivedAt === null && c.archivedAt === null ? (opts.wakeUp ?? '') : ''}
    ${
      m.archivedAt === null && c.archivedAt === null
        ? html`<section class="group">
            <h2>Archive</h2>
            <div class="item">
              <div class="what">
                <strong>Archive this mailbox</strong>
                <p>
                  Hides it and refuses new mail; agents can't use it, and senders are told why. Its
                  history is kept, it stops counting towards the connection's mailboxes, and you can
                  restore it.
                </p>
              </div>
              <form method="post" action="${url}/archive">
                ${csrfField(csrf)}
                <button class="btn danger">Archive ${address}</button>
              </form>
            </div>
          </section>`
        : ''
    }`;
}

/** How to add a connection: an app signs itself in; in hosted mode a human can make one with an API key. */
export function newConnectionPage(opts: {
  mcpUrl: string;
  /** Hosted mode: the API-key form, with what was typed and what went wrong. */
  keyForm?:
    | {
        csrf: string;
        name?: string | undefined;
        label?: string | undefined;
        error?: string | undefined;
        nameInvalid?: boolean;
        full: boolean;
      }
    | undefined;
}): Html {
  const form = opts.keyForm;
  return html`${crumbs(['Connections', '/ui'], 'New connection')}
    <div class="page-head">
      <h1>New connection</h1>
      <p class="lede">
        Each app or agent you connect becomes a connection, with its own contact policy.
      </p>
    </div>
    <section class="group">
      <h2>An app you sign in with</h2>
      <div class="item block">
        <p>
          For Claude Code, Claude Desktop, Cursor and other MCP apps. Add Budd as a remote MCP
          server at this
          address${form ? '; the app opens your browser so you can sign in and approve it' : ''}. It
          appears in Connections when it first connects.
        </p>
        <code class="addr">${opts.mcpUrl}</code>
      </div>
    </section>
    ${
      form
        ? html`<section class="group">
            <h2>An agent with an API key</h2>
            <form class="item block" method="post" action="${NEW_CONNECTION_URL}">
              ${csrfField(form.csrf)}
              <p>
                For agents that can't open a browser: daemons, CI, Multica agents. Budd makes the
                connection and gives it a key, shown once. It accepts messages from no one until you
                change its contact policy.
              </p>
              ${form.error ? notice('bad', 'Nothing changed.', form.error) : ''}
              ${
                form.full && !form.error
                  ? notice(
                      'warn',
                      'Workspace full.',
                      html`It already has the most connections it may have. Archive one you no
                        longer use under <a href="/ui?view=table">Connections</a> before adding
                        another.`,
                    )
                  : ''
              }
              <div class="field">
                <label for="name">Connection name</label>
                <input
                  id="name"
                  type="text"
                  name="name"
                  value="${form.name ?? ''}"
                  maxlength="40"
                  autocomplete="off"
                  autocapitalize="none"
                  spellcheck="false"
                  required
                  aria-describedby="name-hint"
                  ${form.nameInvalid ? html`aria-invalid="true"` : ''}
                />
                <span class="hint" id="name-hint"
                  >Agents and other connections see this name, and messages go to
                  <code>name/handle</code>. Use ${SLUG_RULES}. It can't be changed later.</span
                >
              </div>
              <div class="field">
                <label for="label">Label <span class="muted">(optional)</span></label>
                <input
                  id="label"
                  type="text"
                  name="label"
                  value="${form.label ?? ''}"
                  maxlength="80"
                  aria-describedby="label-hint"
                />
                <span class="hint" id="label-hint">Only you see it.</span>
              </div>
              <button class="btn primary">Create the connection and its key</button>
            </form>
          </section>`
        : ''
    }`;
}

export const notFoundPage = (what: string, kind: 'connection' | 'mailbox' = 'connection'): Html =>
  html`${crumbs(['Connections', '/ui'], 'Not found')}
    <div class="page-head">
      <h1>
        ${
          kind === 'mailbox'
            ? html`No mailbox <code>${what}</code>`
            : isValidSlug(what)
              ? html`No connection named <code>${what}</code>`
              : 'No such connection'
        }
      </h1>
      <p class="lede">It may have been renamed, or it never connected.</p>
    </div>
    <p><a class="btn" href="/ui?view=table">All connections</a></p>`;

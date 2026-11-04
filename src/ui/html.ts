import { html, raw } from 'hono/html';
import type { HtmlEscapedString } from 'hono/utils/html';

export type Html = HtmlEscapedString | Promise<HtmlEscapedString>;

export const PAGE_SIZE = 100;

export const connectionUrl = (slug: string) => `/ui/connections/${encodeURIComponent(slug)}`;

/** A mailbox's own page. Under `mailboxes/`, so a handle can't collide with a connection's other pages. */
export const mailboxUrl = (slug: string, handle: string) =>
  `${connectionUrl(slug)}/mailboxes/${encodeURIComponent(handle)}`;

/** The Messages and Audit log pages, filtered to a connection or one of its mailboxes. */
export const messagesUrl = (slug: string, handle?: string) =>
  `/ui/messages?mailbox=${encodeURIComponent(handle ? `${slug}/${handle}` : slug)}`;
export const auditUrl = (slug: string, handle?: string) =>
  `/ui/audit?${handle ? `mailbox=${encodeURIComponent(`${slug}/${handle}`)}` : `connection=${encodeURIComponent(slug)}`}`;

const iso = (ms: number) =>
  new Date(ms)
    .toISOString()
    .replace('T', ' ')
    .replace(/\.\d+Z$/, 'Z');

/**
 * A time in UTC. app.js rewrites it in the reader's own terms: "5 min ago", or
 * for the `log` format a local timestamp; the local time and UTC on hover.
 */
export const time = (ms: number | null, format?: 'log') =>
  ms === null
    ? html`<span class="muted">never</span>`
    : html`<time
        datetime="${new Date(ms).toISOString()}"
        ${format ? html`data-format="${format}"` : ''}
        >${iso(ms)}</time
      >`;

/** A sender or recipient: `connection/handle`, a chip that opens the mailbox. Budd's own notices have no handle. */
export const handle = (connection: string, name: string | null) =>
  name === null
    ? html`<code class="handle">${connection}</code>`
    : html`<a class="chip-link" href="${mailboxUrl(connection, name)}"
        ><code class="handle">${connection}/${name}</code></a
      >`;

/** A handle listed under its own connection, whose list carries one `unverifiedInfo`. */
export const mailbox = (name: string) => html`<code class="handle">${name}</code>`;

const svg = (paths: string, cls = 'icon') =>
  html`<svg
    class="${cls}"
    viewBox="0 0 16 16"
    aria-hidden="true"
    fill="none"
    stroke="currentColor"
    stroke-width="1.5"
    stroke-linecap="round"
    stroke-linejoin="round"
  >
    ${raw(paths)}
  </svg>`;

/** The UI's icons: always beside a word, or on a button with a name and a tooltip. */
export const ICONS = {
  warning: svg('<path d="M8 1.5 15 14H1z"/><path d="M8 6v3.5M8 11.5v.5"/>'),
  mail: svg('<rect x="1.5" y="3.5" width="13" height="9" rx="1.5"/><path d="m2 4.5 6 4.5 6-4.5"/>'),
  log: svg(
    '<path d="M5.5 4h8M5.5 8h8M5.5 12h8"/><circle cx="2.5" cy="4" r=".6"/><circle cx="2.5" cy="8" r=".6"/><circle cx="2.5" cy="12" r=".6"/>',
  ),
  thread: svg(
    '<path d="M2 3.5h9A1.5 1.5 0 0 1 12.5 5v4A1.5 1.5 0 0 1 11 10.5H7l-3 2.5v-2.5H2A1.5 1.5 0 0 1 .5 9V5A1.5 1.5 0 0 1 2 3.5z"/><path d="M14 6.5h.5a1 1 0 0 1 1 1v3a1 1 0 0 1-1 1h-1v2l-2.5-2"/>',
  ),
  code: svg('<path d="M5.5 4 1.5 8l4 4M10.5 4l4 4-4 4"/>'),
  id: svg('<path d="M6 2 4.5 14M11.5 2 10 14M2.5 5.5h12M1.5 10.5h12"/>'),
  check: svg('<path d="M3 8.5l3 3 7-7"/>'),
  send: svg('<path d="M1.5 8 14.5 2l-3 12-3.5-4.5zM8 9.5l6.5-7.5"/>'),
  arrow: svg('<path d="M3 8h9M8.5 4.5 12 8l-3.5 3.5"/>'),
  newTab: svg('<path d="M9 2.5h4.5V7M13.5 2.5 7.5 8.5M11.5 9.5v3.5h-9v-9H6"/>'),
  shield: svg('<path d="M8 1.5 13.5 3.5v4c0 3.2-2.3 5.8-5.5 7-3.2-1.2-5.5-3.8-5.5-7v-4z"/>'),
  lock: svg(
    '<rect x="3" y="7" width="10" height="7.5" rx="1"/><path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2"/>',
  ),
  chevron: svg('<path d="m4 6 4 4 4-4"/>', 'chev'),
  settings: svg(
    '<circle cx="8" cy="8" r="2.2"/><path d="M8 1.5v2M8 12.5v2M1.5 8h2M12.5 8h2M3.4 3.4l1.4 1.4M11.2 11.2l1.4 1.4M3.4 12.6l1.4-1.4M11.2 4.8l1.4-1.4"/>',
  ),
  close: svg('<path d="M3.5 3.5l9 9M12.5 3.5l-9 9"/>'),
  filter: svg('<path d="M1.5 2.5h13L9.5 8.5v5l-3-1.5V8.5z"/>'),
  filterOn: svg('<path class="fill" d="M1.5 2.5h13L9.5 8.5v5l-3-1.5V8.5z"/>'),
  plus: svg('<path d="M8 3v10M3 8h10"/>'),
  minus: svg('<path d="M3 8h10"/>'),
  fit: svg('<path d="M2 6V2h4M10 2h4v4M14 10v4h-4M6 14H2v-4"/>'),
} as const;

/**
 * One marker for a list of handles: a warning sign that explains, on hover,
 * focus or tap, that handles are unverified. Pages work without JS.
 */
export const unverifiedInfo = (id: string) =>
  html`<span class="info" tabindex="0" aria-describedby="${id}"
    >${ICONS.warning}<span class="sr-only">Handles are unverified</span
    ><span class="info-pop" role="tooltip" id="${id}"
      ><strong>Handles are unverified.</strong> Each agent names its own handle, and any agent on a
      connection can use any of its handles. Budd verifies the connection, not the handle.</span
    ></span
  >`;

export const csrfField = (csrf: string) =>
  html`<input type="hidden" name="_csrf" value="${csrf}" />`;

export type Tone = 'ok' | 'warn' | 'bad';

/**
 * The one shape for an outcome or a caution: a leading word or sentence, then
 * the detail. A standing condition (`live: false`) isn't announced: live pages
 * redraw it, and it's no news each time.
 */
export const notice = (
  tone: Tone,
  lead: string,
  detail: Html | string = '',
  { live = true }: { live?: boolean } = {},
) =>
  html`<p class="notice ${tone}" ${live ? html`role="${tone === 'ok' ? 'status' : 'alert'}"` : ''}>
    <strong>${lead}</strong> ${detail}
  </p>`;

export const list = (items: string[]) =>
  html`${items.map((s, i) => html`${i > 0 ? ', ' : ''}<code>${s}</code>`)}`;

export const plural = (n: number, one: string, many = `${one}s`) =>
  `${n.toLocaleString('en')} ${n === 1 ? one : many}`;

/** "3 messages", or "1 message matches" / "3 messages match" when filtered. */
export const matching = (n: number, one: string, many: string, filtered: boolean) =>
  `${plural(n, one, many)}${filtered ? (n === 1 ? ' matches' : ' match') : ''}`;

/** Where a page sits, below its section: each step a link but the last. */
export const crumbs = (...steps: (readonly [string | Html, string] | string | Html)[]) =>
  html`<nav aria-label="Breadcrumb">
    <ol class="crumbs">
      ${steps.map((step, i) =>
        i === steps.length - 1 || !Array.isArray(step)
          ? html`<li ${i === steps.length - 1 ? html`aria-current="page"` : ''}>
              ${Array.isArray(step) ? step[0] : step}
            </li>`
          : html`<li><a href="${step[1]}">${step[0]}</a></li>`,
      )}
    </ol>
  </nav>`;

/**
 * A page's name, opening a menu of the other pages about it: Messages and the
 * Audit log, filtered to it. A <details>, so it works without JS. Nothing that
 * looks like a tab leads to another page.
 */
export const nameMenu = (opts: {
  name: Html | string;
  what: 'connection' | 'mailbox';
  messages: string;
  audit: string;
  after?: Html | string;
}) =>
  // The heading stays out of the <summary>, which is a button: a button's name hides a
  // heading from heading navigation. Sighted people see one clickable name.
  html`<div class="title-row">
    <h1 class="sr-only">${opts.name}</h1>
    <details class="go" data-menu>
      <summary aria-label="${opts.name}: its messages and audit log">
        <span class="h1" aria-hidden="true">${opts.name}</span>${ICONS.chevron}
      </summary>
      <div class="menu">
        <p class="hint">Opens the page, filtered to this ${opts.what}</p>
        <a href="${opts.messages}"><span class="lead">${ICONS.mail}Messages</span>${ICONS.arrow}</a>
        <a href="${opts.audit}"><span class="lead">${ICONS.log}Audit log</span>${ICONS.arrow}</a>
      </div>
    </details>
    ${opts.after ?? ''}
  </div>`;

/** The sort a table's query string asked for, among the columns it allows; else `fallback`. */
export const sortOf = <K extends string>(
  query: Record<string, string | undefined>,
  columns: readonly K[],
  fallback: K,
  fallbackDir: 'asc' | 'desc' = 'asc',
): { by: K; dir: 'asc' | 'desc' } => {
  const by = columns.find((c) => c === query.sort) ?? fallback;
  return { by, dir: query.dir === 'desc' || query.dir === 'asc' ? query.dir : fallbackDir };
};

const SORT_ICONS = {
  ascending: '<path d="M4 10l4-4 4 4"/>',
  descending: '<path d="M4 6l4 4 4-4"/>',
  none: '<path d="M5 6.5l3-3 3 3M5 9.5l3 3 3-3"/>',
};

/**
 * A heading that sorts its table: a link, so it works without JS. The sorted
 * column carries `aria-sort` and an arrow; choosing it again reverses it.
 */
export const sortHeading = (
  label: string,
  key: string,
  sort: { by: string; dir: 'asc' | 'desc' },
  href: (changes: { sort: string; dir: string }) => string,
) => {
  const on = sort.by === key;
  const state = on ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none';
  return html`<th ${on ? html`aria-sort="${state}"` : ''}>
    <a
      class="sort${on ? ' on' : ''}"
      href="${href({ sort: key, dir: on && sort.dir === 'asc' ? 'desc' : 'asc' })}"
      >${label}${svg(SORT_ICONS[state])}</a
    >
  </th>`;
};

/** Compares for a sort, nulls last whichever the direction. */
export const compare = (
  a: string | number | null,
  b: string | number | null,
  dir: 'asc' | 'desc',
): number => {
  if (a === b) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  const order =
    typeof a === 'string' && typeof b === 'string' ? a.localeCompare(b) : a < b ? -1 : 1;
  return dir === 'asc' ? order : -order;
};

/** An icon button that opens another page: named for screen readers, with the same words on hover. */
export const iconLink = (href: string, icon: Html, label: string) =>
  html`<a class="icon-btn" href="${href}" aria-label="${label}" title="${label}">${icon}</a>`;

/** Links to page back through a long list, and back to its start. */
export const pager = (older: string | undefined, newest: string | undefined) =>
  older || newest
    ? html`<div class="pager">
        ${newest ? html`<a href="${newest}">Back to the newest</a>` : ''}
        ${older ? html`<a href="${older}">Older</a>` : ''}
      </div>`
    : '';

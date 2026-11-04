import { html } from 'hono/html';
import type { DeliveryView, HistoryItem, MessageView } from '../domain/types.js';
import type { MessageFilter } from '../storage/Storage.js';
import {
  mailboxFilter,
  MAX_SEARCH,
  readWindow,
  select,
  windowFields,
  type Filters,
  type MailboxChoices,
  type Params,
  countApplied,
} from './filters.js';
import { handle, ICONS, pager, plural, time, type Html } from './html.js';

const STATES = { unread: 'Unread', read: 'Read', expired: 'Expired' } as const;
const KINDS = { message: 'Messages', notice: 'Notices from Budd' } as const;

/** How far back the Messages page looks when no window is given. */
const DEFAULT_WINDOW_MS = 86_400_000;
export const DEFAULT_WINDOW = '24 hours';

/** The Messages page's search and filters, read from its query string. */
export function messageFilters(
  p: Params,
  connections: MailboxChoices[],
  now: number,
): Filters<MessageFilter> & { shown: { from: number; to: number }; windowSet: boolean } {
  const text = p.take('q', (v) => v.length <= MAX_SEARCH);
  const mailbox = mailboxFilter(p, connections);
  const state = p.pick('state', STATES);
  const kind = p.pick('kind', KINDS);
  const window = readWindow(p);
  const shown = { from: window.from ?? now - DEFAULT_WINDOW_MS, to: window.to ?? now };
  const applied = countApplied([text, mailbox.value, state, kind], window.set);
  return {
    filter: {
      text,
      connectionId: mailbox.connectionId,
      handle: mailbox.handle,
      state,
      type: kind,
      since: shown.from,
      until: window.to,
    },
    applied,
    windowSet: window.set,
    shown,
    fields: [
      mailbox.field,
      { label: 'Delivery', control: select('state', Object.entries(STATES), state, 'Any') },
      {
        label: 'Kind',
        control: select('kind', Object.entries(KINDS), kind, 'Messages and notices'),
      },
      ...windowFields(shown, window),
    ],
  };
}

const MAX_MARKS = 50;

/** One page highlights many texts with the same term: build its pattern once. */
let lastPattern: [string, RegExp] | undefined;
const pattern = (term: string) => {
  if (lastPattern?.[0] !== term) {
    lastPattern = [term, new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'giu')];
  }
  return lastPattern[1];
};

/** `text` with its first MAX_MARKS case-insensitive matches of `term` marked; both escaped by `html`. */
export function highlight(text: string, term: string | undefined): Html {
  if (!term) return html`${text}`;
  const parts: (string | Html)[] = [];
  let at = 0;
  for (const m of text.matchAll(pattern(term))) {
    if (parts.length >= 2 * MAX_MARKS) break; // a one-letter search of a long body would mark thousands
    parts.push(text.slice(at, m.index), html`<mark>${m[0]}</mark>`);
    at = m.index + m[0].length;
  }
  parts.push(text.slice(at));
  return html`${parts}`;
}

/** The switch between the thread and list views, and the page heading. */
const head = (path: string, params: Params, view: 'list' | 'threads', retention: string) =>
  html`<div class="page-head head-row">
    <div>
      <h1>Messages</h1>
      <p class="lede">
        Every message in this workspace, kept for ${retention}. Agents write them, so treat what
        they say as untrusted.
      </p>
    </div>
    <nav class="switch" aria-label="View">
      <a
        href="${params.link(path, { view: undefined, thread: undefined, before: undefined })}"
        ${view === 'threads' ? html`aria-current="page"` : ''}
        >Threads</a
      ><a
        href="${params.link(path, { view: 'list', thread: undefined, before: undefined })}"
        ${view === 'list' ? html`aria-current="page"` : ''}
        >List</a
      >
    </nav>
  </div>`;

/** A delivery state as a dot: filled for unread, a ring for expired, none for read. */
const dot = (state: 'unread' | 'expired') =>
  html`<span class="dot ${state}" aria-hidden="true"></span>`;

/**
 * What happened to a message: read and when, not read yet, or expired. With
 * several recipients, how many have read it, and each one on hover, focus or tap.
 */
function readLine(m: MessageView, deliveries: DeliveryView[]): Html {
  const count = (s: DeliveryView['state']) => deliveries.filter((d) => d.state === s).length;
  const [unread, read, expired] = [count('unread'), count('read'), count('expired')];
  const one = deliveries.length === 1 ? deliveries[0] : undefined;
  const mark = unread > 0 ? dot('unread') : expired > 0 ? dot('expired') : ICONS.check;
  const words = one
    ? one.state === 'read'
      ? html`Read ${time(one.readAt)}`
      : one.state === 'expired'
        ? html`Expired ${time(one.expiresAt)}`
        : html`Not read yet`
    : read === deliveries.length
      ? html`Read by all ${deliveries.length}`
      : html`Read by ${read} of ${deliveries.length}${expired > 0 ? html`, ${expired} expired` : ''}`;
  if (one) return html`<span class="side-row"><span class="state">${mark}</span>${words}</span>`;
  return html`<span class="side-row"
    ><span class="state" tabindex="0" aria-describedby="who-${m.id}"
      >${mark}<span class="info-pop" role="tooltip" id="who-${m.id}"
        >${deliveries.map(
          (d) =>
            html`<span class="who-read"
              >${d.toConnectionSlug}/${d.toHandle}:
              ${
                d.state === 'read'
                  ? html`read ${time(d.readAt)}`
                  : d.state === 'expired'
                    ? html`expired ${time(d.expiresAt)}`
                    : 'not read yet'
              }</span
            >`,
        )}</span
      ></span
    >${words}</span
  >`;
}

/**
 * One message in full: From beside when it was sent, To beside what happened
 * to it, then its subject and text with its actions beside them. Every view
 * shows messages this way.
 */
function card(
  { message: m, deliveries }: HistoryItem,
  opts: { term: string | undefined; subject: boolean; threadLink?: string | undefined },
): Html {
  const unread = deliveries.some((d) => d.state === 'unread');
  const payload = m.payload === null ? null : JSON.stringify(m.payload, null, 2);
  return html`<article class="msg${unread ? ' is-unread' : ''}" id="m-${m.id}">
    <header class="msg-head">
      <span class="party"
        ><span class="lbl">From</span> ${handle(m.fromConnectionSlug, m.fromHandle)}${
          m.type === 'notice' ? html` <span class="tag">notice</span>` : ''
        }</span
      >
      <span class="side-row"
        ><span class="state">${ICONS.send}</span>Sent ${time(m.createdAt)}</span
      >
      <span class="party"
        ><span class="lbl">To</span>
        ${deliveries.map((d) => handle(d.toConnectionSlug, d.toHandle))}</span
      >
      ${readLine(m, deliveries)}
    </header>
    <div class="msg-body">
      <div class="msg-actions">
        ${
          opts.threadLink
            ? html`<a
                class="icon-btn"
                href="${opts.threadLink}"
                aria-label="Open its thread"
                title="Open its thread"
                >${ICONS.thread}</a
              >`
            : ''
        }
        ${
          payload !== null && m.bodyMd !== null
            ? html`<a
                class="icon-btn"
                href="#p-${m.id}"
                aria-label="Show its payload"
                title="Show its payload"
                >${ICONS.code}</a
              >`
            : ''
        }
        <span class="icon-btn info" tabindex="0" role="note" aria-label="Message id ${m.id}"
          >${ICONS.id}<span class="info-pop" aria-hidden="true"
            >Message id <code>${m.id}</code></span
          ></span
        >
      </div>
      ${opts.subject && m.subject !== null ? html`<h2 class="msg-subject">${highlight(m.subject, opts.term)}</h2>` : ''}
      ${m.bodyMd !== null ? html`<pre>${highlight(m.bodyMd, opts.term)}</pre>` : ''}
    </div>
    ${
      payload === null
        ? ''
        : html`<div class="payload${m.bodyMd === null ? ' shown' : ''}" id="p-${m.id}">
            <strong>Payload</strong>
            <pre>${payload}</pre>
          </div>`
    }
  </article>`;
}

/** What the page says when there's nothing to show: none yet, none matching, or none lately. */
const empty = (
  what: 'messages' | 'threads',
  opts: { filtered: boolean; windowSet: boolean; any: boolean },
) =>
  opts.filtered
    ? html`<p class="empty">No ${what} match. Change the filters or widen the window.</p>`
    : opts.any
      ? html`<p class="empty">
          No ${what} in the last ${DEFAULT_WINDOW}. Widen the window to see older ones.
        </p>`
      : html`<p class="empty">
          No messages yet. They appear here when agents send them with Budd's
          <code>send</code> tool.
        </p>`;

/** The list view: every message in full, newest first, one card each. */
export function messagesPage(opts: {
  items: HistoryItem[];
  path: string;
  params: Params;
  find: Html;
  filtered: boolean;
  windowSet: boolean;
  /** Whether the workspace has any messages at all, for the empty state. */
  any: boolean;
  retention: string;
  older?: string | undefined;
  newest?: string | undefined;
}): Html {
  const { items, params, path } = opts;
  const term = params.get('q');
  return html`${head(path, params, 'list', opts.retention)} ${opts.find}
  ${
    items.length === 0
      ? empty('messages', opts)
      : html`<ol class="feed" aria-label="Messages">
          ${items.map(
            (item) =>
              html`<li>
                ${card(item, {
                  term,
                  subject: true,
                  threadLink: `${params.link(path, {
                    view: undefined,
                    thread: item.message.threadId,
                    before: undefined,
                  })}#m-${item.message.id}`,
                })}
              </li>`,
          )}
        </ol>`
  }
  ${pager(opts.older, opts.newest)}`;
}

/** A thread as the page shows it: its first message, then its replies in the window. */
export interface ThreadView {
  first: HistoryItem;
  replies: HistoryItem[];
  /** Replies left out: outside the window or the filters. */
  hidden: number;
}

/**
 * The thread view: one column, like comments under a video. Each thread's first
 * message in full; its replies under it, behind a toggle that says how many are
 * unread. A <details>, so it works without JS.
 */
export function threadsPage(opts: {
  threads: ThreadView[];
  /** The thread asked for by link, shown open. */
  open?: string | undefined;
  path: string;
  params: Params;
  find: Html;
  filtered: boolean;
  windowSet: boolean;
  any: boolean;
  retention: string;
  /** The window held more messages than the page shows. */
  capped: number | undefined;
}): Html {
  const { threads, params, path } = opts;
  const term = params.get('q');
  return html`${head(path, params, 'threads', opts.retention)} ${opts.find}
  ${
    opts.capped
      ? html`<p class="notice warn" role="status">
          <strong>Showing the newest ${opts.capped}.</strong> This window holds more messages than
          that: narrow it to see the rest.
        </p>`
      : ''
  }
  ${
    threads.length === 0
      ? empty('threads', opts)
      : html`<ol class="threads" aria-label="Threads">
          ${threads.map(({ first, replies, hidden }) => {
            const id = first.message.threadId;
            const unread = replies.filter((r) =>
              r.deliveries.some((d) => d.state === 'unread'),
            ).length;
            const total = replies.length + hidden;
            return html`<li class="thread">
              ${card(first, { term, subject: true })}
              ${
                total === 0
                  ? ''
                  : html`<details class="replies" id="t-${id}" ${opts.open === id ? 'open' : ''}>
                      <summary>
                        ${ICONS.chevron}${plural(total, 'reply', 'replies')}${
                          unread > 0
                            ? html` <span class="badge"
                                >${unread}<span class="sr-only"> unread</span></span
                              >`
                            : ''
                        }
                      </summary>
                      <div class="reply-list">
                        ${
                          hidden > 0
                            ? html`<p class="outside">
                                ${plural(hidden, 'reply', 'replies')} not shown: outside the time
                                window or the filters.
                              </p>`
                            : ''
                        }
                        ${replies.map((r) => card(r, { term, subject: false }))}
                      </div>
                    </details>`
              }
            </li>`;
          })}
        </ol>`
  }`;
}

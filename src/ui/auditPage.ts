import { html } from 'hono/html';
import type { AuditActor, AuditEventType, AuditRecord } from '../domain/types.js';
import type { AuditFilter } from '../storage/Storage.js';
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
import { connectionUrl, mailboxUrl, pager, time, type Html } from './html.js';

const GROUPS = {
  messages: 'Messages',
  mailboxes: 'Mailboxes',
  connections: 'Connections',
  policy: 'Contact policy',
  signins: 'Sign-ins and keys',
} as const;
type Group = keyof typeof GROUPS;

/** What each audit event means, in words, and how loudly to show it. */
const EVENTS: Record<
  AuditEventType,
  { label: string; group: Group; tone?: 'bad' | 'warn' | 'quiet' }
> = {
  send: { label: 'Message sent', group: 'messages' },
  send_refused: { label: 'Message refused', group: 'messages', tone: 'bad' },
  send_undelivered: { label: 'Message undeliverable', group: 'messages', tone: 'bad' },
  inbox_read: { label: 'Messages read', group: 'messages', tone: 'quiet' },
  delivery_expired: { label: 'Message expired unread', group: 'messages', tone: 'warn' },
  notice_created: { label: 'Notice from Budd', group: 'messages', tone: 'quiet' },
  retention_purge: { label: 'Old messages deleted', group: 'messages', tone: 'quiet' },
  audit_rotated: { label: 'Oldest audit entries deleted', group: 'messages', tone: 'warn' },
  handle_first_seen: { label: 'New mailbox', group: 'mailboxes' },
  mailbox_archived: { label: 'Mailbox archived', group: 'mailboxes', tone: 'bad' },
  mailbox_restored: { label: 'Mailbox restored', group: 'mailboxes' },
  wake_up_set: { label: 'Wake-up set', group: 'mailboxes', tone: 'warn' },
  wake_up_removed: { label: 'Wake-up removed', group: 'mailboxes' },
  connection_registered: { label: 'Connection added', group: 'connections' },
  connection_attached: { label: 'App took over a connection', group: 'connections', tone: 'warn' },
  connection_blocked: { label: 'Connection blocked', group: 'connections', tone: 'bad' },
  connection_unblocked: { label: 'Connection unblocked', group: 'connections', tone: 'warn' },
  connection_archived: { label: 'Connection archived', group: 'connections', tone: 'bad' },
  connection_restored: { label: 'Connection restored', group: 'connections' },
  connection_relabelled: { label: 'Connection relabelled', group: 'connections', tone: 'quiet' },
  policy_tightened: { label: 'Contact policy narrowed', group: 'policy' },
  policy_widened: { label: 'Contact policy widened', group: 'policy', tone: 'warn' },
  login: { label: 'Signed in', group: 'signins' },
  token_issued: { label: 'App signed in', group: 'signins' },
  token_refreshed: { label: 'App sign-in renewed', group: 'signins', tone: 'quiet' },
  token_revoked: { label: 'App signed out', group: 'signins', tone: 'bad' },
  key_created: { label: 'API key created', group: 'signins' },
  key_revoked: { label: 'API key revoked', group: 'signins', tone: 'bad' },
};

const eventsIn = (group: Group) =>
  (Object.keys(EVENTS) as AuditEventType[]).filter((e) => EVENTS[e].group === group);

/** Shows any event, including ones this version of Budd has no words for. */
function describe(event: string): { label: string; tone?: 'bad' | 'warn' | 'quiet' } {
  return Object.hasOwn(EVENTS, event) ? EVENTS[event as AuditEventType] : { label: event };
}

const ACTORS: Record<AuditActor, { short: string; by: string }> = {
  human: { short: 'you', by: 'you' },
  agent: { short: 'agent', by: 'an agent' },
  system: { short: 'budd', by: 'Budd' },
};

/**
 * The Event filter: a whole group (`g-<group>`), or one event. Each group opens
 * with "All of it", so a choice is one click either way.
 */
const EVENT_CHOICES = (Object.keys(GROUPS) as Group[]).map((g) => ({
  group: GROUPS[g],
  options: [
    [`g-${g}`, `All ${GROUPS[g].toLowerCase()}`] as [string, string],
    ...eventsIn(g).map((e): [string, string] => [e, EVENTS[e].label]),
  ],
}));

const eventChoice = (v: string): AuditEventType[] | undefined =>
  v.startsWith('g-') && Object.hasOwn(GROUPS, v.slice(2))
    ? eventsIn(v.slice(2) as Group)
    : Object.hasOwn(EVENTS, v)
      ? [v as AuditEventType]
      : undefined;

/** JSON with invisible and direction-changing characters spelled out, so a value can't disguise its line. */
const visible = (v: unknown, indent?: number) =>
  JSON.stringify(v, null, indent).replace(/[\p{Cf}\u2028\u2029]/gu, (c) => {
    const code = (c.codePointAt(0) ?? 0).toString(16);
    return code.length > 4 ? `\\u{${code}}` : `\\u${code.padStart(4, '0')}`;
  });

/** The Audit log's search and filters, read from its query string. */
export function auditFilters(
  p: Params,
  connections: MailboxChoices[],
  range: { first: number; last: number } | undefined,
): Filters<AuditFilter> & { shown: { from: number; to: number } | undefined } {
  const text = p.take('q', (v) => v.length <= MAX_SEARCH);
  const event = p.take('event', (v) => eventChoice(v) !== undefined);
  const mailbox = mailboxFilter(p, connections);
  const window = readWindow(p);
  // Filled in with the whole log when no window was asked for: never empty boxes.
  const shown = range && { from: window.from ?? range.first, to: window.to ?? range.last };
  const applied = countApplied([text, event, mailbox.value], window.set);
  return {
    filter: {
      text,
      events: event === undefined ? undefined : eventChoice(event),
      connectionId: mailbox.handle === undefined ? mailbox.connectionId : undefined,
      mailbox: mailbox.handle === undefined ? undefined : `${mailbox.slug ?? ''}/${mailbox.handle}`,
      since: window.from,
      until: window.to,
    },
    applied,
    shown,
    fields: [
      mailbox.field,
      { label: 'Event', control: select('event', EVENT_CHOICES, event, 'Any') },
      ...(shown ? windowFields(shown, window) : []),
    ],
  };
}

const ADDRESS = /^([a-z0-9-]+)\/([a-z0-9-]+)$/;

/** A detail's value: a mailbox address links to its page; anything else is shown exactly. */
const value = (v: unknown, slugs: Set<string>): Html | string => {
  if (
    Array.isArray(v) &&
    v.length > 0 &&
    v.every((x) => typeof x === 'string' && ADDRESS.test(x))
  ) {
    return html`${(v as string[]).map((x, i) => html`${i > 0 ? ',' : ''}${value(x, slugs)}`)}`;
  }
  if (typeof v !== 'string') return visible(v);
  const m = ADDRESS.exec(v);
  if (m?.[1] && m[2] && slugs.has(m[1])) return html`<a href="${mailboxUrl(m[1], m[2])}">${v}</a>`;
  return /^[^\s="\p{C}]+$/u.test(v) ? v : visible(v);
};

export function auditPage(opts: {
  rows: (AuditRecord & { connection: string | null })[];
  /** Connections that still exist, whose names link to their pages. */
  slugs: Set<string>;
  find: Html;
  filtered: boolean;
  older?: string | undefined;
  newest?: string | undefined;
}): Html {
  const { rows, slugs } = opts;
  return html`<div class="page-head">
      <h1>Audit log</h1>
      <p class="lede">
        Who did what in this workspace, newest first. It records metadata, never what messages said.
        Open an entry to see all of it.
      </p>
    </div>
    ${opts.find}
    <div class="scroller" id="audit-log" data-keep-scroll>
      <div class="console">
        <div class="console-bar">
          <span>budd audit</span>
          <span>handles in details are self-declared and unverified</span>
        </div>
        ${
          rows.length === 0
            ? html`<div class="empty">
                ${opts.filtered ? 'No entries match. Change the filters or widen the window.' : 'Nothing has happened yet.'}
              </div>`
            : rows.map((r) => {
                const event = describe(r.event);
                const details = Object.entries(r.detail);
                return html`<details class="line" id="a-${String(r.id)}">
                  <summary>
                    <span class="t">${time(r.at, 'log')}</span>
                    <span class="who">${ACTORS[r.actor].short}</span>
                    <span class="ev ${event.tone ?? ''}" title="${r.event}">${event.label}</span>
                    <span
                      >${
                        r.connection === null
                          ? '-'
                          : slugs.has(r.connection)
                            ? html`<a href="${connectionUrl(r.connection)}">${r.connection}</a>`
                            : r.connection
                      }</span
                    >
                    <span class="kv"
                      >${details.map(
                        ([k, v], i) => html`${i > 0 ? ' ' : ''}<b>${k}=</b>${value(v, slugs)}`,
                      )}</span
                    >
                  </summary>
                  <div class="line-detail">
                    <code>${r.event}</code> · by ${ACTORS[r.actor].by} · entry ${String(r.id)}
                    <pre>${visible(r.detail, 2)}</pre>
                  </div>
                </details>`;
              })
        }
      </div>
      ${pager(opts.older, opts.newest)}
    </div>`;
}

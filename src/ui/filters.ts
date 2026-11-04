import { html } from 'hono/html';
import { isValidSlug } from '../domain/slug.js';
import { ICONS, type Html } from './html.js';

/**
 * The Filters button on every list, opening a drawer with the search and the
 * filters. A <details>, so it opens without JS; the form is a GET, so a
 * filtered view is a link that can be bookmarked, shared and undone with Back.
 */

export const MAX_SEARCH = 100;

/** The query string a page was asked for, kept to the parameters it accepted. */
export class Params {
  private readonly kept = new URLSearchParams();

  constructor(private readonly raw: Record<string, string | undefined>) {}

  /** A trimmed value, or undefined if absent, blank or not `valid`. */
  take(name: string, valid: (v: string) => boolean = () => true): string | undefined {
    const v = this.raw[name]?.trim();
    if (!v || !valid(v)) return undefined;
    this.kept.set(name, v);
    return v;
  }

  /** One of `options`, by key. */
  pick<K extends string>(name: string, options: Readonly<Record<K, unknown>>): K | undefined {
    return this.take(name, (v) => Object.hasOwn(options, v)) as K | undefined;
  }

  /** This page's address with the given parameters set, or removed where undefined. */
  link(path: string, changes: Record<string, string | undefined>): string {
    const next = new URLSearchParams(this.kept);
    for (const [name, value] of Object.entries(changes)) {
      if (value === undefined) next.delete(name);
      else next.set(name, value);
    }
    const q = next.toString();
    return q ? `${path}?${q}` : path;
  }

  /** This page's address keeping only `names`: every search and filter cleared. */
  only(path: string, names: string[]): string {
    const next = new URLSearchParams();
    for (const name of names) {
      const v = this.kept.get(name);
      if (v !== null) next.set(name, v);
    }
    const q = next.toString();
    return q ? `${path}?${q}` : path;
  }

  get(name: string): string | undefined {
    return this.kept.get(name) ?? undefined;
  }
}

/** How many of a page's filters are set; From and To count as one, the time window. */
export const countApplied = (values: unknown[], windowSet = false) =>
  values.filter((v) => v !== undefined && v !== false).length + (windowSet ? 1 : 0);

type Option = [string, string];

export const select = (
  name: string,
  options: (Option | { group: string; options: Option[] })[],
  current: string | undefined,
  any: string,
) => {
  const option = ([value, label]: Option) =>
    html`<option value="${value}" ${value === current ? 'selected' : ''}>${label}</option>`;
  return html`<select name="${name}">
    <option value="">${any}</option>
    ${options.map((o) =>
      Array.isArray(o)
        ? option(o)
        : html`<optgroup label="${o.group}">${o.options.map(option)}</optgroup>`,
    )}
  </select>`;
};

/** A filter in the find bar: a labelled control, or a tick box with its label after it. */
export type Field = { label: string; control: Html } | { tick: Html };

export function findBar(opts: {
  path: string;
  params: Params;
  search: { label: string; placeholder: string };
  fields: Field[];
  /** Parameters the form keeps but doesn't show, such as the view. */
  hidden?: string[] | undefined;
  /** How many filters (the search included) are applied: the button shows it. */
  applied: number;
  summary: Html | string;
}): Html {
  const { path, params } = opts;
  const hidden = opts.hidden ?? [];
  const { applied } = opts;
  const here = params.link(path, {});
  const cleared = params.only(path, hidden);
  return html`<details class="find" data-drawer id="find">
      <summary class="filter-btn${applied > 0 ? ' on' : ''}">
        ${applied > 0 ? ICONS.filterOn : ICONS.filter}<span>Filters</span>${
          applied > 0
            ? html`<span class="badge">${applied}<span class="sr-only"> applied</span></span>`
            : ''
        }
      </summary>
      <a class="drawer-back" href="${here}" tabindex="-1" aria-hidden="true" data-drawer-cancel></a>
      <div class="drawer" role="dialog" aria-modal="true" aria-labelledby="find-title">
        <form method="get" action="${path}" role="search" aria-labelledby="find-title">
          ${hidden.map((name) => {
            const v = params.get(name);
            return v === undefined ? '' : html`<input type="hidden" name="${name}" value="${v}" />`;
          })}
          <div class="drawer-head">
            <h2 id="find-title">Filters</h2>
            <a class="icon-btn" href="${here}" aria-label="Cancel" title="Cancel" data-drawer-cancel
              >${ICONS.close}</a
            >
          </div>
          <div class="drawer-body">
            <label
              >${opts.search.label}
              <input
                type="search"
                name="q"
                value="${params.get('q') ?? ''}"
                maxlength="${MAX_SEARCH}"
                placeholder="${opts.search.placeholder}"
            /></label>
            ${opts.fields.map((f) =>
              'tick' in f
                ? html`<label class="choice">${f.tick}</label>`
                : html`<label>${f.label} ${f.control}</label>`,
            )}
            ${applied > 0 ? html`<a class="clear" href="${cleared}">Clear filters</a>` : ''}
          </div>
          <div class="drawer-foot">
            <button class="btn primary">Apply</button>
            <a class="btn" href="${here}" data-drawer-cancel>Cancel</a>
          </div>
        </form>
      </div>
    </details>
    <p class="result-bar" role="status">
      ${opts.summary}${
        applied > 0
          ? html`<span aria-hidden="true"> · </span><a href="${cleared}">Clear filters</a>`
          : ''
      }
    </p>`;
}

/** The filters a page took from its query string, ready for the store and the find bar. */
export interface Filters<F> {
  filter: F;
  fields: Field[];
  /** How many filters are applied (countApplied). */
  applied: number;
}

/** A `datetime-local` value: a minute, with no time zone. */
const LOCAL_MINUTE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/;
const MINUTE = 60_000;

/**
 * A From/To window, as typed in `datetime-local` boxes. app.js sends the
 * reader's offset from UTC in minutes (`tz`, as getTimezoneOffset gives it);
 * without JS the times are UTC. Undefined ends are open.
 */
export function readWindow(p: Params): { from?: number; to?: number; set: boolean } {
  const tz = Number(p.take('tz', (v) => /^-?\d{1,3}$/.test(v) && Math.abs(Number(v)) <= 840) ?? 0);
  const at = (name: string) => {
    const m = LOCAL_MINUTE.exec(p.take(name, (v) => LOCAL_MINUTE.test(v)) ?? '');
    if (!m) return undefined;
    const [, y, mo, d, h, mi] = m.map(Number) as [number, number, number, number, number, number];
    const ms = Date.UTC(y, mo - 1, d, h, mi) + tz * MINUTE;
    return Number.isFinite(ms) ? ms : undefined;
  };
  const from = at('from');
  const to = at('to');
  // The To minute is included whole.
  return {
    from,
    to: to === undefined ? undefined : to + MINUTE - 1,
    set: from !== undefined || to !== undefined,
  };
}

/** A UTC minute as `datetime-local` wants it. app.js shows it in the reader's time zone. */
const minute = (ms: number) => new Date(ms).toISOString().slice(0, 16);

/**
 * The From and To boxes, always filled in: with what was asked for, else the
 * page's defaults. A default left as it is isn't sent (app.js), so a window
 * that ends "now" keeps ending now.
 */
export const windowFields = (
  shown: { from: number; to: number },
  asked: { from?: number | undefined; to?: number | undefined },
): Field[] =>
  (['from', 'to'] as const).map((name) => ({
    label: name === 'from' ? 'From' : 'To',
    control: html`<input
      type="datetime-local"
      name="${name}"
      value="${minute(shown[name])}"
      data-utc
      ${asked[name] === undefined ? html`data-default` : ''}
    />`,
  }));

/** Said where times were typed: app.js replaces it with the reader's own zone. */
export const UTC_NOTE = html`<span data-utc-note> Times are UTC.</span>`;

/** What the Mailbox filter offers: each connection, and under it its mailboxes. */
export interface MailboxChoices {
  id: string;
  slug: string;
  mailboxes: { handle: string }[];
}

const MAILBOX = /^([a-z0-9-]+)(?:\/([a-z0-9-]+))?$/;

/**
 * The Mailbox filter: a whole connection (`slug`) or one mailbox (`slug/handle`).
 * Old links that say `connection=` still work.
 */
export function mailboxFilter(p: Params, connections: MailboxChoices[]) {
  const known = (v: string) => {
    const m = MAILBOX.exec(v);
    return !!m?.[1] && connections.some((c) => c.slug === m[1]) && (!m[2] || isValidSlug(m[2]));
  };
  const value = p.take('mailbox', known) ?? p.take('connection', known);
  const [, slug, handle] = MAILBOX.exec(value ?? '') ?? [];
  return {
    value,
    connectionId: connections.find((c) => c.slug === slug)?.id,
    slug,
    handle,
    field: {
      label: 'Mailbox',
      control: select(
        'mailbox',
        connections.map((c) => ({
          group: c.slug,
          options: [
            [c.slug, `All of ${c.slug}`] as Option,
            ...c.mailboxes.map((m): Option => [`${c.slug}/${m.handle}`, `${c.slug}/${m.handle}`]),
          ],
        })),
        value,
        'Any',
      ),
    } satisfies Field,
  };
}

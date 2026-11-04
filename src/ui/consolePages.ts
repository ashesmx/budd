import { html } from 'hono/html';
import { durationInWords, type Config } from '../config.js';
import { OPERATOR_LINK_TTL_MS } from '../domain/auth.js';
import type {
  ConsoleAccount,
  ConsoleKey,
  ConsoleWorkspace,
  Operator,
  UsagePoint,
} from '../storage/Storage.js';
import { SETTING_GROUPS, type SettingView } from '../settings.js';
import { DAY_MS, USAGE_KEPT_MS } from '../sweeper/usage.js';
import { plainPage } from './authPages.js';
import { compare, csrfField, ICONS, notice, plural, sortHeading, time, type Html } from './html.js';
import { page, profileMenu, type Profile } from './layout.js';
import { wordmarkFor } from './logo.js';

export type ConsoleSection = 'overview' | 'workspaces' | 'accounts' | 'environment' | 'operators';

const SECTIONS: [ConsoleSection, string, string][] = [
  ['overview', '/console', 'Overview'],
  ['workspaces', '/console/workspaces', 'Workspaces'],
  ['accounts', '/console/accounts', 'Accounts'],
  ['environment', '/console/environment', 'Environment'],
  ['operators', '/console/operators', 'Operators'],
];

const workspaceUrl = (id: string) => `/console/workspaces/${encodeURIComponent(id)}`;

/** A storage figure at or over this share of its limit is close to it. */
const NEAR_LIMIT = 0.8;

/** What the console says about this Budd. */
export interface Instance {
  version: string;
  mode: 'local' | 'hosted';
  address: string;
  startedAt: number;
  /** Hosted mode: who may sign in, and through which provider. */
  signIn: string | undefined;
  wakeUps: string;
  /** The hour of the latest storage measurement. */
  measuredAt: number | undefined;
}

export type Limits = Pick<Config['limits'], 'maxWorkspaceBytes' | 'maxAuditBytes' | 'rotateAudit'>;

type Sort<K> = { by: K; dir: 'asc' | 'desc' };
type SortLink = (changes: { sort: string; dir: string }) => string;

/**
 * A console page: the violet header, so it can't be taken for a workspace's
 * pages (ADR 0022), with the same account menu as the UI.
 */
export function consoleLayout(opts: {
  title: string;
  active: ConsoleSection;
  host: string;
  account: Profile | undefined;
  workspace: string;
  body: Html;
}): Html {
  return page({
    title: `${opts.title} · Budd console`,
    theme: opts.account?.theme,
    header: html`<header class="app-header op-header">
      <a class="brand" href="/console">${wordmarkFor('dark')}<span class="op-tag">Console</span></a>
      <nav aria-label="Console sections">
        ${SECTIONS.map(
          ([key, href, label]) =>
            html`<a href="${href}" ${opts.active === key ? html`aria-current="page"` : ''}
              >${label}</a
            >`,
        )}
      </nav>
      <div class="end">
        <code class="host">${opts.host}</code>
        ${
          opts.account
            ? profileMenu(opts.account, opts.workspace, {
                active: 'console',
                operator: true,
                logout: '/console/logout',
              })
            : ''
        }
      </div>
    </header>`,
    main: html`<main>${opts.body}</main>`,
  });
}

const head = (title: string, lede: Html | string) =>
  html`<div class="page-head">
    <h1>${title}</h1>
    <p class="lede">${lede}</p>
  </div>`;

const KB = 1024;
const MB = KB * KB;
/** A size in the unit that suits it: KB under a megabyte, so small workspaces don't read 0. */
const size = (bytes: number) => {
  if (bytes === 0) return '0 KB';
  if (bytes < KB) return 'under 1 KB';
  if (bytes < MB) return `${Math.round(bytes / KB)} KB`;
  const n = bytes / MB;
  return `${n >= 10 ? n.toFixed(0) : n.toFixed(1)} MB`;
};
/** As size, a decimal finer: the figure under the chart's pointer. */
const exactSize = (bytes: number) =>
  bytes < MB ? `${(bytes / KB).toFixed(1)} KB` : `${(bytes / MB).toFixed(1)} MB`;

type Level = 'ok' | 'near' | 'full';
const level = (bytes: number, limit: number): Level =>
  bytes >= limit ? 'full' : bytes >= limit * NEAR_LIMIT ? 'near' : 'ok';
/** With AUDIT_ROTATE the oldest entries make room, so a full audit log refuses nothing. */
const auditLevel = (bytes: number, limits: Limits): Level =>
  limits.rotateAudit ? 'ok' : level(bytes, limits.maxAuditBytes);

/** Storage against its limit: a bar, the figures, and words when it's close or full. */
function meter(bytes: number, limit: number, state: Level): Html {
  const share = bytes / limit;
  const pct = Math.round(share * 100);
  return html`<span class="op-usage"
    ><svg
      class="op-meter ${state}"
      viewBox="0 0 100 6"
      preserveAspectRatio="none"
      aria-hidden="true"
    >
      <rect class="track" width="100" height="6" rx="1"></rect>
      <rect class="fill" width="${String(Math.min(pct, 100))}" height="6" rx="1"></rect></svg
    ><span class="fig"
      ><span class="num">${size(bytes)}</span> of ${size(limit)}
      ${
        state === 'full'
          ? html`<span class="op-full">${String(pct)}%, at the limit</span>`
          : state === 'near'
            ? html`<span class="op-near">${String(pct)}%, close to the limit</span>`
            : html`<span class="muted"
                >${bytes > 0 && pct < 1 ? 'under 1%' : `${String(pct)}%`}</span
              >`
      }</span
    ></span
  >`;
}

const unmeasured = html`<span class="muted">Not measured yet</span>`;

const usageCells = (w: ConsoleWorkspace, limits: Limits) =>
  html`<td data-label="Messages">
      ${
        w.usage
          ? meter(
              w.usage.messagesBytes,
              limits.maxWorkspaceBytes,
              level(w.usage.messagesBytes, limits.maxWorkspaceBytes),
            )
          : unmeasured
      }
    </td>
    <td data-label="Audit log">
      ${
        w.usage
          ? meter(w.usage.auditBytes, limits.maxAuditBytes, auditLevel(w.usage.auditBytes, limits))
          : unmeasured
      }
    </td>`;

/**
 * A workspace's last 30 days in a table cell: its figure at each UTC midnight,
 * each in its own day's place, so a new workspace's line starts late.
 */
function spark(days: (number | null)[] | undefined, limit: number): Html {
  const measured = (days ?? []).flatMap((v, i) => (v === null ? [] : [{ i, v }]));
  const first = measured[0];
  const last = measured.at(-1);
  if (!first || !last || measured.length < 2) {
    return html`<span class="muted">Not enough yet</span>`;
  }
  const span = Math.max((days?.length ?? 0) - 1, 1);
  const x = (i: number) => 2 + (116 * i) / span;
  const y = (v: number) => 26 - (24 * Math.min(v, limit)) / limit;
  const points = measured.map((p) => `${x(p.i).toFixed(1)},${y(p.v).toFixed(1)}`).join(' ');
  return html`<svg
    class="op-spark"
    viewBox="0 0 120 28"
    role="img"
    aria-label="Last ${String(span + 1 - first.i)} days: ${size(first.v)} to ${size(last.v)}"
  >
    <polyline points="${points}"></polyline>
    <circle cx="${x(last.i).toFixed(1)}" cy="${y(last.v).toFixed(1)}" r="2.5"></circle>
  </svg>`;
}

/** The smallest round step of at least `v`, so the axis reads 0, 30, 60… or 0, 250, 500… */
const roundStep = (v: number) => {
  const power = 10 ** Math.floor(Math.log10(v));
  return ([1, 1.5, 2, 2.5, 3, 4, 5, 6, 7.5, 10].find((m) => m * power >= v) ?? 10) * power;
};

/**
 * One measure over time, in KB or MB, its limit dashed when it has one. The plot
 * stretches to the page while its labels stay text-sized; app.js shows the
 * figure under the pointer, and the table beneath has them all.
 */
function chart(opts: {
  points: { hour: number; bytes: number }[];
  from: number;
  to: number;
  limit: number | undefined;
}): Html {
  const most = Math.max(...opts.points.map((p) => p.bytes), opts.limit ?? 0);
  const unit = most < MB ? { bytes: KB, name: 'KB' } : { bytes: MB, name: 'MB' };
  const step = roundStep(Math.max((most / unit.bytes) * 1.05, 1) / 4);
  const ceiling = step * 4 * unit.bytes;
  const x = (hour: number) => (hour - opts.from) / (opts.to - opts.from);
  const y = (bytes: number) => 1 - bytes / ceiling;
  const at = (n: number) => (n * 1000).toFixed(1);
  const line = opts.points.map((p) => `${at(x(p.hour))},${at(y(p.bytes))}`).join(' ');
  const first = opts.points[0];
  const last = opts.points.at(-1);
  const days = Math.round((opts.to - opts.from) / DAY_MS);
  const ticks = days > 7 ? [30, 25, 20, 15, 10, 5, 0] : [7, 6, 5, 4, 3, 2, 1, 0];
  return html`<div class="op-chart">
    <div class="y-axis" aria-hidden="true">
      ${[4, 3, 2, 1, 0].map((k) => html`<span>${String(step * k)}${k === 4 ? ` ${unit.name}` : ''}</span>`)}
    </div>
    <div
      class="plot"
      data-chart
      data-x="${opts.points.map((p) => x(p.hour).toFixed(4)).join(',')}"
      data-y="${opts.points.map((p) => y(p.bytes).toFixed(4)).join(',')}"
      data-labels="${opts.points.map((p) => exactSize(p.bytes)).join(',')}"
      data-times="${opts.points.map((p) => String(p.hour)).join(',')}"
    >
      <svg viewBox="0 0 1000 1000" preserveAspectRatio="none" aria-hidden="true">
        ${[0, 250, 500, 750, 1000].map(
          (gy) =>
            html`<line class="grid" x1="0" x2="1000" y1="${String(gy)}" y2="${String(gy)}"></line>`,
        )}
        ${
          first && last
            ? html`<path
                class="area"
                d="M${at(x(first.hour))},1000 L${line.replaceAll(' ', ' L')} L${at(x(last.hour))},1000 Z"
              ></path>`
            : ''
        }
        <polyline class="line" points="${line}"></polyline>
        ${
          opts.limit === undefined
            ? ''
            : html`<line
                class="limit"
                x1="0"
                x2="1000"
                y1="${at(y(opts.limit))}"
                y2="${at(y(opts.limit))}"
              ></line>`
        }
        <line class="cross" data-chart-cross y1="0" y2="1000" hidden></line>
      </svg>
      <span class="dot" data-chart-dot hidden></span>
      <span class="tip" data-chart-tip hidden><strong></strong><span></span></span>
    </div>
    <div class="x-axis" aria-hidden="true">
      ${ticks.map((d) => html`<span>${d === 0 ? 'now' : `${String(d)} d ago`}</span>`)}
    </div>
  </div>`;
}

/** The chart's figures for readers without it: the largest of each day. */
function chartTable(label: string, points: { hour: number; bytes: number }[]): Html {
  const byDay = new Map<number, number>();
  for (const p of points) {
    const day = Math.floor(p.hour / DAY_MS) * DAY_MS;
    byDay.set(day, Math.max(byDay.get(day) ?? 0, p.bytes));
  }
  return html`<details class="op-figures">
    <summary>${label}, day by day</summary>
    <table>
      <thead>
        <tr>
          <th>Day (UTC)</th>
          <th>Largest that day</th>
        </tr>
      </thead>
      <tbody>
        ${[...byDay].map(
          ([day, bytes]) =>
            html`<tr>
              <td>${new Date(day).toISOString().slice(0, 10)}</td>
              <td>${size(bytes)}</td>
            </tr>`,
        )}
      </tbody>
    </table>
  </details>`;
}

export const PERIODS = { '7d': 7 * DAY_MS, '30d': USAGE_KEPT_MS } as const;
export type Period = keyof typeof PERIODS;

const periodSwitch = (period: Period, href: (p: Period) => string) =>
  html`<nav class="switch" aria-label="Storage period">
    <a href="${href('7d')}" ${period === '7d' ? html`aria-current="page"` : ''}>7 days</a
    ><a href="${href('30d')}" ${period === '30d' ? html`aria-current="page"` : ''}>30 days</a>
  </nav>`;

const nothingMeasured = html`<p class="pad muted">
  Nothing measured yet. Budd measures storage once an hour.
</p>`;

/** Far below its limit, a chart scales to its own figures, so they don't lie flat along zero. */
const limitShown = (points: { bytes: number }[], limit: number | undefined) =>
  limit !== undefined && Math.max(0, ...points.map((p) => p.bytes)) >= limit / 2;

function chartGroup(opts: {
  title: string;
  /** Beside the title, when this is the page's only chart. */
  aside?: Html | undefined;
  points: { hour: number; bytes: number }[];
  limit: number | undefined;
  from: number;
  now: number;
}): Html {
  const shown = limitShown(opts.points, opts.limit);
  return html`<section class="group">
    <div class="head-row">
      <h2>${opts.title}</h2>
      ${
        opts.limit === undefined
          ? ''
          : shown
            ? html`<span class="op-key"
                ><span class="swatch"></span>Limit ${size(opts.limit)}</span
              >`
            : html`<span class="op-key">Limit ${size(opts.limit)}, off this scale</span>`
      }
      ${opts.aside ?? ''}
    </div>
    ${
      opts.points.length === 0
        ? nothingMeasured
        : html`${chart({
              points: opts.points,
              from: opts.from,
              to: opts.now,
              limit: shown ? opts.limit : undefined,
            })}
            <div class="pad">${chartTable(opts.title, opts.points)}</div>`
    }
  </section>`;
}

const isClose = (w: ConsoleWorkspace, limits: Limits) =>
  w.usage !== undefined &&
  (level(w.usage.messagesBytes, limits.maxWorkspaceBytes) !== 'ok' ||
    auditLevel(w.usage.auditBytes, limits) !== 'ok');

export function overviewPage(opts: {
  instance: Instance;
  accounts: ConsoleAccount[];
  workspaces: ConsoleWorkspace[];
  operators: number;
  total: { hour: number; bytes: number }[];
  limits: Limits;
  period: Period;
  now: number;
}): Html {
  const { instance, accounts, workspaces, limits, now } = opts;
  const newAccounts = accounts.filter((a) => a.createdAt > now - 7 * DAY_MS).length;
  const apps = workspaces.reduce((n, w) => n + w.apps, 0);
  const live = workspaces.reduce((n, w) => n + w.liveApps, 0);
  const keys = workspaces.reduce((n, w) => n + w.keys, 0);
  const close = workspaces.filter((w) => isClose(w, limits));
  const thisHour = Math.floor(now / 3600_000) * 3600_000;
  const stat = (label: string, n: number, sub: string) =>
    html`<li>
      <span class="label">${label}</span><span class="big">${n.toLocaleString('en')}</span
      ><span class="sub">${sub}</span>
    </li>`;
  return html`${head(
      'Overview',
      html`How this Budd is doing. The console only shows: to change anything, use the
        <code>budd</code> command on the server.`,
    )}
    <ul class="op-stats">
      ${stat('Accounts', accounts.length, `${plural(newAccounts, 'new one', 'new ones')} in the last 7 days`)}
      ${stat('Workspaces', workspaces.length, `${close.length.toLocaleString('en')} at or near a limit`)}
      ${stat('Apps connected', apps, `${live.toLocaleString('en')} still signed in`)}
      ${stat('API keys', keys, 'that still work')}
    </ul>
    <div class="op-cols">
      <section class="group">
        <h2>This instance</h2>
        <div class="pad">
          <dl class="facts">
            <dt>Version</dt>
            <dd><code>${instance.version}</code></dd>
            <dt>Mode</dt>
            <dd>${instance.mode === 'hosted' ? 'Hosted' : 'Local'}</dd>
            <dt>Address</dt>
            <dd><code>${instance.address}</code></dd>
            <dt>Running since</dt>
            <dd>${time(instance.startedAt)}</dd>
            ${
              instance.signIn
                ? html`<dt>Sign-in</dt>
                    <dd>${instance.signIn}</dd>`
                : ''
            }
            <dt>Wake-ups</dt>
            <dd>${instance.wakeUps}</dd>
            <dt>Operators</dt>
            <dd>${String(opts.operators)}</dd>
            <dt>Storage measured</dt>
            <dd>
              ${
                instance.measuredAt === undefined
                  ? 'Not yet: every hour, from the first hour Budd runs'
                  : instance.measuredAt >= thisHour
                    ? 'Every hour; last this hour'
                    : html`Every hour; last ${time(instance.measuredAt)}`
              }
            </dd>
          </dl>
        </div>
      </section>
      <section class="group">
        <h2>At or near a limit</h2>
        ${
          close.length === 0
            ? html`<p class="pad">
                No workspace is near its limits (${String(Math.round(NEAR_LIMIT * 100))}% of
                <code>MAX_WORKSPACE_MB</code> or <code>MAX_AUDIT_MB</code>).
              </p>`
            : html`<div class="table-wrap">
                  <table class="stack">
                    <thead>
                      <tr>
                        <th>Workspace</th>
                        <th>Messages</th>
                        <th>Audit log</th>
                      </tr>
                    </thead>
                    <tbody>
                      ${close.map(
                        (w) =>
                          html`<tr>
                            <td>
                              <a href="${workspaceUrl(w.id)}"><code>${w.id}</code></a>
                            </td>
                            ${usageCells(w, limits)}
                          </tr>`,
                      )}
                    </tbody>
                  </table>
                </div>
                <p class="hint pad">
                  At the limit, Budd refuses that workspace’s new messages, or its agents, until
                  there’s room.
                </p>`
        }
      </section>
    </div>
    ${chartGroup({
      title: 'Messages stored, all workspaces',
      aside:
        opts.total.length === 0
          ? undefined
          : periodSwitch(opts.period, (p) => `/console?period=${p}`),
      points: opts.total,
      limit: undefined,
      from: now - PERIODS[opts.period],
      now,
    })}`;
}

type SortKeys<T> = Record<string, (item: T) => string | number | null>;

const sorted = <T>(items: T[], keys: SortKeys<T>, sort: Sort<string>) => {
  const key = keys[sort.by];
  return key ? items.toSorted((a, b) => compare(key(a), key(b), sort.dir)) : items;
};

const WORKSPACE_KEYS = {
  id: (w) => w.id,
  created: (w) => w.createdAt,
  apps: (w) => w.apps,
  keys: (w) => w.keys,
  messages: (w) => w.usage?.messagesBytes ?? null,
  audit: (w) => w.usage?.auditBytes ?? null,
  disk: (w) => w.usage?.fileBytes ?? null,
} satisfies SortKeys<ConsoleWorkspace>;
export const WORKSPACE_SORTS = Object.keys(WORKSPACE_KEYS) as (keyof typeof WORKSPACE_KEYS)[];

export function workspacesPage(opts: {
  workspaces: ConsoleWorkspace[];
  daily: Map<string, (number | null)[]>;
  limits: Limits;
  sort: Sort<keyof typeof WORKSPACE_KEYS>;
  sortLink: SortLink;
}): Html {
  const th = (label: string, key: keyof typeof WORKSPACE_KEYS) =>
    sortHeading(label, key, opts.sort, opts.sortLink);
  return html`${head(
      'Workspaces',
      'Every workspace on this Budd, by ID. Its name, connections and messages aren’t shown.',
    )}
    ${
      opts.workspaces.length === 0
        ? html`<p>No workspaces yet. Each account gets one when it first signs in.</p>`
        : html`<div class="table-wrap">
            <table class="stack">
              <thead>
                <tr>
                  ${th('Workspace', 'id')} ${th('Created', 'created')} ${th('Apps', 'apps')}
                  ${th('API keys', 'keys')} ${th('Messages', 'messages')}
                  ${th('Audit log', 'audit')} ${th('On disk', 'disk')}
                  <th>Last 30 days</th>
                </tr>
              </thead>
              <tbody>
                ${sorted(opts.workspaces, WORKSPACE_KEYS, opts.sort).map(
                  (w) =>
                    html`<tr>
                      <td>
                        <a href="${workspaceUrl(w.id)}"><code>${w.id}</code></a>
                      </td>
                      <td data-label="Created">${time(w.createdAt)}</td>
                      <td data-label="Apps">
                        ${String(w.apps)}
                        <span class="muted">(${String(w.liveApps)} signed in)</span>
                      </td>
                      <td data-label="API keys">${String(w.keys)}</td>
                      ${usageCells(w, opts.limits)}
                      <td data-label="On disk">
                        ${w.usage ? size(w.usage.fileBytes) : unmeasured}
                      </td>
                      <td data-label="Last 30 days">
                        ${spark(opts.daily.get(w.id), opts.limits.maxWorkspaceBytes)}
                      </td>
                    </tr>`,
                )}
              </tbody>
            </table>
          </div>`
    }
    <p class="hint">
      Messages and Audit log are what count against <code>MAX_WORKSPACE_MB</code> and
      <code>MAX_AUDIT_MB</code>. On disk is the file, which doesn’t shrink when messages are
      deleted.
    </p>`;
}

/** Why a workspace's storage needs a look, if it does. */
function storageNotices(w: ConsoleWorkspace, limits: Limits): Html[] {
  if (!w.usage) return [];
  const notices: Html[] = [];
  const messages = level(w.usage.messagesBytes, limits.maxWorkspaceBytes);
  const remedy = html`<code>RETENTION_TTL</code> or <code>MAX_WORKSPACE_MB</code> changes that, for
    every workspace.`;
  if (messages === 'full') {
    notices.push(
      notice(
        'bad',
        'Messages are at the limit.',
        html`Budd refuses this workspace’s new messages until older ones expire. ${remedy}`,
        { live: false },
      ),
    );
  } else if (messages === 'near') {
    notices.push(
      notice(
        'warn',
        'Messages are close to the limit.',
        html`At <code>MAX_WORKSPACE_MB</code> Budd refuses this workspace’s new messages until older
          ones expire. ${remedy}`,
        { live: false },
      ),
    );
  }
  const audit = auditLevel(w.usage.auditBytes, limits);
  if (audit !== 'ok') {
    notices.push(
      notice(
        audit === 'full' ? 'bad' : 'warn',
        audit === 'full'
          ? 'The audit log is at its limit.'
          : 'The audit log is close to its limit.',
        html`${
            audit === 'full'
              ? 'Budd refuses this workspace’s agents'
              : html`At <code>MAX_AUDIT_MB</code> Budd refuses its agents`
          }
          until there’s room. <code>AUDIT_ROTATE</code> deletes the oldest entries instead.`,
        { live: false },
      ),
    );
  }
  return notices;
}

export function workspacePage(opts: {
  workspace: ConsoleWorkspace;
  accounts: ConsoleAccount[];
  keys: ConsoleKey[];
  usage: UsagePoint[];
  limits: Limits;
  period: Period;
  now: number;
}): Html {
  const { workspace: w, limits, now } = opts;
  const from = now - PERIODS[opts.period];
  return html`<nav aria-label="Breadcrumb">
      <ol class="crumbs">
        <li><a href="/console/workspaces">Workspaces</a></li>
        <li aria-current="page"><code>${w.id}</code></li>
      </ol>
    </nav>
    <div class="page-head">
      <h1><code>${w.id}</code></h1>
      <p class="lede">
        Created ${time(w.createdAt)}. Storage is measured every hour and kept for 30 days.
      </p>
    </div>
    ${storageNotices(w, limits)}
    <div class="op-cols">
      <section class="group">
        <h2>Workspace</h2>
        <div class="pad">
          <dl class="facts">
            <dt>${opts.accounts.length === 1 ? 'Account' : 'Accounts'}</dt>
            <dd>
              ${
                opts.accounts.length === 0
                  ? html`<span class="muted">None</span>`
                  : opts.accounts.map(
                      (a, i) =>
                        html`${i > 0 ? ', ' : ''}<code>${a.id}</code>${
                          a.operator ? ' (operator)' : ''
                        }`,
                    )
              }
            </dd>
            <dt>Apps connected</dt>
            <dd>${String(w.apps)}, ${String(w.liveApps)} still signed in</dd>
            <dt>On disk</dt>
            <dd>${w.usage ? size(w.usage.fileBytes) : unmeasured}</dd>
          </dl>
        </div>
      </section>
      <section class="group">
        <h2>API keys</h2>
        ${
          opts.keys.length === 0
            ? html`<p class="pad muted">None</p>`
            : html`<div class="table-wrap">
                <table class="stack">
                  <thead>
                    <tr>
                      <th>Created</th>
                      <th>Last used</th>
                      <th>Stops working</th>
                    </tr>
                  </thead>
                  <tbody>
                    ${opts.keys.map(
                      (k) =>
                        html`<tr>
                          <td data-label="Created">${time(k.createdAt)}</td>
                          <td data-label="Last used">${time(k.lastUsedAt)}</td>
                          <td data-label="Stops working">${time(k.expiresAt)}</td>
                        </tr>`,
                    )}
                  </tbody>
                </table>
              </div>`
        }
      </section>
    </div>
    <div class="op-period">
      <h2>Storage</h2>
      ${
        opts.usage.length === 0
          ? ''
          : periodSwitch(opts.period, (p) => `${workspaceUrl(w.id)}?period=${p}`)
      }
    </div>
    ${chartGroup({
      title: 'Messages stored',
      points: opts.usage.map((p) => ({ hour: p.hour, bytes: p.messagesBytes })),
      limit: limits.maxWorkspaceBytes,
      from,
      now,
    })}
    ${chartGroup({
      title: 'Audit log stored',
      points: opts.usage.map((p) => ({ hour: p.hour, bytes: p.auditBytes })),
      limit: limits.maxAuditBytes,
      from,
      now,
    })}`;
}

/** How an account signs in, without saying who it is. */
export const provider = (issuer: string | null) =>
  issuer === null
    ? 'Local login'
    : issuer === 'https://accounts.google.com'
      ? 'Google'
      : (URL.parse(issuer)?.host ?? issuer);

const ACCOUNT_KEYS = {
  id: (a) => a.id,
  provider: (a) => provider(a.issuer),
  created: (a) => a.createdAt,
  signin: (a) => a.lastSignInAt,
  operator: (a) => (a.operator ? 1 : 0),
} satisfies SortKeys<ConsoleAccount>;
export const ACCOUNT_SORTS = Object.keys(ACCOUNT_KEYS) as (keyof typeof ACCOUNT_KEYS)[];

export function accountsPage(opts: {
  accounts: ConsoleAccount[];
  me: string;
  sort: Sort<keyof typeof ACCOUNT_KEYS>;
  sortLink: SortLink;
}): Html {
  const th = (label: string, key: keyof typeof ACCOUNT_KEYS) =>
    sortHeading(label, key, opts.sort, opts.sortLink);
  return html`${head(
      'Accounts',
      html`Everyone who has signed in to this Budd, by account ID. Emails and names aren’t shown
        here; <code>budd accounts</code> on the server lists them.`,
    )}
    <div class="table-wrap">
      <table class="stack">
        <thead>
          <tr>
            ${th('Account', 'id')} ${th('Signs in with', 'provider')} ${th('Created', 'created')}
            ${th('Last sign-in', 'signin')}
            <th>Workspace</th>
            ${th('Operator', 'operator')}
          </tr>
        </thead>
        <tbody>
          ${sorted(opts.accounts, ACCOUNT_KEYS, opts.sort).map(
            (a) =>
              html`<tr>
                <td>
                  <code>${a.id}</code>${a.id === opts.me ? html` <span class="tag">You</span>` : ''}
                </td>
                <td data-label="Signs in with">${provider(a.issuer)}</td>
                <td data-label="Created">${time(a.createdAt)}</td>
                <td data-label="Last sign-in">${time(a.lastSignInAt)}</td>
                <td data-label="Workspace">
                  ${
                    a.workspaceIds.length === 0
                      ? html`<span class="muted">None</span>`
                      : a.workspaceIds.map(
                          (id, i) =>
                            html`${i > 0 ? ', ' : ''}<a href="${workspaceUrl(id)}"
                                ><code>${id}</code></a
                              >`,
                        )
                  }
                </td>
                <td data-label="Operator">${a.operator ? 'Yes' : 'No'}</td>
              </tr>`,
          )}
        </tbody>
      </table>
    </div>`;
}

export function environmentPage(settings: SettingView[]): Html {
  const differing = settings.filter((s) => s.differs);
  const security = settings.filter((s) => s.info.security);
  const rowLink = (s: SettingView) => html`<a href="#${s.key}"><code>${s.key}</code></a>`;
  const value = (s: SettingView) =>
    s.info.secret
      ? s.set
        ? html`<span class="status active">Set, hidden</span>`
        : html`<span class="muted">Not set</span>`
      : s.value === undefined
        ? html`<span class="muted">Not set</span>`
        : html`<code>${s.value}</code>`;
  return html`${head(
      'Environment',
      html`The settings this Budd runs with, from <code>.env</code> and its environment. To change
        one, edit <code>.env</code> on the server and restart Budd. Secrets only say whether they’re
        set.`,
    )}
    ${
      differing.length === 0
        ? ''
        : notice(
            'warn',
            `${plural(differing.length, 'setting isn’t', 'settings aren’t')} what’s recommended:`,
            html`${differing.map((s, i) => html`${i > 0 ? ', ' : ''}${rowLink(s)}`)}. Each says
              below what’s recommended; change it in <code>.env</code> and restart Budd.`,
            { live: false },
          )
    }
    <p class="hint op-security-note">
      ${ICONS.shield}<span
        >${plural(security.length, 'setting', 'settings')}, marked Security,
        ${security.length === 1 ? 'decides' : 'decide'} who can get in or what can leave the server.
        Check ${security.length === 1 ? 'it' : 'them'} first after editing <code>.env</code>.</span
      >
    </p>
    ${SETTING_GROUPS.map((group) => {
      const rows = settings.filter((s) => s.info.group === group);
      return rows.length === 0
        ? ''
        : html`<section class="group">
            <h2>${group}</h2>
            <div class="table-wrap">
              <table class="stack op-settings">
                <thead>
                  <tr>
                    <th>Setting</th>
                    <th>Value</th>
                    <th>From</th>
                  </tr>
                </thead>
                <tbody>
                  ${rows.map(
                    (s) =>
                      html`<tr id="${s.key}" class="${s.info.security ? 'op-security' : ''}">
                        <td>
                          <span class="op-setting"
                            ><span class="name"
                              ><code>${s.key}</code>${
                                s.info.security
                                  ? html`<span class="tag security">${ICONS.shield}Security</span>`
                                  : ''
                              }${
                                s.info.secret
                                  ? html`<span class="tag secret">${ICONS.lock}Secret</span>`
                                  : ''
                              }</span
                            ><span class="desc">${s.info.description}</span>${
                              s.info.recommended
                                ? html`<span class="hint"
                                    >Recommended: ${s.info.recommended.advice}</span
                                  >`
                                : ''
                            }</span
                          >
                        </td>
                        <td data-label="Value">
                          ${value(s)}
                          ${
                            s.differs
                              ? html`<br /><span class="op-near">Not what’s recommended</span>`
                              : ''
                          }
                        </td>
                        <td data-label="From">
                          ${
                            s.set
                              ? html`<span class="tag set">Set</span>`
                              : html`<span class="muted">Default</span>`
                          }
                        </td>
                      </tr>`,
                  )}
                </tbody>
              </table>
            </div>
          </section>`;
    })}`;
}

const LINK_LIFE = durationInWords(OPERATOR_LINK_TTL_MS);

export function operatorsPage(opts: { operators: Operator[]; me: string; hosted: boolean }): Html {
  return html`${head('Operators', 'The accounts that can open this console.')}
  ${
    opts.hosted
      ? html`<section class="group">
            <div class="table-wrap">
              <table class="stack">
                <thead>
                  <tr>
                    <th>Account</th>
                    <th>Operator since</th>
                    <th>Last sign-in</th>
                  </tr>
                </thead>
                <tbody>
                  ${opts.operators.map(
                    (o) =>
                      html`<tr>
                        <td>
                          <code>${o.accountId}</code>${
                            o.accountId === opts.me ? html` <span class="tag">You</span>` : ''
                          }
                        </td>
                        <td data-label="Operator since">${time(o.addedAt)}</td>
                        <td data-label="Last sign-in">${time(o.lastSignInAt)}</td>
                      </tr>`,
                  )}
                </tbody>
              </table>
            </div>
          </section>
          <section class="group">
            <h2>Adding and removing operators</h2>
            <div class="item block">
              <p>
                Operators are added and removed with the <code>budd</code> command on the server:
                adding one prints a link that works once, for ${LINK_LIFE}, and removing one takes
                the console away at once. <code>budd help</code> lists the commands, and the
                operating guide explains them.
              </p>
            </div>
          </section>`
      : html`<p>In local mode, Budd’s one login is the operator.</p>`
  }`;
}

/** Hosted mode: the console's own sign-in, which starts from this page. */
export const consoleSignInPage = (returnTo: string, providerName: string) =>
  plainPage(
    'Sign in to the console',
    html`<div class="page-head">
        <h1>Sign in to the console</h1>
        <p class="lede">
          The operator console has its own sign-in, separate from your workspace’s. It ends after an
          hour unused.
        </p>
      </div>
      <form method="post" action="/console/login" class="actions">
        <input type="hidden" name="return" value="${returnTo}" />
        <button class="btn primary">Sign in with ${providerName}</button>
      </form>`,
    { console: true },
  );

/** Becoming an operator, from the link `budd operator` printed. */
export const enrolPage = (opts: { code: string; csrf: string; who: string }) =>
  plainPage(
    'Become an operator',
    html`<div class="page-head">
        <h1>Make this account an operator?</h1>
        <p class="lede">You’re signed in as <strong>${opts.who}</strong>.</p>
      </div>
      <p>Operators can open the console on this Budd. It shows:</p>
      <ul>
        <li>every account and workspace, by ID, and when they were last used</li>
        <li>how much each workspace stores, for the last 30 days</li>
        <li>the settings Budd runs with, without the secrets</li>
      </ul>
      <p>Not messages, emails, names or connections. The console can’t change anything.</p>
      <form method="post" action="/console/enrol" class="actions">
        ${csrfField(opts.csrf)}
        <input type="hidden" name="code" value="${opts.code}" />
        <a class="btn quiet" href="/ui">Cancel</a>
        <button class="btn primary">Make me an operator</button>
      </form>
      <p class="hint">
        This link works once. To stop being an operator later, ask whoever runs the server.
      </p>`,
  );

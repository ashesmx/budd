import { html, raw } from 'hono/html';
import type { ConnectionOverview, RouteCount } from '../admin/Admin.js';
import type { WakeUpStates } from '../wakeups/WakeUps.js';
import { ICONS, plural, type Html } from './html.js';

/**
 * The connection map: who can message whom, from each connection's contact
 * policy, with each connection's mailboxes on its edge and, when asked for,
 * the messages they sent. Laid out here, so it works without JS; app.js makes
 * it elastic, zooms it and explains a line on hover.
 */

/** A connection's mailboxes in use: archived ones are hidden from lists. */
export const inUse = (c: Pick<ConnectionOverview, 'mailboxes'>) =>
  c.mailboxes.filter((m) => m.archivedAt === null);

const NODE_MIN_W = 170;
export const NODE_H = 66;
export const GAP = 8;
const NAME_CHAR_W = 9.2;
/** Mailboxes sit on the top and bottom edges, half in and half out. */
export const PILL_H = 24;
const PILL_GAP = 6;
const PILL_INSET = 12;
const PILL_CHAR_W = 7.3;
const PILL_MAX_CHARS = 14;
const BELL_W = 19;
/** Past this, the last place says "+N" and links to the connection. */
const MAX_PILLS = 8;
const ZONE_PAD = 20;
const MARGIN = 30;
/** Up to this many, a circle; more are laid out so the ones that talk sit together. */
const CIRCLE_MAX = 8;
/** A map this wide starts zoomed out: mailboxes as dots. */
const FAR_WIDTH = 1800;

type Kind = 'one' | 'both';
interface Edge {
  from: string;
  to: string;
  kind: Kind;
}

/** Whether `to` accepts messages from `from`. Blocked connections can do neither. */
const accepts = (to: ConnectionOverview, from: ConnectionOverview) =>
  to.status === 'active' &&
  from.status === 'active' &&
  (to.policy.mode === 'all' || to.policy.allowed.includes(from.slug));

/** Each pair once: two-way, or one-way pointing at the connection that accepts. */
function mapEdges(connections: ConnectionOverview[]): Edge[] {
  const edges: Edge[] = [];
  connections.forEach((a, i) => {
    for (const b of connections.slice(i + 1)) {
      const ab = accepts(b, a);
      const ba = accepts(a, b);
      if (ab && ba) edges.push({ from: a.slug, to: b.slug, kind: 'both' });
      else if (ab) edges.push({ from: a.slug, to: b.slug, kind: 'one' });
      else if (ba) edges.push({ from: b.slug, to: a.slug, kind: 'one' });
    }
  });
  return edges;
}

type Point = [number, number];

/** A line between two boxes' centres, ending at their edges so the arrowheads show. app.js does the same. */
const trim = ([x1, y1]: Point, [x2, y2]: Point, [w1, h1]: Point, [w2, h2]: Point) => {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const at = (w: number, h: number) =>
    Math.min((w / 2 + GAP) / Math.abs(dx || 1e-9), (h / 2 + GAP) / Math.abs(dy || 1e-9));
  const t1 = at(w1, h1);
  const t2 = at(w2, h2);
  return [x1 + dx * t1, y1 + dy * t1, x2 - dx * t2, y2 - dy * t2].map((n) => n.toFixed(1));
};

/** Which edge of its box a mailbox sits on. */
type Side = -1 | 1;
/** A box: its centre and width. */
type Box3 = [number, number, number];

/**
 * A message route from one mailbox to another. It leaves each mailbox
 * outwards, away from its box (`pb`, `qb`: centre and width), so it can't be
 * mistaken for a neighbour's; when the other end lies beyond the far edge of
 * the box, it goes round the box's side rather than through it. app.js does
 * the same.
 */
export const curve = ([px, py]: Point, sp: Side, pb: Box3, [qx, qy]: Point, sq: Side, qb: Box3) => {
  const a: Point = [px, py + (sp * PILL_H) / 2];
  const b: Point = [qx, qy + sq * (PILL_H / 2 + 3)];
  const own = pb[0] === qb[0] && pb[1] === qb[1];
  const len = Math.hypot(qx - px, qy - py);
  const reach = own ? Math.max(40, len / 2) : Math.min(180, Math.max(40, len * 0.35));
  const handle = (end: Point, side: Side, [cx, cy, w]: Box3, other: Point): Point => {
    const behind = own ? sp !== sq : (other[1] - cy) * side < -(NODE_H / 2 + PILL_H);
    if (!behind) return [end[0], end[1] + side * reach];
    const toward = own ? (px + qx) / 2 : other[0];
    return [cx + (toward >= cx ? 1 : -1) * (w + 90), end[1] + side * 60];
  };
  const c1 = handle(a, sp, pb, [qx, qy]);
  const c2 = handle(b, sq, qb, [px, py]);
  const f = (v: Point) => `${v[0].toFixed(1)} ${v[1].toFixed(1)}`;
  return `M${f(a)} C${f(c1)} ${f(c2)} ${f(b)}`;
};

type WakeState = 'ok' | 'bad' | 'paused';

interface Pill {
  /** `slug/handle`, or `slug/+` for the mailboxes that don't fit. */
  address: string;
  handle: string | undefined;
  label: string;
  width: number;
  /** Its centre, from the box's centre. */
  ox: number;
  oy: number;
  wake: WakeState | undefined;
  unread: number;
  /** The "+N" place: the mailboxes it stands for, and their wake-ups. */
  more?: { handle: string; wake: WakeState | undefined }[];
}

interface Box {
  c: ConnectionOverview;
  width: number;
  pills: Pill[];
}

/** The worst of some wake-ups: one failing is what matters. */
const worst = (states: (WakeState | undefined)[]): WakeState | undefined =>
  (['bad', 'ok', 'paused'] as const).find((s) => states.includes(s));

const rowWidth = (row: { width: number }[]) =>
  row.reduce((w, p) => w + p.width, 0) + PILL_GAP * Math.max(0, row.length - 1);

const pillLabel = (handle: string) =>
  handle.length > PILL_MAX_CHARS ? `${handle.slice(0, PILL_MAX_CHARS - 1)}…` : handle;

/**
 * A connection's box: wide enough for its name and its mailboxes, half of
 * them on each edge. Which edge each one takes is settled once the map is
 * laid out (seat).
 */
function box(c: ConnectionOverview, wakeUps: WakeUpStates | undefined): Box {
  const mailboxes = inUse(c);
  const fits = mailboxes.length <= MAX_PILLS ? mailboxes : mailboxes.slice(0, MAX_PILLS - 1);
  const wake = (handle: string): WakeState | undefined => {
    const s = wakeUps?.get(`${c.id}/${handle}`);
    return s === undefined
      ? undefined
      : c.status === 'blocked'
        ? 'paused'
        : s === 'on'
          ? 'ok'
          : 'bad';
  };
  const pillWidth = (label: string, w: WakeState | undefined) =>
    Math.round(18 + label.length * PILL_CHAR_W + (w ? BELL_W : 0));
  const pills: Pill[] = fits.map((m) => {
    const label = pillLabel(m.handle);
    const w = wake(m.handle);
    return {
      address: `${c.slug}/${m.handle}`,
      handle: m.handle,
      label,
      width: pillWidth(label, w),
      ox: 0,
      oy: 0,
      wake: w,
      unread: m.unread,
    };
  });
  const rest = mailboxes.slice(fits.length);
  if (rest.length > 0) {
    const label = `+${rest.length}`;
    const more = rest.map((m) => ({ handle: m.handle, wake: wake(m.handle) }));
    const w = worst(more.map((m) => m.wake));
    pills.push({
      address: `${c.slug}/+`,
      handle: undefined,
      label,
      width: pillWidth(label, w),
      ox: 0,
      oy: 0,
      wake: w,
      unread: rest.reduce((n, m) => n + m.unread, 0),
      more,
    });
  }
  const half = Math.ceil(pills.length / 2);
  const width = Math.ceil(
    Math.max(
      NODE_MIN_W,
      c.slug.length * NAME_CHAR_W + 28,
      rowWidth(pills.slice(0, half)) + 2 * PILL_INSET,
      rowWidth(pills.slice(half)) + 2 * PILL_INSET,
    ),
  );
  return { c, width, pills };
}

/**
 * Puts each mailbox on the edge facing most of the mailboxes it messages, and
 * along it in their direction, so its routes leave towards them. `pull` is
 * where a mailbox's messages go, weighted by how many; none, and the
 * mailboxes split evenly in their usual order. With `widen`, the box grows
 * to fit them; without, those that don't fit take the other edge.
 */
function seat(b: Box, pull: (address: string) => Point, widen: boolean) {
  const room = widen ? Infinity : b.width - 2 * PILL_INSET;
  const top: Pill[] = [];
  const bottom: Pill[] = [];
  const fits = (row: Pill[], p: Pill) => rowWidth([...row, p]) <= room;
  const wants = b.pills.map((p, i) => ({ p, i, at: pull(p.address) }));
  for (const w of [...wants].sort((x, y) => x.at[1] - y.at[1] || x.i - y.i)) {
    if (w.at[1] < 0 && fits(top, w.p)) top.push(w.p);
  }
  for (const w of [...wants].sort((x, y) => y.at[1] - x.at[1] || x.i - y.i)) {
    if (w.at[1] > 0 && !top.includes(w.p) && fits(bottom, w.p)) bottom.push(w.p);
  }
  const half = Math.ceil(b.pills.length / 2);
  for (const w of wants) {
    if (top.includes(w.p) || bottom.includes(w.p)) continue;
    const row = top.length < half && fits(top, w.p) ? top : fits(bottom, w.p) ? bottom : top;
    row.push(w.p);
  }
  // Once the map is placed a box can't grow: if facing its traffic doesn't fit, keep the seating it was sized for.
  if (!widen && (rowWidth(top) > room || rowWidth(bottom) > room)) {
    const seated = b.pills.some((p) => p.oy < 0);
    top.splice(0, Infinity, ...(seated ? b.pills.filter((p) => p.oy < 0) : b.pills.slice(0, half)));
    bottom.splice(
      0,
      Infinity,
      ...(seated ? b.pills.filter((p) => p.oy >= 0) : b.pills.slice(half)),
    );
  }
  const along = new Map(wants.map((w) => [w.p, w]));
  const place = (row: Pill[], oy: number) => {
    row.sort((x, y) => {
      const [wx, wy] = [along.get(x), along.get(y)];
      return (wx?.at[0] ?? 0) - (wy?.at[0] ?? 0) || (wx?.i ?? 0) - (wy?.i ?? 0);
    });
    let x = -b.width / 2 + PILL_INSET;
    for (const p of row) {
      p.ox = x + p.width / 2;
      p.oy = oy;
      x += p.width + PILL_GAP;
    }
  };
  b.width = Math.max(b.width, rowWidth(top) + 2 * PILL_INSET, rowWidth(bottom) + 2 * PILL_INSET);
  place(top, -NODE_H / 2);
  place(bottom, NODE_H / 2);
  b.pills = [...top, ...bottom];
}

/**
 * Many connections: start from a circle and let linked ones pull together
 * while all push apart. The same connections and links always give the same
 * map.
 */
function spread(
  nodes: { x: number; y: number; w: number; h: number }[],
  links: [number, number][],
) {
  const n = nodes.length;
  const ideal = 280;
  const rounds = 300;
  const xs = Float64Array.from(nodes, (v) => v.x);
  const ys = Float64Array.from(nodes, (v) => v.y);
  const mx = new Float64Array(n);
  const my = new Float64Array(n);
  const x = (i: number) => xs[i] ?? 0;
  const y = (i: number) => ys[i] ?? 0;
  const add = (a: Float64Array, i: number, by: number) => {
    a[i] = (a[i] ?? 0) + by;
  };
  const push = (i: number, j: number, f: number) => {
    const dx = (x(i) - x(j)) * f;
    const dy = (y(i) - y(j)) * f;
    add(mx, i, dx);
    add(my, i, dy);
    add(mx, j, -dx);
    add(my, j, -dy);
  };
  // Everyone linked to everyone pulls every way at once: the circle is as good as it gets.
  const everyLink = links.length >= (n * (n - 1)) / 2;
  for (let round = 0; round < rounds && !everyLink; round++) {
    const step = 60 * (1 - round / rounds) + 2;
    mx.fill(0);
    my.fill(0);
    // Boxes far apart stop pushing, so groups that aren't linked settle near each other.
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        const d2 = (x(i) - x(j)) ** 2 + (y(i) - y(j)) ** 2;
        if (d2 < (2 * ideal) ** 2) push(i, j, (ideal * ideal) / Math.max(1, d2));
      }
    }
    for (const [i, j] of links) push(i, j, -Math.hypot(x(i) - x(j), y(i) - y(j)) / ideal);
    for (let i = 0; i < n; i++) {
      // A pull to the middle keeps groups that aren't linked from drifting apart.
      const [dx, dy] = [(mx[i] ?? 0) - x(i) * 0.1, (my[i] ?? 0) - y(i) * 0.1];
      const len = Math.hypot(dx, dy);
      if (len > 0) {
        add(xs, i, (dx / len) * Math.min(len, step));
        add(ys, i, (dy / len) * Math.min(len, step));
      }
    }
  }
  nodes.forEach((v, i) => {
    v.x = x(i);
    v.y = y(i);
  });
}

/** Nudges apart any boxes that overlap, mailboxes included. */
function apart(nodes: { x: number; y: number; w: number; h: number }[]) {
  for (let pass = 0; pass < 200; pass++) {
    let moved = false;
    for (const [i, a] of nodes.entries()) {
      for (const b of nodes.slice(i + 1)) {
        const ox = (a.w + b.w) / 2 + 50 - Math.abs(a.x - b.x);
        const oy = (a.h + b.h) / 2 + 60 - Math.abs(a.y - b.y);
        if (ox <= 0 || oy <= 0) continue;
        moved = true;
        if (ox < oy) {
          const s = a.x <= b.x ? -1 : 1;
          a.x += (s * ox) / 2;
          b.x -= (s * ox) / 2;
        } else {
          const s = a.y <= b.y ? -1 : 1;
          a.y += (s * oy) / 2;
          b.y -= (s * oy) / 2;
        }
      }
    }
    if (!moved) break;
  }
}

type Node = { x: number; y: number; w: number; h: number; b: Box };

/** Where each linked connection goes: a circle, or for many, where the ones that talk sit together. */
function place(boxes: Box[], edges: Edge[]): Node[] {
  const linked = boxes.filter((b) => edges.some((e) => e.from === b.c.slug || e.to === b.c.slug));
  const widest = Math.max(NODE_MIN_W, ...linked.map((b) => b.width));
  const r = Math.max(200, (linked.length * (widest + 60)) / (2 * Math.PI));
  const nodes = linked.map((b, i) => {
    const angle = (2 * Math.PI * i) / linked.length - (linked.length === 2 ? Math.PI : Math.PI / 2);
    return { x: r * Math.cos(angle), y: r * Math.sin(angle), w: b.width, h: NODE_H + PILL_H, b };
  });
  if (linked.length > CIRCLE_MAX) {
    const index = new Map(linked.map((b, i) => [b.c.slug, i]));
    spread(
      nodes,
      edges.map((e): [number, number] => [index.get(e.from) ?? 0, index.get(e.to) ?? 0]),
    );
  }
  return nodes;
}

/**
 * The finished map: boxes at their current widths nudged apart, moved inside
 * the margin, and cut-off connections in a column to the right.
 */
function frame(nodes: Node[], boxes: Box[]) {
  for (const n of nodes) n.w = n.b.width;
  apart(nodes);
  const cutOff = boxes.filter((b) => !nodes.some((n) => n.b === b));
  const left = Math.min(0, ...nodes.map((n) => n.x - n.w / 2));
  const top = Math.min(0, ...nodes.map((n) => n.y - n.h / 2));
  const at = new Map<string, Point>();
  for (const n of nodes) {
    n.x = Math.round(n.x - left + MARGIN);
    n.y = Math.round(n.y - top + MARGIN);
    at.set(n.b.c.slug, [n.x, n.y]);
  }
  const graphW = nodes.length === 0 ? 0 : Math.max(...nodes.map((n) => n.x + n.w / 2)) + MARGIN;
  const graphH = nodes.length === 0 ? 0 : Math.max(...nodes.map((n) => n.y + n.h / 2)) + MARGIN;
  const zoneW = Math.max(NODE_MIN_W, ...cutOff.map((b) => b.width)) + 2 * ZONE_PAD;
  const zoneX = graphW + (nodes.length > 0 ? 10 : MARGIN);
  const rowH = NODE_H + PILL_H + 22;
  cutOff.forEach((b, i) => at.set(b.c.slug, [zoneX + zoneW / 2, 90 + i * rowH + NODE_H / 2]));
  const zoneH = 76 + cutOff.length * rowH;
  return {
    at,
    cutOff,
    zone: cutOff.length > 0 ? { x: zoneX, w: zoneW, h: zoneH } : undefined,
    width: Math.ceil(cutOff.length > 0 ? zoneX + zoneW + MARGIN : graphW),
    height: Math.ceil(Math.max(graphH, cutOff.length > 0 ? zoneH + 30 : 0)),
  };
}

const subtitle = (c: ConnectionOverview) =>
  c.status === 'blocked' ? 'Blocked' : plural(inUse(c).length, 'mailbox', 'mailboxes');

/** Shape as well as colour: a tick when wake-ups get through, ! when they don't. */
const bell = (state: WakeState) =>
  html`<g class="wk wk-${state}" transform="translate(14 13)">
    <path d="M-5 2.5h10l-1.4-2V-2a3.6 3.6 0 0 0-7.2 0v2.5zM-1.4 4.3a1.4 1.4 0 0 0 2.8 0" />
    ${
      state === 'paused'
        ? ''
        : html`<g transform="translate(5.5 -4.5)">
            <circle r="4.2" />
            <path d="${state === 'ok' ? 'M-2.2 .2l1.5 1.5 2.9-3' : 'M0-2.4v2.6M0 2.1v.2'}" />
          </g>`
    }
  </g>`;

const WAKE_WORDS: Record<WakeState, string> = {
  ok: 'wake-up on',
  bad: 'wake-up failing',
  paused: 'wake-up paused',
};

const unreadWords = (n: number) => (n === 0 ? 'nothing unread' : `${n} unread`);

/** Zoomed out, a mailbox is a dot shaped by its wake-up: filled when on, a diamond when failing, a ring when paused. */
const dot = (p: Pill) => {
  const [cx, cy] = [p.width / 2, PILL_H / 2];
  return p.wake === 'bad'
    ? html`<rect
        class="dot bad"
        x="${cx - 6}"
        y="${cy - 6}"
        width="12"
        height="12"
        transform="rotate(45 ${cx} ${cy})"
      />`
    : html`<circle
        class="dot${p.wake ? ` ${p.wake}` : ''}"
        cx="${cx}"
        cy="${cy}"
        r="${p.wake ? 6 : 4}"
      />`;
};

const pill = (p: Pill, [x, y]: Point, tip: string, href: string, dim: boolean) =>
  html`<a
    class="mb${p.more ? ' more' : ''}${dim ? ' dim' : ''}"
    href="${href}"
    id="map-mb-${p.address}"
    aria-label="${tip}"
    data-mb="${p.address}"
    data-ox="${p.ox}"
    data-oy="${p.oy}"
    data-w="${p.width}"
    transform="translate(${x + p.ox - p.width / 2} ${y + p.oy - PILL_H / 2})"
    ><title>${tip}</title
    ><circle class="hit" cx="${p.width / 2}" cy="${PILL_H / 2}" r="${PILL_H / 2}" /><rect
      width="${p.width}"
      height="${PILL_H}"
      rx="${PILL_H / 2}"
    />${p.wake ? bell(p.wake) : ''}<text x="${p.wake ? 9 + BELL_W : 9}" y="16">${p.label}</text
    >${dot(p)}</a
  >`;

const node = (b: Box, [x, y]: Point, href: string, cutOff: boolean, dim: boolean) =>
  html`<a
    class="map-node${cutOff ? ' cut-off' : ''}${dim ? ' dim' : ''}"
    href="${href}"
    id="map-n-${b.c.slug}"
    aria-label="${b.c.slug}, ${subtitle(b.c)}"
    data-node="${b.c.slug}"
    data-x="${x}"
    data-y="${y}"
    data-w="${b.width}"
    transform="translate(${x - b.width / 2} ${y - NODE_H / 2})"
    ><rect width="${b.width}" height="${NODE_H}" rx="8" /><text x="14" y="33" class="n"
      >${b.c.slug}</text
    ><text x="14" y="51" class="m">${subtitle(b.c)}</text></a
  >`;

/** Messages between two mailboxes, both ways together. */
interface Route {
  a: string;
  b: string;
  /** a to b, and b to a. */
  ab: number;
  ba: number;
  /** Not read yet, expired ones included. */
  unread: number;
}

/** Each pair of places on the map that messages went between, from `routes`. */
function combine(routes: RouteCount[], place: (address: string) => string | undefined): Route[] {
  const pairs = new Map<string, Route>();
  for (const r of routes) {
    const from = place(r.from);
    const to = place(r.to);
    if (!from || !to || from === to) continue;
    const [a, b] = from < to ? [from, to] : [to, from];
    const key = `${a} ${b}`;
    const route = pairs.get(key) ?? { a, b, ab: 0, ba: 0, unread: 0 };
    if (from === a) route.ab += r.messages;
    else route.ba += r.messages;
    route.unread += r.unread;
    pairs.set(key, route);
  }
  return [...pairs.values()].sort((x, y) => y.ab + y.ba - (x.ab + x.ba) || (x.a < y.a ? -1 : 1));
}

const handleOf = (address: string) => address.slice(address.indexOf('/') + 1);
const slugOf = (address: string) => address.slice(0, address.indexOf('/'));
const percent = (part: number, whole: number) =>
  whole === 0
    ? '0%'
    : part > 0 && part < whole / 100
      ? '<1%'
      : `${Math.round((100 * part) / whole)}%`;
/** Five steps from all read (blue) to none read (orange). */
const unreadStep = (r: Route) => Math.round((4 * r.unread) / (r.ab + r.ba));
/** A place's name in words: the "+N" place is the connection's other mailboxes. */
const named = (address: string) =>
  address.endsWith('/+') ? `other mailboxes of ${slugOf(address)}` : address;

/** One route in words, for its tooltip and the text version. */
function routeWords(r: Route, total: number) {
  const n = r.ab + r.ba;
  const one = r.ab === 0 || r.ba === 0;
  const [from, to] = r.ba > 0 && r.ab === 0 ? [r.b, r.a] : [r.a, r.b];
  const short = (a: string) => (a.endsWith('/+') ? `${slugOf(a)} others` : handleOf(a));
  const what = one
    ? `${named(from)} to ${named(to)}: ${plural(n, 'message')}, one way only`
    : `${named(r.a)} and ${named(r.b)}: ${plural(n, 'message')} both ways`;
  const read = r.unread === 0 ? 'all read' : `${r.unread} not read (${percent(r.unread, n)})`;
  return {
    heading: one ? `${short(from)} → ${short(to)}` : `${short(r.a)} ↔ ${short(r.b)}`,
    text: `${what}. ${percent(n, total)} of all sent; ${read}.`,
    from,
    to,
    one,
  };
}

/** A mailbox in words: its wake-up, what's unread, and who it messaged. */
function pillWords(p: Pill, routes: Route[]) {
  const more = p.more
    ? `${plural(p.more.length, 'more mailbox', 'more mailboxes')}: ${p.more
        .map((m) => (m.wake ? `${m.handle} (${WAKE_WORDS[m.wake]})` : m.handle))
        .join(', ')}`
    : `${p.address}: ${p.wake ? `${WAKE_WORDS[p.wake]}, ` : ''}${unreadWords(p.unread)}`;
  const talks = routes.flatMap((r) =>
    r.a === p.address
      ? [{ other: named(r.b), sent: r.ab, received: r.ba }]
      : r.b === p.address
        ? [{ other: named(r.a), sent: r.ba, received: r.ab }]
        : [],
  );
  return talks.length === 0 ? `${more}.` : `${more}. ${talkWords(talks)}.`;
}

/** Who a mailbox wrote to and heard from: "Sent 12 to a/b and received 9 from it; sent 3 to c/d". */
export function talkWords(talks: { other: string; sent: number; received: number }[]) {
  const words = talks
    .map(({ other, sent, received }) =>
      sent > 0 && received > 0
        ? `sent ${sent} to ${other} and received ${received} from it`
        : sent > 0
          ? `sent ${sent} to ${other}`
          : `received ${received} from ${other}`,
    )
    .join('; ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

export interface MapOptions {
  /** Current connections: archived ones aren't drawn. */
  connections: ConnectionOverview[];
  /** Where a click on a connection or mailbox goes: its card on this map. */
  cardLink: (address: string) => string;
  /** The messages sent in the window, when they're shown, and what to say if there were none. */
  messages?: { routes: RouteCount[]; window: string; none: Html | string } | undefined;
  wakeUps?: WakeUpStates | undefined;
  /** A connection to pick out: everything it can't reach fades. */
  focus?: string | undefined;
}

/** The map. Callers draw it only once there are two connections. */
export function connectionMap(opts: MapOptions): Html {
  const shown = opts.connections;
  const edges = mapEdges(shown);
  const boxes = shown.map((c) => box(c, opts.wakeUps));

  // Where a mailbox's messages start and end: its own place, or its connection's "+N".
  const placeOf = new Map<string, string>();
  for (const b of boxes) {
    for (const p of b.pills) {
      placeOf.set(p.address, p.address);
      for (const m of p.more ?? []) placeOf.set(`${b.c.slug}/${m.handle}`, p.address);
    }
  }
  const routes = opts.messages ? combine(opts.messages.routes, (a) => placeOf.get(a)) : [];
  const total = routes.reduce((n, r) => n + r.ab + r.ba, 0);
  const routesOf = new Map<string, Route[]>();
  for (const r of routes)
    for (const a of [r.a, r.b]) routesOf.set(a, [...(routesOf.get(a) ?? []), r]);

  // Each mailbox faces the connections it messages most: placed once to see
  // where they are, then boxes widen for mailboxes that all face one way.
  const seatAll = (at: Map<string, Point>, widen: boolean) => {
    const point = (slug: string) => at.get(slug) ?? [0, 0];
    const pulls = new Map<string, Point>();
    const pullTo = (from: string, to: string, n: number) => {
      if (slugOf(from) === slugOf(to)) return;
      const [fx, fy] = point(slugOf(from));
      const [tx, ty] = point(slugOf(to));
      const d = Math.hypot(tx - fx, ty - fy) || 1;
      const [x, y] = pulls.get(from) ?? [0, 0];
      pulls.set(from, [x + (n * (tx - fx)) / d, y + (n * (ty - fy)) / d]);
    };
    for (const r of routes) {
      pullTo(r.a, r.b, r.ab + r.ba);
      pullTo(r.b, r.a, r.ab + r.ba);
    }
    for (const b of boxes) seat(b, (address) => pulls.get(address) ?? [0, 0], widen);
  };
  const nodes = place(boxes, edges);
  if (routes.length > 0) seatAll(new Map(nodes.map((n) => [n.b.c.slug, [n.x, n.y]])), true);
  const { at, cutOff, zone, width, height } = frame(nodes, boxes);
  seatAll(at, false);
  const point = (slug: string) => at.get(slug) ?? [0, 0];
  const widthOf = new Map(boxes.map((b) => [b.c.slug, b.width]));
  const size = (slug: string): Point => [widthOf.get(slug) ?? NODE_MIN_W, NODE_H];

  const focus = opts.focus;
  const near = new Set(
    focus
      ? [
          focus,
          ...edges.flatMap((e) => (e.from === focus ? [e.to] : e.to === focus ? [e.from] : [])),
        ]
      : shown.map((c) => c.slug),
  );
  const faded = (slug: string) => focus !== undefined && !near.has(slug);

  const places = new Map<string, { at: Point; side: Side }>();
  for (const b of boxes) {
    const [x, y] = point(b.c.slug);
    for (const p of b.pills)
      places.set(p.address, { at: [x + p.ox, y + p.oy], side: p.oy < 0 ? -1 : 1 });
  }
  const route = (from: string, to: string) => {
    const [p, q] = [places.get(from), places.get(to)];
    if (!p || !q) return '';
    const boxOf = (slug: string): Box3 => [...point(slug), widthOf.get(slug) ?? NODE_MIN_W];
    return curve(p.at, p.side, boxOf(slugOf(from)), q.at, q.side, boxOf(slugOf(to)));
  };

  const classes = ['map', opts.messages ? 'messages' : '', width > FAR_WIDTH ? 'far' : '']
    .filter(Boolean)
    .join(' ');
  const steps = [0, 1, 2, 3, 4];
  const marker = (id: string, cls: string, orient: string) =>
    html`<marker
      id="${id}"
      class="${cls}"
      viewBox="0 0 10 10"
      refX="8"
      refY="5"
      markerWidth="12"
      markerHeight="12"
      markerUnits="userSpaceOnUse"
      orient="${orient}"
      ><path d="M0 0 10 5 0 10z"
    /></marker>`;
  const said = routes.map((r) => ({ r, words: routeWords(r, total) }));
  const woken = boxes.flatMap((b) =>
    b.pills.flatMap((p) =>
      p.more
        ? p.more.flatMap((m) =>
            m.wake ? [{ address: `${b.c.slug}/${m.handle}`, wake: m.wake }] : [],
          )
        : p.wake
          ? [{ address: p.address, wake: p.wake }]
          : [],
    ),
  );

  return html`<div class="map-wrap" data-map>
    ${
      opts.messages && routes.length === 0
        ? html`<p class="map-none">${opts.messages.none}</p>`
        : ''
    }
    <a class="skip" href="#after-map">Skip the map</a>
    <div class="map-zoom" data-zoom hidden>
      <button
        type="button"
        class="icon-btn"
        data-zoom-by="1.4"
        aria-label="Zoom in"
        title="Zoom in"
      >
        ${ICONS.plus}</button
      ><button
        type="button"
        class="icon-btn"
        data-zoom-by="0.714"
        aria-label="Zoom out"
        title="Zoom out"
      >
        ${ICONS.minus}</button
      ><button
        type="button"
        class="icon-btn"
        data-zoom-fit
        aria-label="Fit the whole map"
        title="Fit the whole map"
      >
        ${ICONS.fit}
      </button>
    </div>
    <svg
      class="${classes}"
      viewBox="0 0 ${width} ${height}"
      width="${width}"
      height="${height}"
      id="map"
      role="group"
      aria-labelledby="map-title"
      data-key="${shown.map((c) => c.slug).join(' ')}"
    >
      <title id="map-title">
        Who can message
        whom${opts.messages ? html`, and the messages sent in the last ${opts.messages.window}` : ''}.
        The same follows in words.
      </title>
      <defs>
        ${marker('arrow-one', 'mk-one', 'auto')}
        ${marker('arrow-both', 'mk-both', 'auto-start-reverse')}
        ${steps.map((s) => marker(`route-u${s}`, `mk-u${s}`, 'auto'))}
      </defs>
      <g>
        ${edges.map((e) => {
          const [x1, y1, x2, y2] = trim(point(e.from), point(e.to), size(e.from), size(e.to));
          const dim = focus !== undefined && e.from !== focus && e.to !== focus;
          return html`<line
            class="map-edge ${e.kind}${dim ? ' dim' : ''}"
            data-from="${e.from}"
            data-to="${e.to}"
            x1="${x1}"
            y1="${y1}"
            x2="${x2}"
            y2="${y2}"
            ${raw(e.kind === 'both' ? 'marker-start="url(#arrow-both)" marker-end="url(#arrow-both)"' : 'marker-end="url(#arrow-one)"')}
          />`;
        })}
      </g>
      ${
        zone
          ? html`<rect
                class="cut-off-zone"
                x="${zone.x}"
                y="10"
                width="${zone.w}"
                height="${zone.h}"
                rx="10"
              />
              <text class="zone-label" x="${zone.x + 16}" y="34">Can't message anyone,</text>
              <text class="zone-label" x="${zone.x + 16}" y="52">and nobody can message it</text>`
          : ''
      }
      <g class="routes">
        ${said.map(({ r, words }) => {
          const step = unreadStep(r);
          const dim = focus !== undefined && slugOf(r.a) !== focus && slugOf(r.b) !== focus;
          const d = route(words.from, words.to);
          // A wide, unseen line under each route, so a finger can find a thin one.
          return html`<g
            class="route ${words.one ? 'one' : 'both'} u${step}${dim ? ' dim' : ''}"
            data-a="${words.from}"
            data-b="${words.to}"
            data-tip-h="${words.heading}"
            ><title>${words.text}</title><path class="hit" d="${d}" /><path
              class="line"
              d="${d}"
              stroke-width="${(1.5 + (12 * (r.ab + r.ba)) / total).toFixed(1)}"
              ${words.one ? raw(`marker-end="url(#route-u${step})"`) : ''}
          /></g>`;
        })}
      </g>
      ${boxes.map(
        (b) =>
          html`<g data-of="${b.c.slug}">
            ${node(b, point(b.c.slug), opts.cardLink(b.c.slug), cutOff.includes(b), faded(b.c.slug))}
            ${b.pills.map((p) =>
              pill(
                p,
                point(b.c.slug),
                pillWords(p, routesOf.get(p.address) ?? []),
                p.more ? opts.cardLink(b.c.slug) : opts.cardLink(p.address),
                faded(b.c.slug),
              ),
            )}
          </g>`,
      )}
    </svg>
    <div class="map-tip" data-map-tip hidden></div>
    <p class="map-wheel" data-map-wheel role="status" hidden></p>
    <details class="map-words" id="after-map">
      <summary>The map in words</summary>
      <ul>
        ${edges.map((e) =>
          e.kind === 'both'
            ? html`<li>${e.from} and ${e.to} can message each other.</li>`
            : html`<li>${e.from} can message ${e.to}.</li>`,
        )}
        ${cutOff.map((b) => html`<li>${b.c.slug} can't message anyone, and nobody can message it.</li>`)}
      </ul>
      ${
        opts.messages
          ? html`<h3>Messages in the last ${opts.messages.window}</h3>
              ${
                said.length === 0
                  ? html`<p>None.</p>`
                  : html`<ul>
                      ${said.map(({ words }) => html`<li>${words.text}</li>`)}
                    </ul>`
              }`
          : ''
      }
      ${
        woken.length === 0
          ? ''
          : html`<h3>Wake-ups</h3>
              <ul>
                ${woken.map((w) => html`<li>${w.address}: ${WAKE_WORDS[w.wake]}.</li>`)}
              </ul>`
      }
    </details>
  </div>`;
}

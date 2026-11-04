import { createHash } from 'node:crypto';
import { ROUTES_FRESH_MS } from '../admin/Admin.js';
import { GAP, NODE_H, PILL_H } from './connectionMap.js';

/**
 * Served as /ui/app.css. Follows the OS light/dark setting. The colour,
 * spacing and radius values are the design system's tokens
 * (docs/design/tokens.json); a test keeps the two the same.
 */
const DARK = `
    --bg: #15171a; --panel: #1c1f23; --tag: #262a30; --line: #2c3036; --fg: #e6e8eb; --muted: #9aa1ab;
    --accent: #7ea2ff; --ok: #5fcf8f; --warn: #f0b45a; --bad: #ff8a80; --control-border: #666d77;
    --highlight: #4d3f14;
    --console-bg: #121418; --console-line: #1b1e23; --console-fg: #d7dae0; --console-muted: #8f96a0;
    --console-accent: #7ea2ff; --console-ok: #5fcf8f; --console-warn: #f0b45a; --console-bad: #ff8a80;
    --security: #d4c8ff; --security-bg: #2e2459; --secret: #9ee3da; --secret-bg: #12322f;
    --set: #9fd8f8; --set-bg: #0c2d40;`;

export const CSS = `
:root {
  color-scheme: light dark;
  --bg: #ffffff; --panel: #f6f7f9; --tag: #eef0f3; --line: #dfe2e6; --fg: #1d1f23; --muted: #626872;
  --accent: #2557d6; --ok: #1d7a46; --warn: #a15c00; --bad: #b42318; --control-border: #868c96;
  --highlight: #fde9a6; --backdrop: #00000080;
  --console-bg: #f6f7f9; --console-line: #eef0f3; --console-fg: #1d1f23; --console-muted: #626872;
  --console-accent: #2557d6; --console-ok: #1d7a46; --console-warn: #a15c00; --console-bad: #b42318;
  --security: #5b21b6; --security-bg: #ede9fe; --secret: #0f5e57; --secret-bg: #ddf3f0;
  --set: #075985; --set-bg: #e0f2fe;
  --op-bar: #2b2156; --op-bar-fg: #ffffff; --op-bar-muted: #cfc8f0; --op-bar-line: #4a3d86; --op-bar-mark: #b9a8ff;
  --space-1: .25rem; --space-2: .5rem; --space-3: .75rem; --space-4: 1rem; --space-6: 1.5rem;
  --radius-sm: 4px; --radius-md: 6px; --radius-lg: 8px;
  --content-max: 100%; --group-max: 100%; --text-max: 40rem; --wide-max: 36rem; --dialog-max: 32rem;
  --narrow-max: 30rem; --field-max: 24rem; --control-height: 34px;
  --font-sans: system-ui, -apple-system, "Segoe UI", sans-serif;
  --font-mono: ui-monospace, SFMono-Regular, Menlo, monospace;
}
/* Dark follows the operating system, unless the person chose a theme in Preferences (data-theme). */
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {${DARK}
  }
}
:root[data-theme="dark"] { color-scheme: dark;${DARK}
}
:root[data-theme="light"] { color-scheme: light; }
/* Touch targets: controls grow on phones. */
@media (max-width: 40rem) { :root { --control-height: 44px; } }
* { box-sizing: border-box; }
[hidden] { display: none !important; }
body { margin: 0; background: var(--bg); color: var(--fg); font: 14px/1.5 var(--font-sans); }
a { color: var(--accent); }
:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
code, pre, kbd { font-family: var(--font-mono); font-size: .85rem; }
code.cmd { white-space: nowrap; }
.muted { color: var(--muted); }
.phone-only { display: none; }
.sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }

/* The app header: the logo, the sections, then status and the account menu. */
.app-header { position: sticky; top: 0; z-index: 2; display: flex; flex-wrap: wrap; align-items: center; gap: 0 var(--space-6);
  padding: 0 var(--space-4); border-bottom: 1px solid var(--line); background: var(--panel); }
.brand { display: flex; padding-block: var(--space-3); }
.brand img { display: block; height: 1.5rem; width: auto; }
.app-header nav { display: flex; gap: var(--space-4); align-self: stretch; overflow-x: auto; }
.app-header nav a { display: flex; align-items: center; min-height: 44px; color: var(--muted); text-decoration: none;
  border-bottom: 2px solid transparent; white-space: nowrap; }
.app-header nav a[aria-current="page"] { color: var(--fg); font-weight: 600; border-bottom-color: var(--accent); }
.app-header .end { margin-left: auto; display: flex; align-items: center; gap: var(--space-4); }
/* The account menu: the person's picture (or initial) and name, opening the workspace, Settings and Sign out. */
.profile { position: relative; }
.profile > summary { display: flex; align-items: center; gap: var(--space-2); min-height: 44px; cursor: pointer;
  list-style: none; color: var(--fg); }
.profile > summary::-webkit-details-marker { display: none; }
.avatar { width: 28px; height: 28px; flex: none; border-radius: 50%; object-fit: cover; }
.avatar.initial { display: inline-flex; align-items: center; justify-content: center; background: var(--tag);
  font-size: .85rem; font-weight: 600; }
.menu { position: absolute; top: 100%; z-index: 3; min-width: 14rem; padding: var(--space-1) 0;
  border: 1px solid var(--line); border-radius: var(--radius-md); background: var(--bg); }
.profile .menu { right: 0; }
.menu-workspace { display: grid; gap: 2px; margin: 0; padding: var(--space-2) var(--space-4); border-bottom: 1px solid var(--line); }
.menu-workspace .label { font-size: .75rem; color: var(--muted); text-transform: uppercase; letter-spacing: .04em; }
.menu-workspace .name { font-weight: 600; overflow-wrap: anywhere; }
.app-header .profile .menu nav { display: grid; gap: 0; overflow: visible; }
.app-header .profile .menu nav a { display: flex; align-items: center; min-height: 40px; padding: 0 var(--space-4);
  color: var(--fg); font-weight: 400; text-decoration: none; border-bottom: 0; border-left: 2px solid transparent; }
.app-header .profile .menu nav a:hover { background: var(--panel); }
.app-header .profile .menu nav a[aria-current="page"] { font-weight: 600; border-left-color: var(--accent); }
.profile .menu form { margin: 0; padding: var(--space-1) var(--space-2) 0; border-top: 1px solid var(--line); }
.live { display: inline-flex; align-items: center; gap: var(--space-1); font-size: .8rem; color: var(--muted); }
.live::before { content: ""; width: 8px; height: 8px; border-radius: 50%; border: 1.5px solid var(--muted); }
.live.on::before { background: var(--ok); border-color: var(--ok); }
/* On a phone: the logo and account menu, then the sections on a row of their own. */
@media (max-width: 40rem) {
  .app-header nav { order: 3; flex-basis: 100%; border-top: 1px solid var(--line); }
  .profile .who, .app-header .live { display: none; }
}

main { max-width: var(--content-max); padding: var(--space-6) var(--space-4); }
.page-head { margin-bottom: var(--space-6); }
.head-row { display: flex; flex-wrap: wrap; justify-content: space-between; align-items: flex-start; gap: var(--space-3); }
.head-actions { display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-2); }
h1 { font-size: 1.3rem; margin: 0 0 var(--space-1); overflow-wrap: anywhere; }
h1 code { font-size: inherit; }
.status { font: 500 14px/1 var(--font-sans); }
h2 { font-size: 1.05rem; margin: 0 0 var(--space-2); }
p, .lede { max-width: var(--text-max); }
.lede { color: var(--muted); margin: 0; }
section + section { margin-top: var(--space-6); }
/* Breadcrumbs: below the section they belong to, the page itself last. */
.crumbs { display: flex; flex-wrap: wrap; gap: var(--space-1); margin: 0 0 var(--space-2); padding: 0; list-style: none;
  font-size: .85rem; color: var(--muted); }
.crumbs li + li::before { content: "›"; margin-right: var(--space-1); }
.crumbs a { color: var(--muted); }
.meta { display: flex; flex-wrap: wrap; align-items: baseline; gap: var(--space-1) var(--space-4); margin: var(--space-1) 0 0;
  max-width: none; color: var(--muted); }
/* A label edited where it's shown. */
details.edit { display: inline; }
details.edit > summary { display: inline; color: var(--accent); cursor: pointer; }
.inline-form { display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-2); margin-top: var(--space-2); }
.inline-form input[type=text] { width: auto; min-width: 14rem; }
.inline-form .hint { flex-basis: 100%; }

/* A page's name opens a menu of its other pages: a chevron says so, each item an arrow out. */
.title-row { display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-2); }
.go { position: relative; }
.go > summary { display: inline-flex; align-items: center; gap: var(--space-1); min-height: 44px; padding: 0 var(--space-2);
  margin-left: calc(-1 * var(--space-2)); border-radius: var(--radius-sm); cursor: pointer; list-style: none; }
.go > summary::-webkit-details-marker { display: none; }
.go > summary:hover, .go[open] > summary { background: var(--panel); }
.go > summary .h1 { font-size: 1.3rem; font-weight: 700; overflow-wrap: anywhere; }
.go > summary .h1 code { font-size: inherit; }
.go > summary .chev { width: 16px; height: 16px; color: var(--muted); }
.go[open] > summary .chev { transform: rotate(180deg); }
.go .menu { left: 0; min-width: 16rem; }
.go .menu .hint { margin: 0; padding: var(--space-1) var(--space-4) var(--space-2); font-size: .8rem; }
.go .menu a { display: flex; align-items: center; justify-content: space-between; gap: var(--space-4); min-height: 40px;
  padding: 0 var(--space-4); color: var(--fg); text-decoration: none; }
.go .menu a:hover { background: var(--panel); }
.go .menu .lead { display: inline-flex; align-items: center; gap: var(--space-2); }
.go .menu .icon { color: var(--muted); }

/* Notices: one shape for every outcome, edged in its status colour and led by a word that says which. */
.notice { max-width: var(--group-max); margin: 0 0 var(--space-4); padding: var(--space-2) var(--space-3);
  border: 1px solid var(--line); border-radius: var(--radius-md); background: var(--panel); }
.notice strong { margin-right: var(--space-1); }
.notice.ok { border-color: var(--ok); } .notice.ok strong { color: var(--ok); }
.notice.warn { border-color: var(--warn); } .notice.warn strong { color: var(--warn); }
.notice.bad { border-color: var(--bad); } .notice.bad strong { color: var(--bad); }
.notice.restore { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: var(--space-2) var(--space-4); }
.notice.restore p { margin: 0; }
/* An archived connection: everything below the notice is greyed, in muted text rather than faded, so it stays legible. */
.frozen { color: var(--muted); }
.frozen .group { background: var(--panel); }
.frozen h2, .frozen a, .frozen code, .frozen th { color: var(--muted); }

/* Status: a dot and a word, never colour alone, and never the accent. */
.status { display: inline-flex; align-items: center; gap: var(--space-1); white-space: nowrap; }
.status::before { content: ""; flex: none; width: 8px; height: 8px; border-radius: 50%; background: currentColor; }
.status.active { color: var(--ok); } .status.blocked, .status.expired, .status.failing, .status.failed { color: var(--bad); }
.status.archived, .status.read { color: var(--muted); } .status.unread { color: var(--fg); font-weight: 600; }

.tag { display: inline-block; padding: 0 var(--space-1); border-radius: var(--radius-sm); background: var(--tag);
  font-size: .78rem; color: var(--muted); }
.badge { display: inline-block; min-width: 20px; padding: 0 var(--space-1); border-radius: var(--radius-sm);
  background: var(--fg); color: var(--bg); font-size: .78rem; font-weight: 600; text-align: center; }
.icon { width: 16px; height: 16px; flex: none; }
.chev { width: 12px; height: 12px; flex: none; }
.addr { display: block; max-width: var(--wide-max); margin: var(--space-2) 0; padding: var(--space-2) var(--space-3);
  border-radius: var(--radius-sm); background: var(--tag); overflow-wrap: anywhere; }

.table-wrap { overflow-x: auto; }
/* A table that holds the unverified explanation, which must not be clipped. */
.table-wrap.overlays { overflow: visible; }
table { border-collapse: collapse; width: 100%; }
th, td { text-align: left; vertical-align: top; padding: var(--space-2) var(--space-3); border-bottom: 1px solid var(--line); }
th { color: var(--muted); font-weight: 500; font-size: .85rem; vertical-align: middle; }
/* A heading that sorts its table: a link, its arrow lit on the sorted column. */
th a.sort { display: inline-flex; align-items: center; gap: var(--space-1); min-height: 32px; color: inherit; text-decoration: none; }
th a.sort:hover { color: var(--fg); text-decoration: underline; }
th a.sort .icon { width: 14px; height: 14px; color: var(--muted); opacity: .6; }
th a.sort.on .icon { color: var(--accent); opacity: 1; }
.row-actions { width: 1%; text-align: right; white-space: nowrap; }
.row-title { font-weight: 600; }
.empty { color: var(--muted); }
ul.mailboxes { list-style: none; margin: 0; padding: 0; display: flex; flex-wrap: wrap; gap: var(--space-1) var(--space-3); }
ul.mailboxes code { overflow-wrap: anywhere; }
/* At phone width a table of things becomes a list: each row a block, each cell labelled. */
@media (max-width: 40rem) {
  table.stack thead { display: none; }
  .phone-only { display: block; }
  /* On a phone the explanation spans the screen, under its sign, so none of it is cut off. */
  .info .info-pop { position: fixed; top: auto; left: var(--space-4); right: var(--space-4); width: auto; max-width: none;
    margin-top: var(--space-6); }
  .cell-label { color: var(--muted); }
  table.stack tr { display: grid; gap: var(--space-1); padding: var(--space-2) 0; border-bottom: 1px solid var(--line); }
  table.stack td { display: block; padding: 0; border: 0; }
  table.stack td[data-label]::before { content: attr(data-label) ": "; color: var(--muted); }
  .row-actions { text-align: left; }
  .group > .table-wrap table.stack tr { padding-inline: var(--space-4); }
}

/* Controls */
.btn, button { display: inline-flex; align-items: center; justify-content: center; gap: var(--space-1);
  min-height: var(--control-height); padding: 0 var(--space-3); font: inherit; border-radius: var(--radius-sm);
  border: 1px solid var(--control-border); background: var(--bg); color: var(--fg); text-decoration: none; cursor: pointer; }
.btn.primary { background: var(--accent); border-color: var(--accent); color: var(--bg); }
.btn.danger { border-color: var(--bad); color: var(--bad); }
.btn.destroy { background: var(--bad); border-color: var(--bad); color: var(--bg); font-weight: 600; }
.btn.quiet { border-color: transparent; background: none; color: var(--accent); padding: 0 var(--space-2); }
/* An icon button: named, with the same words on hover; big enough to tap on a phone. */
.icon-btn { position: relative; display: inline-flex; align-items: center; justify-content: center; width: 32px; height: 32px;
  border-radius: var(--radius-sm); color: var(--muted); cursor: pointer; }
.icon-btn:hover, .icon-btn:focus-visible { background: var(--tag); color: var(--fg); }
@media (max-width: 40rem) { .icon-btn { width: 44px; height: 44px; } }
.actions { display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-2); margin-top: var(--space-4); }
.actions .aside { margin-left: auto; order: 2; }
/* Listed first so Enter picks it (the form's default button), shown after the others. */
.actions .later { order: 1; }
form { margin: 0; }
.field { display: grid; gap: var(--space-1); max-width: var(--field-max); margin-bottom: var(--space-4); }
.field label, legend { font-weight: 500; }
.hint { color: var(--muted); font-size: .85rem; }
input[type=text], input[type=url], input[type=password], input[type=search], input[type=datetime-local], select { width: 100%;
  min-height: var(--control-height); padding: 0 var(--space-2); font: inherit; border: 1px solid var(--control-border);
  border-radius: var(--radius-sm); background: var(--bg); color: var(--fg); }
select, input[type=datetime-local] { width: auto; }
/* An API key, shown once: selectable whole, never wrapped mid-word by the browser's own rules. */
textarea.key { display: block; width: 100%; max-width: var(--text-max); padding: var(--space-2); font: .9rem/1.5 var(--font-mono);
  border: 1px solid var(--control-border); border-radius: var(--radius-sm); background: var(--panel); color: var(--fg);
  resize: none; word-break: break-all; }
pre.snippet { max-width: var(--text-max); margin: 0 0 var(--space-4); padding: var(--space-3); border: 1px solid var(--line);
  border-radius: var(--radius-md); background: var(--panel); white-space: pre-wrap; word-break: break-all; }
fieldset { border: 0; padding: 0; margin: 0 0 var(--space-4); }
legend { margin-bottom: var(--space-2); padding: 0; }
.choice { display: flex; gap: var(--space-2); align-items: baseline; margin: var(--space-1) 0; }
.choices { padding-left: var(--space-6); }

/* Groups: one bordered block per subject; actions that can't be undone go last, edged in bad. */
.group { border: 1px solid var(--line); border-radius: var(--radius-md); max-width: var(--group-max); }
.group + .group { margin-top: var(--space-6); }
.group > h2 { padding: var(--space-3) var(--space-4); margin: 0; border-bottom: 1px solid var(--line); }
.group > .table-wrap th:first-child, .group > .table-wrap td:first-child { padding-left: var(--space-4); }
.group > .table-wrap tr:last-child td { border-bottom: 0; }
.item { display: flex; flex-wrap: wrap; gap: var(--space-2) var(--space-6); align-items: center; justify-content: space-between;
  margin: 0; padding: var(--space-4); }
.item.block { display: block; }
.item + .item { border-top: 1px solid var(--line); }
.item .what { flex: 1 1 20rem; min-width: 0; }
.item .what p { margin: var(--space-1) 0 0; color: var(--muted); }
.item > p:first-of-type { margin-top: 0; }
.item ul { margin: 0; padding-left: var(--space-6); display: grid; gap: var(--space-1); }
.item:not(.block) .field { flex: 1 1 20rem; margin: 0; }
/* A form or text in a block row: its parts spaced by gap, so a hint never touches the next label. */
form.item.block { display: grid; gap: var(--space-4); }
form.item.block > * { margin: 0; }
.item ul + p { margin-top: var(--space-3); }
.archived-line { margin: 0; padding: var(--space-2) var(--space-4); }
dl.facts { margin: 0; display: grid; grid-template-columns: max-content 1fr; gap: var(--space-1) var(--space-4); }
dl.facts dt { color: var(--muted); }
dl.facts dd { margin: 0; min-width: 0; overflow-wrap: anywhere; }
.group.danger { border-color: var(--bad); }
.group.danger > h2 { color: var(--bad); border-bottom-color: var(--bad); }

/* Filters: a button that opens a drawer from the right, holding the search and every filter.
   Outline with no filters, filled with a count when some are applied. */
.find { margin: 0 0 var(--space-2); }
.find > summary { list-style: none; }
.find > summary::-webkit-details-marker { display: none; }
.filter-btn { display: inline-flex; align-items: center; gap: var(--space-2); min-height: var(--control-height);
  padding: 0 var(--space-3); border: 1px solid var(--control-border); border-radius: var(--radius-sm);
  background: var(--bg); color: var(--fg); font-weight: 500; cursor: pointer; }
.filter-btn:hover { background: var(--panel); }
.filter-btn.on { border-color: var(--accent); color: var(--accent); }
.filter-btn.on .badge { background: var(--accent); color: var(--bg); }
.icon .fill { fill: currentColor; }
.drawer-back { position: fixed; inset: 0; z-index: 20; background: var(--backdrop); }
.drawer { position: fixed; top: 0; right: 0; bottom: 0; z-index: 21; width: min(24rem, 100%); display: flex;
  flex-direction: column; margin: 0; background: var(--bg); border-left: 1px solid var(--line);
  transition: transform .2s ease-out; }
@media (max-width: 40rem) { .drawer { width: 100%; border-left: 0; } }
@starting-style { .find[open] .drawer { transform: translateX(100%); } }
.find.closing .drawer { transform: translateX(100%); }
.find.closing .drawer-back { opacity: 0; }
.drawer-back { transition: opacity .2s; }
@starting-style { .find[open] .drawer-back { opacity: 0; } }
@media (prefers-reduced-motion: reduce) { .drawer, .drawer-back { transition: none; } }
.drawer > form { display: flex; flex: 1; flex-direction: column; min-height: 0; margin: 0; }
.drawer-head { display: flex; align-items: center; justify-content: space-between; gap: var(--space-2);
  padding: var(--space-3) var(--space-3) var(--space-3) var(--space-4); border-bottom: 1px solid var(--line); }
.drawer-head h2 { margin: 0; font-size: 1.05rem; font-weight: 700; }
.drawer-body { flex: 1; overflow: auto; padding: var(--space-4); display: grid; align-content: start; gap: var(--space-4); }
.drawer-body label { display: grid; gap: var(--space-1); margin: 0; font-weight: 500; }
.drawer-body label.choice { display: flex; align-items: center; gap: var(--space-2); font-weight: 400; }
.drawer-body select, .drawer-body input:not([type="checkbox"]) { width: 100%; font-weight: 400; }
.drawer-body .clear { justify-self: start; }
.drawer-foot { display: flex; gap: var(--space-2); padding: var(--space-3) var(--space-4); border-top: 1px solid var(--line); }
.drawer-foot .btn { flex: 1; justify-content: center; }
select, input { max-width: 100%; }
.result-bar { margin: 0 0 var(--space-3); font-size: .85rem; color: var(--muted); }
.switch { display: inline-flex; border: 1px solid var(--control-border); border-radius: var(--radius-sm); overflow: hidden; }
.switch a { display: inline-flex; align-items: center; min-height: var(--control-height); padding: 0 var(--space-3);
  color: var(--fg); text-decoration: none; }
.switch a + a { border-left: 1px solid var(--control-border); }
.switch a[aria-current="page"] { background: var(--fg); color: var(--bg); }
.pager { display: flex; gap: var(--space-4); margin-top: var(--space-4); }
mark { background: var(--highlight); color: var(--fg); border-radius: 2px; }
.key-field { max-width: var(--text-max); }

/* The unverified marker, and any explanation that opens on hover, focus or tap. */
.info { position: relative; display: inline-flex; vertical-align: middle; color: var(--warn); cursor: help; }
.info > .icon { width: 14px; height: 14px; }
/* Phones: a 44px tap area around the icon, without moving the text around it. */
@media (max-width: 40rem) { .info::before { content: ''; position: absolute; inset: -15px; } }
.info-pop { display: none; position: absolute; top: 100%; left: 0; z-index: 3; width: 20rem; max-width: 80vw;
  margin-top: var(--space-1); padding: var(--space-2) var(--space-3); border: 1px solid var(--line);
  border-radius: var(--radius-md); background: var(--bg); color: var(--fg); font-size: .85rem; font-weight: 400;
  text-align: left; text-transform: none; white-space: normal; }
.info:hover .info-pop, .info:focus .info-pop, .info:focus-within .info-pop,
.state:hover .info-pop, .state:focus .info-pop { display: block; }

/* Messages: every message is a card. From beside when it was sent, To beside what happened to it,
   then its subject and text with its actions at the top right. */
.feed, .threads { list-style: none; margin: 0; padding: 0; display: grid; grid-template-columns: minmax(0, 1fr); }
.feed { gap: var(--space-4); }
.threads { gap: var(--space-6); }
.msg { position: relative; border: 1px solid var(--control-border); border-radius: var(--radius-md); }
.msg.is-unread { border-left: 3px solid var(--accent); }
.msg:target { outline: 2px solid var(--accent); outline-offset: 2px; }
.msg-head { display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: center; column-gap: var(--space-4);
  padding: var(--space-2) var(--space-3); border-radius: var(--radius-md) var(--radius-md) 0 0;
  background: color-mix(in srgb, var(--panel), var(--tag)); }
.party { display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-1); min-height: 24px; min-width: 0; }
.party .lbl { display: inline-block; min-width: 2.5rem; color: var(--muted); font-size: .85rem; }
.party code.handle { padding: 1px 6px; border-radius: var(--radius-sm); box-shadow: inset 0 0 0 1px var(--line);
  color: var(--muted); font-size: .8rem; overflow-wrap: anywhere; }
.chip-link { text-decoration: none; }
@media (max-width: 40rem) {
  .chip-link, .console a, details.edit > summary { display: inline-block; padding-block: var(--space-2); overflow-wrap: anywhere; }
}
.chip-link:hover code, .chip-link:focus-visible code { color: var(--accent); text-decoration: underline; }
.side-row { display: flex; align-items: center; justify-content: flex-end; gap: var(--space-1); min-height: 24px;
  font-size: .85rem; color: var(--muted); white-space: nowrap; }
.state { position: relative; display: inline-flex; align-items: center; justify-content: center; width: 24px; min-height: 24px; flex: none; }
.state .icon { width: 14px; height: 14px; }
.state .info-pop { left: auto; right: 0; width: max-content; max-width: 20rem; }
.who-read { display: block; }
/* A delivery state is a dot: filled for unread, a ring for expired, none for read. */
.dot { display: inline-block; width: .6rem; height: .6rem; border-radius: 50%; }
.dot.unread { background: var(--accent); }
.dot.expired { border: 2px solid var(--warn); }
.msg-body { padding: var(--space-2) var(--space-3) var(--space-3); }
.msg-body::after { content: ""; display: block; clear: both; }
.msg-actions { float: right; display: flex; gap: var(--space-1); margin: 0 0 var(--space-1) var(--space-3); }
.msg-actions .info { color: var(--muted); }
.msg-actions .info-pop { left: auto; right: 0; width: max-content; }
.msg-subject { margin: var(--space-1) 0 0; font-size: 1rem; overflow-wrap: anywhere; }
.msg pre { margin: var(--space-2) 0 0; font: 14px/1.55 var(--font-sans); white-space: pre-wrap; word-break: break-word; }
.payload { display: none; margin: 0 var(--space-3) var(--space-3); padding: var(--space-2) var(--space-3);
  border-radius: var(--radius-sm); background: var(--tag); }
.payload:target, .payload.shown { display: block; }
.payload pre { font: .85rem/1.5 var(--font-mono); }
@media (max-width: 40rem) {
  .msg-head { grid-template-columns: minmax(0, 1fr); }
  .side-row { justify-content: flex-start; }
}
/* Threads: one column, like comments under a video; replies indented under the first message. */
.replies { margin-top: var(--space-2); }
.replies > summary { display: inline-flex; align-items: center; gap: var(--space-1); min-height: var(--control-height); padding: 0 var(--space-2);
  border-radius: var(--radius-sm); color: var(--accent); font-weight: 600; cursor: pointer; list-style: none; }
.replies > summary::-webkit-details-marker { display: none; }
.replies > summary:hover { background: var(--panel); }
.replies[open] > summary .chev { transform: rotate(180deg); }
.reply-list { display: grid; gap: var(--space-3); margin: var(--space-2) 0 0 var(--space-4); padding-left: var(--space-4);
  border-left: 2px solid var(--line); }
.outside { margin: 0; color: var(--muted); font-size: .85rem; }

/* The connection map: one-way links flow towards the connection that accepts; two-way links are solid.
   It fits the screen and never grows: app.js zooms and pans inside it. */
.map-bar { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between;
  gap: var(--space-2) var(--space-4); margin: 0 0 var(--space-3); }
.map-ctl { display: inline-flex; flex-wrap: wrap; align-items: center; gap: var(--space-2); margin: 0; }
.map-ctl .lbl { color: var(--muted); }
.map-wrap { position: relative; padding: var(--space-3); border: 1px solid var(--line); border-radius: var(--radius-md);
  background: var(--panel); overflow: hidden; }
.map { display: block; max-width: 100%; max-height: max(20rem, calc(100vh - 19rem)); width: auto; height: auto;
  margin: 0 auto; user-select: none; -webkit-user-select: none; }
/* A finger scrolls the page over the map until the map is tapped; a connection drags at once. */
.map.zoomable { width: 100%; height: max(20rem, calc(100vh - 19rem)); max-height: none; cursor: grab;
  touch-action: pan-x pan-y; }
.map.zoomable.engaged, .map.zoomable.engaged .map-node { touch-action: none; }
.map-wrap:has(.map.engaged) { border-color: var(--accent); }
.map:focus-visible { outline-offset: -3px; }
.map:focus:not(:focus-visible) { outline: none; }
.map.panning { cursor: grabbing; }
.map-wrap .skip { position: absolute; top: var(--space-2); left: var(--space-2); z-index: 3; }
.map-wrap .skip:not(:focus) { width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); }
.map-none { margin: 0 0 var(--space-2); }
.map-wheel { position: absolute; left: 50%; bottom: var(--space-4); z-index: 2; margin: 0; transform: translateX(-50%);
  padding: var(--space-2) var(--space-3); border: 1px solid var(--line); border-radius: var(--radius-md);
  background: var(--bg); font-size: .85rem; pointer-events: none; }
.map-words { margin: var(--space-2) 0 0; font-size: .9rem; }
.map-words > summary { cursor: pointer; color: var(--muted); }
.map-words h3 { margin: var(--space-3) 0 var(--space-1); font-size: .9rem; }
.map-words ul { margin: 0; padding-left: var(--space-5); }
.map-zoom { position: absolute; top: var(--space-2); right: var(--space-2); z-index: 1; display: flex; gap: 2px; padding: 2px;
  background: var(--bg); border: 1px solid var(--line); border-radius: var(--radius-md); }
.map-hint { margin: var(--space-2) 0 0; }
.map-edge { fill: none; stroke-width: 2.5; }
.map-edge.both { stroke: var(--ok); }
.map-edge.one { stroke: var(--accent); stroke-dasharray: 8 6; animation: flow 1s linear infinite; }
@keyframes flow { to { stroke-dashoffset: -14; } }
.mk-one path { fill: var(--accent); }
.mk-both path { fill: var(--ok); }
.map-node { cursor: grab; }
.map-node rect { fill: var(--bg); stroke: var(--control-border); stroke-width: 1.2; }
.map-node:hover rect, .map-node:focus-visible rect { stroke: var(--accent); stroke-width: 2; }
.map-node.cut-off rect { stroke: var(--warn); stroke-dasharray: 5 4; }
.map-node .n { font: 600 15px var(--font-mono); fill: var(--fg); }
.map-node .m { font: 12px var(--font-sans); fill: var(--muted); }
.cut-off-zone { fill: none; stroke: var(--control-border); stroke-dasharray: 4 4; }
.zone-label { font: 12px var(--font-sans); fill: var(--muted); }
/* Mailboxes sit on their connection's edge; a bell shows a wake-up: a tick when it works, ! when it fails. */
.mb { cursor: pointer; }
.mb rect { fill: var(--panel); stroke: var(--control-border); stroke-width: 1.2; }
.mb:hover rect, .mb:focus-visible rect { stroke: var(--accent); stroke-width: 2; }
.mb text { font: 600 12px var(--font-mono); fill: var(--fg); }
.mb.more text { fill: var(--muted); }
.mb .dot { display: none; fill: var(--control-border); }
.mb .hit { fill: transparent; }
.wk { color: var(--muted); }
.wk-ok { color: var(--ok); } .wk-bad { color: var(--bad); }
.wk path { fill: none; stroke: currentColor; stroke-width: 1.4; stroke-linecap: round; stroke-linejoin: round; }
.wk circle { fill: var(--bg); stroke: currentColor; stroke-width: 1.3; }
/* Zoomed out: mailboxes become dots shaped by their wake-up (filled when on, a diamond when failing,
   a ring when paused), and boxes show only their names. */
.map.far .mb rect:not(.dot), .map.far .mb text, .map.far .mb .wk, .map.far .map-node .m { display: none; }
.map.far .mb .dot { display: inline; }
.map.far .mb .dot.ok { fill: var(--ok); }
.map.far .mb .dot.bad { fill: var(--bad); }
.map.far .mb .dot.paused { fill: var(--bg); stroke: var(--muted); stroke-width: 2; }
/* Messages: width is the route's share of all sent, colour runs from blue (all read) to orange (all unread),
   and a one-way route moves towards its reader. The contact policy fades behind them. */
.map.messages .map-edge { opacity: .22; }
.map.messages .map-edge.dim { opacity: .06; }
.route { cursor: help; }
.route path { fill: none; stroke-linecap: round; }
.route .hit { stroke: transparent; stroke-width: var(--route-hit, 16px); pointer-events: stroke; }
.route.one .line { stroke-dasharray: 10 7; animation: flow-route 1.1s linear infinite; }
@keyframes flow-route { to { stroke-dashoffset: -17; } }
.route.u0 .line { stroke: var(--accent); } .mk-u0 path { fill: var(--accent); }
.route.u1 .line { stroke: color-mix(in oklab, var(--warn) 25%, var(--accent)); } .mk-u1 path { fill: color-mix(in oklab, var(--warn) 25%, var(--accent)); }
.route.u2 .line { stroke: color-mix(in oklab, var(--warn) 50%, var(--accent)); } .mk-u2 path { fill: color-mix(in oklab, var(--warn) 50%, var(--accent)); }
.route.u3 .line { stroke: color-mix(in oklab, var(--warn) 75%, var(--accent)); } .mk-u3 path { fill: color-mix(in oklab, var(--warn) 75%, var(--accent)); }
.route.u4 .line { stroke: var(--warn); } .mk-u4 path { fill: var(--warn); }
.routes.hovering .route:not(.hot) { opacity: .3; }
@media (prefers-reduced-motion: reduce) { .map-edge.one, .route.one .line { animation: none; } }
/* Focus on one connection: whatever it can't reach fades. */
.map .dim { opacity: .15; }
.map-tip { position: absolute; z-index: 2; max-width: 20rem; padding: var(--space-2) var(--space-3); pointer-events: none;
  background: var(--bg); border: 1px solid var(--line); border-radius: var(--radius-md); font-size: .85rem; }
.map-tip strong { display: block; font-family: var(--font-mono); }
/* A connection or mailbox opened on the map. Without JS it's open in the page, over a backdrop. */
dialog.card { width: min(var(--dialog-max), calc(100% - 2rem)); max-width: none; padding: 0; }
dialog.card[open]:not(:modal) { position: fixed; inset: 10vh 0 auto; z-index: 30; margin: 0 auto;
  box-shadow: 0 0 0 100vmax var(--backdrop); }
.card-head { display: flex; align-items: center; gap: var(--space-2); padding: var(--space-2) var(--space-2) var(--space-2) var(--space-4);
  border-bottom: 1px solid var(--line); }
.card-head h2 { flex: 1; min-width: 0; margin: 0; font: 700 1.05rem var(--font-mono); overflow-wrap: anywhere; }
.card-head .tools { display: flex; gap: 2px; }
.card .facts { padding: var(--space-3) var(--space-4) var(--space-4); }
.card-foot { margin: 0; padding: 0 var(--space-4) var(--space-4); }
.num { font-variant-numeric: tabular-nums; font-weight: 600; }

/* Long lists on big screens: the header, search and filters stay put; the list scrolls in its own
   box, so nothing scrolls under the header. Not on short or narrow screens. */
@media (min-width: 64rem) and (min-height: 40rem) {
  body.pinned { height: 100vh; height: 100dvh; display: flex; flex-direction: column; overflow: hidden; }
  body.pinned > main { flex: 1; min-height: 0; width: 100%; display: flex; flex-direction: column; }
  body.pinned > main > * { flex: none; }
  body.pinned .scroller { flex: 1 1 auto; min-height: 0; overflow: auto; overscroll-behavior: contain; }
}

/* The audit log reads like a terminal: monospaced, one line per entry that opens in place. */
.console { background: var(--console-bg); color: var(--console-fg); border: 1px solid var(--line); border-radius: var(--radius-md);
  font-family: var(--font-mono); font-size: .8rem; line-height: 1.6; overflow-x: auto; }
.console a { color: var(--console-accent); }
.console-bar { display: flex; flex-wrap: wrap; justify-content: space-between; gap: var(--space-2);
  padding: var(--space-2) var(--space-3); color: var(--console-muted); border-bottom: 1px solid var(--console-line); }
.console .line > summary { display: grid; grid-template-columns: 10.5rem 3.5rem 14rem 9rem minmax(0, 1fr); gap: var(--space-3);
  padding: 2px var(--space-3); cursor: pointer; list-style: none; white-space: nowrap; }
.console .line > summary::-webkit-details-marker { display: none; }
.console .line > summary > * { overflow: hidden; text-overflow: ellipsis; }
.console .line:hover > summary, .console .line[open] > summary { background: var(--console-line); }
.console .kv { unicode-bidi: isolate; }
.console .t, .console .who, .console .kv b { color: var(--console-muted); font-weight: 400; }
.console .ev { font-family: var(--font-sans); font-weight: 600; }
.console .ev.bad { color: var(--console-bad); } .console .ev.warn { color: var(--console-warn); }
.console .ev.quiet { color: var(--console-muted); font-weight: 400; }
.console .line-detail { padding: var(--space-2) var(--space-3) var(--space-3) 14.5rem; color: var(--console-fg); }
.console .line-detail pre { margin: var(--space-1) 0 0; white-space: pre-wrap; word-break: break-word; font-size: inherit; }
.console .empty { padding: var(--space-3); color: var(--console-muted); }
@media (max-width: 40rem) {
  .console .line > summary { grid-template-columns: minmax(0, 1fr); white-space: normal; gap: 0; padding-block: var(--space-1); }
  .console .line-detail { padding-left: var(--space-3); }
}

dialog { border: 1px solid var(--line); border-radius: var(--radius-lg); background: var(--bg);
  color: var(--fg); max-width: var(--dialog-max); padding: var(--space-6); }
dialog::backdrop { background: var(--backdrop); }

/* Standalone pages (sign in, connect an app): the wordmark only, one narrow column. */
.standalone main { max-width: var(--narrow-max); margin: 0 auto; padding-top: calc(2 * var(--space-6)); }
.standalone main.wide { max-width: var(--wide-max); }
.standalone main > section { margin-top: calc(2 * var(--space-6)); padding-top: var(--space-4); border-top: 1px solid var(--line); }

/* The account menu's workspace name leads back to its pages. */
.menu-workspace a.name { color: var(--fg); text-decoration: none; }
.menu-workspace a.name:hover { color: var(--accent); text-decoration: underline; }
/* A menu item that opens a new tab says so with its icon. */
.app-header .profile .menu nav a.out { justify-content: space-between; gap: var(--space-4); }
.app-header .profile .menu nav a.out .icon { color: var(--muted); }

/* The operator console: the app header on a violet bar in both themes, so it can't be taken for a workspace's pages. */
.app-header.op-header { background: var(--op-bar); border-bottom-color: var(--op-bar); color: var(--op-bar-fg); }
.op-header .brand { display: inline-flex; align-items: center; gap: var(--space-3); text-decoration: none; }
.op-tag { padding: 0 var(--space-2); border: 1px solid var(--op-bar-mark); border-radius: var(--radius-sm);
  color: var(--op-bar-fg); font-size: .8rem; font-weight: 600; }
.op-header > nav a { color: var(--op-bar-muted); }
.op-header > nav a[aria-current="page"] { color: var(--op-bar-fg); border-bottom-color: var(--op-bar-mark); }
.op-header .host { color: var(--op-bar-fg); background: none; font-size: .85rem; }
.op-header .profile > summary { color: var(--op-bar-fg); }
.op-header .avatar.initial { background: var(--op-bar-line); }
/* White on the bar; the menu below it is the page's own colours, with the usual accent ring. */
.op-header > .brand:focus-visible, .op-header > nav a:focus-visible, .op-header .profile > summary:focus-visible {
  outline-color: var(--op-bar-fg); }
@media (max-width: 40rem) {
  .op-header > nav { flex-wrap: wrap; column-gap: var(--space-4); border-top-color: var(--op-bar-line); }
  .op-header .host { display: none; }
}
.group > .pad, .group > p.pad { margin: 0; padding: var(--space-3) var(--space-4); }
.group > .head-row { padding: var(--space-3) var(--space-4); border-bottom: 1px solid var(--line); align-items: center; }
.group > .head-row h2 { margin: 0; }
/* Overview's figures. */
.op-stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(9rem, 1fr)); gap: var(--space-4);
  margin: 0 0 var(--space-6); padding: 0; list-style: none; }
.op-stats li { display: grid; gap: var(--space-1); padding: var(--space-3) var(--space-4); border: 1px solid var(--line);
  border-radius: var(--radius-md); }
.op-stats .label, .op-stats .sub { color: var(--muted); font-size: .85rem; }
.op-stats .big { font-size: 1.6rem; font-weight: 700; line-height: 1.2; font-variant-numeric: tabular-nums; }
.op-cols { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(22rem, 100%), 1fr)); gap: var(--space-6);
  align-items: start; margin-bottom: var(--space-6); }
.op-cols .group + .group { margin-top: 0; }
.op-period { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: var(--space-3);
  margin: var(--space-6) 0 var(--space-3); }
.op-period h2 { margin: 0; }
/* Storage against a limit: a bar, the figures, and words when it's close or full. */
.op-usage { display: grid; gap: 2px; min-width: 9rem; }
.op-meter { display: block; width: 100%; height: 6px; }
.op-meter .track { fill: var(--tag); }
.op-meter .fill { fill: var(--accent); }
.op-meter.near .fill { fill: var(--warn); }
.op-meter.full .fill { fill: var(--bad); }
.op-usage .fig { font-size: .85rem; font-variant-numeric: tabular-nums; }
.op-near { color: var(--warn); font-weight: 500; }
.op-full { color: var(--bad); font-weight: 600; }
/* A workspace's last 30 days in a table cell. */
.op-spark { display: block; width: 120px; height: 28px; }
.op-spark polyline { fill: none; stroke: var(--accent); stroke-width: 1.5; stroke-linejoin: round; }
.op-spark circle { fill: var(--accent); }
/*
 * Charts: one measure each, its limit dashed, the grid recessive. The plot stretches to fit while its
 * labels, outside the SVG, stay text-sized: the y axis's five figures sit on the grid's five lines.
 */
.op-chart { display: grid; grid-template-columns: auto 1fr; grid-template-rows: 12rem auto; column-gap: var(--space-2);
  padding: var(--space-4) var(--space-4) 0; font-size: .75rem; line-height: 1rem; color: var(--muted);
  font-variant-numeric: tabular-nums; }
.op-chart .y-axis { display: flex; flex-direction: column; justify-content: space-between; margin-block: -.5rem;
  text-align: right; }
.op-chart .plot { position: relative; touch-action: pan-y; }
.op-chart .plot svg { position: absolute; inset: 0; width: 100%; height: 100%; overflow: visible; }
.op-chart .plot svg * { vector-effect: non-scaling-stroke; }
.op-chart .grid { stroke: var(--tag); stroke-width: 1; }
.op-chart .area { fill: var(--accent); opacity: .12; }
.op-chart .line { fill: none; stroke: var(--accent); stroke-width: 2; stroke-linejoin: round; }
.op-chart .limit { stroke: var(--bad); stroke-width: 1.5; stroke-dasharray: 6 4; }
.op-chart .cross { stroke: var(--muted); stroke-width: 1; }
.op-chart .dot { position: absolute; width: 10px; height: 10px; margin: -5px 0 0 -5px; border: 2px solid var(--bg);
  border-radius: 50%; background: var(--accent); pointer-events: none; }
.op-chart .tip { position: absolute; z-index: 1; padding: var(--space-1) var(--space-2); border: 1px solid var(--line);
  border-radius: var(--radius-sm); background: var(--bg); color: var(--fg); white-space: nowrap; pointer-events: none; }
.op-chart .tip strong { display: block; }
.op-chart .x-axis { grid-column: 2; display: flex; justify-content: space-between; padding-top: var(--space-1); }
.op-chart .x-axis span { display: flex; justify-content: center; width: 0; white-space: nowrap; }
.op-chart .x-axis span:first-child { justify-content: flex-start; }
.op-chart .x-axis span:last-child { justify-content: flex-end; }
@media (max-width: 40rem) { .op-chart .x-axis span:nth-last-child(even) { visibility: hidden; } }
.op-key { display: inline-flex; align-items: center; gap: var(--space-2); margin-left: auto; color: var(--muted); font-size: .85rem; }
.op-key .swatch { width: 1.5rem; border-top: 2px dashed var(--bad); }
.op-figures > summary { color: var(--accent); cursor: pointer; font-size: .85rem; }
@media (max-width: 40rem) { .op-figures > summary { display: flex; align-items: center; min-height: var(--control-height); } }
.op-figures table { max-width: var(--field-max); margin-top: var(--space-2); }
/* A setting: its name, what it does, and what's recommended when that isn't simply the default. Every group's columns line up. */
table.op-settings { table-layout: fixed; }
.op-settings th:nth-child(1) { width: 55%; }
.op-settings th:nth-child(2) { width: 30%; }
.op-setting { display: grid; gap: 2px; max-width: var(--text-max); }
.op-setting .desc { color: var(--muted); }
.op-setting .name { display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-2); }
.op-setting .tag { display: inline-flex; align-items: center; gap: var(--space-1); font-size: .75rem; }
.op-settings .tag.security { background: var(--security-bg); color: var(--security); font-weight: 500; }
.op-settings .tag.secret { background: var(--secret-bg); color: var(--secret); font-weight: 500; }
.op-settings .tag.set { background: var(--set-bg); color: var(--set); font-weight: 500; }
.op-security-note .icon { color: var(--security); }
.op-setting .tag .icon, .op-security-note .icon { width: 12px; height: 12px; flex: none; }
.op-security-note { display: flex; align-items: baseline; gap: var(--space-2); }
/* A setting the warning links to: clear of the sticky header (taller on a phone), and
   marked like a linked message, keeping its text on the usual background. */
.op-settings tr[id] { scroll-margin-top: 7rem; }
@media (max-width: 40rem) { .op-settings tr[id] { scroll-margin-top: 11rem; } }
.op-settings tr:target > td:first-child { box-shadow: inset 3px 0 0 var(--accent); }
.op-settings td { overflow-wrap: anywhere; }
`;

/**
 * Served as /ui/app.js. The pages work without it; it adds:
 * - live pages (main[data-live]) re-render their <main> when the server reports
 *   a change, unless the person is typing, keeping open details and scroll;
 * - times: "5 min ago", with the local time and UTC on hover;
 * - From/To boxes in the reader's own time zone (the server works in UTC);
 * - menus that close on a click elsewhere or Escape;
 * - the connection map: zoom, pan and drag inside it, lines explained on hover, cards over it;
 * - the filter drawer: it slides away on Cancel or Escape, putting back what was there;
 * - the operator console's charts: the figure under the pointer;
 * - opening confirmation dialogs modally.
 */
export const JS = `
(() => {
  const dialog = document.querySelector('dialog[data-confirm]');
  if (dialog) { dialog.close(); dialog.showModal(); dialog.querySelector('[data-cancel]')?.focus(); }

  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const isUtc = /^(Etc\\/)?(UTC|GMT|UCT|Universal|Zulu)$/.test(zone);
  const local = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'medium' });
  const localZone = new Intl.DateTimeFormat(undefined, { timeZoneName: 'short' });
  const utc = new Intl.DateTimeFormat(undefined, { timeStyle: 'medium', timeZone: 'UTC' });
  const ago = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
  const pad = (n) => String(n).padStart(2, '0');
  const day = (d) => d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  const logTime = (d) => day(d) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
  const relative = (d) => {
    const s = (d.getTime() - Date.now()) / 1000;
    if (Math.abs(s) < 45) return s < 0 ? 'just now' : 'in a moment';
    const [, unit, size] = [[60, 'second', 1], [3600, 'minute', 60], [86400, 'hour', 3600],
      [604800, 'day', 86400], [Infinity, 'week', 604800]].find(([below]) => Math.abs(s) < below);
    return ago.format(Math.round(s / size), unit);
  };
  const times = () => {
    for (const el of document.querySelectorAll('time[datetime]')) {
      const d = new Date(el.getAttribute('datetime'));
      if (Number.isNaN(d.getTime())) continue;
      const zoneName = localZone.formatToParts(d).find((p) => p.type === 'timeZoneName')?.value ?? '';
      el.title = isUtc ? local.format(d) + ' UTC' : local.format(d) + ' ' + zoneName + ' (' + utc.format(d) + ' UTC)';
      el.textContent = el.dataset.format === 'log' ? logTime(d) : relative(d);
    }
  };

  // The server fills From/To in UTC: show them in the reader's zone, and say which zone was meant.
  const windows = () => {
    for (const input of document.querySelectorAll('input[data-utc]')) {
      const d = new Date(input.value + 'Z');
      if (Number.isNaN(d.getTime())) continue;
      input.value = day(d) + 'T' + pad(d.getHours()) + ':' + pad(d.getMinutes());
      input.defaultValue = input.value;
      input.removeAttribute('data-utc');
      const shown = input.value;
      // A default left untouched isn't sent: the page keeps choosing it (a window that ends now).
      if (input.hasAttribute('data-default')) {
        input.form?.addEventListener('submit', () => { if (input.value === shown) input.disabled = true; });
      }
      const form = input.form;
      if (form && !form.querySelector('input[name="tz"]')) {
        const tz = document.createElement('input');
        tz.type = 'hidden';
        tz.name = 'tz';
        tz.value = String(new Date().getTimezoneOffset());
        form.append(tz);
      }
    }
    for (const note of document.querySelectorAll('[data-utc-note]')) note.hidden = true;
  };

  // Menus (the account menu, a page's name) close on a click elsewhere or Escape, as menus do.
  document.addEventListener('click', (e) => {
    for (const menu of document.querySelectorAll('details[data-menu][open]')) {
      if (!menu.contains(e.target)) menu.open = false;
    }
  });
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    for (const menu of document.querySelectorAll('details[data-menu][open]')) {
      menu.open = false;
      menu.querySelector('summary')?.focus();
    }
  });

  // A picture that won't load (expired, rate limited) gives way to the initial.
  for (const img of document.querySelectorAll('img.avatar[data-initial]')) {
    const fallback = () => {
      const span = document.createElement('span');
      span.className = 'avatar initial';
      span.setAttribute('aria-hidden', 'true');
      span.textContent = img.dataset.initial;
      img.replaceWith(span);
    };
    if (img.complete && img.naturalWidth === 0) fallback(); else img.addEventListener('error', fallback);
  }

  // The connection map: zoom and pan inside it, drag a connection (its mailboxes and lines follow),
  // and hover over, tap or focus a line or mailbox to have it explained. A short press opens its card.
  // Where things were put is kept for the visit, so a live refresh or another window leaves them be.
  const GAP = ${GAP}, PILL_H = ${PILL_H}, NODE_H = ${NODE_H};
  const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), Math.max(lo, hi));
  const trim = (a, b, sa, sb) => {
    const dx = b[0] - a[0], dy = b[1] - a[1];
    const t = (s) => Math.min((s[0] / 2 + GAP) / Math.abs(dx || 1e-9), (s[1] / 2 + GAP) / Math.abs(dy || 1e-9));
    const ta = t(sa), tb = t(sb);
    return [a[0] + dx * ta, a[1] + dy * ta, b[0] - dx * tb, b[1] - dy * tb];
  };
  const curve = (p, sp, pb, q, sq, qb) => {
    const a = [p[0], p[1] + sp * PILL_H / 2], b = [q[0], q[1] + sq * (PILL_H / 2 + 3)];
    const own = pb[0] === qb[0] && pb[1] === qb[1];
    const len = Math.hypot(q[0] - p[0], q[1] - p[1]);
    const reach = own ? Math.max(40, len / 2) : Math.min(180, Math.max(40, len * 0.35));
    const handle = (end, side, [cx, cy, w], other) => {
      if (own ? sp === sq : (other[1] - cy) * side >= -(NODE_H / 2 + PILL_H)) return [end[0], end[1] + side * reach];
      const toward = own ? (p[0] + q[0]) / 2 : other[0];
      return [cx + (toward >= cx ? 1 : -1) * (w + 90), end[1] + side * 60];
    };
    const c1 = handle(a, sp, pb, q), c2 = handle(b, sq, qb, p);
    const f = (v) => v[0].toFixed(1) + ' ' + v[1].toFixed(1);
    return 'M' + f(a) + ' C' + f(c1) + ' ' + f(c2) + ' ' + f(b);
  };
  let holding = false;
  let refit = () => {};
  let quietMap = () => {};
  let mapSvg, mapEngaged = false;
  window.addEventListener('resize', () => refit());
  // Escape hides a line's explanation; a tap outside the map lets a finger scroll the page again.
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') quietMap(); });
  document.addEventListener('pointerdown', (e) => {
    if (!mapSvg?.isConnected || mapSvg.closest('[data-map]').contains(e.target)) return;
    mapEngaged = false;
    mapSvg.classList.remove('engaged');
  });
  const map = () => {
    const wrap = document.querySelector('[data-map]');
    const svg = wrap?.querySelector('svg.map');
    if (!svg) return;
    const world = { w: svg.viewBox.baseVal.width, h: svg.viewBox.baseVal.height };
    const key = 'budd-map ' + svg.dataset.key;
    let saved = {};
    try { saved = JSON.parse(sessionStorage.getItem(key) || '{}'); } catch { /* a private window: start afresh */ }
    const at = new Map();
    let view;
    // Only boxes someone dragged are kept: the rest follow the server's layout, which changes with the window shown.
    const dragged = new Set();
    const save = () => { try { sessionStorage.setItem(key, JSON.stringify({ at: Object.fromEntries([...dragged].map((slug) => [slug, at.get(slug)])), view })); } catch { /* not kept */ } };
    const nodes = new Map([...svg.querySelectorAll('[data-node]')].map((n) => [n.dataset.node, n]));
    const size = (slug) => [+nodes.get(slug).dataset.w, NODE_H];
    // Nothing goes past the map's edge.
    const keepIn = (slug, p) => {
      const [w, h] = size(slug);
      return [clamp(p[0], w / 2 + 4, world.w - w / 2 - 4), clamp(p[1], h / 2 + PILL_H / 2 + 2, world.h - h / 2 - PILL_H / 2 - 2)];
    };
    for (const [slug, n] of nodes) {
      const p = saved.at?.[slug];
      if (Array.isArray(p)) dragged.add(slug);
      at.set(slug, keepIn(slug, Array.isArray(p) ? p : [+n.dataset.x, +n.dataset.y]));
    }
    const pillsOf = new Map([...nodes.keys()].map((slug) => [slug, [...svg.querySelectorAll('g[data-of="' + slug + '"] [data-mb]')]]));
    const places = new Map();
    const draw = (slug) => {
      const [x, y] = at.get(slug), [w, h] = size(slug);
      nodes.get(slug).setAttribute('transform', 'translate(' + (x - w / 2) + ' ' + (y - h / 2) + ')');
      for (const p of pillsOf.get(slug)) {
        const px = x + +p.dataset.ox, py = y + +p.dataset.oy;
        places.set(p.dataset.mb, { at: [px, py], side: p.dataset.oy < 0 ? -1 : 1 });
        p.setAttribute('transform', 'translate(' + (px - p.dataset.w / 2) + ' ' + (py - PILL_H / 2) + ')');
      }
    };
    const edges = [...svg.querySelectorAll('line[data-from]')];
    const routePaths = [...svg.querySelectorAll('g.route')];
    const slugOf = (address) => address.slice(0, address.indexOf('/'));
    const lines = (slug) => {
      for (const line of edges) {
        if (slug && line.dataset.from !== slug && line.dataset.to !== slug) continue;
        const [x1, y1, x2, y2] = trim(at.get(line.dataset.from), at.get(line.dataset.to), size(line.dataset.from), size(line.dataset.to));
        line.setAttribute('x1', x1); line.setAttribute('y1', y1); line.setAttribute('x2', x2); line.setAttribute('y2', y2);
      }
      for (const r of routePaths) {
        const a = slugOf(r.dataset.a), b = slugOf(r.dataset.b);
        if (slug && a !== slug && b !== slug) continue;
        const p = places.get(r.dataset.a), q = places.get(r.dataset.b);
        if (!p || !q) continue;
        const d = curve(p.at, p.side, [...at.get(a), size(a)[0]], q.at, q.side, [...at.get(b), size(b)[0]]);
        for (const path of r.querySelectorAll('path')) path.setAttribute('d', d);
      }
    };
    for (const slug of nodes.keys()) draw(slug);
    // Only what was dragged differs from what the server drew.
    if (saved.at) lines();

    // Zoom and pan: the viewBox moves; the map keeps its size on the page.
    svg.classList.add('zoomable');
    const zoomBar = wrap.querySelector('[data-zoom]');
    zoomBar.hidden = false;
    // A mailbox's tap area reaches out from its box, never over it.
    const hits = [...svg.querySelectorAll('.mb')].map((p) => [p.querySelector('.hit'), p.dataset.oy < 0 ? -1 : 1]);
    const names = [...nodes.values()].map((n) => [n.querySelector('.n'), +n.dataset.w, n.dataset.node.length]);
    svg.setAttribute('tabindex', '0');
    const help = document.getElementById('map-help');
    if (help) {
      help.append(' On a touch screen, tap the map to move and zoom it. From the keyboard, Tab to the map: arrows move it, + and − zoom.');
      svg.setAttribute('aria-describedby', 'map-help');
    }
    const box = () => svg.getBoundingClientRect();
    const fit = () => {
      const b = box(), s = Math.max(world.w / b.width, world.h / b.height, 1);
      return { x: (world.w - b.width * s) / 2, y: (world.h - b.height * s) / 2, w: b.width * s, h: b.height * s };
    };
    const show = () => {
      const b = box();
      if (!b.width || !b.height) return;
      const f = fit();
      view.w = clamp(view.w, f.w / 4, f.w);
      view.h = view.w * b.height / b.width;
      view.x = view.w >= world.w ? (world.w - view.w) / 2 : clamp(view.x, 0, world.w - view.w);
      view.y = view.h >= world.h ? (world.h - view.h) / 2 : clamp(view.y, 0, world.h - view.h);
      svg.setAttribute('viewBox', [view.x, view.y, view.w, view.h].map((v) => v.toFixed(1)).join(' '));
      const scale = b.width / view.w, far = scale < 0.7;
      svg.classList.toggle('far', far);
      // However far out, a mailbox is at least 28 pixels to tap, a route 24, and a name 11 high where it fits.
      const r = Math.max(PILL_H / 2, 14 / scale);
      for (const [h, side] of hits) { h.setAttribute('r', r.toFixed(1)); h.setAttribute('cy', (PILL_H / 2 + side * (r - PILL_H / 2)).toFixed(1)); }
      svg.style.setProperty('--route-hit', (24 / scale).toFixed(1) + 'px');
      for (const [n, w, chars] of names) n.style.fontSize = far ? Math.max(15, Math.min(11 / scale, (w - 28) / (chars * 0.62))).toFixed(1) + 'px' : '';
    };
    view = saved.view && saved.view.w > 0 ? { ...saved.view } : fit();
    show();
    refit = show;
    const toWorld = (e) => {
      const b = box();
      return [view.x + (e.clientX - b.left) / b.width * view.w, view.y + (e.clientY - b.top) / b.height * view.h];
    };
    const zoom = (by, [cx, cy]) => {
      const w = view.w / by, k = w / view.w;
      view = { x: cx - (cx - view.x) * k, y: cy - (cy - view.y) * k, w, h: view.h * k };
      show(); save();
    };
    const pan = (dx, dy) => { view = { ...view, x: view.x + dx, y: view.y + dy }; show(); save(); };
    const middle = () => [view.x + view.w / 2, view.y + view.h / 2];
    for (const b of zoomBar.querySelectorAll('[data-zoom-by]')) b.addEventListener('click', () => zoom(+b.dataset.zoomBy, middle()));
    zoomBar.querySelector('[data-zoom-fit]').addEventListener('click', () => { view = fit(); show(); save(); });
    // The wheel scrolls the page; with Ctrl or ⌘ (and a trackpad's pinch, which sends Ctrl) it zooms.
    const hintBox = wrap.querySelector('[data-map-wheel]');
    let hintTimer;
    const hint = (text) => {
      hintBox.textContent = text;
      hintBox.hidden = !text;
      clearTimeout(hintTimer);
      if (text) hintTimer = setTimeout(() => { hintBox.hidden = true; }, 1500);
    };
    svg.addEventListener('wheel', (e) => {
      if (e.ctrlKey || e.metaKey) { e.preventDefault(); zoom(Math.exp(-e.deltaY * 0.0015), toWorld(e)); return; }
      hint('Hold Ctrl (⌘ on a Mac) and scroll to zoom');
    }, { passive: false });
    // The keyboard: arrows pan and + or − zoom while the map has focus.
    svg.addEventListener('keydown', (e) => {
      if (e.target !== svg) return;
      const step = view.w / 8;
      const by = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[e.key];
      if (by) { e.preventDefault(); pan(by[0], by[1]); }
      else if (e.key === '+' || e.key === '=') { e.preventDefault(); zoom(1.4, middle()); }
      else if (e.key === '-') { e.preventDefault(); zoom(0.714, middle()); }
    });
    // Whatever gets focus comes into view.
    const whereIs = (el) => el.dataset.node ? at.get(el.dataset.node) : places.get(el.dataset.mb)?.at;
    svg.addEventListener('focusin', (e) => {
      const el = e.target.closest('[data-node], [data-mb]');
      const p = el && whereIs(el);
      if (!p) return;
      const m = Math.min(view.w, view.h) / 8;
      if (p[0] < view.x + m || p[0] > view.x + view.w - m || p[1] < view.y + m || p[1] > view.y + view.h - m) {
        pan(p[0] - view.x - view.w / 2, p[1] - view.y - view.h / 2);
      }
    });

    // One pointer on the background pans, two pinch; on a connection, it drags. On a touch
    // screen a finger scrolls the page until the map has been tapped, and then moves the map.
    const down = new Map();
    let gesture, pressed, pressedRoute, moved = false;
    // Kept across live refreshes, which replace the map.
    mapSvg = svg;
    svg.classList.toggle('engaged', mapEngaged);
    const engaged = () => mapEngaged;
    svg.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      down.set(e.pointerId, [e.clientX, e.clientY]);
      pressed = e.target.closest('a');
      pressedRoute = e.target.closest('.route');
      const node = e.target.closest('[data-node]');
      const touchFree = e.pointerType !== 'touch' || engaged();
      if (!touchFree && !pressed && !pressedRoute) hint('Tap the map to move and zoom it');
      moved = false;
      if (down.size === 2 && gesture?.kind !== 'drag' && (e.pointerType !== 'touch' || engaged())) {
        const [a, b] = [...down.values()];
        gesture = { kind: 'pinch', d: Math.hypot(a[0] - b[0], a[1] - b[1]) };
      } else if (node && touchFree) {
        gesture = { kind: 'drag', slug: node.dataset.node, x: e.clientX, y: e.clientY, at: at.get(node.dataset.node), scale: view.w / box().width };
      } else if (!node && !e.target.closest('[data-mb]') && touchFree) {
        gesture = { kind: 'pan', x: e.clientX, y: e.clientY, view: { ...view }, scale: view.w / box().width };
      } else return;
      holding = true;
      svg.setPointerCapture(e.pointerId);
    });
    svg.addEventListener('pointermove', (e) => {
      if (!gesture || !down.has(e.pointerId)) return;
      down.set(e.pointerId, [e.clientX, e.clientY]);
      if (gesture.kind === 'pinch') {
        if (down.size < 2) return;
        const [a, b] = [...down.values()], d = Math.hypot(a[0] - b[0], a[1] - b[1]);
        const mid = toWorld({ clientX: (a[0] + b[0]) / 2, clientY: (a[1] + b[1]) / 2 });
        if (gesture.d > 0) zoom(d / gesture.d, mid);
        gesture.d = d;
        moved = true;
        return;
      }
      const dx = (e.clientX - gesture.x) * gesture.scale, dy = (e.clientY - gesture.y) * gesture.scale;
      if (!moved && Math.hypot(e.clientX - gesture.x, e.clientY - gesture.y) < 4) return;
      moved = true;
      if (gesture.kind === 'drag') {
        at.set(gesture.slug, keepIn(gesture.slug, [gesture.at[0] + dx, gesture.at[1] + dy]));
        dragged.add(gesture.slug);
        draw(gesture.slug);
        lines(gesture.slug);
      } else {
        svg.classList.add('panning');
        view = { ...view, x: gesture.view.x - dx, y: gesture.view.y - dy };
        show();
      }
    });
    const up = (e) => {
      if (e.type === 'pointerup' && e.pointerType === 'touch' && !moved && !pressed && !pressedRoute && !mapEngaged) {
        mapEngaged = true;
        svg.classList.add('engaged');
        hint('');
      }
      down.delete(e.pointerId);
      if (down.size > 0 && gesture?.kind === 'pinch') return;
      if (gesture && moved) save();
      gesture = undefined;
      holding = false;
      svg.classList.remove('panning');
    };
    svg.addEventListener('pointerup', up);
    svg.addEventListener('pointercancel', up);

    // A click (not a drag) on a connection or mailbox opens its card over the map.
    svg.addEventListener('click', (e) => {
      // Held by pointer capture, the click may land on the map itself rather than what was pressed.
      const link = e.target.closest('a') || pressed;
      if (!link) return;
      // Ctrl, ⌘ or Shift: the browser opens the card's page in a new tab or window, as usual.
      if ((e.ctrlKey || e.metaKey || e.shiftKey) && !moved) return;
      e.preventDefault();
      if (moved) { moved = false; return; }
      openCard(link.getAttribute('href'), link);
    });

    // Lines and mailboxes explain themselves: hover, keyboard focus, or a tap. A mailbox lights up its routes.
    const tip = wrap.querySelector('[data-map-tip]');
    const routes = svg.querySelector('.routes');
    for (const el of svg.querySelectorAll('[data-tip-h], [data-mb]')) {
      const t = el.querySelector('title');
      if (t) { el.dataset.tip = t.textContent.trim(); t.remove(); }
    }
    let hot = [];
    const explain = (el, x, y) => {
      if (hot[0] !== el) {
        for (const h of hot) h.classList.remove('hot');
        const address = el.dataset.mb;
        hot = [el, ...(address ? routePaths.filter((r) => r.dataset.a === address || r.dataset.b === address) : [])];
        for (const h of hot) h.classList.add('hot');
        routes?.classList.toggle('hovering', hot.length > 1 || el.matches('.route'));
        tip.replaceChildren();
        if (el.dataset.tipH) { const h = document.createElement('strong'); h.textContent = el.dataset.tipH; tip.append(h); }
        tip.append(el.dataset.tip);
        tip.hidden = false;
      }
      // Above the pointer, so it doesn't cover the end of the line it's explaining.
      const b = wrap.getBoundingClientRect(), w = tip.offsetWidth, h = tip.offsetHeight;
      tip.style.left = clamp(x - b.left - w / 2, 8, b.width - w - 8) + 'px';
      tip.style.top = clamp(y - b.top - h - 14 < 8 ? y - b.top + 18 : y - b.top - h - 14, 8, b.height - h - 8) + 'px';
    };
    const quiet = () => { for (const h of hot) h.classList.remove('hot'); hot = []; routes?.classList.remove('hovering'); tip.hidden = true; };
    svg.addEventListener('pointermove', (e) => {
      if (gesture && moved) return quiet();
      const el = e.target.closest('[data-tip]');
      if (el && e.pointerType === 'mouse') explain(el, e.clientX, e.clientY);
      else if (!el && e.pointerType === 'mouse') quiet();
    });
    svg.addEventListener('pointerleave', (e) => { if (e.pointerType === 'mouse') quiet(); });
    // A tap on a route explains it; with the pointer held by the map, what was pressed is what counts.
    svg.addEventListener('pointerup', (e) => {
      if (e.pointerType === 'mouse' || moved) return;
      if (pressedRoute) explain(pressedRoute, e.clientX, e.clientY); else if (!pressed) quiet();
    });
    svg.addEventListener('focusin', (e) => {
      const el = e.target.closest('[data-tip]');
      if (!el) return;
      const r = el.getBoundingClientRect();
      explain(el, r.left + r.width / 2, r.top);
    });
    svg.addEventListener('focusout', quiet);
    quietMap = quiet;
  };

  // A storage chart (the operator console): the hour and figure nearest the pointer or finger.
  const charts = () => {
    const at = new Intl.DateTimeFormat(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' });
    for (const plot of document.querySelectorAll('[data-chart]')) {
      const [xs, ys, times] = ['x', 'y', 'times'].map((k) => plot.dataset[k].split(',').map(Number));
      const labels = plot.dataset.labels.split(',');
      const cross = plot.querySelector('[data-chart-cross]');
      const dot = plot.querySelector('[data-chart-dot]');
      const tip = plot.querySelector('[data-chart-tip]');
      const [figure, when] = tip.children;
      const show = (e) => {
        const r = plot.getBoundingClientRect();
        const x = (e.clientX - r.left) / r.width;
        let i = 0;
        for (let j = 1; j < xs.length; j++) if (Math.abs(xs[j] - x) < Math.abs(xs[i] - x)) i = j;
        cross.setAttribute('x1', xs[i] * 1000);
        cross.setAttribute('x2', xs[i] * 1000);
        dot.style.left = xs[i] * 100 + '%';
        dot.style.top = ys[i] * 100 + '%';
        figure.textContent = labels[i];
        when.textContent = at.format(times[i]);
        // Beside the point, on whichever side and half has room.
        tip.style.left = xs[i] > .6 ? '' : 'calc(' + xs[i] * 100 + '% + 12px)';
        tip.style.right = xs[i] > .6 ? 'calc(' + (100 - xs[i] * 100) + '% + 12px)' : '';
        tip.style.top = ys[i] < .4 ? '' : '4px';
        tip.style.bottom = ys[i] < .4 ? '4px' : '';
        for (const el of [cross, dot, tip]) el.removeAttribute('hidden');
      };
      plot.addEventListener('pointermove', show);
      plot.addEventListener('pointerdown', show);
      plot.addEventListener('pointerleave', () => { for (const el of [cross, dot, tip]) el.setAttribute('hidden', ''); });
    }
  };
  charts();

  // A card (a connection or mailbox opened on the map) is a modal dialog; closing it goes back to the map.
  let opener;
  const openCard = async (href, from, remember = true) => {
    opener = from;
    try {
      const res = await fetch(href, { credentials: 'same-origin', headers: { 'X-Budd-Part': 'card' } });
      const doc = res.ok ? new DOMParser().parseFromString(await res.text(), 'text/html') : undefined;
      const next = doc?.querySelector('dialog[data-card]');
      if (!next) { location.href = href; return; }
      const open = document.querySelector('dialog[data-card]');
      open?.remove();
      document.querySelector('main').append(next);
      // Back closes the card, as it would a page; one card replaces another.
      if (open || !remember) history.replaceState({ card: true }, '', href);
      else history.pushState({ card: true }, '', href);
      cards();
      times();
    } catch { location.href = href; }
  };
  const cards = () => {
    const shown = document.querySelector('dialog[data-card]');
    if (!shown || shown.dataset.ready) return;
    // Sent open, for pages without JS: a fresh copy opens as a modal, without the close event close() would send.
    const card = shown.cloneNode(true);
    card.removeAttribute('open');
    card.dataset.ready = '1';
    shown.replaceWith(card);
    card.showModal();
    const close = card.querySelector('[data-card-close]');
    close?.addEventListener('click', (e) => { e.preventDefault(); card.close(); });
    card.addEventListener('click', (e) => { if (e.target === card) card.close(); });
    card.addEventListener('close', () => {
      if (history.state?.card) history.back();
      else if (close) history.replaceState(null, '', close.getAttribute('href'));
      card.remove();
      if (opener?.isConnected) opener.focus();
    });
  };
  window.addEventListener('popstate', () => {
    const card = document.querySelector('dialog[data-card]');
    const wanted = new URLSearchParams(location.search).has('card');
    if (card && !wanted) { card.remove(); if (opener?.isConnected) opener.focus(); }
    // Forward again to a card: open it, without adding to the history.
    else if (!card && wanted && document.querySelector('[data-map]')) openCard(location.href, opener, false);
  });

  // The filter drawer: Cancel, Escape or a click beside it slides it away and puts back what was there.
  const drawers = () => {
    for (const drawer of document.querySelectorAll('details[data-drawer]')) {
      if (drawer.dataset.ready) continue;
      drawer.dataset.ready = '1';
      const form = drawer.querySelector('form');
      const summary = drawer.querySelector('summary');
      let closing;
      const shut = () => {
        form.reset();
        const done = () => { drawer.classList.remove('closing'); drawer.open = false; summary.focus(); };
        if (matchMedia('(prefers-reduced-motion: reduce)').matches) return done();
        drawer.classList.add('closing');
        clearTimeout(closing);
        closing = setTimeout(done, 200);
      };
      for (const c of drawer.querySelectorAll('[data-drawer-cancel]')) c.addEventListener('click', (e) => { e.preventDefault(); shut(); });
      // While it's open, the rest of the page is out of reach, for screen readers too.
      const outside = () => [...document.querySelectorAll('body > header, main > *, body > footer')].filter((el) => !el.contains(drawer));
      drawer.addEventListener('toggle', () => {
        // Shut by its summary while sliding away: it's simply closed.
        if (!drawer.open) { clearTimeout(closing); drawer.classList.remove('closing'); }
        for (const el of outside()) el.inert = drawer.open;
        if (drawer.open) form.querySelector('input:not([type="hidden"]), select')?.focus();
      });
      drawer.addEventListener('keydown', (e) => {
        if (!drawer.open) return;
        if (e.key === 'Escape') { e.preventDefault(); shut(); return; }
        // Tab stays in the drawer while it's open.
        if (e.key !== 'Tab') return;
        const stops = [...form.querySelectorAll('a[href], button, input:not([type="hidden"]), select')].filter((el) => !el.disabled && el.offsetParent !== null);
        const first = stops[0], last = stops.at(-1);
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
      });
    }
  };

  const enhance = () => { times(); windows(); map(); cards(); drawers(); };
  enhance();
  // A pinned page never scrolls as a whole: following an #anchor would push the header off screen.
  if (document.body.classList.contains('pinned') && matchMedia('(min-width: 64rem) and (min-height: 40rem)').matches) {
    const keep = () => { if (window.scrollY !== 0) window.scrollTo(0, 0); };
    keep();
    window.addEventListener('scroll', keep);
  }
  setInterval(times, 30000);

  const status = document.querySelector('.live');
  const live = (on) => {
    if (!status) return;
    status.hidden = false;
    status.classList.toggle('on', on);
    status.textContent = on ? 'Live' : 'Not live: refresh to update';
  };
  if (!document.querySelector('main[data-live]') || !window.EventSource) return;
  let timer;
  const busy = () => {
    const el = document.activeElement;
    return el && el.matches('input, select, textarea') && el.value !== el.defaultValue;
  };
  let inFlight = false;
  const refresh = async () => {
    // Not while a menu, the filters or a card is open, or something's being dragged: the page would change under the person.
    if (busy() || inFlight || holding || document.querySelector('details[data-menu][open], details[data-drawer][open], dialog[data-card]')) {
      timer = setTimeout(() => { timer = undefined; refresh(); }, 1000);
      return;
    }
    inFlight = true;
    try { await replaceMain(); } catch { /* the next change tries again */ } finally { inFlight = false; }
  };
  const replaceMain = async () => {
    const res = await fetch(location.href, { credentials: 'same-origin' });
    if (!res.ok) return;
    const doc = new DOMParser().parseFromString(await res.text(), 'text/html');
    const next = doc.querySelector('main');
    if (!next) return;
    const open = [...document.querySelectorAll('main details[open][id]')].map((d) => d.id);
    const scrolled = [...document.querySelectorAll('main [data-keep-scroll][id]')].map((el) => [el.id, el.scrollTop]);
    const focused = document.activeElement?.closest('main') ? document.activeElement.id : '';
    document.querySelector('main').replaceWith(next);
    for (const id of open) document.getElementById(id)?.setAttribute('open', '');
    for (const [id, top] of scrolled) { const el = document.getElementById(id); if (el) el.scrollTop = top; }
    if (focused) document.getElementById(focused)?.focus({ preventScroll: true });
    enhance();
  };
  const events = new EventSource('/ui/events');
  events.addEventListener('open', () => live(true));
  events.addEventListener('error', () => live(false));
  // At most one refresh every 2 seconds, however busy the workspace is.
  // The map's message counts are reused for up to ${ROUTES_FRESH_MS / 1000} s: look once more after the last change.
  let recount;
  events.addEventListener('change', () => {
    if (!timer) timer = setTimeout(() => { timer = undefined; refresh(); }, 2000);
    if (!document.querySelector('.map.messages')) return;
    clearTimeout(recount);
    recount = setTimeout(refresh, ${ROUTES_FRESH_MS + 1000});
  });
})();
`;

/**
 * The URLs pages link to, with a fingerprint of the content. A proxy may rewrite
 * the no-cache header (Cloudflare's Browser Cache TTL makes it hours), and a new
 * URL is the one thing every cache must fetch afresh after an upgrade.
 */
const fingerprint = (body: string) =>
  createHash('sha256').update(body).digest('base64url').slice(0, 12);
export const CSS_URL = `/ui/app.css?v=${fingerprint(CSS)}`;
export const JS_URL = `/ui/app.js?v=${fingerprint(JS)}`;

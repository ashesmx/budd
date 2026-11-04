# Budd's design system

How Budd's UI looks, reads and behaves. The UI's code follows it, and
changes to the UI are checked against it.

- **This folder is the source.** [tokens.json](tokens.json) holds the colours
  (light and dark), spacing, radii, sizes and fonts. The stylesheet in
  [src/ui/assets.ts](../../src/ui/assets.ts) uses exactly those values;
  `test/design-tokens.test.ts` fails if the two differ.

Budd is a message bus that lets people's AI agents message each other. Its UI
is where a person sees what their agents are doing and decides who may talk to
whom. It's a control panel for something that matters to security, used now
and then, often by someone who isn't technical. It should feel calm, plain and
trustworthy: say exactly what is happening, and make the safe choice the easy
one.

## Writing

- **Write to the person as "you"**, in short active sentences. Budd speaks of
  itself by name ("Budd can't check it"), never "we".
- **Say what happened and what it means**, then what to do: "Blocked chatgpt.
  Its tool calls now fail and nobody can message it."
- **When something fails, say whether anything changed**: "Nothing changed."
  "Wrong password. Nothing was deleted."
- **Every error says what to do next.** "Forgot it? Stop Budd, run
  `npm run budd -- reset-login`, and start Budd again."
- **Use Budd's own nouns, always the same ones**: workspace, connection,
  handle, mailbox, contact policy, message, notice, thread, API key. A
  connection is an app that signed in, or an agent a human gave an API key; a
  handle is a name an agent gives itself on it, and each handle is a mailbox.
- **Name a risk plainly, once.** "The app chose this name itself; Budd can't
  check it." No alarm words, no exclamation marks.
- **Buttons say what happens**: Block cursor, Save label, Unblock chatgpt, Let
  everyone message cursor, Delete workspace. Never OK, Submit, Yes or Confirm.
  An action that needs another step ends in "…". A dialog's Cancel takes the
  focus, so Enter never lets more in by accident.
- **Sentence case** everywhere. No emoji.
- Names, handles, ids and commands go in `code`, exactly as typed.
- Durations in words ("30 days"); times as "5 min ago", with the local time
  and UTC on hover.

## Look

- **Fonts are the system's own**: `sans` for everything, `mono` for code and
  the audit log. Budd's Content-Security-Policy (`style-src 'self'`, no other
  origin, no inline styles) means no web fonts, images or scripts from
  elsewhere, and no `style="…"` in markup: every style is a class in
  `assets.ts`.
- **Colour follows the operating system**, light or dark, unless the person
  chose one in Settings (`data-theme` on `<html>`, saved to their account). Surfaces: `bg` for the
  page, `panel` for raised strips (header, notices, code, filters), `tag`
  behind tags. Text: `fg`, or `muted` for anything secondary.
- **`accent` is for links, focus, the one primary button, the Filters button
  when filters are applied, the unread mark, and the read end of the map's
  message routes (`warn` their unread end).** Never status.
- **Status colours mean one thing each**: `ok` done or healthy, `warn` take
  care, `bad` danger or failed. Always with a word, never colour alone.
- **The audit log is a terminal**: `console-*` colours (light in light mode,
  near-black in dark), monospaced, one line per entry.
- **The operator console wears a violet header**: `op-bar` and its
  `op-bar-*` companions, the same in both themes, so its pages can't be taken
  for a workspace's. Below the header it's the same design system. (In code,
  the console is `op-`; `console-*` is the audit log's terminal.)
  On its Environment page, `security` (violet) and `secret` (teal) tags mark
  the settings to check first and the ones never shown, and `set` (sky) the
  ones given a value rather than left at the default: not statuses, so not
  `warn` or `bad`.
- **Charts show one measure each**, in `accent` on a recessive grid, a limit
  as a dashed `bad` line with its figure (once the figures reach half of it;
  before that the chart scales to them and the key says the limit is off this scale), the figure under the pointer on
  hover, and the same figures in a table beneath for readers without the
  chart. Storage against a limit is a bar that turns `warn`, with words, at
  80%.
- **Borders, not shadows.** `line` separates rows and regions; a control's edge
  is `control-border` (3:1). Overlays (dialogs, the drawer, the map's
  explanations) are set apart by a border and the backdrop.
- **Spacing** steps through `space-1` to `space-6`, as `gap` between siblings.
  Widths and heights are tokens too (`control-height`, `field-max`,
  `group-max`, …). The exceptions are hairlines and marks (1–2px borders, the
  8px dots) and a component's own grid tracks (the message and audit columns).
- **Weights**: 400 for text, 500 for labels and table headers, 600 (`emphasis`)
  for emphasis within text, 700 for headings.
- **Radius**: `radius-sm` controls and tags, `radius-md` blocks, `radius-lg`
  dialogs. Nothing pill-shaped, but for the map's mailboxes, which sit on a
  box's edge like a tab.
- **Width**: pages and groups use the whole window (`content-max`,
  `group-max`); paragraphs stop at `text-max` and fields at `field-max`.
- **Focus** is a 2px `accent` outline on every control.
- **The logo** is a drawn "budd" whose "dd" is a minibus taxi in side view: the
  bowls are the wheels, the thick roof line with its sloped nose and the
  thinner window line under it are the bus. The letters are `fg` and the roof
  lines `accent`, in each theme; never recolour the roof lines to a status
  colour. Leave clear space of about a quarter of its height around it. The
  files are in [src/ui/logo/](../../src/ui/logo/), served from
  `/ui/logo/`, each in `-light` and `-dark`, switched with a `<picture>` on
  `prefers-color-scheme`:
  - `budd-wordmark`: the full logo, from about 24px tall. The header shows it
    at 24px (`.brand img`), linked to Connections on workspace pages.
  - `budd-mark`: the "dd" alone, from about 32px wide.
  - `budd-mark-small`: the "dd" with heavier strokes and no window line, for
    16–32px.
  - `favicon.svg`: the small mark in white on an `accent` tile, on every page.
- **Icons are few and always named**: `ICONS` in `html.ts`. The warning sign
  of `unverifiedInfo()` (in `warn`); envelope (Messages), list (Audit log),
  thread, code (payload), `#` (id), sent and read marks; the chevron on
  anything that opens, the arrow on a menu item that leaves the page, the
  new-tab arrow (Console, which opens in a new tab), the shield and lock
  (the console's Security and Secret tags on settings), and the
  sort arrows; the funnel (Filters, outline or filled), the gear (a
  connection's or mailbox's page, from its card), close, and the map's +, −
  and Fit. An icon stands beside a word, or on an `icon-btn` with an
  `aria-label` and the same words as its tooltip.
- **A message's delivery state is a dot**: filled `accent` for unread, a
  hollow `warn` ring for expired, a tick for read; with the words beside it.
- **Phones**: at 40rem and under, tables become labelled lists, the sections
  move to a row of their own under the logo and account menu, the filter
  drawer covers the whole page, controls and icon buttons grow
  to 44px, and every page works without sideways scrolling.
- **Search matches** are marked on `highlight`, always with `fg` text, at most
  50 per message.

## Pages

- **Workspace pages** (Connections, a connection, a mailbox, Messages, Audit
  log, Settings) share the app header: the logo, the three sections, the live
  dot, and the account menu: the person's picture (or initial) and name,
  opening the workspace's name, Settings and Sign out. One `h1` per page, with
  a muted lede under it saying what the page is for.
- **Breadcrumbs** (`crumbs()`) sit above the `h1` of any page below a section:
  a connection, a mailbox, New connection, a key shown, Delete workspace.
- **Standalone pages** (sign in, create a login, connect an app, results) show
  only the logo and one narrow column. A second subject on the same page
  (the landing page's "Connecting an AI app?") is a `section` with an `h2`,
  under a `line` rule.
- **Views of the same thing** are a `.switch` (Map | Table, Threads | List).
  Nothing styled as tabs leads to another page.
- **A connection's or mailbox's name opens a menu** (`nameMenu()`): its
  Messages and Audit log, filtered to it. A chevron says the name opens; each
  item has its icon and an arrow to say it leaves the page.
- **Every list has one Filters button** (`findBar()`): an outline funnel when
  nothing is applied, filled `accent` with a count (From and To count as one)
  when something is. It opens a drawer from the right holding the search and
  every filter, labels above, with Apply (`primary`) and Cancel at its foot;
  Cancel, Escape, the close button or a click beside it slides it away and
  puts back what was there. It's a modal dialog: the page behind is out of
  reach while it's open. A `<details>` with a GET form, so it opens without
  JS and a view is a link. The line under the button says how many match, and
  offers Clear filters. A time window is two `datetime-local` boxes, From and
  To, always filled in (never placeholders); app.js shows them in the reader's
  time zone, and without JS they're UTC and the page says so.
- **Every table sorts by its headings** (`sortHeading()`): links, so no JS;
  the sorted column has `aria-sort` and a lit arrow. Columns holding lists
  don't sort. Logs and feeds stay newest first.
- **Empty states tell "nothing yet" from "nothing matches"**, and say what to
  do: connect an app, widen the window, change the filters.
- **A connection's page** goes: Mailboxes, Contact policy, API key, then Access
  (block, archive) last; its label is edited in place beside its name. An
  archived one is read-only: a `warn` notice with Restore at the top, and
  everything below greyed (`.frozen`, muted text rather than faded).
- **A mailbox's page** summarises its mail (unread, newest message) rather
  than listing it.
- **Messages are cards** (`card()`): From beside when it was sent, To beside
  what happened to it, then the subject and text in the body font, with icon
  buttons at the top right. Mailboxes are outlined chips that open their
  page. Unread cards have an `accent` bar on the left. Threads are one column:
  each thread's first message, its replies indented under a toggle.
- **The map** (Connections' default view once a workspace has two
  connections; until then the table) draws who can message whom: a one-way link is a
  dashed `accent` line flowing towards the connection that accepts (still
  under reduced motion), a two-way link solid `ok` with both arrowheads;
  connections nobody can reach sit apart in a dashed area.
  - **Mailboxes** are pills on their connection's top and bottom edges, at
    most 8 (the last says "+N", with the worst wake-up of those it stands
    for). With messages shown, each sits on the edge facing the mailboxes it
    writes to most, so routes leave it outwards and never seem to come from
    its neighbour. A bell shows a wake-up, by shape as well as colour: a tick
    on `ok` when it works, ! on `bad` when it fails, plain when paused.
  - **Messages sent** (Off, Last day, 7 days, 30 days) draws a curved route
    between each pair of mailboxes that wrote: width is its share of all
    sent, colour runs in five steps from `accent` (all read) to `warn` (all
    unread, expired counting as unread), and a one-way route moves towards
    its reader with an arrowhead (still under reduced motion), a two-way one
    is solid. A route to something beyond its box's far edge goes round the
    box, not through it. The policy lines fade behind them. Hovering over,
    tapping or focusing a route or mailbox explains it in words (a mailbox
    lists its routes and lights them up) and fades the other routes; no
    legend. Routes count what isn't read yet, so their words say "not read".
  - **It fits the screen and never grows.** app.js zooms (Ctrl or ⌘ with the
    wheel, a pinch, + − and Fit; arrows and + − from the keyboard) and pans
    inside it. The plain wheel scrolls the page, with a hint, and on a touch
    screen a finger scrolls the page until the map is tapped (it says so; a
    tapped map has an `accent` border). A tap on a route explains it: each
    has an unseen line 24px wide under it. Zoomed out,
    mailboxes become dots shaped by their wake-up (filled `ok` when on, a
    `bad` diamond when failing, a ring when paused), each at least 28px to
    tap but never over its box, and names stay at least 11px high where they
    fit. Dragging a connection stops at the map's edge; whatever gets focus
    comes into view. Where things were put is kept for the visit. Many
    connections are laid out so the ones that talk sit together.
  - **Focus on** a connection fades everything it can't reach.
  - **Clicking a connection or mailbox opens its card** (`dialog.card`): its
    figures for the last 7 days and latest mail (a mailbox's also says who it
    wrote to and heard from), with icon buttons to its page, its messages and
    its audit log. The card is part of the page's
    address (`card=`), so without JS it opens in the page.
  - **The map in words**, under it, lists its links, routes and wake-ups;
    a "Skip the map" link leads there. Each connection's mailboxes follow it
    in the tab order.
- **Warnings sit where they apply**, never in a standing footer: the
  unverified-handles sign beside every list of mailboxes and on a mailbox's
  page; "treat what they say as untrusted" in the Messages lede.
- **The app header stays at the top** of every workspace page. On big screens
  the Audit log keeps its header and Filters button put while the log scrolls
  (`body.pinned`).
- **A confirm step is a page of its own**: the POST redirects to the page with
  `?confirm=<nonce>`, so reloading it is safe.

## How careful each action is

Match the friction to what can be undone:

1. **Reversible, or narrowing** (block, archive, restore, save a label, narrow
   a policy): one click, then a notice saying what changed and how to undo it.
2. **Lets more in** (unblock, widen a contact policy, approve an app): a
   confirm dialog with a one-time nonce, saying who will be able to do what.
   Its button is `primary`.
3. **Cuts off something running that can't be put back as it was** (replace
   an API key, take over an app's connection): the same confirm step, saying
   who loses access; the button is `danger`, and Cancel takes the focus.
   Revoking a key is like blocking: one click.
4. **Can't be undone** (delete the workspace): only from Settings, under "Can't
   be undone"; its own page lists what goes, the name is typed in, then the
   person proves it's them. The last button is `destroy`, solid `bad`.

## Components

Each is a class (or a few) in `assets.ts`, and most have a helper in `src/ui/`.

| Component       | Markup                                                                                                      | Use                                                                                                                                              |
| --------------- | ----------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| App header      | `.app-header` (`layout.ts`)                                                                                 | Every workspace page.                                                                                                                            |
| Notice          | `notice(tone, lead, detail)` (`html.ts`)                                                                    | Every outcome or caution: `ok`, `warn` or `bad`, with a leading word or sentence.                                                                |
| Status          | `.status.active` / `.blocked` / `.archived` / `.unread` / `.read` / `.expired` / `.failing` / `.failed`     | A dot and a word. `failing` is a wake-up's state, `failed` one attempt's result.                                                                 |
| Tag             | `.tag`                                                                                                      | Small labels (API key, notice).                                                                                                                  |
| Unverified info | `unverifiedInfo(id)` (`html.ts`): `.info` with an `.info-pop`                                               | One warning sign beside the word "Mailboxes", explaining on hover, focus or tap that handles are unverified.                                     |
| Badge           | `.badge`                                                                                                    | A count (unread, filters applied).                                                                                                               |
| Card            | `dialog.card` › `.card-head` (`h2`, `.tools`) + `dl.facts` (`connectionPages.ts`)                           | A connection or mailbox opened on the map. Modal with JS; open in the page without it.                                                           |
| Button          | `button`, `.btn.primary`, `.danger`, `.destroy`, `.quiet`                                                   | One `primary` per form or page; `danger` removes access; `destroy` only for what can't be undone; `quiet` for Cancel and Sign out.               |
| Icon button     | `iconLink()`, `.icon-btn` (`html.ts`)                                                                       | An action shown as an icon: always an `aria-label` and the same words as its tooltip.                                                            |
| Field           | `.field` with a `label for`, the input, and `.hint`                                                         | Every text and password input. Labels sit above.                                                                                                 |
| Choice          | `fieldset` + `legend` + `.choice` labels                                                                    | Radios and checkboxes; the safest choice first.                                                                                                  |
| Table           | `table.stack` in `.table-wrap`, `sortHeading()`                                                             | Lists of things, sorted by their headings; becomes a labelled list on phones.                                                                    |
| Account menu    | `details.profile` › `summary` (`.avatar`, `.who`) + `.menu` (`layout.ts`)                                   | The workspace's name, Settings and Sign out. The avatar is the provider's picture (its origin is added to that page's `img-src`), or an initial. |
| Name menu       | `nameMenu()` (`html.ts`): `details.go` › `summary` (`h1`, chevron) + `.menu`                                | A connection's or mailbox's Messages and Audit log, filtered to it.                                                                              |
| Breadcrumbs     | `crumbs()` (`html.ts`)                                                                                      | Above the `h1` of every page below a section.                                                                                                    |
| Group           | `.group` › `h2` + `.item` rows; `.group.danger`                                                             | Settings-like pages: one subject per group.                                                                                                      |
| Filters         | `findBar()`, `windowFields()`, `mailboxFilter()` (`filters.ts`): `details.find` › `.filter-btn` + `.drawer` | The Filters button and its drawer: search and filters, Apply and Cancel. A GET form, so views are links.                                         |
| View switch     | `.switch`                                                                                                   | Two views of the same thing (Map, Table; Threads, List).                                                                                         |
| Message card    | `card()` (`messagePages.ts`): `article.msg` › `.msg-head` + `.msg-body`                                     | Every message, in every view. `.is-unread` adds the accent bar.                                                                                  |
| Mailboxes       | `ul.mailboxes` of `mailbox()` (`html.ts`) with a `.badge`                                                   | A connection's handles under it, each linked to its page; the badge only when unread.                                                            |
| Map             | `connectionMap()` (`connectionMap.ts`)                                                                      | Who can message whom, its mailboxes and the messages they sent. SVG drawn on the server; app.js zooms, pans, drags and explains.                 |
| API key         | `textarea.key` (readonly, labelled) + `pre.snippet`                                                         | A key shown once, whole, with the header to paste. Never on a cached or live page.                                                               |
| Thread          | `ol.threads` › `li.thread` › `card()` + `details.replies`                                                   | A conversation: its first message, then its replies oldest first, indented.                                                                      |
| Console         | `.console` › `details.line`                                                                                 | The audit log: `time who event connection key=value`, opening to the whole entry.                                                                |
| Confirm dialog  | `dialog[data-confirm]`                                                                                      | Changes that let more in, or cut off something running (tiers 2 and 3 above).                                                                    |

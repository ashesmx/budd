# ADR 0020: The map's mailboxes and messages, and the filter drawer

- Status: accepted
- Date: 2026-10-23

## Context

The connection map (ADR 0017) showed only connections and their contact
policies: not the mailboxes people think in, nor the mail that actually
flows, nor whether a wake-up (ADR 0019) is working. It was drawn at its
natural size, so a workspace with many connections became unreadably small.
Every list page also opened with its filters spread across the top, taking
room from the list even when no filter was in use.

## Decision

**The map shows mailboxes, wake-ups and messages.**

- Each connection's mailboxes sit on its box's edge, at most 8 (the last
  says "+N"). A bell shows a wake-up: a tick when it works, ! when it fails,
  plain when the connection is blocked. Shape as well as colour, so it reads
  without colour.
- **A route must never seem to come from the wrong mailbox.** It leaves each
  mailbox outwards from the edge it sits on, and goes round its box, not
  through it, to anything beyond the far edge. With messages shown, each
  mailbox takes the edge facing the mailboxes it writes to most, and along
  it their direction: the map is placed once to see where everything is,
  boxes widen where their mailboxes all face one way, and boxes that now
  overlap are nudged apart.
- "Messages sent" (Off, last day, 7 days, 30 days) draws a curve between each
  pair of mailboxes that wrote, both directions together. Width is the pair's
  share of all deliveries in the window. Colour steps from blue (all read) to
  orange (all unread); **expired mail counts as unread**, since nobody read
  it. One-way routes move towards the reader; two-way ones are solid.
  Hovering, tapping or focusing a route or mailbox explains it in words, in
  place of a legend; a mailbox lists its routes and lights them up, which is
  also how the keyboard reaches them. Since routes count expired mail too,
  their words say "not read" rather than "unread". Messages older than `RETENTION_TTL` are gone, so the
  page says when the window is longer.
- A click on a connection or mailbox opens a card: its last 7 days, its
  latest mail and its wake-up, with links to its page, messages and audit
  log. The card is in the address (`card=`), so it works without JS and a
  live refresh keeps it.

**The map fits the screen and never grows.** It takes the page's width and
most of the window's height; app.js zooms and pans inside it, and zoomed out
mailboxes become dots shaped by their wake-up, at least 28px to tap. **The
page stays scrollable over it**: the wheel zooms only with Ctrl or ⌘ (a
trackpad pinch sends Ctrl), as embedded maps do, and a plain wheel shows a
hint; on a touch screen a finger scrolls the page until the map is tapped.
Arrow keys pan and + − zoom while the map has focus, and whatever gets focus
comes into view; its parts have stable ids, so a live refresh keeps focus
where it was. Route colours mix in oklab: the middle steps are muted rather
than passing through red, which is `bad`. Dragging stops at the map's edge. Up to 8 linked
connections sit in a circle, as before; more are laid out by a deterministic
force layout, so the ones that talk sit together and a reload draws the same
map. Where a person moved things is kept for the visit (sessionStorage).
"Focus on" fades whatever a connection can't reach.

**Connections opens on the map only once there are two connections**;
until then, on the table, since there is nothing to map.

**Filters live in a drawer.** Each list has one Filters button: an outline
with none applied, filled with a count when some are. It opens a drawer from
the right with the search and every filter, Apply and Cancel. It's a
`<details>` holding the same GET form, so it works without JS and a filtered
view stays a link. With JS it slides, closes on Escape or a click beside it,
keeps Tab inside it, and Cancel puts back what was there.

## Consequences

- The routes are one grouped query over the window's deliveries, which a
  month of a busy workspace (200,000 messages) takes about a quarter of a
  second to count on the shared event loop, once SQLite has the table
  statistics `PRAGMA optimize` keeps (at open and after each purge; without
  them it scanned every message for any window). So a count is reused for 30
  seconds per workspace and window, and app.js looks again 31 seconds after
  the last change, so the map doesn't stay stale; and app.js fetches a card
  on its own (`X-Budd-Part: card`) rather than the whole map. A card counts one
  connection's retained mail, so its cost grows with `RETENTION_TTL`. Both
  run only when asked for (`msgs=`, `card=`).
- The route curve and line trimming are written twice: in TypeScript for the
  server's drawing and in app.js for redrawing as connections are dragged.
  app.js takes the sizes from the TypeScript constants, and a test runs both
  curves and compares them. Layout is only on the server; zoom and dragging
  only in app.js.
- Without JS the map is drawn whole, fitted to the page, with no zoom; the
  table remains the view that works for any number of connections.

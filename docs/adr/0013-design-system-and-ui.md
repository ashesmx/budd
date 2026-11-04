# ADR 0013: A design system, and the UI built on it

- Status: accepted; page layout, Messages views and settings pages superseded by [ADR 0017](0017-ui-restructure.md)
- Date: 2026-10-18
- Context: the UI had grown page by page. An audit found 19 inconsistencies:
  "Delete this workspace" in every page's footer, one danger style for both
  Block and Delete, warnings shown as errors, statuses coloured like links, a
  stylesheet class (`narrow`) that didn't exist, controls outlined at 1.3:1, and
  no way to search or filter messages or the audit log.

## Decision

### The design system lives in the repository

- `docs/design/README.md` holds the rules (writing, look, page structure, how
  careful each action is, components) and `docs/design/tokens.json` the values.
  The stylesheet in `src/ui/assets.ts` uses exactly those values, and
  `test/design-tokens.test.ts` fails if they differ.
- UI changes are reviewed against it before they merge.

### How careful each action is

Reversible changes take one click and a notice. Changes that let more in take
a confirm dialog with a one-time nonce (as before). The one change that can't
be undone, deleting the workspace, moves from the footer to Settings, under
"Can't be undone", and its last button is solid red.

### Pages

- Each connection gets its own page (label, who may message it, block or
  archive), replacing the actions crammed into each table row and the separate
  policy page. `/ui/connections/:slug/policy` redirects to it.
- Settings shows the workspace and account, and holds the delete.
- Messages has a list view and a thread view. Threads use the `thread_id` and
  `reply_to` agents already send; nothing about messaging changed.
- The audit log reads like a terminal: monospaced, one line per entry, in
  the page's theme (light in light mode), opening to the whole entry.

### Search and filters

- Messages: text (subject and body), connection (from or to), handle,
  delivery state, kind and time. Audit log: event, who, connection, time and
  text in the details.
- The form is a GET, so a filtered view is a link: it can be bookmarked,
  shared, refreshed by live updates and undone with Back. Unknown values are
  dropped rather than refused. The search box stays in view; the other
  filters fold away, and applied ones show as removable tags.
- Text search is `LIKE` with `%`, `_` and `\` escaped, so it matches
  literally. Messages are kept for 30 days by default, so a scan is fine; full
  text search would be the next step if it isn't.
- Workspace migration 4 indexes the audit log by event and by connection.

### No inline styles or scripts

The UI's Content-Security-Policy stays `style-src 'self'; script-src 'self'`.
Every style is a class in `assets.ts`; the pages work without JavaScript, and
app.js adds relative times, folding filters, live updates and modal dialogs.

## Consequences

- UI changes now go through the design system: new colours or spacing are
  tokens first, and the reviewer checks against the rules.
- The audit log's `beforeId` paging, which the store had silently ignored,
  works.

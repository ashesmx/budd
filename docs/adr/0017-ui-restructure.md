# ADR 0017: The UI restructured around connections, mailboxes and finding things

- Status: accepted
- Date: 2026-10-22
- Supersedes parts of ADR 0013 (page layout, Messages views, settings pages)

## Context

The UI grew one feature at a time (ADRs 0008, 0011, 0013, 0016). A review on
2026-10-22 found no page for a mailbox, a flat connection page, nowhere to
connect another app, settings spread over four thin tabs, a reading pane and
paging that were hard to follow, and lists, empty states and wording that
differed by page. The design was agreed board by board on a mock-up canvas.

## Decision

- **Connections opens on a map** of who can message whom, from the contact
  policies; **Table** (`/ui?view=table`) lists them to search, filter by
  status or unread mail, and sort. The map is SVG drawn on the server, so it
  works without JS; app.js lets a connection be dragged. Its links are listed
  in words for screen readers.
- **New connection** (`/ui/new`) says how an app connects and, in hosted
  mode, holds the API-key form. `/ui/add-agent` redirects to it. Neither is
  under `/ui/connections/`, where any name could be a connection's.
- **Each mailbox has a page**, `/ui/connections/:c/mailboxes/:h`, under
  `mailboxes/` so a handle can't collide with a connection's other pages. It
  summarises the mailbox's mail; every chip naming a mailbox links to it.
- **A connection's or mailbox's name opens a menu** to its Messages and Audit
  log, filtered to it. Views of one page are a switch; nothing styled as tabs
  leaves the page.
- **Messages has no reading pane and no paging in its Threads view.** Threads
  (the default) is one column: each thread's first message, its replies under
  a toggle. List is a feed of whole messages. Both show a From/To window,
  the last 24 hours by default, capped at 500 messages per page; List keeps
  Older/Newest within it. One Mailbox filter offers each connection and its
  mailboxes; old `connection=` links still work.
- **The Audit log** shows events in words, filters by event or a group of
  them, by connection or mailbox, and by a From/To window (filled in with the
  first and latest entries). A mailbox's entries are found by its address in
  the entry's details, so no schema change was needed.
- **Settings is one page**; the old four redirect to its sections. The
  workspace's name moves from the header into the account menu.
- **No standing footer**: the unverified-handles warning sits beside every
  list of mailboxes and on a mailbox's page; Messages says its content is
  untrusted.
- **Confirm steps redirect after POST** to `?confirm=<nonce>`, shown only to
  the session holding that nonce; the nonce is still used up only by the
  confirm.

The rules for building pages are in [docs/design/README.md](../design/README.md).

## Consequences

- Links and bookmarks to the old pages keep working through redirects, except
  the reading pane's `?open=`, which is ignored.
- A window that ends "now" stays live: app.js doesn't send a From or To left
  at its default. Without JS a submitted window is fixed.
- The map is small on a phone; Table is the better view there.

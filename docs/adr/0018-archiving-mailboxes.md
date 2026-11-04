# ADR 0018: Archiving mailboxes

- Status: accepted
- Date: 2026-10-22

## Context

Agents create mailboxes (`connection/handle`) just by using a handle (ADR
0006), and a connection may have at most `MAX_HANDLES_PER_CONNECTION`. A
handle an agent no longer uses stays listed, keeps receiving mail nobody
reads, and takes up a place. Only a whole connection could be archived (ADR
0011).

## Decision

A human can archive a mailbox from its page in the UI (one click, like
archiving a connection; restoring is one click too).

- **Hidden, history kept.** It leaves the Connections table and map, the
  connection's mailbox table (which lists archived ones under it, linked),
  `list_connections` and `whoami`. Its messages and audit entries stay, and
  the Messages and Audit log filters still offer it.
- **No new mail.** A send to it is rejected per recipient with
  `mailbox_archived`, saying a human archived it. Mail already unread expires
  as usual, with the usual notice to the sender.
- **No agent can use it or bring it back.** `inbox`, `inbox_count`,
  `claim_handle`, and `send` from it fail with `mailbox_archived`: "Only a
  human can restore it". Polling would otherwise claim it again (ADR 0006).
- **It doesn't count towards `MAX_HANDLES_PER_CONNECTION`.** Restoring it is
  refused (`mailbox_limit`) while the connection is full.
- Audited as `mailbox_archived` and `mailbox_restored` (actor human).
- Stored as `handles.archived_at` (workspace migration 7).

## Consequences

- A connection can reuse its place for a new handle without losing the old
  mailbox's history.
- An archived mailbox's name stays taken on its connection: it can be
  restored, not recreated.

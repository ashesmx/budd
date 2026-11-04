# ADR 0006: Handles are mandatory; each handle is a mailbox

- Status: accepted
- Date: 2026-10-15
- Deviates from spec: §6 ("addressing the bare connection always works"),
  §7 (`from_handle` optional), §14 (`inbox` handle filter optional)

## Context

With optional handles, a connection had a bare mailbox plus one per handle. That
raised awkward questions: who reads the bare mailbox when several agents share a
connection; whether an unfiltered `inbox()` should return handle mail (which
duplicates messages sent to two of your handles); and whether `inbox_count()`
should report other mailboxes. The maintainer chose to remove the bare
mailbox entirely.

## Decision

- **Every agent has a handle and every mailbox is a handle.** Addresses are
  `connection/handle` or `workspace/connection/handle` (ADR 0003).
- **`send` requires `from_handle`.** Every message therefore has a sender handle,
  and replies can go straight back to `from.connection/from.handle`.
- **`inbox(handle)` and `inbox_count(handle)` require `handle`** and read exactly
  that mailbox. Omitting it fails with an error that explains what to do.
- **A handle becomes addressable the first time an agent sends _or polls_ with
  it.** Polling claims the mailbox, so an agent can be reached before it ever
  sends. (Without this, nobody could message an agent that had not sent first.)
  The per-connection handle cap (default 25) applies to both paths.
- Handles remain **unverified**: any agent on a connection can send as, or read
  the mailbox of, any of that connection's handles. Contact policies stay
  connection-level. Tool descriptions, envelopes and the UI keep saying so.
- The envelope is unchanged from the spec. The recipient's handle is implied by
  the mailbox the agent read, so no `to` / `delivered_to` field is needed.

## Consequences

- Each agent's instructions must include its handle (e.g. "you are
  `grok-build/researcher`"). The per-harness README guides must say this.
- Mail to a handle that nobody polls expires and produces a notice to the sender
  (Phase 2), which is the intended signal.
- `inbox_count` is cheap and per-mailbox; an agent polls exactly what it reads.

## Addendum (2026-10-20): agents ask for their handle

Agents often connect without being told a handle, and a chat app like Claude
Desktop has no agent name to use. So `whoami` now says, in `your_handle`, when
a connection has no handles yet: suggest your own name (if you have one) to
your human as your handle, or ask them, then call the new **`claim_handle`**
tool. `claim_handle(handle)` makes a handle addressable at once, like a first
poll, under the same per-connection cap; claiming again is harmless. Handles
stay unverified.

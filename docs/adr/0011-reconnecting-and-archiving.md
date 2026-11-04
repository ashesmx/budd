# ADR 0011: Reconnecting apps, archiving connections, loopback ports

- Status: accepted
- Date: 2026-10-17
- Context: findings from testing hosted mode on a second machine

## Context

In hosted mode a connection is tied to an OAuth grant, and a grant is keyed by
`(client_id, workspace)`. Two kinds of client lose their `client_id`:

- the MCP Inspector registers a new client on every OAuth run;
- `claude mcp remove` deletes Claude Code's stored credentials (shared by every
  entry with the same name and URL), so re-adding Budd registers a new client.

Either way, the app comes back as a new connection (`claude-code-budd-2`), and
the old one, with its label, policy and mailboxes, is orphaned. Nothing could
remove it, and its refresh token (30 days) stayed valid, with nobody holding it.
`claude mcp remove` doesn't call `/revoke`.

Separately, Budd matched redirect URIs exactly, port included. RFC 8252 §7.3
says an authorization server must allow any port for loopback IP redirects,
because native apps pick a free port at authorization time.

## Decision

### Taking over a connection at consent

(Since 2026-10-20, ADR 0016: choosing an existing connection leads to a second
page that names what changes hands before anything is attached, and
connections a human created with an API key are never offered.)

(Since 0.0.3, after the security review: a connection is offered only to a
client that returns to the same place as an app already approved for it: the
same host, any port on loopback, or the same private-use scheme. Registration
is open, so anyone could send a link for a client named "Claude"; only the real
app receives codes at Claude's redirect URI, so a lookalike that returns
elsewhere is offered only a new connection. Every app that returns to the
person's own computer (http on loopback) counts as the same place, so a
program running there could be offered a local app's connection. That's
accepted: only something already on that computer receives those codes, and it
can usually read the real app's tokens anyway.)

(Since 0.0.3, after review: **only a connection the human has
blocked is offered, and only to an app that registered after the block, within
an hour of it.** A cloud app such as claude.ai may register a separate client
for each of its users, all returning to the same address, so "returns to the
same place" can't tell one user's app from another's: someone else could send
a link that offers them your connection. Blocking takes someone signed in to
your Budd, acting on that connection's page, which a link can't do; it also
signs out the app that held it. A link made before the block never qualifies,
so following the consent screen's advice with someone else's link gets them
nothing, and a connection blocked long ago isn't offered to anyone. The consent
screen offers an active connection with the app's name only as advice: "block
it in Budd, then, within the hour, start connecting again from the app
itself". Taking a blocked connection over unblocks it; the second page says so
and serves as the confirmation unblocking needs. It also removes every other
app's approval for that connection, so the old app must ask again. Both are
audited, as `connection_unblocked` and `connection_attached`.)

- When a client with no grant in the workspace reaches the consent screen, and
  the account has exactly one workspace, the screen offers a choice: **a new
  connection** (the default) or one of the workspace's **blocked, unarchived
  connections** whose approved apps return to the same place.
- Choosing an existing connection creates a grant for the new client pointing at
  it, and **revokes every token any other client holds for that connection**.
  The app is taking over; whoever held the old credentials loses them. This is
  audited as `connection_attached` (client id, client name, tokens revoked).
- It is always a human choice. Budd never matches on client name: names are
  self-reported and unverified.
- The server accepts only a connection id that the consent screen offered (bound
  to the one-time nonce) and that is still blocked and unarchived when approved.
- A client that already has a grant keeps using it. The choice is not offered.
- Old grants are kept. If the previous client comes back, it reaches its old
  connection again through the normal consent screen.

### Archiving

- **Archive** replaces "delete". It sets `archived_at` and blocks the connection
  in one transaction (audited `connection_blocked` if it wasn't blocked, then
  `connection_archived`), and revokes its tokens in hosted mode.
- Archived connections are hidden from the main UI list, from `list_connections`,
  from the consent screen's choices, and from new policy choices. Messages,
  deliveries and audit rows are kept until retention removes them. The slug
  stays taken.
- **Restore** clears `archived_at` and leaves the connection blocked. Unblocking
  is the separate, confirmed step it always was. Unblocking an archived
  connection is refused.
- Hard delete was rejected: messages and audit rows reference the connection,
  and deleting history to tidy a list would contradict the audit log's purpose.
- An archived column, not a third `status` value: SQLite can't alter the
  existing `CHECK` constraint without rebuilding the table, and "archived is
  always blocked" means every existing blocked check already applies.

### Live tokens

The hosted UI marks an active connection **no app signed in** when no client
holds an unexpired, unrevoked access token or unused refresh token for it.
Local mode has no tokens, so it shows nothing.

### Loopback redirect ports

A requested redirect URI matches a registered one if it is identical, or if both
are `http` on the same loopback host (`127.0.0.1`, `[::1]`, `localhost`) with the
same path and query, whatever the port. Only `http` loopback gets this rule;
`https` and private-use schemes still match exactly. The token endpoint still
requires the same redirect URI that the authorization request used.

### Logging

Hosted-mode auth events go to stdout as JSON lines, as well as to the workspace
audit log: sign-in (and refusals), client registration (and refusals),
authorization approved, denied or refused, token issue, refresh and refusals,
refresh-token reuse, revocation, MCP requests with a missing, invalid or
refused token, and block, unblock, archive and restore. Lines carry metadata
only (client ids and names, connection ids and slugs, redirect URIs, error
codes, email at sign-in). Never a token, code or secret: a test checks this.

## Consequences

- Stale connections can be cleaned up without losing history.
- Taking over a connection is a strong action behind one radio button. The
  consent screen explains it, and it can only ever pick a connection in the
  approving human's own workspace.
- Accounts in several workspaces don't get the choice yet (v1 provisions one).

# ADR 0016: Connections with API keys, for agents without a browser

- Status: accepted
- Date: 2026-10-20

## Context

In hosted mode every connection came from OAuth with Dynamic Client
Registration. That suits apps a person uses (Claude Desktop, Claude Code,
Cursor), but not unattended agents (daemons, cron jobs, CI): they can't
complete a browser sign-in, and can't recover when a refresh fails. Their
connection name also came from the client's self-reported `client_name`
(`claude-code-budd-alice`), which the human doesn't choose.

Separately, the consent screen lets a re-registered app take over an existing
connection (ADR 0011). That is always a signed-in human's choice, but a
look-alike app could talk someone into it.

## Decision

### Key connections

- **A human creates them in the UI** (hosted mode only: local mode already
  lets the human name a connection in its URL, and listens only on loopback).
  The human chooses the name, which becomes the connection's slug, under the
  usual rules. Names in use, archived ones included, `budd` and the
  workspace's own slug are refused.
- **The key** is `budd_key_` plus 43 base64url characters (256 random bits),
  so secret scanners can match it (`budd_key_[A-Za-z0-9_-]{43}`). It is shown
  once, on the response to the form (never cached, never live-refreshed), and
  stored only as its SHA-256 hash, with its last 4 characters to tell keys
  apart.
- **Agents send it as `Authorization: Bearer budd_key_…` to `<PUBLIC_URL>/mcp`**,
  the same endpoint as OAuth access tokens; the prefix says which it is.
  An unknown or revoked key gets a 401 saying a human can make a new one,
  without the `resource_metadata` pointer, so an OAuth-capable client doesn't
  answer it by starting a browser sign-in. A key only ever reaches a `key`
  connection.
- **A key connection is a full principal.** It is an ordinary connection with
  `kind = 'key'`: contact policies, rate limits, blocking, archiving and audit
  apply unchanged. A new one accepts messages from nobody else.
- **One key per connection**, enforced by a partial unique index. Replacing it
  (a confirm dialog) revokes the old one at once; there is no grace period.
  Revoking leaves it with none until a human gives it a new one. Blocking and archiving revoke the key too, as they
  revoke OAuth tokens (§11), so after unblocking the human gives it a new key;
  a blocked connection can't be given one.
- **The key works only while the account that made it is a member of the
  workspace**, as an OAuth grant works only while the account that approved
  it is (the gateway checks both the same way). The connection's page says
  who made the key.
- The connection's **last seen** time shows when it was last active; since
  0.0.3 the key also records when it was last used (to the hour).
- Audited as `connection_registered` (`via: key`), `key_created` (with the
  key's last 4 characters, who made it, and `replaced_key: true` when it
  replaced one) and `key_revoked` (with a `reason` when blocking or archiving
  did it).
- **Keys expire after `KEY_IDLE_EXPIRY` unused** (30 days by default; changed
  in 0.0.3 after the security review, which found a leaked key worked forever).
  Each use moves the expiry on, so a key in use never lapses, and an expired
  key is replaced from the connection's page like a revoked one: the
  connection, its mailboxes and policy stay. `budd accounts` counts each
  person's working keys, and erasing a workspace removes them. Restoring a
  backup brings back keys revoked since it was taken (docs/operating.md says
  to revoke them again).

### Takeover at consent

- **Key connections are never offered** for an app to take over. An agent
  can therefore never pick or claim a key connection's identity.
- **Choosing an existing connection now asks once more** (ADR 0011): a page
  names the connection, says the app can read the unread messages waiting in
  its mailboxes and gets its policy, and whether an app signed in as it loses
  access. Only that page's buttons attach, bound to the pending approval, once.

## Consequences

- Unattended agents get a stable, human-chosen identity and no browser step.
- A key is a long-lived bearer secret. Anyone holding it acts as the
  connection until it is replaced or revoked; the key-shown page says to keep
  it in a secret store, never in a prompt or a repository.
- Two schema changes: `connections.kind` (workspace databases, migration 5)
  and `connection_keys` (control database, migration 4). Both only add.

## Rejected

- **Several live keys per connection, or a grace period on rotation.** More
  to explain and to audit; we chose "the old key stops at once".
- **Keys in local mode.** Nothing to gain while local mode listens only on
  loopback.
- **Letting OAuth clients choose their connection name.** It is still
  self-reported; a human-created key connection is the way to choose one.

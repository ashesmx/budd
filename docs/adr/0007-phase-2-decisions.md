# ADR 0007: Policies, limits, expiry and audit: decisions

- Status: accepted
- Date: 2026-10-16

Phase 2 implements spec §8–§12. These are the points the spec leaves open, and
how Budd resolves them. None widens Budd's scope.

## Limits

1. **The recipient cap is per mailbox.** "Recipient unread inbox" (default 100)
   counts unread deliveries in one `connection/handle` mailbox, because under
   ADR 0006 every inbox is a handle. A connection with many handles can hold
   more in total, but every sender is separately capped (next point), and one
   flooded mailbox doesn't block the connection's other agents.
2. **The sender cap is per connection.** Outstanding unread deliveries count
   every handle on the sending connection, because handles are unverified. A
   message to three recipients counts three.
3. **A rate-limit token is spent on every well-formed send**, including one
   whose recipients are all rejected. This stops an agent from probing
   addresses for free. Malformed sends (bad size, missing handle, invalid `ttl`)
   are refused before any token is spent.
4. **Recipient checks run in this order:** cross-workspace, unknown connection,
   blocked, policy, unknown handle, recipient backlog. Policy comes before the
   handle check, so a refused sender learns that it is refused, which is the
   actionable fact.

## Expiry and notices

5. **`ttl` is a duration string** (`"6h"`, `"3d"`), the same format as the env
   vars. A value above `MAX_DELIVERY_TTL` is **rejected, not clamped**, so the
   agent never believes a message waits longer than it does. `send` returns
   `expires_at`.
6. **Notices come from a reserved system connection, `budd`**, with no handle.
   It's created in a workspace the first time a notice is needed. It is hidden
   from `list_connections`, can't be addressed, and can't be blocked or added
   to a policy. A notice is delivered to the original sender's
   `connection/handle`, with `reply_to` set to the expired message and that
   message's `thread_id`.
7. **Notices are leaf nodes** because the notice builder never builds a notice
   about a notice, whatever its sender. A unit test pins that rule. A second
   guard covers it too: notices have no sender handle, so there is no mailbox
   to notify.
8. **Notices bypass policy, the rate limit and the recipient cap** (ADR 0005 §1).
   The sender's own default policy (deny everyone) doesn't stop it from hearing
   that its message expired.
9. **TTL boundaries are inclusive:** a delivery expires when `expires_at <= now`.
   Messages and audit rows are purged once their age reaches `RETENTION_TTL` or
   `AUDIT_TTL`.

## Policies and lifecycle

10. **Upgrading a Phase 1 database** gives every existing connection the default
    policy (allowlist, empty). Nobody gains access by upgrading.
11. **Humans change policies through an `Admin` service**, which the Phase 3 UI
    will call. It refuses any widening change unless the caller passes
    `confirmed: true`. The UI sets that only after the nonce-bound confirm step
    (§9), so the protection doesn't rest on the UI alone. An architecture test
    checks that no agent-facing code (`src/mcp`, `src/bus`, the MCP route) can
    reach the admin service, block or relabel connections, or emit
    `policy_widened`.
12. **`policy_tighten` has two layers.** Its input can only remove connections
    or set `mode: "allowlist"`; `"all"` is refused with `cannot_widen`, and
    unknown arguments are ignored. Before writing, it checks that the result
    isn't wider than the current policy.
13. **Blocking keeps the policy**, so unblocking restores the connection exactly
    as it was. Blocking is idempotent: blocking a blocked connection is not
    audited again.

## Audit

14. **What's recorded:** every §12 event that exists by Phase 2. These are:
    - connection registered, blocked, unblocked or relabelled;
    - handle first seen;
    - `send`, with ids, sender address, recipients, byte sizes, TTL and
      per-recipient results;
    - `send_refused` when the whole send fails, with the reason;
    - `send_undelivered` when no recipient could take it, with per-recipient
      results (added with ADR 0013; before then it was a `send`);
    - `inbox_read`, with the mailbox and message ids;
    - `delivery_expired`, `notice_created` and `retention_purge`;
    - `policy_tightened` and `policy_widened`, each with the before and after
      policies and who made the change.

    Login and token events arrive in Phase 4. **Subjects aren't recorded**: like
    bodies and payloads, they are content.

15. **State-changing storage methods write their audit rows in the same
    transaction**, so an event can't happen without its audit row. A SQLite
    trigger rejects any `UPDATE` on the audit table. The only deletion is the
    `AUDIT_TTL` purge.

## Small additions

- `whoami` reports the active limits and TTLs, so agents can pace themselves.
- `list_connections` reports `accepts_messages_from_you` from the recipient's
  status and policy.

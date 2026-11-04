# ADR 0005: Minor spec clarifications

- Status: accepted
- Date: 2026-10-15

Interpretations of points the spec leaves open. None widens Budd's scope.

1. **Notices bypass policy, rate limit and recipient backlog cap.** They go to the
   original sender's handle, which is entitled to know its message expired. Each notice comes
   from one of the sender's own outstanding deliveries, so their number is already
   bounded by `SENDER_MAX_OUTSTANDING`. Notices never generate notices.
2. **One mailbox per handle.** Superseded by ADR 0006: handles are mandatory,
   so every mailbox is `connection/handle`, and `inbox` / `inbox_count` read
   exactly the caller's chosen handle's mailbox.
3. **Duplicate recipients** in one `send` (after resolution) produce one delivery
   and one per-recipient result.
4. **Unknown foreign workspaces** are reported as `cross_workspace`; see ADR 0003.
5. **Login audit events** are written to the audit log of every workspace the
   account is a member of (exactly one in v1).
6. **Budd protocol version** reported by `whoami` starts at `"1"`, independent of
   the package version.
7. **`PORT=0`** is accepted and means "ephemeral port" (used by tests).

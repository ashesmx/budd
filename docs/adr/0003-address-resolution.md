# ADR 0003: Address forms and resolution

- Status: accepted (revised by ADR 0006 before Phase 1 shipped)
- Date: 2026-10-15

## Context

The spec allows relative addresses (`connection`, `connection/handle`) and fully
qualified ones (`workspace/connection[/handle]`). With optional handles, a
two-part address such as `alice/claude-desktop` was ambiguous. ADR 0006 makes
handles mandatory, which removes the ambiguity.

## Decision

Every address names an agent, i.e. a handle on a connection:

| Form                          | Example                       | Meaning                                               |
| ----------------------------- | ----------------------------- | ----------------------------------------------------- |
| `connection/handle`           | `grok-build/researcher`       | Relative: resolved in the sender's workspace          |
| `workspace/connection/handle` | `alice/grok-build/researcher` | Fully qualified: `workspace` must be the sender's own |

Parsing, in order:

1. Any address containing `@` fails the whole send (reserved for federation).
2. Addresses are trimmed and lowercased; each part must be `[a-z0-9-]{2,40}`.
3. A one-part address (`grok-build`) fails the whole send with a hint to add a
   handle. Anything with more than three parts is invalid.
4. Per recipient: a foreign workspace is rejected as `cross_workspace`, whether or
   not it exists, so the error never reveals other workspaces. Otherwise
   `unknown_connection`, `blocked` or `unknown_handle` as appropriate.

Malformed addresses fail the whole call because they are input errors; the
per-recipient rejection reasons are reserved for well-formed addresses.

## Consequences

- No connection-vs-workspace collision rules are needed.
- The connection slug `budd` stays reserved as the sender of notices.

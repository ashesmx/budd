# ADR 0004: `thread` excludes unread deliveries

- Status: accepted
- Date: 2026-10-15

## Context

`thread` returns "messages in a thread your connection sent or received". If it
included unread deliveries, an agent could read messages without consuming them,
bypassing consume-on-read and making `inbox` state misleading.

## Decision

`thread` returns, within retention, only messages that the caller's connection
**sent**, or for which it holds a delivery in state **`read`**. Unread and expired
deliveries are omitted. `inbox` remains the only way to read a new message.
`thread` never changes delivery state.

## Consequences

- An agent that sees `inbox_count > 0` must call `inbox` to see new replies;
  `thread` is for context, not polling.

# ADR 0001: Architecture overview

- Status: accepted
- Date: 2026-10-15

## Context

Budd is an MCP message bus that lets AI agents in different harnesses exchange
messages. It is **a bus, not a workflow engine**: passive (no push, long-polling
or webhooks; wake-ups, [ADR 0019](0019-wake-ups.md), are the one exception), at-most-once (consume on read), and isolated per workspace. The
full specification is the project brief; this ADR records the shape of the code.

## Decision

### Guiding principle: easy to install, easy to operate

Every design choice is weighed against this:

- **Local mode needs zero configuration.** `npm start` works with defaults; no `.env`.
- **Every error says what to do next**, for operators (config errors, startup
  refusals) and agents (tool errors, rejections) alike.
- **Fewer moving parts:** fewer env vars, fewer manual steps, copy-pasteable
  setup snippets for each harness.
- Operability ideas still have to keep Budd narrow: a feature that makes
  it harder to run needs a strong reason.

### Runtime and libraries

| Concern       | Choice                                                            | Notes                                                                |
| ------------- | ----------------------------------------------------------------- | -------------------------------------------------------------------- |
| Runtime       | Node 22 LTS, TypeScript `strict`, ESM                             | `engines: >=22.12` (since 0.0.5: Node 24 LTS, `>=24.11`)             |
| MCP           | `@modelcontextprotocol/sdk` 1.31.0 (exact)                        | Streamable HTTP only, via `WebStandardStreamableHTTPServerTransport` |
| HTTP          | Hono 4 + `@hono/node-server`                                      | See below                                                            |
| DB            | SQLite via `better-sqlite3`, WAL mode                             | One control DB plus one file per workspace                           |
| Validation    | zod 4                                                             | Config (env) and tool inputs                                         |
| Tests/quality | Vitest, ESLint (typescript-eslint strict, type-checked), Prettier | `npm run check` runs all of them                                     |

Every dependency is pinned to an exact version at least two weeks old at the time
it was added. TypeScript is pinned to 6.0.x rather than 7.x because
typescript-eslint 8 supports `typescript <6.1`.

**Why Hono.** The SDK ships a web-standard (`Request` → `Response`) Streamable
HTTP transport with built-in Host/Origin allow-lists, which Hono consumes natively
(`transport.handleRequest(c.req.raw)`). Hono is small, has first-class middleware
for cookies, CSRF and SSE (all needed for the UI), and the SDK already depends on
it, so it adds no new supply-chain surface. The SDK's OAuth server helpers are
Express routers; whether to adapt them or write equivalent Hono handlers is
decided in Phase 4 and will get its own ADR.

### Modes

`BUDD_MODE=local|hosted`. The bus, policies, limits and UI are shared code; only
the identity layer differs:

- **local**: connection identity is the URL path (`/mcp/<connection>`), one implicit
  account and one workspace (`local`), loopback bind enforced at config load.
- **hosted**: Budd is the OAuth 2.1 AS for MCP clients (DCR, PKCE S256, rotating
  refresh tokens); humans sign in with Google OIDC. Connection = `(workspace, client_id)`.

### Storage layout

- `$DATA_DIR/control.db`: accounts, workspace registry, memberships, and in hosted
  mode OAuth clients/codes/token hashes. Instance-level data only.
- `$DATA_DIR/workspaces/<workspace_id>.db`: connections, handles, policies,
  messages, deliveries, audit.
- A single **workspace gateway** module resolves the workspace DB from the
  authenticated request context; it is the only path to a workspace DB.
- Migrations are ordered SQL scripts tracked with `PRAGMA user_version`, run per DB on open.

### Swappable interfaces

These exist so a future Postgres or multi-replica deployment is an adapter swap.
Only the v1 implementations are built.

| Interface     | v1 implementation                            | File             |
| ------------- | -------------------------------------------- | ---------------- |
| `Storage`     | `SqliteStorage`                              | `src/storage/`   |
| `Sweeper`     | `IntervalSweeper` (in-process `setInterval`) | `src/sweeper/`   |
| `RateLimiter` | `TokenBucketRateLimiter` (in-memory)         | `src/ratelimit/` |
| `EventBus`    | `InProcessEventBus` (topics = workspace IDs) | `src/events/`    |

`Storage` is async even though `better-sqlite3` is synchronous, so a networked
adapter needs no caller changes. No SQLite-specific SQL may appear outside
`src/storage/sqlite/`.

### Single instance only

Running two replicas against the same data would double-run every sweeper job
(duplicate expiry notices) and split rate-limit buckets (each replica allows the
full rate). The SSE event bus would also miss events produced on the other
replica. Budd v1 must run as exactly one process.

## Consequences

- Workspace isolation is structural (separate files, one gateway), not just a
  `WHERE workspace_id = ?` convention.
- Cross-workspace features (none in v1) would need control-DB-level design.
- Scaling out requires new `Sweeper`, `RateLimiter` and `EventBus` adapters
  (e.g. leader election, shared counters, pub/sub), plus a server-based `Storage`.

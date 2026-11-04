# Architecture

How Budd's code is laid out, for people working on it. To use Budd, read the
[README](README.md) instead.

## Working on Budd

```sh
npm ci
npm run check     # typecheck, lint, format check, tests: run before every commit
npm run dev       # local mode, restarting on change
npm test          # tests only (Vitest)
npm run smoke     # Docker end to end: build, hardening, backup/restore, refusals
```

`npm run smoke` (`scripts/smoke.sh`) builds the image and runs it exactly as
`docker-compose.yml` does, with dummy sign-in credentials, then checks what
must work and what must fail: health and headers, the container hardening,
file permissions, the documented backup and restore commands (word for word
from `docs/operating.md`), bad archives, bad configuration and a database from
a newer Budd. It uses its own project, image, volume and port, removes them
when done, and exits non-zero if any check fails. Run it before merging
anything that touches Docker, startup, storage or the operating docs. If you
change a command in `docs/operating.md`, change it in the script too.

Node 24.11 (the first 24 LTS) or newer. Dependencies are pinned to exact versions, each at least two
weeks old when added.

## The shape of it

Budd is one Node process: a Hono HTTP server with three faces.

```
            AI apps (MCP)                    humans (browser)
                 │                                  │
   /mcp/<name> (local) or /mcp + OAuth (hosted)   /ui, /login, /authorize
                 │                                  │
           src/http/mcpRoute.ts               src/ui/, src/auth/
                 │                                  │
           src/mcp/server.ts                   src/admin/Admin.ts
           (nine tools)                        (human-only writes)
                 │                                  │
             src/bus/Bus.ts                         │
                 └──────────────┬───────────────────┘
                        src/storage/gateway.ts
                 (the only way to a workspace database)
                                │
                    src/storage/sqlite/ (SQLite)
```

- **Agents** reach the bus only through MCP tools. **Humans** change policies,
  block, archive and relabel only through `Admin`, from the UI. Nothing
  agent-facing can import `Admin`; an architecture test checks this.
- **Every workspace is its own SQLite file.** `WorkspaceGateway` hands out a
  workspace's store only for a context it issued itself (a verified connection,
  or a signed-in human). It is the only caller of `openWorkspace`; a test checks
  this too.
- **Local and hosted mode share everything except identity.** Local mode names
  the connection by URL path. Hosted mode gets it from an OAuth access token or an API key (ADR 0016).

## Source map

| Path                        | What's there                                                                                                                                                                                                                     |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/main.ts`, `src/cli.ts` | Process entry points: `serve`, `backup`, `reset-login`, `login`, `connections`, `block`, `accounts`, `erase-workspace`                                                                                                           |
| `src/config.ts`             | Environment variables, validated with zod. Errors name the variable.                                                                                                                                                             |
| `src/server.ts`             | Wires storage, gateway, bus, admin, sweeper and HTTP together; startup banner; graceful shutdown                                                                                                                                 |
| `src/http/`                 | The Hono app (`app.ts`), body limits, the local-mode Host/Origin guard, and the MCP route                                                                                                                                        |
| `src/mcp/server.ts`         | The nine MCP tools and their input schemas. Thin: each calls `Bus`.                                                                                                                                                              |
| `src/bus/`                  | `Bus` (send, inbox, thread, policies as agents see them), addressing, envelopes, notices, trust wording                                                                                                                          |
| `src/admin/Admin.ts`        | What a human can do: block, unblock, archive, restore (connections and mailboxes), relabel, set policy, read history and audit                                                                                                   |
| `src/auth/`                 | Hosted mode: OAuth server (`oauth.ts`: DCR, token, revoke), sign-in and consent (`browser.ts`), OIDC. Local UI login.                                                                                                            |
| `src/ui/`                   | Server-rendered pages (`hono/html`), routes, sessions, CSRF, confirm-step nonces, the small CSS and JS; follows docs/design/                                                                                                     |
| `src/storage/Storage.ts`    | The storage interfaces. Async, so a networked database could replace SQLite without caller changes.                                                                                                                              |
| `src/storage/gateway.ts`    | `WorkspaceGateway`: the authenticated way to a workspace store                                                                                                                                                                   |
| `src/storage/sqlite/`       | The SQLite adapter, migrations (`PRAGMA user_version`), backup. The only place SQL appears.                                                                                                                                      |
| `src/sweeper/`              | Interval jobs: expire unread deliveries (and send notices), purge old messages, audit rows and OAuth leftovers                                                                                                                   |
| `src/wakeups/`              | Wake-ups (ADR 0019): set by a human, sent by a sweeper job, signed if given a secret; secrets sealed with the workspace's key (`WorkspaceKeys`, locked by `BUDD_SECRET_KEY`), sent only to public HTTPS hosts in `WAKE_UP_HOSTS` |
| `src/events/`               | In-process event bus. Audit writes publish to it, and the UI's live updates (SSE) listen.                                                                                                                                        |
| `src/ratelimit/`            | In-memory token buckets (sends, registration, sign-in attempts)                                                                                                                                                                  |
| `src/domain/`               | Plain types: connections, messages, audit events, OAuth records, slugs                                                                                                                                                           |
| `test/`                     | Vitest. `helpers/harness.ts` starts a real Budd on a temp data dir; `helpers/hosted.ts` adds a mock OIDC provider and a scripted browser                                                                                         |

## Ideas that hold it together

- **Every state change writes its audit row in the same transaction.** The
  audit log can't miss an event, and audit writes are what drive the UI's live
  refresh. So a full audit log (`MAX_AUDIT_MB`, without `AUDIT_ROTATE`) refuses
  an agent's action whole; a human's or Budd's own entry is always written.
- **What a workspace stores is counted as it's written.** Triggers keep
  running totals of message and audit bytes (`stored_bytes`), so the quotas
  cost one row read, not a scan.
- **At-most-once delivery.** `inbox` marks deliveries read in the transaction
  that returns them. `thread` never shows unread messages
  ([ADR 0004](docs/adr/0004-thread-excludes-unread.md)).
- **A send is decided inside the transaction that stores it.** The store reads
  everything the checks need (recipients' policies and backlogs, the sender's
  outstanding count) and hands it to the bus's `decide`
  function, so no policy change or block can slip in between a check and the
  write, whatever the storage adapter. The workspace's size is checked after
  the message is written, by the same count the database keeps, and an
  oversized send is rolled back.
- **Widening needs two requests.** Any change that lets more in (widening a
  policy, unblocking) records a pending change with a one-time nonce bound to the
  browser session, and only a second POST with that nonce applies it.
- **Archived means blocked.** Archiving sets `archived_at` and blocks in one
  transaction, so every blocked check also covers archived connections
  ([ADR 0011](docs/adr/0011-reconnecting-and-archiving.md)).
- **Tokens, codes and secrets are stored only as SHA-256 hashes**, and never
  logged. Logs are JSON lines of metadata (`src/log.ts`).
- **Single instance.** The sweeper, rate limiter and event bus are in-process.
  Running two processes on one data directory is unsupported. The interfaces
  (`Sweeper`, `RateLimiter`, `EventBus`, `Storage`) are where that would change.

## Design decisions

Each significant decision is an ADR in [docs/adr/](docs/adr/). Where an ADR
mentions "the spec", it means Budd's original design brief for v1, which isn't
published; each ADR says what it needs from it. "Phase 1" to "Phase 4" are the
stages Budd was first built in, before its first release.

| ADR                                                     | Decision                                                                 |
| ------------------------------------------------------- | ------------------------------------------------------------------------ |
| [0001](docs/adr/0001-architecture.md)                   | Architecture, libraries, storage layout, single instance                 |
| [0002](docs/adr/0002-docker-is-hosted-mode-only.md)     | Docker runs hosted mode only                                             |
| [0003](docs/adr/0003-address-resolution.md)             | How `connection/handle` addresses resolve                                |
| [0004](docs/adr/0004-thread-excludes-unread.md)         | `thread` excludes unread deliveries                                      |
| [0005](docs/adr/0005-spec-clarifications.md)            | Clarifications of the spec                                               |
| [0006](docs/adr/0006-mandatory-handles.md)              | Every agent has a handle                                                 |
| [0007](docs/adr/0007-phase-2-decisions.md)              | Policies, limits, expiry and notices                                     |
| [0008](docs/adr/0008-ui.md)                             | The UI                                                                   |
| [0009](docs/adr/0009-hosted-mode.md)                    | Hosted mode: OAuth server and sign-in                                    |
| [0010](docs/adr/0010-local-ui-login.md)                 | The local UI login                                                       |
| [0011](docs/adr/0011-reconnecting-and-archiving.md)     | Reconnecting apps, archiving, loopback redirect ports, auth logging      |
| [0012](docs/adr/0012-erasing-workspaces.md)             | Erasing workspaces                                                       |
| [0013](docs/adr/0013-design-system-and-ui.md)           | A design system, and the UI built on it                                  |
| [0014](docs/adr/0014-return-page-after-consent.md)      | After consent, a page (not a redirect) sends the browser back to the app |
| [0015](docs/adr/0015-landing-page.md)                   | A landing page before signing in                                         |
| [0016](docs/adr/0016-api-key-connections.md)            | Connections with API keys, for agents without a browser                  |
| [0017](docs/adr/0017-ui-restructure.md)                 | The UI restructured around connections, mailboxes and finding things     |
| [0018](docs/adr/0018-archiving-mailboxes.md)            | Archiving mailboxes                                                      |
| [0019](docs/adr/0019-wake-ups.md)                       | Wake-ups: Budd tells an agent's platform when a mailbox has mail         |
| [0020](docs/adr/0020-map-messages-and-filter-drawer.md) | The map's mailboxes and messages, and the filter drawer                  |
| [0021](docs/adr/0021-who-may-sign-in.md)                | Hosted mode needs a decision on who may sign in                          |
| [0022](docs/adr/0022-operator-console.md)               | A read-only operator console                                             |

What Budd defends against, and the risks it accepts, is in
[docs/threat-model.md](docs/threat-model.md).

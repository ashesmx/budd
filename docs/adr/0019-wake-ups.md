# ADR 0019: Wake-ups

- Status: accepted
- Date: 2026-10-22
- Sets aside ADR 0001's "no push, long-polling or webhooks" for this one case

## Context

Agents find mail by polling `inbox_count`. For an AI agent each poll is a whole
session, so polling often is costly and polling rarely leaves mail waiting.
Several agent platforms can start an agent from an HTTPS request: Claude Code
routines (an API trigger), Grok Bot routines and Multica Autopilot (webhook
triggers). Claude Desktop, Cowork, the Claude Code command line and OpenAI's
apps can't yet.

## Decision

A human can give a mailbox a **wake-up**: an HTTPS address Budd POSTs to when
the mailbox has mail. Polling is unchanged. The setup guide is
[docs/integrations/wake-ups.md](../integrations/wake-ups.md).

- **Set by a human only**, in the UI (`WakeUps`, beside `Admin`): an address,
  an optional bearer token, and retries (0–5, every 5 min, 15 min or 1 h).
  Nothing on the MCP side mentions wake-ups. Once saved, the address and token
  are never shown; the host and the token's last 4 characters are. Setting and
  removing are audited (`wake_up_set`, `wake_up_removed`) with the host only;
  each wake-up isn't, and its last result is shown on the mailbox page. A
  test button sends one at once.
- **One fixed body**: `{"event":"budd.mail","mailbox":…,"text":…}`, no
  content, sender or subject. `anthropic-version` is added only for
  `api.anthropic.com`.
- **Signed, with an id** (added before release, 2026-10-22): an optional
  signing secret, sealed like the token, signs the body as
  `X-Hub-Signature-256: sha256=<hex HMAC-SHA256>`, the GitHub scheme Multica
  checks. The body carries a unique `id` (a ULID, also sent as
  `Idempotency-Key`) and `sent_at`, so the signature covers them and a
  receiver can refuse replays and duplicates. We first relied on the secret in
  Multica's URL alone; signing means a leaked URL isn't enough.
- **Allowed hosts**: `WAKE_UP_HOSTS` (default `api.anthropic.com`,
  `api2.cursor.sh`, `multica.ai`; `*` for any public host) is checked when
  saving and again when sending, so taking a host off the list stops its
  wake-ups.
- **Capped**: at most `WAKE_UPS_PER_HOUR` (default 30) per mailbox in a fixed
  hour window, retries included and tests not, so senders can't run up an
  agent's bill.
- **When**: new mail wakes its mailbox at once, unless it was woken in the
  last minute (since 0.0.5; before, the first message waited for the sweep).
  A sweeper job each minute, on its own sweeper so it can't delay
  expiry or purges, wakes a mailbox with unread, unexpired mail that wasn't
  woken since it was last read (so a burst is one wake-up), and sends retries
  due while the mail stays unread. Mail newer than the last wake-up wakes it
  again at most once per retry interval, so a wake-up that failed, or that the
  agent didn't act on, can't leave a mailbox unwoken for good. State is in the database, so a restart loses
  nothing.
- **Secrets**: each workspace has a random 32-byte key in `control.db`
  (control migration 7). The address and
  token are AES-256-GCM sealed in the workspace database (migration 8), with
  the workspace, connection, mailbox and field as associated data. A workspace
  file alone doesn't reveal them; a backup holds both, unless the operator
  sets `BUDD_SECRET_KEY`: then each workspace key is stored sealed with it
  (`WorkspaceKeys`; existing ones at startup, whether or not wake-ups are on),
  and neither the data directory nor a backup alone opens anything. A
  workspace gets its key with its first wake-up; unused keys older Budds made
  are dropped at startup. A key Budd can't unlock is never replaced: saving is
  refused, so a missing or mistyped `BUDD_SECRET_KEY` costs nothing once it's
  put back. `BUDD_SECRET_KEY_PREVIOUS` rotates it; `budd forget-wake-up-keys`
  is the deliberate way out when it's lost.
- **Outbound safety (SSRF)**: HTTPS on port 443 only; no credentials in the
  address; tokens of visible ASCII only; every address the name resolves to
  must be public (private, loopback, link-local, CGNAT, multicast, reserved
  and IPv4-mapped refused); the connection goes to the checked address, never
  through a proxy; no redirects; the body isn't read; 10 seconds in all, lookup
  included; only a coarse status is kept (`HTTP 202`, couldn't connect, a bad
  certificate, no answer), so a test can't map someone's network. Tests are
  limited per mailbox and per workspace. No override for private networks.
- **Never wakes** a blocked or archived connection or an archived mailbox;
  archiving a mailbox or its connection removes its wake-up.
- **`WAKE_UPS=off`** (on by default) stops them and hides their setup; saved
  ones are kept.

## Consequences

- Budd now makes outbound requests. Operators who restrict egress must allow
  HTTPS to their agents' platforms; `HTTPS_PROXY` isn't used.
- A wake-up sweep waits on platforms, 8 at a time and 10 seconds at most each,
  on its own sweeper.
- Restoring a workspace database without the `control.db` it came with leaves
  its wake-ups unreadable until re-entered; so does losing `BUDD_SECRET_KEY`.
- Connections shows a notice while any wake-up's latest attempt failed, so a
  silently broken one doesn't leave mail unread unnoticed.

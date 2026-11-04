# ADR 0022: A read-only operator console

- Status: accepted
- Date: 2026-10-23

## Context

An operator watches a Budd instance with CLI commands (`budd accounts`,
`budd connections`) run over SSH. That works for acting on the instance, but
it's awkward for checking on it: who signed up, which workspaces are growing,
what the instance is configured with.

The people using a hosted Budd shouldn't become visible to its operator in
the process: their email addresses, names and messages stay theirs.

## Decision

### Who is an operator

- **`budd operator <email>` prints a one-time link** (10 minutes, single use,
  stored hashed, like `budd login`) that only the account signed in with that
  email can use, so a link that reaches the wrong person is no use to them;
  trying it doesn't use it up. It works while Budd runs, including through
  `docker compose exec`. Proof of operator is shell access to the server,
  which the other operator commands already rely on.
- **They open the link and sign in as usual** (with the identity provider,
  so the sign-in rules of ADR 0021 still apply), confirms "Make this account
  an operator?", and is taken to `/console`. Their account ID goes in an
  `operators` table in the control database, and the server log says so.
- **After that, the operator just signs in at `/console`.** No more links.
  Operators also see **Console** in the account menu, beside Settings and
  Sign out; it opens the console in a new tab.
- **An instance can have several operators**, each enrolled with their own
  link. `budd operators` lists them and `budd remove-operator <account id>`
  removes one; the console checks the table on every request, so removal
  takes effect at once.
- **Local mode:** the one local account is the operator, with no link, and
  the console uses the UI's own sign-in: there's only one person to sign in.

### Signing in to the console

- `/console` starts its own sign-in and sets its own session cookie
  (`__Host-` over https), shorter-lived than the UI's. A UI session alone
  can't open the console, and a console session can't use the UI: the
  session itself says which it is, so cookie paths needn't. Signing out of
  either ends both in that browser.
- **It looks unlike the workspace pages**, so nobody mistakes one for the
  other: a violet header (new `op-bar` tokens), its own tab title, on the
  same design system.
- The usual Host/Origin checks and a rate limit apply.
- **The console's header has the same account menu as the UI** (workspace,
  Settings, Console, Sign out), so the workspace's name leads back to its
  pages. Sign out ends both the console and the UI session.
- **A signed-in account that isn't an operator gets a 403**, as plain text
  like Budd's other refusals: no page of its own.

### What it shows

Read-only, and only from the control database plus file sizes:

- **Instance:** version, mode, uptime, `PUBLIC_URL`.
- **Environment:** every setting, marked as the default or as set. Secrets
  (`GOOGLE_CLIENT_SECRET`, `OIDC_CLIENT_SECRET`, `BUDD_SECRET_KEY`,
  `BUDD_SECRET_KEY_PREVIOUS`) show only "set" or "not set". Each has a
  one-line description, and a recommendation where that's more than "keep the
  default"; a value that differs from it is flagged. Both come from the
  settings registry in `src/settings.ts`, a record keyed by the schema's
  own setting names so none can be missed, and tests keep its defaults, the
  schema, `.env.example` and operating.md's table in step.
- **Accounts:** ID, provider, created, last sign-in (a new column, set at each
  sign-in), workspaces.
- **Workspaces:** ID, created, accounts, apps connected and how many still
  hold live tokens, API keys with last use and expiry, and storage: today's
  figure against `MAX_WORKSPACE_MB` and `MAX_AUDIT_MB`, and its history.
- **Operators:** account ID and when they were added.

It never shows emails, names, pictures, workspace names (a hosted workspace is
named after its email address), connection names, handles or messages.

### Storage history

- **An hourly sweeper job** records, per workspace, the bytes counted against
  `MAX_WORKSPACE_MB` (messages) and `MAX_AUDIT_MB` (audit), and the file size
  on disk, in a `workspace_usage` table in the control database: one row per
  workspace per UTC hour. It runs on the first sweep of an hour that has no
  row yet, so a restart doesn't skip or repeat an hour.
- The server reads those two counters from each workspace database, as the
  sweeper already opens them all; the console reads only the control
  database.
- **A rolling 30 days:** older rows are deleted as new ones go in. Erasing a
  workspace deletes its rows.

## Alternatives

- **`OPERATOR_EMAILS` in `.env`:** depends on the email the provider reports,
  and with `OPEN_SIGNUP` or `@domain` rules one mistake would open the console.
  Enrolment binds the account itself (provider and subject).
- **An operator password in `.env`:** one more secret to create, rotate and
  leak.
- **A CLI link for every visit:** safest, but needs SSH every time, which
  defeats the point of a console.
- **Recording size when a workspace is used:** idle workspaces would leave
  gaps, and it adds a write to the message path.
- **File size alone:** SQLite files don't shrink when rows are deleted, and
  the limits count stored messages and audit entries, not the file.

## Consequences

- After enrolment, console access rests on the operator's identity-provider
  account. The console is read-only, which limits what a stolen account gets.
- The console is a new privileged page on the internet; it gets the same
  reviews as the sign-in flow.
- Operators see how many accounts and workspaces exist and how much each
  stores, by ID. The operating docs say so, for any privacy notice an instance
  publishes.
- The CLI stays the way to act on the instance: erasing, blocking, removing
  operators.

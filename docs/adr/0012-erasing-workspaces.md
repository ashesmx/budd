# ADR 0012: Erasing workspaces

- Status: accepted
- Date: 2026-10-18
- Context: people need to erase their own data, and operators need to erase a
  leaver's; until now that meant a `node -e` snippet from docs/operating.md

## Decision

### One erase, two ways in

- **The account holder, in the UI** ("Delete this workspace", at the foot of
  every page; since ADR 0013, in Settings). Two steps, because it can't be undone:
  1. Type the workspace name. The page lists what goes: connections, messages,
     the audit log, every connected app's sign-in, and the account.
  2. Prove it's them, now. Local mode: the UI password (sharing the sign-in
     page's rate limit). Hosted mode: sign in again with the instance's identity
     provider.
- **The operator, from the command line:** `budd erase-workspace <name>`.
  Instance-wide powers stay out of the account UI.
- Both call `eraseWorkspaceData` (src/storage/sqlite/erase.ts): delete the
  database file and its WAL and SHM files, then, in one transaction, every
  account left with no workspace and the workspace row (memberships, grants,
  codes and tokens cascade). The file goes first, so a failed delete changes
  nothing and can be retried.
- Erased rows are overwritten, not just unlinked: every database runs with
  `secure_delete`, and the control DB's WAL is checkpointed and truncated after
  an erase, so backups taken afterwards don't contain them.
- While an account has exactly one workspace, erasing the workspace deletes the
  account too. When accounts can have several, only an account left with none
  goes.

### Budd keeps running for the UI; the CLI needs it stopped

- The server closes the workspace's database, erases it, and ends the UI
  sessions of every account erased with it. Tokens are gone with their grants,
  so connected apps fail on their next call.
- A workspace database is opened only if the workspace is still registered, so
  a request already in flight can't recreate an erased file.
- The CLI is a separate process, and the server keeps workspace databases open,
  so the CLI refuses while Budd runs. To know, the server **claims its data
  directory**: it holds an exclusive SQLite transaction open on
  `DATA_DIR/budd.lock` for as long as it runs. The operating system releases
  it if the process dies, so there's no stale lock to clean up, and it works
  across Docker containers sharing a volume. It also stops two servers from
  using one data directory. `budd reset-login` takes it too. `budd backup`
  doesn't: it stays safe while Budd runs. File locks are unreliable on
  network shares, so the data directory belongs on a local disk or volume.
- The CLI commands that write (`erase-workspace`, `reset-login`) and
  `accounts` refuse a control DB whose schema isn't exactly the one they know,
  rather than migrating it or misreading it.

### Signing in again (hosted mode)

- Only standard OpenID Connect, so any provider works. Budd sends `max_age=0`,
  which obliges the provider to re-authenticate and to include `auth_time` in
  the ID token, and also requests `auth_time` as an essential claim (OIDC Core
  §5.5), which is the only way Google provides it. It adds `prompt=login` only
  if the provider's discovery document lists it in `prompt_values_supported`:
  Google doesn't support `prompt=login` (it documents `none`, `consent` and
  `select_account` only), and doesn't re-authenticate on request.
- Providers may ignore all of this, so Budd **checks `auth_time`**: it must be
  within the last 5 minutes. If not, nothing is deleted, and the page asks the
  person to sign out at their provider and start again. The window is measured
  from now rather than from the click, so that Google users who signed in
  recently aren't made to sign out of Google every time (accepted risk 15 in
  [the threat model](../threat-model.md)).
- The identity that signs in must be the session's own account (matched on
  issuer and subject, never email).
- Step 2 redeems the session's one-time confirmation nonce, and from there the
  pending sign-in carries the confirmation (the session and workspace): it is
  stored server-side, used once, and bound to the browser by the sign-in
  cookie, `state`, PKCE and the OIDC nonce. The provider's callback erases at
  once. A session has at most one such sign-in in progress, so this can't fill
  the store of sign-ins.
- An account the provider no longer accepts (email unverified, outside
  `ALLOWED_HD`, or from a previous `OIDC_ISSUER`) can't confirm, so only the
  operator can erase its workspace.
- After a form POST, Budd sends the browser to the provider with a
  continue page, not a redirect: the UI's CSP (`form-action 'self'`) would
  block a redirect to another origin.

### After erasing

- Hosted mode: signing in again creates a new account with a new, empty
  workspace.
- Local mode: Budd creates a new, empty `local` workspace at once (the CLI
  leaves that to the next start). The UI login went with the account, so Budd
  issues a new setup link, shows it on the confirmation page, and prints it in
  the terminal.
- Backups taken before, and the logs, still contain erased data. The UI and
  the docs say so.

## Consequences

- With Google, deleting a workspace needs a Google sign-in from the last 5
  minutes; otherwise the person signs out of Google first.
- `budd.lock` appears in the data directory. Starting a second Budd on the same
  directory now fails with a message saying so.

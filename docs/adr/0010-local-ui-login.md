# ADR 0010: The local UI has a username and password

- Status: accepted
- Date: 2026-10-16
- Deviates from spec: §15 ("Local mode: no login")

## Context

In local mode any process on the machine could use the UI, and so widen contact
policies or unblock connections. That includes an AI app that can run shell
commands. The security review flagged this. A secret link printed at startup
was considered and rejected by the maintainer as easy to lose. Local mode is
mostly for testing, so a little setup is acceptable.

## Decision

- **First start:** with no login, Budd prints a one-time setup link
  (`/setup?code=…`, 256 random bits) in its startup output. The page creates a
  username and a password of at least 8 characters, then signs you in.
- **The setup link is single-use.** It stops working once a login exists.
  Until then a new link is printed at every start, so it can't really be lost.
- **Every UI page and the live-update stream need the login.** This sits on top
  of the existing loopback and Host/Origin checks.
- **Passwords** are hashed with scrypt (N=16384, r=8, p=1, random 16-byte salt),
  with the parameters stored alongside the hash, and compared in constant time.
- **Sign-in attempts** are limited to 10 a minute.
- **A wrong username takes as long to refuse as a wrong password.**
- **Sign-in starts a fresh session.** The session used for the sign-in form
  can't open the UI.
- **`npm run budd -- reset-login`** removes the login. The next start prints a
  new setup link.
- Sign-in reuses hosted mode's session machinery: the local account is a real
  account that owns the `local` workspace. Both modes now follow the same
  hierarchy, account › workspace › connection › handle.
- **MCP is unchanged.** AI apps still connect to `/mcp/<name>` with no login.

## Consequences

- The UI is no longer usable by any local process, only by whoever knows the
  login.
- This doesn't make local mode safe against an AI app that runs shell commands
  as your OS user. Such an app can read or edit Budd's data files directly,
  including resetting the login. The real boundary is still the OS user; the
  README says to run Budd, or the shell-capable apps, as a different OS user
  when that matters.
- There is one more first-run step, which the README covers.

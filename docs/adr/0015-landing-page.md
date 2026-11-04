# ADR 0015: A landing page before signing in

- Status: accepted
- Date: 2026-10-19

## Context

In hosted mode, opening `/ui` without a session went straight to the identity
provider's sign-in. Nothing said what Budd was, which provider the person was
about to use, or how to connect an app. Local mode already showed its own
username and password form, but it said no more than "Sign in to Budd".

## Decision

- **Both modes show the same landing page at `/login`**: "Sign in to Budd",
  a line on what Budd is and what signing in shows, and a "Connecting an AI
  app?" section with the MCP URL (`<PUBLIC_URL>/mcp` hosted,
  `<origin>/mcp/<name>` local, as on the Connections page).
- **Hosted:** a Sign in button, with the host of the provider's sign-in page
  from its discovery document ("You’ll sign in at `accounts.google.com`"; the
  issuer's host if discovery fails), and the `ALLOWED_HD` domain
  when there is exactly one. That one is already public: Budd sends it to the
  provider as `hd`. A list of several is never shown.
  Nothing goes to the provider until the person clicks (`/login?start=1`).
  It works with any OpenID Connect provider: nothing is Google-specific.
- **Local:** the existing sign-in form, under the same heading and text.
- **An app's consent request skips the landing page.** When the sign-in
  returns to `/authorize`, the person has just asked an app to connect, and
  the consent screen explains what's happening, so a stop on the way adds a
  click and says nothing new.
- **Links that mean "sign in now"** (Sign in again, Try a different account,
  Sign in after signing out) use `start=1` and go straight to the provider.
- The bounce through Budd's own origin (to see a SameSite=Strict session
  cookie after a cross-site arrival) stays, before the landing page and
  before `start=1`, so a link from elsewhere never sends someone who is
  signed in to the provider again.

## Consequences

- One more click to sign in to the UI in hosted mode.
- The landing page shows the MCP URL and the provider's host to anyone who
  opens Budd. Both are already public: the URL is Budd's address, and the
  provider is in the discovery metadata and the sign-in redirect.
- `/login?start=1` from a link elsewhere starts a sign-in after the bounce, as
  `/login` did before.
- **Blocked or archived connection page:** its "Open …" link appears only when
  the UI would show that workspace (it has no switcher yet).

## Amendment (0.0.3): a click starts every sign-in

The security review found that a link could start a sign-in by itself
(`/login?start=1`, or an app's `/authorize`), which completes without a click
when the person is signed in at their provider. Each completed sign-in starts a
Budd session, and an account keeps at most 10, so a page that opened the link
ten times signed the person out on their other devices.

Now only the landing page's **Sign in** button starts a sign-in: a form POST
to `/login`, accepted only when the browser's `Origin` (or `Sec-Fetch-Site`)
says the form is Budd's. There is no session yet to carry a CSRF token.

- `/login?start=1` and the "sign in now" links (Sign in again, Try a different
  account, Sign in after signing out) show the landing page.
- **An app's consent request shows the landing page too**, reversing the
  decision above: one more click when connecting an app while signed out.
- Signing in to confirm erasing a workspace was already a form POST, and is
  unchanged.

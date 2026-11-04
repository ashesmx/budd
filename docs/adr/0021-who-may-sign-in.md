# ADR 0021: Hosted mode needs a decision on who may sign in

- Status: accepted
- Date: 2026-10-23

## Context

Every account that signs in to a hosted Budd gets a workspace (ADR 0009).
Until 0.0.4 the only restriction was `ALLOWED_HD`, and without it anyone the
identity provider accepted could sign up. Two security reviews flagged that
default: a stranger's workspace
uses the server's resources and, with wake-ups, makes outbound requests from
it.

`ALLOWED_HD` reads Google's `hd` claim, which no other provider sends, so an
operator using another provider, or a Google user inviting a few people
outside an organisation, had no restriction in Budd at all.

Open sign-up is still a fair choice for an instance meant for the public.

## Decision

- **`ALLOWED_EMAILS`**: email addresses, or `@domain` for every address at a
  domain (exactly that domain, not its subdomains), compared with the email
  the provider verified. Works with every provider that sends
  `email_verified`. With Google, an `@domain` (other than `@gmail.com`)
  matches only when `hd` is that domain: anyone who once received mail at a
  domain can make a personal Google account with that address, and it stays
  verified after they lose the mailbox.
- **`ALLOWED_HD` only with Google**, the one provider that vouches for `hd`;
  with another `OIDC_ISSUER` it's refused at startup.
- **`OPEN_SIGNUP=true`**: anyone the provider accepts. Off by default.
- **Hosted mode refuses to start** unless `ALLOWED_EMAILS` or `ALLOWED_HD` is
  set, or `OPEN_SIGNUP=true`. Setting `OPEN_SIGNUP=true` with a list is refused
  too, since the list would do nothing.
- A sign-in is allowed when its `hd` is in `ALLOWED_HD` or its email (or
  `@domain`) is in `ALLOWED_EMAILS`. It's checked at every sign-in.
- A refusal names the allowed domain only when a single `ALLOWED_HD` domain
  is the whole rule (Google's sign-in page is told that domain anyway);
  otherwise it names no one, so the list isn't disclosed.

## Alternatives

- **Warn at startup, keep open sign-up the default:** a warning in a log is
  easy to miss, and the risky choice should be the one that takes a setting.
- **Refuse to start without `ALLOWED_HD`:** wouldn't work for other
  providers, or for an instance meant for the public.
- **Allowed emails managed in the UI:** instance settings live in `.env`
  until there is an admin UI.

## Consequences

- Upgrading a hosted Budd that relied on open sign-up needs one line in
  `.env`; it says so at startup, and operating.md's upgrade notes say it too.
- An `@domain` entry trusts the provider's `email_verified` for that domain,
  except with Google, where it needs the domain's Workspace. A domain whose
  mail isn't on Google Workspace can then only be allowed address by address
  with Google sign-in.
- Someone taken off the list can't sign in to erase their own workspace; the
  operator can.

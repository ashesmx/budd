# ADR 0009: Hosted mode: OAuth, sign-in and connections

- Status: accepted
- Date: 2026-10-16
- Deviates from spec: §5 ("Google OIDC") is generalised to any OpenID Connect
  provider; §2 (slug "derived at registration") is completed at consent.

## Context

Hosted mode (spec §5) makes Budd the OAuth 2.1 authorization server for MCP
clients, with humans signing in through Google. Google came first, but
any provider should work.

## Decisions

### Hono handlers, SDK schemas

The SDK's server auth helpers (`mcpAuthRouter` and friends) are Express
routers. Budd runs on Hono, and adding Express just for them would double the
HTTP stack. Budd implements the endpoints as Hono handlers and reuses the SDK's
zod schemas (`OAuthClientMetadataSchema`), so registration input is validated
exactly as the SDK would. The SDK's _client_ OAuth flow, which the MCP
Inspector also uses, is tested end to end against these handlers
(`test/sdk-oauth.test.ts`). The real Inspector (2.9.0) was also run against a
local hosted instance and completed the flow.

### Any OpenID Connect provider, Google by default

- `OIDC_ISSUER` defaults to `https://accounts.google.com`. Credentials come from
  `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` (the spec's names) or
  `OIDC_CLIENT_ID` / `OIDC_CLIENT_SECRET`. The provider is found by discovery.
- Sign-in uses the authorization code flow with PKCE, `state` and `nonce`. The
  ID token's signature is verified against the provider's JWKS, refetched once
  on an unknown key. Budd also checks `iss`, `aud`, `azp`, `exp`/`iat` (60 s
  skew) and `nonce`.
- **An email must be present and verified.** An account is identified by
  `(issuer, sub)`, never by email; the email is refreshed on each sign-in.
- `ALLOWED_HD` checks Google's `hd` claim server-side. Other providers don't
  send `hd`, so with `ALLOWED_HD` set only Google Workspace accounts can sign
  in; restrict other providers at the provider. (Since 0.0.5, `ALLOWED_EMAILS`
  works with any provider, and hosted mode needs a choice:
  [ADR 0021](0021-who-may-sign-in.md).)
- A first sign-in creates the account and its personal workspace, slugged from
  the email's local part (`alice`, then `alice-2`, ...).

### Endpoints

| Endpoint                                      | Standard                    |
| --------------------------------------------- | --------------------------- |
| `/.well-known/oauth-protected-resource[/mcp]` | RFC 9728                    |
| `/.well-known/oauth-authorization-server`     | RFC 8414                    |
| `POST /register`                              | RFC 7591 (DCR)              |
| `GET/POST /authorize`                         | OAuth 2.1, PKCE (RFC 7636)  |
| `POST /token`                                 | code and refresh grants     |
| `POST /revoke`                                | RFC 7009                    |
| `/login`, `/auth/callback`, `POST /logout`    | human sign-in (OIDC client) |
| `/mcp`                                        | bearer token only           |

- **An unauthenticated `/mcp` request** gets `401` with
  `WWW-Authenticate: Bearer resource_metadata="…"`, which is how clients
  discover the rest.
- **PKCE S256 is required for every client**, confidential ones included, and
  the challenge must be well formed.
- **`resource` (RFC 8707)**, if sent, must name Budd's MCP endpoint. The
  redirect back carries `iss` (RFC 9207).
- **There are no scopes.** A token grants exactly one connection's MCP access.
- **CORS (`*`, no credentials)** is enabled on the metadata, register, token,
  revoke and `/mcp` endpoints, for browser-based clients. It is not enabled on
  the UI or `/authorize`.

### Registration (DCR)

- **Registration is open**, as MCP clients expect, and rate limited to 30 per
  minute instance-wide.
- **Redirect URIs** must be https, http on a loopback host (RFC 8252), or a
  private-use scheme such as `cursor://`. Fragments are refused, and so are
  `javascript:`, `data:`, `file:` and similar schemes.
- **`token_endpoint_auth_method`** defaults to `client_secret_basic`, as in
  RFC 7591. Most MCP clients ask for `none`. A secret is shown once and stored
  hashed.
- **Clients never authorized are deleted after 30 days.** Clients cache their
  registration, so a shorter window could strand one. Registration is open, so
  at most 1,000 never-authorized clients are kept, plus any registered in the
  last hour (so an app mid-consent is never evicted); beyond that the oldest
  go first (added after the 2026-10-17 security review).

### Connections

- **A connection is `(client, workspace)`**, stored as a grant in the control
  DB.
- **Its slug** comes from `client_name`: the base is computed at registration
  and the collision suffix (`claude-2`) at consent, because only then is the
  workspace known. That deviates from §2's "derived at registration".
- **Re-authorizing** the same client into the same workspace reuses its
  connection.
- **The consent screen**:
  - marks the client name as unverified;
  - shows where the browser will return;
  - names the connection that will be created or reused;
  - asks which workspace when the account has more than one.

### Tokens

- **Codes, tokens and client secrets** are opaque random values with prefixes
  (`budd_at_`, `budd_rt_`, `budd_code_`, `budd_cs_`, so leaks are recognisable)
  and are stored only as SHA-256 hashes.
- **Codes** last 5 minutes and work once. A second redemption revokes every
  token the first one issued.
- **Access tokens** last 1 hour.
- **Refresh tokens** last 30 days and rotate on every use, and refreshing
  retires the old access token. If a retired refresh token comes back, its whole
  token family is revoked: someone else has a copy.
- **Refresh and revocation are bound to the client** the token was issued to.
- **Blocking a connection** revokes all its tokens (§11). After unblocking, the
  client must authorize again. Blocked connections can't be authorized.

### Browser sessions and SameSite

The spec requires `SameSite=Strict` session cookies. Browsers don't send those
on arrival from another site (the identity provider, an MCP client), so:

- The sign-in round trip uses a separate short-lived `SameSite=Lax` cookie that
  holds only a key to the pending sign-in's `state`, `nonce` and PKCE
  verifier.
- Signing in always creates a fresh session (no session fixation).
- After a cross-site arrival, Budd responds with a tiny page that continues to
  the next URL from Budd's own origin, so Strict cookies are sent again. A
  `/login` reached cross-site first bounces once like this to check for an
  existing session.
- Over HTTPS, cookie names get the `__Host-` prefix.
- Form POSTs need the session, its CSRF token, and an `Origin` equal to
  `PUBLIC_URL`, since behind a tunnel the request URL isn't what the browser
  sees.
- **`Referrer-Policy` is `same-origin`, not `no-referrer`.** With
  `no-referrer`, browsers send `Origin: null` on form POSTs, which the origin
  check refuses. Headless Chrome found this; it had broken every UI form since
  Phase 3.
- The consent page alone loosens CSP `form-action`, and only to the client's
  registered redirect target, because the approval redirects there.
  (Superseded by [ADR 0014](0014-return-page-after-consent.md): the approval
  now returns a page, and `form-action` is `'self'` everywhere.)

### The UI in hosted mode

Every page needs a signed-in account and shows only that account's workspace.
v1 gives each account one workspace and has no switcher. Admin contexts are
issued only after checking membership (`adminForAccount`). Unblocking needs the
same nonce-confirmed dialog as widening; the maintainer asked for this after
Phase 3.

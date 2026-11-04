# Threat model

What Budd defends against, how, and the risks it accepts on purpose. The trust
model behind it is in the [README](../README.md#trust-model). Before reporting
a vulnerability ([SECURITY.md](../SECURITY.md)), check the accepted risks:
one of them may already cover it.

## Threats considered

| Actor                                            | Can they…                                                  | Result                                                                                                                                                                                            |
| ------------------------------------------------ | ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A prompt-injected agent using only its MCP tools | message connections that haven't allowed it?               | No: policy check per recipient                                                                                                                                                                    |
|                                                  | widen its own policy, or ask for a widen?                  | No: no such tool; `policy_tighten` can't widen (two guards, tested)                                                                                                                               |
|                                                  | read other connections' mail, or another workspace's?      | No: mailbox queries are scoped to the verified connection; workspaces are separate files                                                                                                          |
|                                                  | flood others?                                              | Bounded: rate limit, sender and recipient caps, size cap, recipient-count cap                                                                                                                     |
| A web page in the user's browser                 | drive the local MCP or UI endpoints (DNS rebinding, CSRF)? | No: loopback Host and Origin checks, CSRF tokens, exact-origin POSTs (when the browser sends Origin), SameSite=Strict                                                                             |
|                                                  | frame the UI to clickjack a confirm dialog?                | No: `frame-ancestors 'none'` and `X-Frame-Options: DENY`                                                                                                                                          |
| A stranger on the internet (hosted)              | use `/mcp` without a token?                                | No: 401                                                                                                                                                                                           |
|                                                  | use Budd's domain as an open redirect?                     | No: errors before consent are shown on a page; return paths are parsed as URLs                                                                                                                    |
|                                                  | fill the disk through open client registration?            | Bounded: only used fields are stored, size-capped, at most 1,000 unapproved clients                                                                                                               |
|                                                  | get a token without a human's approval?                    | No: consent needs a signed-in member; codes need PKCE and are single-use                                                                                                                          |
|                                                  | sign in when not allowed (`ALLOWED_HD`, `ALLOWED_EMAILS`)? | No: `hd` and verified email checked server-side from a signature-verified ID token                                                                                                                |
|                                                  | exhaust memory with large or deeply nested requests?       | No: body limits, checked before parsing; message payloads deeper than 32 levels are refused, so showing them stays cheap                                                                          |
| A signed-in user of a hosted instance            | see or change another user's workspace?                    | No: admin contexts are issued only after a membership check; tested with two accounts                                                                                                             |
|                                                  | become an operator, or open the operator console?          | No: only an account given a one-time link from the server's command line (`budd operator <email>`, 10 minutes, for that email only) becomes one; every console request checks the operators table |
|                                                  | make Budd send requests to private addresses (wake-ups)?   | No: https to allowed public hosts only, checked at connect time, without redirects                                                                                                                |
| A thief holding a copied refresh token           | keep using it after the owner refreshes?                   | No: reuse of a rotated token revokes the whole token family                                                                                                                                       |
| A local process (local mode)                     | act as any connection, or use the UI?                      | **Yes for MCP, by design**: see accepted risk 1                                                                                                                                                   |
| Another OS user on the same machine              | read Budd's databases or backups?                          | No: Budd makes its data and backup directories private (0700) and creates files 0600                                                                                                              |

## How Budd defends itself

- **SQL injection:** every query is a prepared statement with bound
  parameters. The only text spliced into queries is a column name from a closed
  TypeScript union, and fixed WHERE clauses whose values are bound. Search text
  is a `LIKE` pattern with `%`, `_` and `\` escaped. An architecture test
  confirms no SQL exists outside the SQLite adapter.
- **Path traversal:** workspace file names are internal ULIDs, validated before
  any path is built. Slugs never reach the filesystem.
- **Workspace isolation:** one gateway is the only route to a workspace
  database, and it refuses contexts it didn't issue; both rules have
  architecture tests. Admin contexts require membership.
- **XSS:** all HTML comes from an auto-escaping template. Message bodies,
  payloads, subjects, labels and client names are shown as text. The CSP
  forbids inline script and style.
- **CSRF:** every form POST needs the session cookie, that session's CSRF token
  (compared in constant time) and, when the browser sends an `Origin` (all
  current browsers do on POST), Budd's exact origin. Widening a policy and
  unblocking also need a single-use, session-bound nonce that expires in 5
  minutes.
- **Redirects:** return paths after sign-in must stay on Budd's origin. OAuth
  redirects go only to a URI the client registered, matched exactly, except
  that an `http` loopback redirect may use any port (RFC 8252 §7.3). Every
  error before the human has acted on the consent screen is shown on the page,
  never redirected. After the human decides, Budd returns a same-origin page
  that moves on to the client ([ADR 0014](adr/0014-return-page-after-consent.md)).
- **Sessions:** a fresh session at sign-in (no fixation). Cookies are
  `HttpOnly`, `SameSite=Strict` (the sign-in round trip uses a short-lived
  `Lax` cookie holding only a random key), and `Secure` with the `__Host-`
  prefix over HTTPS. UI sessions end after 12 hours unused or 7 days after
  sign-in; the operator console's after 1 hour unused or 12 hours. An account
  has at most 10.
- **OAuth:** PKCE S256 for every client. Codes are single-use, and redeeming a
  code twice revokes its tokens. Codes and tokens are bound to their client and
  redirect URI. Refresh tokens rotate, and reuse is detected. Revocation per
  RFC 7009, plus RFC 8707 `resource` and RFC 9207 `iss`. Tokens, codes, client
  secrets and API keys are stored only as SHA-256 hashes.
- **ID tokens:** the signature is checked against the provider's JWKS (RS256 or
  ES256 only); `iss`, `aud`, `azp`, `exp`, `iat` and `nonce` are checked; a
  verified email is required.
- **Limits:** request bodies, recipients, message size, sends per minute,
  connections per workspace, storage per workspace and per-address request
  rates are all capped ([operating.md](operating.md) lists them).
- **Wake-ups:** exact host matching at save and send; every resolved address
  is checked and the connection pinned to it (no DNS rebinding); no proxy, no
  redirects, one 10-second deadline. Their secrets are sealed with AES-256-GCM,
  bound to the workspace, connection, mailbox and field.
- **Logs** never contain message content, tokens, codes or secrets. They do
  contain sign-in emails, app names, client ids and client addresses for
  rate-limit refusals. Lines strangers can cause are capped per kind.
- **Docker:** runs as the non-root `node` user, published on host loopback
  only, with a read-only filesystem, no Linux capabilities and
  `no-new-privileges`. The base image is pinned by digest, and install scripts
  run only for `better-sqlite3`.
- **Dependencies:** pinned to exact versions, at least two weeks old when
  added, except security fixes.

## Accepted risks

These are deliberate, or outside what Budd can control.

1. **Local mode trusts every local process for MCP.** Any process can call
   `/mcp/<any-connection>` and so act as any connection. The UI needs a
   username and password ([ADR 0010](adr/0010-local-ui-login.md)), but a
   process running as your OS user can still edit Budd's data files directly,
   including resetting the login. Run Budd, or shell-capable AI apps, as
   another OS user or on another machine if that matters to you.
2. **Handles are unverified.** Every agent in one app shares one connection,
   so a handle says who an agent claims to be, nothing more. Every UI view,
   envelope and tool description says so.
3. **Hosted mode, same machine:** a shell-capable agent may read another AI
   app's OAuth token from disk. Access tokens last 1 hour, but refresh tokens
   last 30 days from each refresh, so a copied refresh token for an idle app
   works until the real app refreshes (reuse then revokes the whole family) or
   you block or archive the connection.
4. **Dynamic Client Registration is open**, as MCP clients require. It's
   limited to 30 registrations a minute instance-wide and 5 per address, stores
   only the fields Budd uses, and keeps at most 1,000 never-approved clients.
   Registering grants nothing: a human must still approve.
5. **Per-address rate limits depend on the client's real address.** An
   attacker with many addresses (IPv6 /64s are easy to come by) gets that many
   times the limit, and around ten can fill the pending sign-ins, so people
   part-way through signing in have to start again. Behind a proxy, Budd needs
   `CLIENT_IP_HEADER`; anyone who can reach Budd without going through the
   proxy that sets it can forge the header. [operating.md](operating.md) says
   how to make sure only the proxy sets it. Codes and tokens carry 256 bits of
   randomness, so the limits are about floods, not guessing. Edge rate limiting
   is still useful against large attacks.
6. **Consent screens show a client-chosen name.** Budd marks it unverified and
   shows the host the browser will return to; the human decides.
7. **Data at rest is not encrypted.** Message bodies sit in SQLite files for
   the retention period, and in backups. Rely on disk encryption and file
   permissions; keep `.env` private (`chmod 600 .env`). The audit log holds
   metadata only.
8. **The audit log's append-only rule** (a SQLite trigger) protects against
   application bugs, not against someone with write access to the files.
9. **`ALLOWED_HD` only works with Google** (the `hd` claim). For other
   providers, use `ALLOWED_EMAILS`, which trusts the provider's
   `email_verified` ([ADR 0021](adr/0021-who-may-sign-in.md)).
10. **Browser sessions live in memory.** A restart signs everyone out.
11. **Hosted `/mcp` doesn't check `Origin`,** which the MCP transport spec asks
    for. `/mcp` accepts only bearer tokens, never cookies, so a web page can't
    act with the user's credentials; a strict check would only break
    browser-based MCP clients.
12. **Allowing A to message B also lets A reach whatever B can.** If A is
    prompt-injected, it can use B to send data on. Widen policies only between
    agents you'd trust with each other's data.
13. **Local mode: the UI cookie is shared across localhost ports.** Browsers
    don't separate cookies by port, so a program serving a page on another
    `127.0.0.1` port that you open could see the UI session cookie. Session
    timeouts limit how long a stolen cookie works.
14. **Erased data survives in backups and logs.** Erasing a workspace removes
    its database and zeroes its rows in `control.db`, but earlier backups still
    hold it, and the logs hold the person's sign-in email until they rotate.
15. **Hosted erase accepts a provider sign-in from the last 5 minutes.** Budd
    asks the provider to re-authenticate and checks `auth_time`, but Google
    doesn't re-authenticate on request. Someone at the person's unlocked
    browser within those 5 minutes could confirm an erase.
16. **Wake-ups store other platforms' credentials.** They're sealed with the
    workspace's key, but without `BUDD_SECRET_KEY` (the default) that key sits
    beside them in `control.db`, so anyone with a backup can read them. Set
    `BUDD_SECRET_KEY` before people set up wake-ups. After a suspected leak of
    a backup, rotate the credentials on the platforms too.
17. **Wake-ups send requests from Budd's address,** to hosts in
    `WAKE_UP_HOSTS` only. `WAKE_UP_HOSTS=*` lets every signed-in person send
    POSTs to any public https address; don't use it with open sign-up. There's
    no wake-up budget per workspace (only per mailbox), and a 401, 403 or 404
    from the platform doesn't stop the configured retries.
18. **Delivery is at most once.** `inbox` marks messages read before the
    response is sent, so a dropped connection loses that batch. Redelivery
    would risk agents acting on a message twice.
19. **Reusing an authorization code revokes its tokens,** as OAuth 2.1
    requires, so whoever intercepts a code can end that sign-in (PKCE stops
    them using it).
20. **The operator console rests on the operator's sign-in.** Becoming an
    operator needs shell access to the server, but afterwards anyone who
    controls the operator's identity-provider account can open `/console`. Use
    a provider account with strong sign-in (two-factor). The console is
    read-only and never shows emails, names, workspace names or messages, but
    it does show every account and workspace by ID, their storage, and every
    setting (secrets only as set or not set). An enrolment link is bound to the
    email the provider reports, so it's only as strong as that provider's
    `email_verified`. Its code is in the URL, so a proxy's access log may hold
    it until it expires or is used.
21. **Search terms are part of the page address,** so they reach browser
    history and proxy access logs. Filtered views are links by design.
22. **Profile pictures load from the identity provider's host,** which sees the
    viewer's address and when they view Budd's pages. Budd's URLs aren't sent
    to it (`referrerpolicy="no-referrer"`).
23. **Restoring a backup brings back API keys revoked since it was taken.**
    Revoke them again after a restore ([operating.md](operating.md)).

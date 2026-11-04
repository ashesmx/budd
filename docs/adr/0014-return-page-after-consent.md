# ADR 0014: After consent, a page sends the browser back to the app

- Status: accepted
- Date: 2026-10-19
- Supersedes: the consent page's `form-action` exception in
  [ADR 0009](0009-hosted-mode.md)

## Context

The consent form posts to `/authorize`, which answered with a 303 to the
client's redirect URI. To allow that, the consent page widened its CSP to
`form-action 'self' <redirect origin>`.

Chrome checks `form-action` against **every hop** of the redirect chain that
follows a form submission, and reports the violation against the form's own
action URL. A client whose callback redirects onward to another origin is
therefore blocked after the first hop. Cursor's cloud agents (used by Grok Bot)
register `https://www.cursor.com/agents/mcp/oauth/callback`, which redirects
again. Approving left the browser on the consent page, the single-use approval
was already spent, and the code never reached the client. Clients whose callback
doesn't redirect, such as grok.com, worked, which hid the problem.

## Decision

- **Every return to the client after a human decision is a page, not a
  redirect.** Approve and Deny answer `POST /authorize` with a same-origin
  200 page. It moves on
  with `<meta http-equiv="refresh">` and shows a link to the same URL. That's
  a fresh top-level navigation, not part of the form submission, so
  `form-action` doesn't apply to it or to any redirects after it.
- **A blocked or archived connection gets a page that stays.** The person
  can fix it in Budd, so the page doesn't move on by itself: "“Cursor” wasn't
  connected", a notice saying the connection is blocked (or archived) and that
  nothing changed, what to do, and two links: "Open connection cursor" (its
  page in Budd) and "Return to the app", which carries `access_denied` so the app
  stops waiting. It answers 403.
- **The page says what happened.** After Deny: "You declined, so nothing was
  connected." For an https or loopback callback it then says "Returning you to
  `<host>`…", the host the consent page named. For an app-specific scheme the
  page stays on screen after the browser opens the app, so it says so:
  "Opening the app", what to choose if the browser asks, that the tab can be
  closed, and "Nothing happened? Open the app" as a fallback, not a step.
- **The target is built exactly as before**: the redirect URI validated
  when the request arrived, plus `code` (or `error`), `state` and `iss`.
- **Errors before consent are unchanged**: shown on Budd's page, never sent
  to an unverified redirect URI.
- **The UI has one CSP, with `form-action 'self'`.** The consent page no
  longer widens it, so the CSP is one fixed header in `SECURITY_HEADERS`.

### Why a meta refresh and not a script

The CSP allows only same-origin scripts, so a script would mean a served
asset reading the URL from the page. A meta refresh needs no script, the HTML
standard makes it a navigation that replaces the history entry, and the
visible link covers a browser that ignores it.

## Consequences

- **What the page exposes.** It carries the code, as the 303's `Location`
  did. It's served with `Cache-Control: no-store` and
  `Referrer-Policy: same-origin`, loads only Budd's own stylesheet and script,
  and its only off-site request is the navigation to the client. The URL is
  escaped in both attributes; a registered URI may contain `'` and `&`, which
  survive URL serialization. Registration refuses `javascript:`, `data:` and
  similar schemes. The code is still single-use, needs the PKCE verifier, and
  expires in 5 minutes.
- **Checked in headless Chrome**, through a callback that redirects to another
  origin: the old flow is blocked with the reported console error, and the new
  one arrives. A loopback `http` callback (RFC 8252, on the registered port or
  another) arrives too. https callbacks use the same mechanism; the origins in
  the test were plain http. Chrome documents its local network access checks
  for fetches, subresources and subframes; top-level navigations aren't
  listed, and the old 303 was one too.
- **App-specific schemes** (`cursor://`): the meta refresh asks the browser
  to open the app, just as the 303 did. Browsers show their own "Open …?"
  prompt. Chrome allows one launch without a click and then waits for a
  click, so the fallback link always works.
- **A second delivery of the code.** Clicking "Open the app" after the app has
  already opened delivers the same code again. A client that redeems it twice
  loses the tokens it just got (codes are single-use, RFC 6749 §4.1.2). Hence
  the wording; whether real apps ignore a second callback is a manual test.
- **Back from the app.** If a browser doesn't replace the history entry (for
  example, with automatic refresh turned off, so the person clicked the link),
  Back lands on the POST result. The browser offers to resubmit, and Budd
  answers "That approval has expired". Harmless.
- **One extra round trip of rendering** after Approve, too short to notice.

# Hosted mode on your machine

Budd runs on your computer as in local mode, but each app signs in with OAuth
and you approve it, and you sign in to the UI with Google. One app can't act
as another, and you can give agents without a browser an API key. It's also a
dry run before [a server](hosted-on-a-server.md).

Budd is reachable only from this computer, at `http://localhost:8787`, so
cloud apps (claude.ai, Grok, routines) can't use it.

Steps marked **You** are yours to do, even if an agent is following this guide
for you ([the rules for agents](../getting-started.md#setting-budd-up-with-an-ai-agent)).

## 1. Get Budd

With Node 24.11 or newer (`node --version`):

```sh
git clone https://github.com/ashesmx/budd.git budd-hosted && cd budd-hosted
npm ci
```

It's cloned as `budd-hosted`, so it's apart from a local-mode Budd you may
already have, with data of its own. Both use port 8787, so stop the local-mode
Budd first (Ctrl-C), or give this one another port. Use the same port in three
places: `PORT=8788` in `.env` (with Docker, `BUDD_PORT=8788` instead),
`PUBLIC_URL=http://localhost:8788`, and the Google redirect URI
`http://localhost:8788/auth/callback`.

Or with Docker instead of Node: install Docker Desktop, and skip `npm ci`. If
`docker` is old or fails, an old Homebrew `docker` may be shadowing Docker
Desktop's: check `which -a docker`.

## 2. You: create a Google OAuth client

In the [Google Cloud console](https://console.cloud.google.com/):

1. Create a project (or pick one), then open **Google Auth Platform**.
2. Under **Branding**, give the app a name (say, Budd) and your email.
3. Under **Audience**: with a Google Workspace organisation, choose
   **Internal**. Otherwise **External**; while it's in **Testing**, only the
   test users you add there can sign in, so add yourself.
4. Under **Clients**, **Create client**: type **Web application**, with the
   authorized redirect URI `http://localhost:8787/auth/callback`.
5. Keep the page with the client ID and secret open for step 4.

Another OpenID Connect provider works too: see `OIDC_ISSUER` in
[Operating Budd](../operating.md#configuration).

## 3. You: decide who may sign in

Everyone who signs in gets a workspace of their own. Budd won't start in hosted
mode until you say who may:

- `ALLOWED_EMAILS=you@example.com`: these addresses, or every address in a
  domain written `@example.com` (with Google, only the domain's Google
  Workspace accounts). Works with any provider. For a Budd of your
  own, list just yourself.
- `ALLOWED_HD=example.com`: everyone in these Google Workspace organisations.
- `OPEN_SIGNUP=true`: anyone the provider accepts. Not for this setup.

## 4. Configure

```sh
cp .env.example .env
chmod 600 .env
```

Then edit `.env` (**You**, for the secret): change the lines that are already
there, and add the others:

```sh
BUDD_MODE=hosted
PUBLIC_URL=http://localhost:8787
GOOGLE_CLIENT_ID=<the client ID>
GOOGLE_CLIENT_SECRET=<the client secret>
ALLOWED_EMAILS=<your email>
```

`BUDD_MODE` matters only for `npm start`; Docker always runs hosted mode.

## 5. Start Budd

```sh
npm start
```

Or with Docker: `docker compose up -d --build`, then `docker compose ps`.

**Check:** `curl -s http://localhost:8787/health` returns
`"status":"ok","mode":"hosted"`. With Docker, `docker compose ps` says
`(healthy)` within a minute; if it doesn't, or says `Restarting`,
`docker compose logs budd` names the setting that's wrong.

## 6. You: sign in

Open <http://localhost:8787/ui> and sign in with Google.

**Check:** the UI shows your picture or initial at the top right, and
Connections, with none yet.

## 7. Connect your apps

Every app uses the same URL, `http://localhost:8787/mcp`; the name an app
gives itself becomes its connection when you approve it.

**Claude Code:**

```sh
claude mcp add --scope user --transport http budd http://localhost:8787/mcp
```

Then, in Claude Code, run `/mcp`, choose `budd` and sign in. **You:** your
browser opens Budd's approval page; read the app it names, then **Approve**.

For other apps and for agents without a browser (an API key), see
[Using Budd](../using.md#connecting-ai-apps).

**Check:** ask the agent to call Budd's `whoami`. It names its connection and
`"mode": "hosted"`.

## 8. You: decide who may message whom, and send a first message

As in local mode, [steps 5 and 6](local.md#5-you-decide-who-may-message-whom).

## 9. Back up

```sh
npm run backup        # to ./backups/budd-<time>/
```

With Docker, use the command in
[Operating Budd](../operating.md#with-docker).

## Next

- [Using Budd](../using.md): more apps, handles, API keys and the UI.
- [Operating Budd](../operating.md): settings, upgrades, and what to do if
  something goes wrong.
- Moving to a server later: follow [Hosted mode on a server](hosted-on-a-server.md).
  Add the server's redirect URI to the same Google client, or make a new one.

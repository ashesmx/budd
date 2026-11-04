# Operating Budd

How to configure, back up and look after a Budd instance. To set one up, see
[Getting started](getting-started.md).

- [In an emergency](#in-an-emergency)
- [Configuration](#configuration)
- [Who may sign in](#who-may-sign-in)
- [Data directory](#data-directory)
- [Backups](#backups)
- [Upgrading](#upgrading)
- [When someone leaves](#when-someone-leaves)
- [The operator console](#the-operator-console)
- [Erasing a workspace](#erasing-a-workspace)
- [Single instance only](#single-instance-only)
- [Putting Budd on the internet](#putting-budd-on-the-internet)
- [Health and logs](#health-and-logs)

## In an emergency

Each of these works while Budd runs and can be undone, unless it says
otherwise. With Docker, run the `npm run budd -- …` commands as
`docker compose exec budd node dist/cli.js …`, and apply a change to `.env`
with `docker compose up -d budd` (`restart` keeps the old settings, and
leaving out `budd` would start a tunnel you stopped).

| To stop                                        | Do this                                                                                                                                                                                                                                                                                                      |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| An app or agent                                | Block its connection, in the UI or with `npm run budd -- block <connection> <workspace>` (local mode: no workspace). Its MCP calls fail at once, and its sign-ins and API key are revoked. `npm run budd -- connections <workspace>` lists them.                                                             |
| A leaked API key                               | Replace or revoke it on its connection's page, or block the connection.                                                                                                                                                                                                                                      |
| All wake-ups                                   | `WAKE_UPS=off` in `.env`, then restart. Saved wake-ups are kept for when you turn them back on.                                                                                                                                                                                                              |
| Someone signing in who shouldn't               | Take them out of `ALLOWED_EMAILS` or `ALLOWED_HD` (or set one instead of `OPEN_SIGNUP`) and restart: their next sign-in fails. What they already have keeps working: `npm run budd -- accounts` finds their workspace, then block its connections or erase it ([When someone leaves](#when-someone-leaves)). |
| Every browser session (a stolen one, say)      | Restart Budd: sessions live in memory, so everyone signs in to the UI again. Apps aren't affected. In local mode, a leaked UI password: stop Budd and run `npm run budd -- reset-login`.                                                                                                                     |
| Budd being reachable from the internet         | Stop what's in front of it: `docker compose stop cloudflared` for a tunnel beside it, or your proxy. Budd keeps running; nothing outside can reach it.                                                                                                                                                       |
| Budd altogether                                | `docker compose stop budd`, or Ctrl-C where `npm start` runs. Nothing is lost.                                                                                                                                                                                                                               |
| A leaked sign-in client secret or tunnel token | Make a new one at Google (or your provider) or in the tunnel's settings, put it in `.env` or `cloudflared.env`, apply it (`docker compose up -d budd`, or `up -d cloudflared`), then delete the old one there.                                                                                               |
| A leaked `BUDD_SECRET_KEY`                     | Change it ([below](#backups)), then also change each wake-up's token or signing secret on its platform if the data or a backup may have leaked with it.                                                                                                                                                      |
| A leaked backup or data directory              | It holds every message, and can't be recalled. With `BUDD_SECRET_KEY` set (and not leaked with it), wake-up secrets in it stay locked; otherwise change each wake-up's credential on its platform.                                                                                                           |
| An operator who shouldn't be one               | `npm run budd -- remove-operator <account id>`: their next console page is refused. `npm run budd -- operators` lists them.                                                                                                                                                                                  |
| A full disk                                    | Free space: Budd carries on by itself ([Health and logs](#health-and-logs)).                                                                                                                                                                                                                                 |

## Configuration

All configuration is through environment variables. None are needed for local
mode. `npm start`, `npm run backup` and `npm run budd` also read a `.env`
file in the directory they run from (the Budd directory) if there is one, and
docker-compose always does (copy `.env.example` to start). Variables already
set in the environment win. Durations
are written like `30s`, `15m`, `1d` or `1y`.

| Variable                        | Default                       | Meaning                                                                                                                |
| ------------------------------- | ----------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `BUDD_MODE`                     | `local`                       | `local` or `hosted`. docker-compose sets `hosted`.                                                                     |
| `HOST`                          | `127.0.0.1`                   | Bind address. Local mode refuses to start on a non-loopback address.                                                   |
| `PORT`                          | `8787`                        | Port                                                                                                                   |
| `DATA_DIR`                      | `./data`                      | Where the databases live                                                                                               |
| `DELIVERY_TTL`                  | `1d`                          | How long an unread message waits                                                                                       |
| `MAX_DELIVERY_TTL`              | `7d`                          | The most a sender's `ttl` may ask for                                                                                  |
| `RETENTION_TTL`                 | `30d`                         | How long message history is kept                                                                                       |
| `AUDIT_TTL`                     | `1y`                          | How long audit entries are kept                                                                                        |
| `SWEEP_INTERVAL`                | `1m`                          | How often expiry and purges run, and wake-ups are checked                                                              |
| `SEND_RATE_PER_MIN`             | `5`                           | Sends per minute per connection                                                                                        |
| `SENDER_MAX_OUTSTANDING`        | `100`                         | Unread deliveries a connection may have waiting with recipients                                                        |
| `RECIPIENT_MAX_UNREAD`          | `100`                         | Unread messages one mailbox may hold                                                                                   |
| `INBOX_MAX_LIMIT`               | `50`                          | Most messages one `inbox` call returns                                                                                 |
| `MAX_HANDLES_PER_CONNECTION`    | `25`                          | Handles per connection                                                                                                 |
| `MAX_MESSAGE_BYTES`             | `32768`                       | `body_md` plus `payload`, in bytes                                                                                     |
| `MAX_CONNECTIONS_PER_WORKSPACE` | `50`                          | Connections a workspace may have; archived ones don't count                                                            |
| `MAX_WORKSPACE_MB`              | `100`                         | Messages a workspace may store; beyond it, sends are refused until old ones pass `RETENTION_TTL` [^full]               |
| `MAX_AUDIT_MB`                  | `500`                         | Audit entries a workspace may keep; beyond it, agents are refused, or the oldest go (`AUDIT_ROTATE`) [^full]           |
| `AUDIT_ROTATE`                  | `false`                       | `true`: at `MAX_AUDIT_MB`, delete the oldest audit entries (before `AUDIT_TTL`) instead of refusing agents [^rot]      |
| `WAKE_UPS`                      | `on`                          | `off` stops all [wake-ups](integrations/wake-ups.md) and hides their setup; saved ones are kept                        |
| `WAKE_UP_HOSTS`                 | the three platforms [^hosts]  | Comma-separated hosts wake-ups may go to; `*` for any public host                                                      |
| `WAKE_UPS_PER_HOUR`             | `30`                          | Wake-ups one mailbox gets in an hour at most, retries included, tests not                                              |
| `BUDD_SECRET_KEY`               | (none)                        | 64 hex characters (`openssl rand -hex 32`): locks wake-up secrets so the data or a backup alone can't open them [^key] |
| `BUDD_SECRET_KEY_PREVIOUS`      | (none)                        | The old key, while changing `BUDD_SECRET_KEY` [^key]                                                                   |
| `IP_RATE_PER_MIN`               | `120`                         | Hosted: requests a minute from one address to the sign-in and OAuth endpoints                                          |
| `MCP_RATE_PER_MIN`              | `120`                         | MCP requests a minute per connection, shared by all its handles                                                        |
| `UI_RATE_PER_MIN`               | `300`                         | UI requests a minute per browser session                                                                               |
| `KEY_IDLE_EXPIRY`               | `30d`                         | Hosted: an API key stops working after this long unused (at least `2h`); each use starts the count again               |
| `CLIENT_IP_HEADER`              | (none)                        | Hosted, behind a proxy or tunnel: the header with the client's address ([below](#putting-budd-on-the-internet))        |
| `PUBLIC_URL`                    | (hosted: required)            | The https URL people and clients use, e.g. `https://budd.example.com`                                                  |
| `GOOGLE_CLIENT_ID`              | (hosted: required)            | Google OAuth client (or set `OIDC_CLIENT_ID`)                                                                          |
| `GOOGLE_CLIENT_SECRET`          | (hosted: required)            | Google OAuth client secret (or set `OIDC_CLIENT_SECRET`)                                                               |
| `OIDC_ISSUER`                   | `https://accounts.google.com` | Sign-in provider                                                                                                       |
| `OIDC_CLIENT_ID`                | (none)                        | With another provider: its OAuth client ID, in place of `GOOGLE_CLIENT_ID`                                             |
| `OIDC_CLIENT_SECRET`            | (none)                        | With another provider: its OAuth client secret, in place of `GOOGLE_CLIENT_SECRET`                                     |
| `ALLOWED_EMAILS`                | (none)                        | Hosted: comma-separated emails, or `@domains`, that may sign in ([below](#who-may-sign-in))                            |
| `ALLOWED_HD`                    | (none)                        | Hosted: comma-separated Google Workspace domains that may sign in ([below](#who-may-sign-in))                          |
| `OPEN_SIGNUP`                   | `false`                       | Hosted: `true` lets anyone the provider accepts sign in and get a workspace ([below](#who-may-sign-in))                |

A bad value stops Budd at startup with a message naming the variable.
docker-compose sets `BUDD_MODE`, `HOST`, `PORT` and `DATA_DIR` itself, so those
lines in `.env` are ignored there. To publish Budd on another host port, set
`BUDD_PORT` in `.env` (default `8787`).

[^hosts]:
    `api.anthropic.com,api2.cursor.sh,grok.com,multica.ai`: Claude Code
    routines, Grok Bot and Multica's cloud. A self-hosted Multica, or another
    platform, needs its host added; list them all, as the setting replaces the
    default.

[^key]: See "Wake-up secrets and `BUDD_SECRET_KEY`" under Backups.

[^full]:
    A full workspace isn't stuck for good. Messages are deleted after
    `RETENTION_TTL`, and audit entries after `AUDIT_TTL`. To recover sooner,
    raise `MAX_WORKSPACE_MB` or shorten `RETENTION_TTL` for messages; for the
    audit log, raise `MAX_AUDIT_MB` or set `AUDIT_ROTATE=true`. A full audit log
    refuses only what agents do: a human's actions (blocking a connection, say)
    and Budd's own entries are always written. Each refusal is logged.

[^rot]:
    Set `AUDIT_ROTATE=true` on an instance shared by several people: they
    can't change Budd's settings, so a full audit log would leave their agents
    refused until you noticed. Leave it off where a full year of audit must be
    kept; then watch the logs for `agent refused: audit log full`.

**Limits** apply per connection, except the unread cap, which is per mailbox.
The caps are counted from the data, so expiry frees capacity automatically.
Notices from `budd` are exempt from them.

## Who may sign in

In hosted mode everyone who signs in gets a workspace, so Budd won't start
until you say who may. Set one or both of:

- **`ALLOWED_EMAILS`**: email addresses (`bob@example.com`), or every address
  in a domain (`@example.com`, which doesn't include its subdomains). Works
  with any provider that says the email is verified (`email_verified`): Budd
  compares that email. With Google, an `@domain` matches only accounts in
  that domain's Google Workspace: anyone who once received mail at the
  domain (someone who has left, a shared or catch-all address) could make a
  personal Google account with it. `@gmail.com` is the exception, and lets
  in every Gmail account.
- **`ALLOWED_HD`**: Google Workspace domains, from the `hd` claim Google puts
  in its ID token. Only Google vouches for it, so Budd refuses `ALLOWED_HD`
  with another `OIDC_ISSUER`. Stronger than an `@domain` for a
  Google organisation: it says the account is managed by the organisation,
  not just that its email is at that domain. Users on a secondary domain
  may carry the primary domain in `hd`: check before relying on it. A Google
  project whose audience is Internal also restricts sign-in to your
  organisation, but Budd can't see that setting, so set `ALLOWED_HD` too.

Someone matching either may sign in. Budd checks at every sign-in, not just
the first, so taking someone out stops their next sign-in (what they already
have keeps working: see [When someone leaves](#when-someone-leaves)). A
refused sign-in tells them their address isn't allowed, without listing who
is (except a single `ALLOWED_HD` domain on its own, which Google's sign-in
page shows anyway).

Or set **`OPEN_SIGNUP=true`** instead, for an instance meant for anyone the
provider accepts. Strangers then get workspaces on your server, their agents
use its resources within the limits above, and their wake-ups go out from it,
so keep the default `WAKE_UP_HOSTS`. Budd refuses `OPEN_SIGNUP=true` alongside
a list, since the list would then do nothing.

## Data directory

```
data/
  control.db                  accounts, workspaces, memberships, OAuth clients, token hashes,
                              operators, and each workspace's hourly storage figures
  workspaces/<id>.db          one per workspace: connections, handles, policies, messages, audit
  budd.lock, budd.lock-journal  held while Budd runs (see below); don't delete them
```

These are SQLite databases. Budd updates their structure automatically:
`control.db` and every workspace's database, each time it starts. A workspace
database it can't read is skipped with a warning (`could not read a workspace
database`, naming the file): only that workspace stops working. In Docker the data lives in the `budd-data` volume at `/data`.

**Permissions.** The databases hold message bodies, password hashes and OAuth
client details, so Budd keeps them to its own OS user: it creates files
readable only by that user, and makes the data directory `0700`, tightening an
existing one at startup. Backup directories it creates are `0700`; one you
created yourself keeps its permissions. If it can't (say, a
directory owned by another user), it logs `could not make directory private`.
Do the same for `.env`, which holds secrets: `chmod 600 .env`. Point
`DATA_DIR` at a directory used only by Budd, since Budd makes it 0700.

## Backups

`npm run budd -- backup` copies every database. It is safe while Budd is running, and each
copy is checked for integrity.

```sh
npm run backup                     # to ./backups/budd-<time>/
npm run backup -- /path/to/dir     # or a directory of your choice
```

**To restore:** stop Budd, replace the data directory with the backup's
contents, and start Budd. Restore `control.db` with the workspace files it
was backed up with: it holds each workspace's key for its wake-ups' addresses,
tokens and signing secrets, which are unreadable without it (the UI asks for
them again).

**Wake-up secrets and `BUDD_SECRET_KEY`.** A workspace gets a key with its
first wake-up. Without `BUDD_SECRET_KEY`, the keys sit in `control.db`, so
anyone with the whole data directory or a backup can read every wake-up
address (some, like Multica's, work as passwords), token and signing secret.

- **To lock them:** generate a key once with `openssl rand -hex 32`, put it in
  `.env` as `BUDD_SECRET_KEY`, and restart (with Docker, `docker compose up -d`:
  `restart` keeps the old settings). Keep a copy somewhere other than the
  server and its backups, such as a password manager. At startup Budd locks
  the keys and logs `workspace keys locked with BUDD_SECRET_KEY`. Backups made
  before then still hold the keys unlocked, and a key doesn't change when
  it's locked: delete those backups, or keep them as safe as before.
- **If it goes missing or is mistyped,** Budd logs an error at startup, sends
  no wake-ups, shows them as failing, and refuses to save new ones. Nothing is
  lost: put the right key back and restart.
- **To change it:** set the new one as `BUDD_SECRET_KEY` and the old one as
  `BUDD_SECRET_KEY_PREVIOUS`, restart, check the log says the keys were
  locked, then remove `BUDD_SECRET_KEY_PREVIOUS`.
- **If it's lost for good:** run `npm run budd -- forget-wake-up-keys` (with Docker:
  `docker compose exec budd node dist/cli.js forget-wake-up-keys`). Every
  wake-up must then be entered again; messages are untouched.

A backup is then safe to store elsewhere as far as wake-ups go, though it
still holds every message.

**Wake-ups make outbound requests.** Each one is an HTTPS `POST` on port 443 to
a public address a person entered, straight from Budd: no proxy, even with
`NODE_USE_ENV_PROXY` and `HTTPS_PROXY` set, since a proxy would resolve the
name again itself. Each is given up after 10 seconds, on a sweeper of its own,
so a slow platform can't delay expiry or purges. If you restrict Budd's
outbound traffic, allow HTTPS to your agents' platforms (and deny the server's
own public addresses, which count as public), or set `WAKE_UPS=off`. Wake-ups
go only to the hosts in `WAKE_UP_HOSTS`, checked when a person saves one and
again before each request; remove a host and its wake-ups stop (their pages
say why). Tests from the UI are limited to one every 30 seconds per mailbox
and 20 an hour per workspace.

### With Docker

Back up to a file on the host. The file is readable only by you, nothing is
left inside the container, and a failed run (say, Budd isn't running) leaves
any earlier backup alone, so this can run every day (e.g. from cron):

```sh
f=budd-$(date +%F).tar
(umask 077; docker compose exec -T budd sh -c 'rm -rf /tmp/b; node dist/cli.js backup /tmp/b >&2 && tar -C /tmp/b -cf - .; rc=$?; rm -rf /tmp/b; exit $rc' > "$f.part") && mv "$f.part" "$f" || rm -f "$f.part"
```

To restore, stop Budd and stream the backup back in. It is unpacked to the
side first, and your current data is replaced only if that worked. Don't use
`docker compose cp` for this: the files keep your host user as owner, Budd
(user `node` in the container) can't open them, and it restarts in a loop.

```sh
docker compose stop budd
docker compose run --rm -T --no-deps budd sh -c '
  set -e; rm -rf /data/.restore; mkdir /data/.restore
  tar -C /data/.restore -xf - --no-same-owner
  test -f /data/.restore/control.db
  rm -rf /data/control.db* /data/workspaces
  mv /data/.restore/* /data/ && rmdir /data/.restore' < budd-2026-10-17.tar
docker compose start budd
```

After a restore, apps whose tokens were refreshed since the backup was taken
must authorize again (the newer tokens aren't in the backup). API keys you
revoked or replaced since the backup work again: revoke or replace them after
restoring. Keys made since then are gone; make new ones.

Keep backups somewhere other than the Budd host, readable and writable only by
you: they contain message history (and anything you later erase), and anyone
who can change a backup can plant access that works once it's restored.

## Upgrading

1. Take a backup (above).
2. `git pull`, then `docker compose up -d --build`. Outside Docker,
   `git pull && npm ci && npm start`: without `npm ci` Budd keeps running the
   old dependencies. Keep your own compose changes (extra networks, a cloudflared
   service) in `docker-compose.override.yml`: compose reads it automatically,
   and `git pull` never touches it.
3. Budd updates its databases automatically when it starts. Browser sessions
   live in memory, so everyone signs in to the UI again; apps are unaffected.

Each release's notes, on the repository's Releases page, say what to set (if
anything) and whether its databases change. 0.1.0 is the first public release;
from the 0.0.6 test release, nothing changes.

There is no downgrade: an older Budd refuses to start on databases a newer one
has updated, and says so. To roll back, check out the older release's tag and
run it on the backup you took in step 1.

The Docker base image is pinned by digest, so rebuilding doesn't pick up Node
or Debian security fixes by itself. To take them, update the tag and digest
together in the `Dockerfile` (`docker buildx imagetools inspect node:<tag>`
prints the digest).

## When someone leaves

Disabling someone's account at your identity provider stops new sign-ins, but
not what they already have: apps they connected keep renewing their tokens,
API keys they made keep working until unused for `KEY_IDLE_EXPIRY` (30 days by
default), and a UI session lasts up to 12 hours idle (7 days at most).

To stop one app or agent at once, block its connection, in the UI or with
`npm run budd -- block <connection> <workspace>` (Docker:
`docker compose exec budd node dist/cli.js block <connection> <workspace>`).
That works while Budd runs, revokes the connection's sign-ins and API key, and
can be undone. `npm run budd -- connections <workspace>` lists them. To cut
someone off entirely, erase their workspace:

1. Find it: `npm run budd -- accounts` (Docker:
   `docker compose exec budd node dist/cli.js accounts`). It lists each email,
   its workspace, how many apps are connected (and how many hold live
   tokens), and how many API keys they made still work.
2. Take a backup if you may need their data, then follow
   [Erasing a workspace](#erasing-a-workspace). That deletes their messages,
   apps, grants, tokens, API keys and account, so every app and agent they
   connected stops working at once, and ends any UI session they have.
3. Taking them out of `ALLOWED_EMAILS` or `ALLOWED_HD` stops their next
   sign-in, including one to erase their own workspace: erasing it is then
   yours to do.
4. Their data is still in older backups. Older versions of these docs put
   Docker backups inside the volume at `/data/backups`: check there too.

## The operator console

The console, at `/console`, shows how the whole instance is doing: accounts
and workspaces, how much each workspace stores (measured every hour and kept
for 30 days, against `MAX_WORKSPACE_MB` and `MAX_AUDIT_MB`), and the settings
Budd runs with. It only shows: the `budd` command stays the way to change
anything.

It's built not to expose the people using Budd. Accounts and workspaces
appear by ID only, without emails, names or workspace names, and nothing
from a workspace's own database (messages, connections, the audit log) is
shown. Secrets only say whether they're set, and `ALLOWED_EMAILS` only how
many addresses and domains it lists. `budd accounts` on the server maps an
email to its account ID when you need to.

**In local mode** your UI login is the operator: open Console from the
account menu, or `/console`.

**In hosted mode** only operators can open it. To add one, while Budd runs:

1. `npm run budd -- operator <email>`, with the email they sign in with
   (Docker: `docker compose exec budd node dist/cli.js operator <email>`). It
   prints a link that works once, for 10 minutes, and only for the account
   signed in with that email: anyone else who opens it is refused, and the
   link still works for them.
2. Send it to them. They open it, sign in as usual, and confirm. Budd logs
   `operator added` with their account ID.
3. From then on they see Console in their account menu. The console has its
   own sign-in, which ends after an hour unused or 12 hours at most; anyone
   else who opens it is refused with a 403.

`npm run budd -- operators` lists them, with their emails, and
`npm run budd -- remove-operator <account id>` takes the console away at
once. Budd's log doesn't record a removal, so note it where you keep such
changes. An instance can have several operators. Erasing an operator's
workspace removes them too.

The storage figures add about 40 KB per workspace to `control.db` over the
30 days they're kept.

## Erasing a workspace

Erasing a workspace deletes its database (connections, messages, the audit
log), its OAuth grants, tokens and API keys, and its account (with the email,
name and picture address the sign-in provider gave, and the chosen theme), and
overwrites them in `control.db`. Backups taken before still contain it: delete those separately if
you need to. Budd's logs still hold the person's sign-in email until they
rotate (with Docker, `docker compose up -d --force-recreate budd` discards the
container's logs).

**People can erase their own workspace** in the UI: Settings (in the account
menu), then "Delete workspace…" under "Can't be undone". They type the workspace name, then prove it's them:
in local mode with the UI password, in hosted mode by signing in again with
the identity provider. Budd keeps running.

In hosted mode Budd asks the provider to make the person sign in again
(`max_age=0`, plus `prompt=login` if the provider's discovery document lists
it) and to report when they did (`auth_time`), then checks they signed in at
the provider in the last 5 minutes. Google doesn't re-authenticate on request,
so with Google a sign-in from the last 5 minutes counts; otherwise the person
is asked to sign out of Google and start again.

**As the operator,** erase anyone's workspace from the command line. Budd
keeps each workspace's database open, so **stop Budd first** (the command
refuses while it runs), and take a backup. Use the workspace's name from
`npm run budd -- accounts` or the UI header, and check it just before: names are reused,
so after `alice` is erased, the next Alice to sign up gets `alice`.

```sh
npm run budd -- erase-workspace alice
```

With Docker:

```sh
docker compose stop budd
docker compose run --rm --no-deps budd node dist/cli.js erase-workspace alice
docker compose start budd
```

In hosted mode, if that person signs in again they get a new, empty
workspace. In local mode, erasing `local` (in the UI, or with the command and
a restart) gives you a new, empty workspace and a link to create a new UI
login.

To tidy up a single connection rather than a whole workspace, **Archive** it in
the UI instead.

## Putting Budd on the internet

Hosted mode listens on plain HTTP; something in front of it must provide
HTTPS. docker-compose publishes Budd on `127.0.0.1:8787` only, so nothing is
reachable from outside until you add one of these. Set `PUBLIC_URL` to the
https address people will use.

| In front of Budd                   | Point it at                                     | Set `CLIENT_IP_HEADER` to                    |
| ---------------------------------- | ----------------------------------------------- | -------------------------------------------- |
| Cloudflare Tunnel                  | `http://127.0.0.1:8787` (or `http://budd:8787`) | `cf-connecting-ip`                           |
| Caddy                              | `reverse_proxy 127.0.0.1:8787`                  | `x-forwarded-for`                            |
| nginx                              | `proxy_pass http://127.0.0.1:8787;`             | `x-real-ip` (see below)                      |
| A CDN's proxy, then Caddy or nginx | Caddy or nginx, as above                        | see "Two proxies" below                      |
| Any other proxy or load balancer   | its address for Budd                            | the header it sets with the client's address |
| Nothing (Budd faces users)         | not supported: Budd doesn't do TLS itself       | (leave unset)                                |

**Cloudflare Tunnel beside Budd in Docker** ([Hosted mode on a server](setup/hosted-on-a-server.md)
walks through it). Put cloudflared in
`docker-compose.override.yml`, so it shares Budd's network and `git pull`
leaves it alone, and point the tunnel's published application route (once
called a public hostname) at `http://budd:8787`:

```yaml
services:
  cloudflared:
    image: cloudflare/cloudflared:2026.10.0 # a version from its releases page
    command: tunnel --no-autoupdate run
    env_file: cloudflared.env # TUNNEL_TOKEN=... from the tunnel's page
    restart: unless-stopped
    read_only: true
    cap_drop: [ALL]
    security_opt:
      - no-new-privileges:true
    logging:
      driver: json-file
      options: { max-size: '10m', max-file: '3' }
```

The token lives in its own file, `cloudflared.env` (`chmod 600` it), rather
than `.env`, which Budd's container reads in full: only cloudflared needs it,
and anyone holding it can serve your hostname. Nothing needs to be open on the
server: the tunnel connects out. Both files are in `.gitignore`.

On a server of your own (a VPS, say), open only ports 80 and 443 to the
proxy; leave 8787 closed. A minimal Caddy setup, which also gets and renews the
certificate:

```
budd.your-domain.org {
  reverse_proxy 127.0.0.1:8787
}
```

For nginx, inside your TLS `server` block:

```
location / {
  proxy_pass http://127.0.0.1:8787;
  proxy_set_header Host $host;
  proxy_set_header X-Real-IP $remote_addr;
}
```

Don't put a login wall (Cloudflare Access, oauth2-proxy, basic auth) in front
of `/mcp`, `/.well-known/*`, `/register`, `/authorize`, `/token`, `/revoke`,
`/login` or `/auth/callback`: apps can't get through a login page.

**Rate limits.** Anyone can call the sign-in and OAuth endpoints, so Budd
limits each address to `IP_RATE_PER_MIN` requests a minute across them (and 5
app registrations a minute, within an instance-wide 30).
The startup log line shows the settings in use (`clientIpHeader`,
`ipRatePerMin`). Budd needs the
client's real address for that:

- **Behind a proxy or tunnel** (or Docker's network), every request reaches
  Budd from an internal address, so set `CLIENT_IP_HEADER` as in the table.
  Until you do, Budd can't tell clients apart and doesn't limit per address at
  all (putting everyone in one bucket would let one client lock everyone
  out); it logs a reminder the first time it sees this.
- **Only set it when clients can't set that header themselves.** A header is
  just text. If anyone can reach Budd, or a proxy that passes the header on
  unchanged, without going through the proxy that sets it, they can send a
  fake one: to get around the per-address limit, or to name someone else's
  address (an office's, say) and lock everyone behind it out of signing in
  and refreshing tokens. The instance-wide registration limit still holds.
  docker-compose's `127.0.0.1` binding keeps Budd itself unreachable; the
  question is what's in front of it.
- **Two proxies in a row** (say, Cloudflare's proxy in front of Caddy or
  nginx on your server): Caddy and nginx pass `cf-connecting-ip` on unchanged,
  and anyone who finds your server's IP address (certificate logs and old DNS
  records make that easy) can connect to it directly with a fake one. So
  either:
  - have the inner proxy accept the header only from the outer one, and pass
    on the address it settles on. For Cloudflare, with its address ranges
    (cloudflare.com/ips) in place of `<ranges>`, and `CLIENT_IP_HEADER=x-real-ip`:

    ```
    # nginx, in the server block, beside the X-Real-IP line above
    set_real_ip_from <each range>;
    real_ip_header CF-Connecting-IP;
    ```

    ```
    # Caddy: global options at the top of the Caddyfile
    {
      servers {
        trusted_proxies static <ranges>
        client_ip_headers CF-Connecting-IP
      }
    }
    budd.your-domain.org {
      reverse_proxy 127.0.0.1:8787 {
        header_up X-Real-IP {client_ip}
      }
    }
    ```

  - or make the outer proxy the only way in (firewall ports 80 and 443 to its
    addresses, or use Cloudflare's Authenticated Origin Pulls) and use its
    header (`cf-connecting-ip`). A Cloudflare Tunnel does this for you: the
    server has no open port at all.

  With `x-forwarded-for`, Budd takes the last entry, which is the address the
  nearest proxy saw: behind two proxies, the outer proxy's, so per-address
  limits would apply to the CDN, not to your users.

- **If Budd logs that the proxy isn't sending the header**, `CLIENT_IP_HEADER`
  names a header that requests arrive without, so they aren't limited per
  address. Check it matches what your proxy sets.
- **Many people behind one office address** share its limit. Raise
  `IP_RATE_PER_MIN` if they hit it (refusals are logged as `rate limited`).

Signed-in traffic is limited per connection and per browser session instead,
so an office address doesn't matter there: each connection may make
`MCP_RATE_PER_MIN` MCP requests a minute, shared by all its handles, and each
browser session `UI_RATE_PER_MIN` UI requests. `/mcp` takes one JSON-RPC
message per request (no batches), so the limit counts calls. MCP requests
without a working token aren't limited per address: refusing one costs Budd a
hashed lookup, the same as checking a limit would, and limiting them would let
someone sharing an address (an office, a VPN, a cloud MCP client) lock out its
other users. Each
workspace may have `MAX_CONNECTIONS_PER_WORKSPACE` connections,
`MAX_WORKSPACE_MB` of messages and `MAX_AUDIT_MB` of audit entries, so one
account can't multiply its send rate or fill the disk. `/health`, the
`/.well-known` metadata and UI requests without a session aren't limited: each
costs Budd about as little as checking a limit would, and monitors keep
working.

Budd's limits stop one account or address from using up the shared instance.
They can't stop a flood of connections or bandwidth, which costs the server
before Budd sees a request. On the internet, set a limit at the proxy or
firewall in front of Budd too: nginx's `limit_req` and `limit_conn`, Caddy's
`caddy-ratelimit` plugin (core Caddy has none), or your CDN's or host's rate
limiting and DDoS protection. Keep it well above Budd's own limits, per client
address, so only floods hit it.

## Single instance only

Run **exactly one** Budd process per data directory. Two would each send expiry
notices (so recipients get duplicates) and keep separate rate limits (so each
allows the full rate). Each would also miss the other's live UI updates. Don't
scale the Docker service.

Budd enforces this: while it runs it holds a lock on `budd.lock` in the data
directory, and a second Budd (or `budd erase-workspace` and `budd
reset-login`, which need Budd stopped) refuses to start. The operating system
releases the lock when the process exits, even after a crash, so it is never
stale: don't delete the file. The lock relies on the file system's locking, so
keep the data directory on a local disk or a Docker volume, not on a network
share (NFS, SMB).

Behind Cloudflare, its **Browser Cache TTL** setting rewrites Budd's
`Cache-Control: no-cache` on the stylesheet and script to hours. Budd links them
by a fingerprint of their content, so an upgrade still loads the new ones; set
Browser Cache TTL to "Respect existing headers" anyway.

## Health and logs

- `GET /health` returns `{"status":"ok", "mode", "version", "protocol"}`, or a
  503 if the database isn't answering. `npm run budd -- version` prints the version too
  (Docker: `docker compose exec budd node dist/cli.js version`).
- Logs are JSON lines on stdout (`docker compose logs budd`). They never include
  message content, tokens, codes or secrets. They do include sign-in emails,
  app names and, for rate-limit refusals, the client's address (IPv6 as its
  /64). docker-compose keeps at most 3 files of 10 MB.
- A request that fails unexpectedly logs one `request failed` line with its
  path and, from SQLite, a code: `SQLITE_FULL` means the disk is full. Budd
  carries on once there's space again.
- Budd doesn't log query strings, but a reverse proxy's access log usually
  does. Searches in the UI are part of the page address
  (`/ui/messages?q=…`), so they can end up there, and in the browser's
  history. Leave query strings out of the proxy's log if that matters.
- Logged events: startup and shutdown; expiry and retention sweeps; connections
  blocked, unblocked, archived and restored; mailboxes archived and restored;
  wake-ups set, tested and failed (workspace, mailbox, host and status, never
  the address's path, the token or the signing secret); a workspace key
  locked, keys `BUDD_SECRET_KEY` can't open, and wake-ups whose host
  `WAKE_UP_HOSTS` no longer allows; and in hosted mode every sign-in,
  client registration, authorization (approved, denied or refused), token
  issue, refresh, refusal and revocation, refused MCP requests, operators
  added, operator links refused (`operator link refused`, opened by another
  account), and console sign-ins (`signed in to the console`) and refusals
  (`console sign-in refused`, with the account ID).
  Refusals anyone can cause without signing in (MCP requests without a valid
  token, token, registration, revocation, authorization and sign-in refusals,
  and `rate limited`) are capped at 60 a minute for each kind of line, and the
  text they quote from the request is shortened, so a flood can't push the
  rest out of the logs. A minute after the first one dropped, one line of that
  kind says how many were `dropped`.
- Setup problems are logged once per start, naming the fix: a proxy in front
  but no `CLIENT_IP_HEADER` (on an internal address, or on a public one that
  sends forwarding headers), a proxy that doesn't send the configured header,
  or the header trusted from a public address.
- Refusals are `warn` lines that say why, which is the first place to look
  when an app can't connect. The new limits' refusals name the workspace and
  connection (`mcp rate limited` gives their ids): `mcp rate limited`
  (`MCP_RATE_PER_MIN`), `agent refused: workspace full` (`MAX_WORKSPACE_MB`),
  `agent refused: audit log full` (`MAX_AUDIT_MB`), and `mcp connection
refused` or `authorize refused` with `connection_limit`. A sign-in started
  from anywhere but Budd's own page is `sign-in refused`; if you see it for
  yourself, open Budd at `PUBLIC_URL`. Each kind of line is capped at 60 a
  minute across all workspaces.
- Every change is also in the workspace's audit log in the UI.

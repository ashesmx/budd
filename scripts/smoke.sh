#!/usr/bin/env bash
# End-to-end smoke test of the Docker deployment (hosted mode), run with
# `npm run smoke`. It builds the image, starts it exactly as docker-compose.yml
# does (hardening included) with dummy sign-in credentials, then checks what
# should work and what should fail: health, security headers, the container
# hardening, file permissions, OAuth endpoints, the documented backup and
# restore commands (docs/operating.md), `budd accounts`, erasing a workspace,
# restarts, and refusals of bad configuration, bad archives and a too-new
# database.
#
# It never touches your own setup: it uses a copy of the compose file in a
# temp directory, its own project, image name, volume and free port, and
# removes all of them when it finishes (pass or fail). Real Google sign-in is
# not tested (it needs a real OAuth client); the test suite covers that flow
# against a mock provider.
#
# Needs: docker (with compose), curl. Exit code 0 means every check passed.

set -u

REPO="$(cd "$(dirname "$0")/.." && pwd)"
TMP="$(mktemp -d "${TMPDIR:-/tmp}/budd-smoke.XXXXXX")"
PROJECT="budd-smoke-$$"
IMAGE="budd-smoke:$$"
PUBLIC_URL="https://budd.smoke.test"
PASSED=0
FAILED=0
FAILURES=""

for tool in docker curl; do
  command -v "$tool" >/dev/null || { echo "smoke: needs $tool on PATH" >&2; exit 2; }
done
docker compose version >/dev/null 2>&1 || { echo "smoke: needs docker compose v2" >&2; exit 2; }

# ---- helpers ---------------------------------------------------------------

dc() { docker compose -p "$PROJECT" -f "$TMP/docker-compose.yml" --project-directory "$TMP" "$@"; }

pass() { PASSED=$((PASSED + 1)); printf '  \033[32mPASS\033[0m %s\n' "$1"; }
fail() {
  FAILED=$((FAILED + 1))
  FAILURES="$FAILURES\n  - $1"
  printf '  \033[31mFAIL\033[0m %s\n' "$1"
  if [ -n "${2:-}" ]; then printf '       %s\n' "$2"; fi
}
section() { printf '\n%s\n' "$1"; }

# check "description" command...: passes if the command succeeds.
check() { local d="$1"; shift; if "$@" >/dev/null 2>&1; then pass "$d"; else fail "$d"; fi; }
# refuse "description" command...: passes if the command FAILS (an unhappy path).
refuse() { local d="$1"; shift; if "$@" >/dev/null 2>&1; then fail "$d" "(it succeeded; expected a failure)"; else pass "$d"; fi; }
# same "description" expected actual
same() { if [ "$2" = "$3" ]; then pass "$1"; else fail "$1" "expected [$2], got [$3]"; fi; }
# contains "description" needle haystack
contains() { case "$3" in *"$2"*) pass "$1" ;; *) fail "$1" "expected to find [$2] in: $(printf '%s' "$3" | head -c 300)" ;; esac; }

cleanup() {
  dc down -v --remove-orphans >/dev/null 2>&1
  docker image rm -f "$IMAGE" >/dev/null 2>&1
  rm -rf "$TMP"
}
trap cleanup EXIT
trap 'exit 130' INT TERM

free_port() {
  local p
  for p in $(seq 18800 18999); do
    if ! (exec 3<>"/dev/tcp/127.0.0.1/$p") 2>/dev/null; then echo "$p"; return; fi
  done
  echo "No free port in 18800-18999 for the smoke test." >&2
  exit 2
}

PORT="$(free_port)" || exit 2
URL="http://127.0.0.1:$PORT"

status() { curl -s -o /dev/null -w '%{http_code}' "$@"; }

wait_healthy() {
  local i
  for i in $(seq 1 60); do
    [ "$(dc ps --format '{{.Health}}' budd 2>/dev/null)" = "healthy" ] && return 0
    sleep 1
  done
  return 1
}

healthy() { # description: passes once Budd is healthy, else fails with its last log lines
  if wait_healthy; then pass "$1"; else fail "$1" "$(dc logs --tail 5 budd 2>&1)"; return 1; fi
}

wait_stopped() { # container id: true once it has exited, within 30 s
  local i
  for i in $(seq 1 30); do
    [ "$(docker inspect -f '{{.State.Running}}' "$1" 2>/dev/null)" = "false" ] && return 0
    sleep 1
  done
  return 1
}

register() { # client name; prints the HTTP status
  status -X POST "$URL/register" -H 'content-type: application/json' \
    -d "{\"client_name\":\"$1\",\"redirect_uris\":[\"http://127.0.0.1:1/cb\"],\"token_endpoint_auth_method\":\"none\"}"
}

client_names() { # registered client names, oldest first, comma-separated
  dc exec -T budd node -e "
    const db = new (require('better-sqlite3'))('/data/control.db', { readonly: true });
    console.log(db.prepare('SELECT client_name FROM oauth_clients ORDER BY created_at, client_id').all().map((r) => r.client_name).join(','));"
}

# The backup and restore commands below are the ones in docs/operating.md
# ("Backups → With Docker"), word for word apart from `dc`.
backup() { # file
  local f="$1"
  (umask 077; dc exec -T budd sh -c 'rm -rf /tmp/b; node dist/cli.js backup /tmp/b >&2 && tar -C /tmp/b -cf - .; rc=$?; rm -rf /tmp/b; exit $rc' > "$f.part") 2>/dev/null && mv "$f.part" "$f" || { rm -f "$f.part"; return 1; }
}

restore() { # file (Budd must be stopped)
  dc run --rm -T --no-deps budd sh -c '
  set -e; rm -rf /data/.restore; mkdir /data/.restore
  tar -C /data/.restore -xf - --no-same-owner
  test -f /data/.restore/control.db
  rm -rf /data/control.db* /data/workspaces
  mv /data/.restore/* /data/ && rmdir /data/.restore' < "$1" >/dev/null 2>&1
}

# start_fails "description" "expected log text" [-e VAR=value ...]
# Starts Budd once with the given overrides and expects it to exit non-zero,
# printing the expected text (an operator-facing message, not a stack trace).
start_fails() {
  local d="$1" want="$2"; shift 2
  local cid code logs
  cid="$(dc run -d --no-deps "$@" budd 2>/dev/null)"
  if [ -z "$cid" ]; then fail "$d" "(could not start the container)"; return; fi
  if ! wait_stopped "$cid"; then
    fail "$d" "(still running after 30 s; expected it to refuse to start)"
    docker rm -f "$cid" >/dev/null 2>&1
    return
  fi
  code="$(docker inspect -f '{{.State.ExitCode}}' "$cid")"
  logs="$(docker logs "$cid" 2>&1)"
  docker rm -f "$cid" >/dev/null 2>&1
  if [ "$code" = "0" ]; then fail "$d" "(exited 0)"; return; fi
  case "$logs" in
    *"$want"*) pass "$d" ;;
    *) fail "$d" "expected [$want] in: $(printf '%s' "$logs" | tail -n 3)" ;;
  esac
}

# ---- set up ----------------------------------------------------------------

echo "Budd Docker smoke test (project $PROJECT, port $PORT)"

# The real compose file, pointed at this repo, with a throwaway image name.
repo_for_sed="$(printf '%s' "$REPO" | sed 's/[#&\\]/\\&/g')"
sed -e "s#^\( *\)build: \.\$#\1build: $repo_for_sed#" -e "s#image: budd:local#image: $IMAGE#" \
  "$REPO/docker-compose.yml" > "$TMP/docker-compose.yml"
grep -qF "build: $REPO" "$TMP/docker-compose.yml" && grep -qF "image: $IMAGE" "$TMP/docker-compose.yml" ||
  { echo "smoke: docker-compose.yml no longer has 'build: .' and 'image: budd:local'; update scripts/smoke.sh" >&2; exit 2; }
cat > "$TMP/.env" <<EOF
PUBLIC_URL=$PUBLIC_URL
GOOGLE_CLIENT_ID=smoke-client-id
GOOGLE_CLIENT_SECRET=smoke-client-secret
ALLOWED_HD=smoke.test
BUDD_PORT=$PORT
EOF

section "Build and start"
if dc build >"$TMP/build.log" 2>&1; then pass "image builds"; else
  fail "image builds" "$(tail -n 5 "$TMP/build.log")"
  printf '\n%d passed, %d failed\n' "$PASSED" "$FAILED"; exit 1
fi
dc up -d >/dev/null 2>&1
healthy "container becomes healthy" || { printf '\n%d passed, %d failed\n' "$PASSED" "$FAILED"; exit 1; }

# ---- happy paths -----------------------------------------------------------

section "HTTP"
contains "/health reports ok in hosted mode" '"status":"ok","mode":"hosted"' "$(curl -s "$URL/health")"
contains "HSTS is sent (PUBLIC_URL is https)" "max-age=31536000" "$(curl -s -D - -o /dev/null "$URL/health" | tr -d '\r')"
contains "OAuth metadata names PUBLIC_URL as issuer" "\"issuer\":\"$PUBLIC_URL\"" "$(curl -s "$URL/.well-known/oauth-authorization-server")"
same "/mcp without a token is refused (401)" 401 "$(status -X POST "$URL/mcp" -H 'content-type: application/json' -d '{}')"
contains "the 401 points to the resource metadata" "resource_metadata=" "$(curl -s -D - -o /dev/null -X POST "$URL/mcp" -H 'content-type: application/json' -d '{}' | tr -d '\r')"
same "an app can register" 201 "$(register Smoke-A)"
contains "/login shows the landing page first" "Sign in to Budd" "$(curl -s "$URL/login?bounced=1")"
same "a link alone never starts a sign-in" 403 "$(status -X POST "$URL/login" -d 'return=/ui')"
contains "the Sign in button sends the browser to the sign-in provider" "Taking you to sign in" "$(curl -s -X POST "$URL/login" -H "origin: $PUBLIC_URL" -d 'return=/ui')"
contains "the logo is in the image (served as an SVG)" "image/svg+xml" "$(curl -s -D - -o /dev/null "$URL/ui/logo/favicon.svg" | tr -d '\r' | grep -i '^content-type')"

section "Container hardening"
CID="$(dc ps -q budd)"
same "runs as the node user" "1000" "$(dc exec -T budd id -u)"
# /home/node belongs to node, so only a read-only filesystem stops this write.
check "the node user can write its home in principle (sanity)" dc exec -T budd test -O /home/node
refuse "the root filesystem is read-only (even node's own home)" dc exec -T budd touch /home/node/written
same "Docker records a read-only root filesystem" "true" "$(docker inspect -f '{{.HostConfig.ReadonlyRootfs}}' "$CID")"
check "/tmp is writable (tmpfs)" dc exec -T budd touch /tmp/written
# A non-root process has no effective capabilities anyway; the bounding set
# shows whether cap_drop removed them from the container.
same "no Linux capabilities (bounding set empty)" "0000000000000000" "$(dc exec -T budd sh -c "grep CapBnd /proc/self/status | cut -f2")"
same "no-new-privileges is set" "1" "$(dc exec -T budd sh -c "grep NoNewPrivs /proc/self/status | cut -f2")"
contains "logs are rotated (json-file, 10m x 3)" '"max-file":"3","max-size":"10m"' "$(docker inspect -f '{{json .HostConfig.LogConfig.Config}}' "$CID")"
same "published on 127.0.0.1 only" "127.0.0.1" "$(docker inspect -f '{{(index (index .NetworkSettings.Ports "8787/tcp") 0).HostIp}}' "$CID")"

section "File permissions"
same "/data is private (700)" "700" "$(dc exec -T budd stat -c %a /data)"
same "control.db is private (600)" "600" "$(dc exec -T budd stat -c %a /data/control.db)"

section "Backups (docs/operating.md, Docker)"
B1="$TMP/backup-1.tar"; B2="$TMP/backup-2.tar"
check "backup succeeds" backup "$B1"
check "backup can run again (repeatable)" backup "$B2"
same "the backup file is private to you (600)" "600" "$(stat -c %a "$B1" 2>/dev/null || stat -f %Lp "$B1")" # GNU, then BSD
contains "the backup holds control.db" "control.db" "$(tar -tf "$B1")"
refuse "the backup holds no leftover WAL/SHM files" sh -c "tar -tf '$B1' | grep -E -- '-(wal|shm)$'"
dc exec -T budd sh -c 'mkdir -p /tmp/b && echo stale > /tmp/b/junk' >/dev/null 2>&1
check "a leftover /tmp/b from a failed run doesn't block the next backup" backup "$TMP/backup-3.tar"

section "budd accounts"
contains "lists accounts (none yet: sign-in needs a real provider)" "No accounts yet." "$(dc exec -T budd node dist/cli.js accounts 2>&1)"

section "Restart"
dc restart budd >/dev/null 2>&1
healthy "healthy again after a restart"
same "data survives a restart" "Smoke-A" "$(client_names)"

section "Restore (docs/operating.md, Docker)"
same "a change after the backup" 201 "$(register Smoke-B)"
same "both apps are there before restoring" "Smoke-A,Smoke-B" "$(client_names)"
dc stop budd >/dev/null 2>&1
check "restoring a good backup succeeds" restore "$B1"
dc start budd >/dev/null 2>&1
healthy "healthy after a restore"
same "the restore rolled back the later change" "Smoke-A" "$(client_names)"
same "restored files belong to Budd (node) and are private" "node 600" "$(dc exec -T budd stat -c '%U %a' /data/control.db)"

section "Erasing a workspace (docs/operating.md, Docker)"
# Signing in needs a real provider, so a leaver's account and workspace are seeded directly.
LEAVER_WS=01ARZ3NDEKTSV4RRFFQ69G5FAV
dc exec -T budd node -e "
  const db = new (require('better-sqlite3'))('/data/control.db');
  db.prepare(\"INSERT INTO accounts (id, email, created_at) VALUES ('01ARZ3NDEKTSV4RRFFQ69G5FAW', 'leaver@smoke.test', 0)\").run();
  db.prepare(\"INSERT INTO workspaces (id, slug, created_at) VALUES ('$LEAVER_WS', 'leaver', 0)\").run();
  db.prepare(\"INSERT INTO memberships (account_id, workspace_id, created_at) VALUES ('01ARZ3NDEKTSV4RRFFQ69G5FAW', '$LEAVER_WS', 0)\").run();
  db.close();" >/dev/null 2>&1
dc exec -T budd sh -c "mkdir -p /data/workspaces && : > /data/workspaces/$LEAVER_WS.db"
contains "budd accounts lists the leaver" "leaver@smoke.test" "$(dc exec -T budd node dist/cli.js accounts 2>&1)"
contains "erase-workspace refuses while Budd runs (another container)" "Stop it first" \
  "$(dc run --rm -T --no-deps budd node dist/cli.js erase-workspace leaver 2>&1)"
contains "a second Budd on the same data refuses to start" "is using its data directory" \
  "$(dc run --rm -T --no-deps budd 2>&1)"
dc stop budd >/dev/null 2>&1
contains "erase-workspace erases it once Budd is stopped" "Erased workspace leaver" \
  "$(dc run --rm -T --no-deps budd node dist/cli.js erase-workspace leaver 2>&1)"
refuse "...and its database file is gone" dc run --rm -T --no-deps budd test -e "/data/workspaces/$LEAVER_WS.db"
contains "erasing it again says there's no such workspace" "No workspace named leaver" \
  "$(dc run --rm -T --no-deps budd node dist/cli.js erase-workspace leaver 2>&1)"
dc start budd >/dev/null 2>&1
healthy "healthy after erasing"
same "the leaver's account is gone" "No accounts yet." "$(dc exec -T budd node dist/cli.js accounts 2>&1)"
check "a backup after erasing succeeds" backup "$TMP/after-erase.tar"
refuse "...and holds no trace of the leaver" sh -c "tar -xOf '$TMP/after-erase.tar' | grep -a -q leaver@smoke.test"
same "other data is untouched" "Smoke-A" "$(client_names)"

# ---- unhappy paths ---------------------------------------------------------

section "Backups that must fail safely"
dc stop budd >/dev/null 2>&1
before="$(cksum < "$B1")"
refuse "a backup while Budd is stopped fails" backup "$B1"
same "...and leaves that file's earlier backup intact" "$before" "$(cksum < "$B1")"
refuse "...and leaves no partial .part file" test -e "$B1.part"

section "Restores that must be refused (data left intact)"
: > "$TMP/empty.tar"
head -c 3000 "$B1" > "$TMP/truncated.tar"
echo "not a backup" > "$TMP/note.txt"; tar -C "$TMP" -cf "$TMP/no-control-db.tar" note.txt
printf 'garbage%.0s' $(seq 1 200) > "$TMP/garbage.tar"
refuse "an empty archive is refused" restore "$TMP/empty.tar"
refuse "a truncated archive is refused" restore "$TMP/truncated.tar"
refuse "an archive without control.db is refused" restore "$TMP/no-control-db.tar"
refuse "a file that isn't an archive is refused" restore "$TMP/garbage.tar"
dc start budd >/dev/null 2>&1
healthy "healthy after the refused restores"
same "the data survived every refused restore" "Smoke-A" "$(client_names)"

section "Requests that must be refused"
same "an oversized registration body (413)" 413 "$(status -X POST "$URL/register" -H 'content-type: application/json' -d "{\"client_name\":\"$(head -c 20000 /dev/zero | tr '\0' x)\"}")"
same "too many redirect URIs (400)" 400 "$(status -X POST "$URL/register" -H 'content-type: application/json' \
  -d '{"redirect_uris":["https://a.test/1","https://a.test/2","https://a.test/3","https://a.test/4","https://a.test/5","https://a.test/6"],"token_endpoint_auth_method":"none"}')"
same "a javascript: redirect URI (400)" 400 "$(status -X POST "$URL/register" -H 'content-type: application/json' -d '{"redirect_uris":["javascript:alert(1)"],"token_endpoint_auth_method":"none"}')"
same "/mcp with a made-up token (401)" 401 "$(status -X POST "$URL/mcp" -H 'authorization: Bearer budd_at_nope' -H 'content-type: application/json' -d '{}')"
same "/mcp with a made-up API key (401)" 401 "$(status -X POST "$URL/mcp" -H "authorization: Bearer budd_key_$(head -c 43 /dev/zero | tr '\0' A)" -H 'content-type: application/json' -d '{}')"
contains "...saying a human can make a new one" "connection’s page in the Budd UI" "$(curl -s -X POST "$URL/mcp" -H 'authorization: Bearer budd_key_nope' -H 'content-type: application/json' -d '{}')"
same "adding a connection with an API key needs signing in" 302 "$(status "$URL/ui/new")"
same "/token from an unknown app (401)" 401 "$(status -X POST "$URL/token" -d 'grant_type=authorization_code&code=nope&client_id=nope&code_verifier=nope')"
cid="$(curl -s -X POST "$URL/register" -H 'content-type: application/json' \
  -d '{"client_name":"Smoke-T","redirect_uris":["http://127.0.0.1:1/cb"],"token_endpoint_auth_method":"none"}' | sed -n 's/.*"client_id":"\([^"]*\)".*/\1/p')"
contains "/token with a made-up code (invalid_grant)" "invalid_grant" "$(curl -s -X POST "$URL/token" -d "grant_type=authorization_code&code=nope&client_id=$cid&code_verifier=nope&redirect_uri=http://127.0.0.1:1/cb")"
auth_headers="$(curl -s -D - -o /dev/null "$URL/authorize?client_id=nope&response_type=code" | tr -d '\r')"
contains "/authorize for an unknown app shows a page (400)" "HTTP/1.1 400" "$auth_headers"
refuse "...and redirects nowhere" sh -c "printf '%s' '$auth_headers' | grep -i '^location:'"
same "/login can't be sent off-site after sign-in" "200" "$(status "$URL/login?return=/..//evil.example")"
refuse "...and never names the other site" sh -c "curl -s -D - '$URL/login?return=/..//evil.example' | grep -i 'evil.example'"
same "/ui needs signing in" 302 "$(status "$URL/ui")"

section "Per-address rate limits"
# Docker publishes Budd through its bridge, so every request arrives from an
# internal address, like behind a proxy. Without CLIENT_IP_HEADER Budd must not
# lump everyone into one bucket (one client could lock everyone out).
hammer() { # count, extra curl args...: prints the request number of the first 429, if any,
  # and keeps that response's headers in $TMP/429.headers
  local n="$1" i; shift
  for i in $(seq 1 "$n"); do
    [ "$(curl -s -o /dev/null -D "$TMP/last.headers" -w '%{http_code}' -X POST "$URL/token" "$@" \
      -d 'grant_type=authorization_code&code=x&client_id=nope')" = "429" ] &&
      { mv "$TMP/last.headers" "$TMP/429.headers"; echo "$i"; return; }
  done
}
same "without CLIENT_IP_HEADER, 150 requests from one place aren't refused" "" "$(hammer 150)"
contains "...and Budd logs that CLIENT_IP_HEADER should be set" "set CLIENT_IP_HEADER" "$(dc logs budd 2>&1)"

# With CLIENT_IP_HEADER, as behind nginx: each client address is limited. A low
# rate refills too slowly (one every 6 s) for a slow host to blur the count.
printf 'CLIENT_IP_HEADER=x-real-ip\nIP_RATE_PER_MIN=10\n' >> "$TMP/.env"
dc up -d >/dev/null 2>&1 # recreated with the new setting; limits start fresh
healthy "healthy with CLIENT_IP_HEADER set"
contains "the startup log shows the rate-limit settings" '"clientIpHeader":"x-real-ip","ipRatePerMin":10' "$(dc logs budd 2>&1)"
first="$(hammer 30 -H 'x-real-ip: 198.51.100.7')"
if [ -n "$first" ] && [ "$first" -ge 11 ] && [ "$first" -le 13 ]; then
  pass "one client address is limited after IP_RATE_PER_MIN requests (here $first)"
else
  fail "one client address is limited after IP_RATE_PER_MIN requests" "first 429 at request [${first:-never}]"
fi
contains "the refusal says when to retry" "retry-after: 60" "$(tr -d '\r' < "$TMP/429.headers" 2>/dev/null | tr '[:upper:]' '[:lower:]')"
same "another client address isn't affected (401 for the unknown app, not 429)" 401 "$(status -X POST "$URL/token" -H 'x-real-ip: 198.51.100.8' -d 'grant_type=authorization_code&code=x&client_id=nope')"
same "health isn't rate limited" 200 "$(status -H 'x-real-ip: 198.51.100.7' "$URL/health")"
same "MCP isn't rate limited (still 401, not 429)" 401 "$(status -X POST "$URL/mcp" -H 'x-real-ip: 198.51.100.7' -H 'content-type: application/json' -d '{}')"
for _ in 1 2 3 4 5; do
  status -X POST "$URL/token" -H 'x-real-ip: 198.51.100.7' -d 'grant_type=authorization_code&code=x&client_id=nope' >/dev/null
done
same "six refusals are logged once, not once each" "1" "$(dc logs budd 2>&1 | grep -c '"msg":"rate limited"' | tr -d ' ')"
status -X POST "$URL/token" -d 'grant_type=authorization_code&code=x&client_id=nope' >/dev/null
contains "a request without the configured header is logged as a proxy problem" "check that the proxy sets that header" "$(dc logs budd 2>&1)"

section "Configuration that must be refused at startup"
dc stop budd >/dev/null 2>&1
start_fails "placeholder GOOGLE_CLIENT_ID" "is still the placeholder" -e GOOGLE_CLIENT_ID=replace-me.apps.googleusercontent.com
start_fails "placeholder GOOGLE_CLIENT_SECRET" "is still the placeholder" -e GOOGLE_CLIENT_SECRET=replace-me
start_fails "placeholder PUBLIC_URL (example.com)" "is still the placeholder" -e PUBLIC_URL=https://budd.example.com
start_fails "missing PUBLIC_URL" "PUBLIC_URL: required in hosted mode" -e PUBLIC_URL=
start_fails "http PUBLIC_URL on a public host" "must be https" -e PUBLIC_URL=http://budd.smoke.test
start_fails "PUBLIC_URL with a path" "must be just scheme, host and port" -e PUBLIC_URL=https://budd.smoke.test/budd
start_fails "a bad duration" "invalid duration" -e DELIVERY_TTL=soon
start_fails "an http OIDC_ISSUER" "OIDC_ISSUER" -e OIDC_ISSUER=http://idp.smoke.test
start_fails "a CLIENT_IP_HEADER that isn't a header name" "CLIENT_IP_HEADER: must be a header name" -e "CLIENT_IP_HEADER=x-real-ip: 1.2.3.4"
start_fails "a zero IP_RATE_PER_MIN" "IP_RATE_PER_MIN" -e IP_RATE_PER_MIN=0
start_fails "no say in who may sign in" "needs to know who may sign in" -e ALLOWED_HD=

section "A database from a newer Budd must be refused"
dc run --rm -T --no-deps budd node -e "
  const db = new (require('better-sqlite3'))('/data/control.db');
  db.pragma('user_version = 999'); db.close();" >/dev/null 2>&1
start_fails "refuses to start, naming the newer version" "newer version of Budd"
dc stop budd >/dev/null 2>&1
check "restoring the backup recovers it" restore "$B1"
dc start budd >/dev/null 2>&1
healthy "healthy again after recovering"

# ---- summary ---------------------------------------------------------------

printf '\n%d passed, %d failed\n' "$PASSED" "$FAILED"
if [ "$FAILED" -gt 0 ]; then printf 'Failed:%b\n' "$FAILURES"; exit 1; fi

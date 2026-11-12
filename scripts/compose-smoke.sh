#!/usr/bin/env bash
# Boots the compose stack from throwaway secrets, checks it, tears it down.
# Verifies: migrate exits 0; /readyz is 200 on the API and both workers; the
# instances table holds 1 api + 2 worker live rows; after `compose stop worker` both worker
# rows are no longer live and no crawl is `running`. Touches only the compose
# project `ariadne-smoke` (its own network and volumes).
set -euo pipefail
cd "$(dirname "$0")/.."

PROJECT=ariadne-smoke
HOST_PORT="${ARIADNE_API_HOST_PORT:-18787}"
ENVFILE="$(mktemp)"
rand() { openssl rand -hex 24; }
cat > "$ENVFILE" <<ENV
ARIADNE_API_TOKEN=$(rand)
ARIADNE_METRICS_TOKEN=$(rand)
ARIADNE_CREDENTIALS_KEY=smoke:$(openssl rand -base64 32)
POSTGRES_PASSWORD=$(rand)
ARIADNE_ALLOWED_DOMAINS=example.com
ARIADNE_API_HOST_PORT=${HOST_PORT}
ENV
dc() { docker compose -p "$PROJECT" --env-file "$ENVFILE" "$@"; }
cleanup() {
  local rc=$?
  if [ $rc -ne 0 ]; then dc logs --tail 40 >&2 || true; fi
  dc down -v --remove-orphans >&2 || true
  rm -f "$ENVFILE"
  if [ $rc -eq 0 ]; then echo "SMOKE PASS"; else echo "SMOKE FAIL ($rc)" >&2; fi
  exit $rc
}
trap cleanup EXIT
fail() { echo "FAIL: $*" >&2; exit 1; }
psql() { dc exec -T postgres psql -U ariadne -d ariadne -At -c "$1"; }

dc up -d --build --scale worker=2 --wait --wait-timeout 300 api worker \
  || fail "stack did not come up healthy"

# migrate is one-shot: it must have exited 0.
mig="$(dc ps -a --format '{{.State}} {{.ExitCode}}' migrate)"
[ "$mig" = "exited 0" ] || fail "migrate: '$mig'"
echo "migrate: exited 0"

code="$(dc exec -T api curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:8787/readyz)"
[ "$code" = 200 ] || fail "api /readyz: $code"
echo "api /readyz: 200"
for cid in $(dc ps -q worker); do
  code="$(docker exec "$cid" curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:8788/readyz)"
  [ "$code" = 200 ] || fail "worker $cid /readyz: $code"
  echo "worker ${cid:0:12} /readyz: 200"
done
# The published API port answers from the host too.
code="$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:${HOST_PORT}/healthz")"
[ "$code" = 200 ] || fail "host /healthz: $code"

roles="$(psql "select role||'='||count(*) from instances where stopped_at is null group by role order by role" | tr '\n' ' ')"
# api:serve registers its instance at boot, so exactly 1 api and 2 worker.
[ "$roles" = "api=1 worker=2 " ] || fail "instances: '$roles'"
echo "instances (live): $roles"

dc stop worker >/dev/null 2>&1
live="$(psql "select count(*) from instances where role='worker' and stopped_at is null and heartbeat_at > now() - interval '60 seconds'")"
[ "$live" = 0 ] || fail "$live worker instance(s) still live after stop"
running="$(psql "select count(*) from crawls where status='running'")"
[ "$running" = 0 ] || fail "$running crawl(s) running with no worker"
echo "workers stopped: no live worker instance, 0 running crawls"

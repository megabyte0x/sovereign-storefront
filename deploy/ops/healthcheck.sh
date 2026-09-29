#!/bin/sh
# Every five minutes: public-doctor --strict. On FAIL, post a sanitized body to
# the operator webhook. The URL is never printed.
set -eu

ROOT="$(CDPATH= cd -- "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"

COMPOSE_FILE="${SSF_COMPOSE_FILE:-$ROOT/deploy/compose.yaml}"
ENV_FILE="${SSF_ENV_FILE:-/srv/ssf/public-testnet.env}"
REPO="${SSF_REPO_ROOT:-$ROOT}"
if [ -f /srv/ssf/ops.env ]; then
  set -a
  . /srv/ssf/ops.env
  set +a
fi
run_doctor() {
  if docker compose -f "$COMPOSE_FILE" --env-file "$ENV_FILE" exec -T seller test -f /app/scripts/public-doctor.ts; then
    docker compose -f "$COMPOSE_FILE" --env-file "$ENV_FILE" exec -T seller \
      node --experimental-strip-types /app/scripts/public-doctor.ts --strict
  else
    node --experimental-strip-types "$REPO/scripts/public-doctor.ts" --strict
  fi
}

set +e
doctor=$(run_doctor 2>&1)
code=$?
set -e

payload=$(printf '%s\n' "$doctor" | node --experimental-strip-types "$ROOT/deploy/ops/health-payload.ts" --exit "$code")
printf '%s\n' "$payload"

if [ "$code" -ne 0 ] && [ -n "${SSF_HEALTH_URL:-}" ]; then
  curl -fsS --max-time 15 -H 'Content-Type: text/plain' --data-binary @- >/dev/null \
    --url "$SSF_HEALTH_URL" <<EOF
$payload
EOF
fi
exit "$code"

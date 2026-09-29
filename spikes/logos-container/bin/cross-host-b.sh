#!/bin/sh
# Replica-side: init storage_module, connect to laptop A, download 8 MiB, sha256.
# Env: PEER_A, TAILSCALE_A, CID8, EXPECT_SHA256, A_PORT (default 8091)
set -eu
ROOT="$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
COMPOSE="docker compose -f $ROOT/compose.replica.yml"
CTL=/usr/local/bin/entrypoint.sh
A_PORT="${A_PORT:-8091}"
PHASE="${PHASE:-download}"
: "${CID8:?}"
: "${EXPECT_SHA256:?}"
if [ "$PHASE" != "reread" ]; then
  : "${PEER_A:?}"
  : "${TAILSCALE_A:?}"
fi

ctl() {
  $COMPOSE exec -T logos-b "$CTL" --json "$@"
}

mkdir -p state/node-b
cat > state/node-b/storage-init.json <<EOF
{"data-dir":"/data/storage-data","log-file":"/data/storage-data/storage.log","log-level":"INFO","listen-port":8091,"disc-port":8090,"network":"logos.test"}
EOF

$COMPOSE up -d --no-build
i=0
while [ "$i" -lt 45 ]; do
  out="$(ctl daemon status 2>/dev/null || true)"
  echo "$out" | grep -Eq '"status": ?"running"' && break
  i=$((i + 1))
  sleep 1
done
echo "$out" | grep -Eq '"status": ?"running"'

ctl module load storage_module >/dev/null || true
debug="$(ctl call storage_module debug 2>/dev/null || true)"
if ! echo "$debug" | grep -q '"id"'; then
  ctl call storage_module init @/data/storage-init.json >/dev/null
  ctl call storage_module start >/dev/null
fi
i=0
while [ "$i" -lt 30 ]; do
  debug="$(ctl call storage_module debug 2>/dev/null || true)"
  echo "$debug" | grep -q '"id"' && break
  i=$((i + 1))
  sleep 2
done

if [ "$PHASE" = "reread" ]; then
  ADDR="a-stopped"
else
  ADDR="/ip4/${TAILSCALE_A}/tcp/${A_PORT}/p2p/${PEER_A}"
  echo "connect /ip4/${TAILSCALE_A}/tcp/${A_PORT}/p2p/<peerA>"
  ctl call storage_module connect "$PEER_A" "json:[$(python3 -c 'import json,sys; print(json.dumps(sys.argv[1]))' "$ADDR")]"
fi

dest=/data/8m.out
localflag=false
if [ "$PHASE" = "reread" ]; then
  dest=/data/8m.reread
  localflag=true
fi
start=$(date +%s%N)
n=0
while [ "$n" -lt 4 ]; do
  m="$(ctl call storage_module downloadManifest "$CID8" 2>/dev/null || true)"
  echo "$m" | grep -q '"success":false' || break
  n=$((n + 1))
  sleep 3
done
n=0
while [ "$n" -lt 4 ]; do
  dl="$(ctl call storage_module downloadToUrl "$CID8" "$dest" "$localflag" 65536 2>/dev/null || true)"
  echo "$dl" | python3 -c 'import json,sys; d=json.load(sys.stdin); r=(d.get("result") or {}); print("download_success", r.get("success"))'
  echo "$dl" | grep -q '"success":true' && break
  n=$((n + 1))
  sleep 3
done
i=0
while [ "$i" -lt 180 ]; do
  if $COMPOSE exec -T logos-b sh -c "test -f '$dest' && test \$(stat -c%s '$dest') -eq 8388608"; then
    break
  fi
  i=$((i + 1))
  sleep 1
done
end=$(date +%s%N)
ms=$(( (end - start) / 1000000 ))
GOT="$($COMPOSE exec -T logos-b sha256sum "$dest" | awk '{print $1}')"
echo "phase=$PHASE download8_ms=$ms got=$GOT expected=$EXPECT_SHA256"
if [ "$GOT" != "$EXPECT_SHA256" ]; then
  echo "sha256 mismatch" >&2
  exit 1
fi
echo "digest_match"

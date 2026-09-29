#!/bin/sh
# Two-container same-host replication: 1 MiB + 8 MiB, then origin-stop re-read.
set -eu
ROOT="$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
COMPOSE="docker compose -f $ROOT/compose.yml"
CTL=/usr/local/bin/entrypoint.sh
A_PORT=8091
B_PORT=8091

json_field() {
  python3 -c 'import json,sys
p=sys.argv[1].split(".")
d=json.load(sys.stdin)
for k in p:
    if isinstance(d, dict):
        d=d.get(k)
    else:
        d=None
        break
if d is None:
    sys.exit(1)
if isinstance(d, (dict, list)):
    json.dump(d, sys.stdout)
else:
    print(d)
' "$1"
}

ctl() {
  svc=$1
  shift
  $COMPOSE exec -T "$svc" "$CTL" --json "$@"
}

wait_running() {
  svc=$1
  i=0
  while [ "$i" -lt 45 ]; do
    out="$(ctl "$svc" daemon status 2>/dev/null || true)"
    echo "$out" | grep -q running && return 0
    i=$((i + 1))
    sleep 1
  done
  echo "timeout waiting for $svc daemon" >&2
  return 1
}

peer_id() {
  ctl "$1" call storage_module debug | json_field result.value.id
}

mkdir -p state/node-a state/node-b state/files
cat > state/node-a/storage-init.json <<EOF
{"data-dir":"/data/storage-data","log-file":"/data/storage-data/storage.log","log-level":"INFO","listen-port":${A_PORT},"disc-port":8090,"network":"logos.test"}
EOF
cat > state/node-b/storage-init.json <<EOF
{"data-dir":"/data/storage-data","log-file":"/data/storage-data/storage.log","log-level":"INFO","listen-port":${B_PORT},"disc-port":8090,"network":"logos.test"}
EOF

$COMPOSE up -d --no-build
wait_running logos-a
wait_running logos-b

bring_storage() {
  svc=$1
  ctl "$svc" module load storage_module >/dev/null || true
  debug="$(ctl "$svc" call storage_module debug 2>/dev/null || true)"
  if ! echo "$debug" | grep -q '"id"'; then
    ctl "$svc" call storage_module init @/data/storage-init.json >/dev/null
    ctl "$svc" call storage_module start >/dev/null
  fi
  i=0
  while [ "$i" -lt 30 ]; do
    debug="$(ctl "$svc" call storage_module debug 2>/dev/null || true)"
    if echo "$debug" | python3 -c 'import json,sys
d=json.load(sys.stdin)
v=(d.get("result") or {}).get("value") or {}
sys.exit(0 if v.get("id") else 1)' 2>/dev/null; then
      return 0
    fi
    i=$((i + 1))
    sleep 2
  done
  echo "$svc storage_module has no peer id: $debug" >&2
  return 1
}

bring_storage logos-a
bring_storage logos-b

PEER_A="$(peer_id logos-a)"
PEER_B="$(peer_id logos-b)"
CID_A="$($COMPOSE ps -q logos-a)"
IP_A="$(docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' "$CID_A")"
echo "peerA_prefix=${PEER_A%${PEER_A#????????????}} peerB_prefix=${PEER_B%${PEER_B#????????????}} ipA=$IP_A"

ADDR="/ip4/${IP_A}/tcp/${A_PORT}/p2p/${PEER_A}"
conn="$(ctl logos-b call storage_module connect "$PEER_A" "json:[$(python3 -c 'import json,sys; print(json.dumps(sys.argv[1]))' "$ADDR")]")"
echo "$conn" | python3 -c 'import json,sys; d=json.load(sys.stdin); assert (d.get("result") or {}).get("success") is not False, d; print("connect_ok")'
echo "connected B -> /ip4/${IP_A}/tcp/${A_PORT}/p2p/<peerA>"

dd if=/dev/urandom of=state/files/1m.bin bs=1048576 count=1 status=none
dd if=/dev/urandom of=state/files/8m.bin bs=1048576 count=8 status=none
SUM1="$(sha256sum state/files/1m.bin | awk '{print $1}')"
SUM8="$(sha256sum state/files/8m.bin | awk '{print $1}')"
cp state/files/1m.bin state/node-a/1m.bin
cp state/files/8m.bin state/node-a/8m.bin

upload_one() {
  svc=$1
  src=$2
  name=$3
  start=$(date +%s%N)
  up="$(ctl "$svc" call storage_module uploadUrl "$src" 65536)"
  echo "$up" | python3 -c 'import json,sys; d=json.load(sys.stdin); assert (d.get("result") or {}).get("success") is True, d'
  i=0
  cid=""
  while [ "$i" -lt 60 ]; do
    mans="$(ctl "$svc" call storage_module manifests)"
    cid="$(echo "$mans" | python3 -c 'import json,sys
name=sys.argv[1]
d=json.load(sys.stdin)
for x in ((d.get("result") or {}).get("value") or []):
    if x.get("filename")==name and x.get("cid"):
        print(x["cid"]); break
' "$name" || true)"
    if [ -n "$cid" ]; then
      break
    fi
    i=$((i + 1))
    sleep 1
  done
  end=$(date +%s%N)
  if [ -z "$cid" ]; then
    echo "upload $name: no cid" >&2
    return 1
  fi
  ms=$(( (end - start) / 1000000 ))
  echo "$cid $ms"
}

download_one() {
  svc=$1
  cid=$2
  dest=$3
  bytes=$4
  localflag=${5:-false}
  start=$(date +%s%N)
  n=0
  while [ "$n" -lt 4 ]; do
    m="$(ctl "$svc" call storage_module downloadManifest "$cid" 2>/dev/null || true)"
    echo "$m" | grep -q '"success":false' || break
    n=$((n + 1))
    sleep 2
  done
  n=0
  while [ "$n" -lt 4 ]; do
    dl="$(ctl "$svc" call storage_module downloadToUrl "$cid" "$dest" "$localflag" 65536 2>/dev/null || true)"
    if echo "$dl" | python3 -c 'import json,sys
d=json.load(sys.stdin)
sys.exit(0 if (d.get("result") or {}).get("success") is True else 1)' 2>/dev/null; then
      break
    fi
    n=$((n + 1))
    sleep 2
  done
  i=0
  while [ "$i" -lt 60 ]; do
    if $COMPOSE exec -T "$svc" sh -c "test -f '$dest' && test \$(stat -c%s '$dest') -eq $bytes"; then
      break
    fi
    i=$((i + 1))
    sleep 1
  done
  end=$(date +%s%N)
  ms=$(( (end - start) / 1000000 ))
  echo "$ms"
}

echo "=== 1 MiB upload A ==="
set -- $(upload_one logos-a /data/1m.bin 1m.bin)
CID1=$1
MS_UP1=$2
echo "cid1_prefix=${CID1%${CID1#????????????}} upload_ms=$MS_UP1"
echo "=== 1 MiB download B ==="
MS_DL1="$(download_one logos-b "$CID1" /data/1m.out 1048576)"
GOT1="$($COMPOSE exec -T logos-b sha256sum /data/1m.out | awk '{print $1}')"
echo "download1_ms=$MS_DL1 got=$GOT1 expected=$SUM1"
[ "$GOT1" = "$SUM1" ]

echo "=== 8 MiB upload A ==="
set -- $(upload_one logos-a /data/8m.bin 8m.bin)
CID8=$1
MS_UP8=$2
echo "cid8_prefix=${CID8%${CID8#????????????}} upload_ms=$MS_UP8"
echo "=== 8 MiB download B ==="
MS_DL8="$(download_one logos-b "$CID8" /data/8m.out 8388608)"
GOT8="$($COMPOSE exec -T logos-b sha256sum /data/8m.out | awk '{print $1}')"
echo "download8_ms=$MS_DL8 got=$GOT8 expected=$SUM8"
[ "$GOT8" = "$SUM8" ]

echo "=== ram both nodes ==="
docker stats --no-stream --format '{{.Name}} mem={{.MemUsage}}' $($COMPOSE ps -q)

echo "=== watch probe on B ==="
$COMPOSE exec -T logos-b sh -c 'rm -f /data/watch.log'
$COMPOSE exec -d logos-b sh -c 'exec /usr/local/bin/entrypoint.sh --json watch storage_module --event storageDownloadDone > /data/watch.log 2>&1'
sleep 2
ctl logos-b call storage_module downloadToUrl "$CID8" /data/8m.watch false 65536 >/dev/null || true
i=0
while [ "$i" -lt 20 ]; do
  if $COMPOSE exec -T logos-b sh -c 'test -s /data/watch.log && grep -q storageDownloadDone /data/watch.log'; then
    break
  fi
  i=$((i + 1))
  sleep 1
done
WATCH_CID="$($COMPOSE ps -q logos-b)"
docker top "$WATCH_CID" -eo pid,args | awk '/watch storage_module/ {print $1}' | while read -r pid; do
  kill -9 "$pid" 2>/dev/null || true
done
watch_bytes="$($COMPOSE exec -T logos-b wc -c /data/watch.log | awk '{print $1}')"
watch_lines="$($COMPOSE exec -T logos-b sh -c 'grep -c storageDownloadDone /data/watch.log || true')"
echo "watch_bytes=$watch_bytes"
echo "watch_lines=$watch_lines"

echo "=== stop A, re-read 8 MiB from B ==="
umask 077
printf '%s\n' "$CID8" > state/cid8
printf '%s\n' "$SUM8" > state/sum8
printf '%s\n' "$PEER_A" > state/peer-a
$COMPOSE stop logos-a
MS_REREAD="$(download_one logos-b "$CID8" /data/8m.reread 8388608 true)"
GOTR="$($COMPOSE exec -T logos-b sha256sum /data/8m.reread | awk '{print $1}')"
echo "reread8_ms=$MS_REREAD got=$GOTR expected=$SUM8"
[ "$GOTR" = "$SUM8" ]

echo "=== image size ==="
docker image inspect "${LOGOS_IMAGE:-ssf-logosctl:0.2.3-arm64}" --format 'image_size_bytes={{.Size}}'

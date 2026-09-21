# Storage spike: encrypted Logos retrieval

Gate B probe. Two independently stored Logos Storage nodes, AES-256-GCM ciphertext, restricted local HTTPS gateway, Chromium decrypt.

## Pinned versions

| Piece | Version |
| --- | --- |
| logosctl | 0.2.3 (AppImage, aarch64-linux) |
| storage_module | 2.1.2 |
| storage_module root hash | `19b11b153748c30665608c5527776ba2be74f7764481a11d33f687098764b740` |
| libstorage | `0.1.0-523c7a51` |
| encryption | Web Crypto `AES-GCM` 256-bit, 12-byte nonce |
| ciphertext format | `SSF1` \|\| nonce \|\| ciphertext+tag |

Install logosctl from the GitHub release tarball into `runtime/` (gitignored). Do **not** run `install-logosctl.sh` (it writes `/usr/local/bin` and needs root).

```sh
curl -fL -o runtime/logosctl-aarch64-linux.tar.gz \
  https://github.com/logos-co/logos-logoscore-cli/releases/download/0.2.3/logosctl-aarch64-linux.tar.gz
tar -xzf runtime/logosctl-aarch64-linux.tar.gz -C runtime
```

Archive SHA-256: `f1ed1debcac20a9943ae2786021f574e439af42f853db0e753a365acb45eb3c3`

## Commands

```sh
export APPIMAGE_EXTRACT_AND_RUN=1
LOGOSCTL=./runtime/logosctl-aarch64.AppImage

# two sessions, independent data dirs
$LOGOSCTL --config-dir ./runtime/node-a daemon start --detach
$LOGOSCTL --config-dir ./runtime/node-b daemon start --detach
$LOGOSCTL --config-dir ./runtime/node-a catalog refresh
$LOGOSCTL --config-dir ./runtime/node-a package install storage_module \
  --version 2.1.2 --root-hash 19b11b153748c30665608c5527776ba2be74f7764481a11d33f687098764b740 --yes
# repeat install for node-b, then:
$LOGOSCTL --config-dir ./runtime/node-a module load storage_module
$LOGOSCTL --config-dir ./runtime/node-a call storage_module init @./runtime/node-a/storage-init.json
$LOGOSCTL --config-dir ./runtime/node-a call storage_module start
# start() true is acceptance; wait and query peerId/debug for a live node.

node --test crypto.test.mjs gateway.test.mjs
node probe.mjs
```

Completion events (not call acceptance): `storageUploadDone`, `storageDownloadDone`, `storageStop`. `fetch()` is acceptance-only and is not used as replica proof.

## Size limit

First release maximum for the independent-replica + browser path: **73 bytes ciphertext** (41 bytes plaintext). That is what this probe retrieved through node B after node A stopped, then decrypted in Chromium.

Local AES-GCM rejects plaintext above 8 MiB. The implementation does **not** stream. 4 KiB and 64 KiB origin uploads were accepted on node A; replica retrieval of those sizes after origin restart was not proven.

## Verdict: PARTIAL

Independent ciphertext retrieval and authenticated browser decrypt worked for the harmless fixture. Larger replica sizes remain unproven.

# Live test checklist (Task 12 manual run)

One section per workflow stage, in the parent plan's L order. Record only what
you actually observe, with the exact `live-observe` line in each section. L
matrix rows are filled by `finalize` from these observations; do not type them
by hand. T01 stays NOT_RUN (gate D4: no public-testnet wallet or lightwalletd
endpoint is available; L results do not imply testnet readiness).

Evidence text must describe what you saw without quoting it: no addresses, no
ZIP-321 URIs, no UFVKs, no tokens, no plaintext product bytes. A secret-shaped
value is refused, the row becomes FAIL, and the value is not written.

## Setup

```
npm run infra:up
SSF_STRICT_LIVE=1 npm run infra:doctor
```

`infra:doctor` must print 6/6 PASS before anything else. Then start the seller
and record its output:

```
npm run start:live | tee .runtime/live/diag/manual-seller.log
```

The ready line must read `ready scanner=true messaging=true checkout=false
products=0` (checkout stays false and products stays 0 until a publish). Then:

```
node --experimental-strip-types scripts/live-observe.ts init --log .runtime/live/diag/manual-seller.log
```

`init` reads the ready line and the component-started log events from that
file, captures build provenance from `dist/build-info.json`, and writes a 0600
`.runtime/live/demo/observations.json`. If the seller is not running, pass
`--log` pointing at the log that holds its ready line; `init` fails honestly
when that line is absent.

## Seller-stop rule

Stop the seller only through the `start:live` wrapper PID, and only after
checking its command line:

```
tr '\0' ' ' < /proc/<pid>/cmdline
```

Confirm the line is the `node ... scripts/start-live.ts` wrapper before
signalling it. Never signal a Logos node, the scanner, or any PID you did not
start yourself.

## Node-A restart / re-prove rule

After any `node --experimental-strip-types scripts/live-infra/logos-node.ts
stop --node a`, bring A back and re-prove A→B replication before continuing:

```
node --experimental-strip-types scripts/live-infra/logos-node.ts start --node a
npm run infra:up
SSF_STRICT_LIVE=1 npm run infra:doctor
```

`infra:up` is the idempotent re-prove path. Do not continue until strict doctor
reports 6/6 again.

## publish

Command (plaintext file ≤ 41 bytes; the admin token is read from the file, never
typed):

```
SSF_ADMIN_TOKEN_FILE=.runtime/live/seller/admin.token node --experimental-strip-types scripts/publish-live.ts --admin-url http://127.0.0.1:8788 --plaintext-file <file> --version <v> --amount-zat <n> --description <text>
```

Observe: the command exits 0 and prints a version with `replica: true`, and the
product page at `http://127.0.0.1:8787` shows the new description and price.
Record the byte length and the version, never the plaintext.

```
node --experimental-strip-types scripts/live-observe.ts stage publish --status PASS --evidence "published version <v>, <n> bytes, replica true"
```

## replica-b

Observe: after publish, strict doctor row `logos-replication` is PASS and its
evidence names a new CID prefix with the published byte count. Do not reuse a
pre-existing CID.

```
node --experimental-strip-types scripts/live-observe.ts stage replica-b --status PASS --evidence "logos-replication PASS, new cid prefix, byte count matches publish"
```

## two-invoices

DOM control: the product page button `Buy` (`#buy`). Press it twice.

Observe: two checkout pages, each showing a payment QR (`role="img"`,
accessible name "Payment request QR") and a ZIP-321 URI (`#zip321-uri`), both
for the same amount. Do not copy either URI into the evidence.

```
node --experimental-strip-types scripts/live-observe.ts stage two-invoices --status PASS --evidence "two Buy presses, two equal-amount invoices"
```

## fund-a

Command, using the URI of invoice A only (the URI goes to the command, not to
the evidence):

```
node --experimental-strip-types scripts/live-pay.ts fund --uri <uri>
```

Observe: the command prints a txid. Record that a payment was broadcast for
invoice A only.

```
node --experimental-strip-types scripts/live-observe.ts stage fund-a --status PASS --evidence "faucet funded invoice A only"
```

## below-threshold

```
node --experimental-strip-types scripts/live-pay.ts mine --blocks 9
node --experimental-strip-types scripts/live-pay.ts confirmations --txid <txid>
```

Observe: `confirmations` prints a count below 10, and the purchase status page
(`#payment-label`) does not show the payment as confirmed. No key material is
released.

```
node --experimental-strip-types scripts/live-observe.ts stage below-threshold --status PASS --evidence "9 blocks mined, confirmations below 10, no release"
```

## threshold

```
node --experimental-strip-types scripts/live-pay.ts mine --blocks 1
node --experimental-strip-types scripts/live-pay.ts confirmations --txid <txid>
```

Observe: `confirmations` prints at least 10 and the status page advances.

```
node --experimental-strip-types scripts/live-observe.ts stage threshold --status PASS --evidence "confirmations reached 10"
```

## interrupt

Seller-stop rule applies. Stop the seller wrapper, and close the browser tab,
before the application delivery completes.

Observe: the wrapper process exits and the tab is gone while delivery was still
pending (`#delivery-label` not yet complete).

```
node --experimental-strip-types scripts/live-observe.ts stage interrupt --status PASS --evidence "seller wrapper and browser stopped before delivery completed"
```

## restart

```
npm run start:live | tee .runtime/live/diag/manual-seller.log
```

Observe: a new ready line, `scanner=true messaging=true`, and the product count
includes the published version. Re-run `init` is not required; the observations
file already holds provenance.

```
node --experimental-strip-types scripts/live-observe.ts stage restart --status PASS --evidence "seller restarted, ready line shows published product count"
```

## waku-recover

DOM controls: reopen `http://127.0.0.1:8787`, press `My purchases`
(`#nav-purchases`), then press the button whose name is the purchase's request
id (`data-request-id`).

Observe: the status page returns for the same invoice, and the delivery
completes (`#delivery-label`) without a new payment.

```
node --experimental-strip-types scripts/live-observe.ts stage waku-recover --status PASS --evidence "same invoice recovered over Waku after restart, no new payment"
```

## origin-stop

Node-A restart rule applies afterwards.

```
node --experimental-strip-types scripts/live-infra/logos-node.ts status --node a
node --experimental-strip-types scripts/live-infra/logos-node.ts stop --node a
```

Observe: `status` before the stop shows the node running, and `stop` reports it
stopped. Record the failed origin health, not a peer id.

```
node --experimental-strip-types scripts/live-observe.ts stage origin-stop --status PASS --evidence "node A stopped; origin health failed"
```

## gateway-restart

Follow the node-A restart rule exactly: `logos-node.ts start --node a`, then
`npm run infra:up`, then strict doctor 6/6. The restart drops the gateway's
process cache, so the next fetch must come from B.

```
node --experimental-strip-types scripts/live-observe.ts stage gateway-restart --status PASS --evidence "node A restarted, infra:up re-proved replication, strict doctor 6/6"
```

## fresh-context-import

DOM controls, in a fresh browser context (new profile, no leftover state): open
`http://127.0.0.1:8787`, press `My purchases`, then use the `Import backup` file
input (`#import-backup`) to import the purchase backup exported earlier with
`Export backup` (`#export-backup`).

Observe: `#import-status` confirms the import, and the purchase list shows the
same request id.

```
node --experimental-strip-types scripts/live-observe.ts stage fresh-context-import --status PASS --evidence "fresh browser context imported the purchase backup"
```

## decrypt-equal

DOM control: press the request-id button in the imported purchase list.

Observe: the browser decrypts the copy fetched from B and the displayed bytes
match the published plaintext. Record the equality and the byte count only.

```
node --experimental-strip-types scripts/live-observe.ts stage decrypt-equal --status PASS --evidence "decrypted bytes equal published plaintext, byte count matches"
```

## ack

Observe: after decryption the seller log shows the authenticated ack for the
same invoice (event only; no message body in the evidence).

```
node --experimental-strip-types scripts/live-observe.ts stage ack --status PASS --evidence "seller log shows authenticated ack for the recovered invoice"
```

## b-stays-locked

Observe: throughout, invoice B's checkout never advances. Its payment QR stays
unpaid and no delivery occurs for it.

```
node --experimental-strip-types scripts/live-observe.ts stage b-stays-locked --status PASS --evidence "invoice B unpaid and locked for the whole run"
```

## normal-delivery

DOM controls: press `Buy` once more and fund that invoice without interrupting
anything.

```
node --experimental-strip-types scripts/live-pay.ts fund --uri <uri>
node --experimental-strip-types scripts/live-pay.ts mine --blocks 10
```

Observe: delivery completes on its own (`#delivery-label`) with no restart.

```
node --experimental-strip-types scripts/live-observe.ts stage normal-delivery --status PASS --evidence "uninterrupted delivery completed after 10 confirmations"
```

## response-loss-reconnect

DOM control: on a delivered purchase, reload the page and press the request-id
button again.

Observe: the status page reconnects and shows the same delivered state; no
second payment is created.

```
node --experimental-strip-types scripts/live-observe.ts stage response-loss-reconnect --status PASS --evidence "reload reconnected to the delivered purchase, no second payment"
```

## Named suite rows

Each L row that the report derives from suites needs its own observed evidence.
Record one line per row as you check it; `--fail` when the check does not hold.

```
node --experimental-strip-types scripts/live-observe.ts suite L02 --ok --evidence "scanner cargo metadata locked, protocol probe passed"
node --experimental-strip-types scripts/live-observe.ts suite L04 --ok --evidence "seller restart kept the invoice allocation"
node --experimental-strip-types scripts/live-observe.ts suite L06 --ok --evidence "fork and stale-health fixtures retained revoked identity"
node --experimental-strip-types scripts/live-observe.ts suite L07 --ok --evidence "crash-boundary database tests passed"
node --experimental-strip-types scripts/live-observe.ts suite L08 --ok --evidence "payment permutation fixtures passed"
node --experimental-strip-types scripts/live-observe.ts suite L10 --ok --evidence "no live HTTP purchase route observed in browser network log"
node --experimental-strip-types scripts/live-observe.ts suite L13 --ok --evidence "payment URI decoded back from the QR image"
node --experimental-strip-types scripts/live-observe.ts suite L14 --ok --evidence "readiness recovered after the dependency returned"
node --experimental-strip-types scripts/live-observe.ts suite L15 --ok --evidence "backup verified; no spending key in the scanner config"
node --experimental-strip-types scripts/live-observe.ts suite L16 --ok --evidence "41-byte publish accepted, over-cap rejected"
```

`backup:live` checks the L15 archive without printing key material:

```
node --experimental-strip-types scripts/backup-live.ts verify --archive <archive> --key-file .runtime/live/seller/backup.key
```

## Finalize

```
node --experimental-strip-types scripts/live-observe.ts finalize
```

Prints one `PASS`/`FAIL`/`NOT_RUN` line per row and writes a 0600
`.runtime/live/demo/report.json`. The exit code is nonzero unless every L row
and every workflow stage passed; T01 is reported NOT_RUN. A missing stage is
listed by name in the output, so record it and run `finalize` again.

import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromiumRoundtrip } from "./run-roundtrip.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const peersFile = path.join(HERE, "runtime/public-peers.json");
const outFile = path.join(HERE, "runtime/baseline-results.json");
const peers = JSON.parse(readFileSync(peersFile, "utf8")).dialable;
if (!Array.isArray(peers) || peers.length < 1) {
  throw new Error("no public dialable peers");
}
const SPAN_MS = 30 * 60 * 1000;
const RUNS = 10;
const t0 = Date.now();
const runs = [];
writeFileSync(outFile, JSON.stringify({ started: new Date(t0).toISOString(), peerCount: peers.length, runs }, null, 2) + "\n");

for (let i = 0; i < RUNS; i += 1) {
  const slot = t0 + Math.floor((i * SPAN_MS) / RUNS);
  const wait = slot - Date.now();
  if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
  const started = new Date().toISOString();
  const port = 18770 + i;
  let packed;
  try {
    packed = await chromiumRoundtrip({
      peers,
      count: 50,
      contentTopic: `/sovereign-storefront/1/spike13-base-${i}-${Date.now()}/proto`,
      peerTimeoutMs: 60_000,
      recvTimeoutMs: 45_000,
      port,
    });
  } catch (err) {
    packed = {
      result: {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
        sent: 0,
        sendAck: 0,
        verified: 0,
        successRate: 0,
        p95Ms: null,
        connected: 0,
      },
      logs: [],
    };
  }
  const r = packed.result;
  const row = {
    i,
    started,
    finished: new Date().toISOString(),
    ok: r.ok,
    error: r.error ?? null,
    connected: r.connected ?? 0,
    sent: r.sent ?? 0,
    sendAck: r.sendAck ?? 0,
    verified: r.verified ?? 0,
    successRate: r.successRate ?? 0,
    p95Ms: r.p95Ms ?? null,
    pubsubTopic: r.pubsubTopic ?? null,
    logs: (packed.logs ?? []).slice(0, 4),
  };
  runs.push(row);
  writeFileSync(outFile, JSON.stringify({ started: new Date(t0).toISOString(), peerCount: peers.length, runs }, null, 2) + "\n");
  process.stdout.write(`${JSON.stringify(row)}\n`);
}
process.stdout.write(`baseline_done runs=${runs.length}\n`);

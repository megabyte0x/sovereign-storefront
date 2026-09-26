// R2.3: live stop-origin retrieval proof. Publish a fresh 41-byte product via
// origin A, stop A (logos-node.ts, gate D2 = a), then fetch the CID through a
// NEW adapter + catalogue from replica B only, decrypt it on the buyer path and
// compare hashes. A is always restarted in `finally`, followed by a strict
// doctor wait for 6 PASS rows.
//
// Gated on SSF_LIVE_ORIGIN_STOP=1 so `npm test` never stops a node. When the
// gate is set every missing precondition FAILS (throws); nothing early-returns
// as a pass. This file never touches node B, infra:up/down or ths.
import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { LIVE_ENV_PATH, parseEnvText, readLiveEnvFile } from '../../scripts/start-live.ts';
import { readDaemonIdentity, replicationProof, writeFileAtomic0600 } from '../../scripts/live-infra/logos-up.ts';
import { runWithRestore } from '../../scripts/live-infra/logos-node.ts';
import { LIVE_ROOT } from '../../scripts/live-infra/paths.ts';
import { FIRST_RELEASE_MAX_CIPHERTEXT_BYTES, FIRST_RELEASE_MAX_PLAINTEXT_BYTES, createCryptoAdapter } from '../../src/adapters/crypto.ts';
import { createCredentialAdapter } from '../../src/adapters/credentials.ts';
import {
  createLogosStorageAdapter,
  defaultLogosRunner,
  detectLogosRuntime,
  type LogosRunner,
  type LogosRuntime,
} from '../../src/adapters/storage.ts';
import { decryptDownload } from '../../src/browser/download.ts';
import { publishProduct } from '../../src/seller/admin.ts';
import { openCatalogue } from '../../src/seller/catalogue.ts';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const LOGOS_NODE = path.join(REPO_ROOT, 'scripts', 'live-infra', 'logos-node.ts');
const DOCTOR = path.join(REPO_ROOT, 'scripts', 'live-infra', 'doctor.ts');
const SCRATCH_ROOT = process.env.TMPDIR ?? tmpdir();
const TEST_TIMEOUT_MS = 900_000;
const DOCTOR_DEADLINE_MS = 300_000;

const enabled = process.env.SSF_LIVE_ORIGIN_STOP === '1';

type CallRecord = { configDir: string; op: string };

/** Wraps the real runner and records, per call, which config dir it addressed. */
function recordingRunner(inner: LogosRunner, log: CallRecord[]): LogosRunner {
  return {
    call(configDir, method, args) {
      log.push({ configDir, op: `call:${method}` });
      return inner.call(configDir, method, args);
    },
    subscribe(configDir, eventName, timeoutMs) {
      log.push({ configDir, op: `watch:${eventName}` });
      return inner.subscribe(configDir, eventName, timeoutMs);
    },
  };
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function logosTempCount(): number {
  return readdirSync(SCRATCH_ROOT).filter((n) => n.startsWith('ssf-logos-')).length;
}

/** Owned-looking processes: node A daemon children and any storage_module watch. */
function logosProcessCount(nodeADir: string): { nodeA: number; watches: number } {
  const out = spawnSync('ps', ['-eo', 'pid=,args='], { encoding: 'utf8' }).stdout;
  const rows = out.split('\n').filter((l) => l.trim() && !/\b(ps|grep|bash -c)\b/.test(l));
  return {
    nodeA: rows.filter((l) => l.includes(nodeADir) && !l.includes(' watch ') && !l.includes(' call ')).length,
    watches: rows.filter((l) => l.includes(' watch storage_module')).length,
  };
}

/**
 * Restarting A changes its daemon identity, so doctor's `logos-replication`
 * proof (bound to both daemons' startedAt) goes stale and only infra:up would
 * rewrite it. Re-prove replication for real against the restarted daemon (fresh
 * bytes uploaded on A, downloaded from B, digest compared) and record it in the
 * same shape logos-up.ts writes, via its own exported helpers.
 */
async function reproveReplication(runtime: LogosRuntime, workDir: string): Promise<void> {
  const runner = defaultLogosRunner(runtime.logosctlPath);
  // A freshly restarted origin answers "Failed to start download." for a while;
  // the adapter retries only that transient error, here over a longer window.
  const storage = createLogosStorageAdapter(runtime, { runner, workDir }, { downloadAttempts: 20, downloadRetryDelayMs: 5_000 });
  const bytes = new Uint8Array(randomBytes(FIRST_RELEASE_MAX_PLAINTEXT_BYTES));
  let downloaded: Uint8Array | undefined;
  let cid = '';
  let lastError: unknown;
  for (let attempt = 1; attempt <= 3 && downloaded === undefined; attempt += 1) {
    try {
      cid = await storage.publish(bytes); // publish also reconnects B -> A by loopback multiaddr
      downloaded = await storage.fetch(cid);
    } catch (error) {
      lastError = error;
      await new Promise((r) => setTimeout(r, 10_000));
    }
  }
  if (downloaded === undefined) {
    throw new Error(`post-restart replication re-proof failed: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
  }
  const digestMatch = sha256(downloaded) === sha256(bytes);
  if (!digestMatch) throw new Error('post-restart replication digest mismatch');
  const peerIdA = await runner.call(runtime.originConfigDir, 'peerId');
  const peerIdB = await runner.call(runtime.replicaConfigDir, 'peerId');
  const a = readDaemonIdentity(runtime.originConfigDir);
  const b = readDaemonIdentity(runtime.replicaConfigDir);
  if (typeof peerIdA !== 'string' || typeof peerIdB !== 'string' || !a || !b) {
    throw new Error('post-restart replication: cannot read peer ids / daemon identities');
  }
  const proof = replicationProof({
    provedAt: new Date().toISOString(),
    peerIdA,
    peerIdB,
    cidPrefix: cid.slice(0, 12),
    bytes: bytes.byteLength,
    digestMatch,
    daemonStartedAt: { a, b },
  });
  writeFileAtomic0600(path.join(LIVE_ROOT, 'logos', 'replication.json'), `${JSON.stringify(proof, null, 2)}\n`);
}

function logosNode(command: 'stop' | 'start' | 'status'): { code: number; stdout: string; stderr: string } {
  const r = spawnSync(process.execPath, ['--experimental-strip-types', LOGOS_NODE, command, '--node', 'a'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    timeout: 300_000,
  });
  return { code: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

function doctorPassRows(): { pass: number; rows: string[] } {
  const r = spawnSync(process.execPath, ['--experimental-strip-types', DOCTOR], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    timeout: 240_000,
    env: { ...process.env, SSF_STRICT_LIVE: '1' },
  });
  const rows = (r.stdout ?? '').split('\n').filter((l) => / (PASS|FAIL|SKIP) /.test(`${l} `));
  return { pass: rows.filter((l) => /^\S+ PASS\b/.test(l)).length, rows };
}

async function waitDoctorAllPass(): Promise<string[]> {
  const deadline = Date.now() + DOCTOR_DEADLINE_MS;
  let last: string[] = [];
  while (Date.now() < deadline) {
    const { pass, rows } = doctorPassRows();
    last = rows;
    if (pass === 6 && rows.length === 6) return rows;
    await new Promise((r) => setTimeout(r, 10_000));
  }
  throw new Error(`strict doctor did not reach 6 PASS within ${DOCTOR_DEADLINE_MS}ms: ${last.join(' | ')}`);
}

describe.runIf(enabled)('live: replica B serves a fresh CID while origin A is stopped', () => {
  let runtime: LogosRuntime;
  let scratchDir = '';
  let tempBefore = 0;
  let procsBefore = { nodeA: 0, watches: 0 };
  let restartedOk = true;

  beforeAll(() => {
    const liveEnv = parseEnvText(readLiveEnvFile(LIVE_ENV_PATH)); // enforces 0600; values never printed
    for (const key of ['LOGOSCTL', 'LOGOS_NODE_A', 'LOGOS_NODE_B'] as const) {
      if (!liveEnv[key]) throw new Error(`live.env is missing ${key}: run npm run infra:up`);
      process.env[key] ??= liveEnv[key];
    }
    process.env.APPIMAGE_EXTRACT_AND_RUN ??= '1';
    const detected = detectLogosRuntime();
    if (!detected.ok) throw new Error(`live Logos runtime unavailable: ${detected.reason}`);
    if (logosNode('status').stdout.trim() !== 'node-a running') throw new Error('precondition: node A is not running');
    const init = JSON.parse(readFileSync(path.join(detected.runtime.originConfigDir, 'storage-init.json'), 'utf8'));
    const port = init?.['listen-port'];
    if (!Number.isInteger(port)) throw new Error('node A storage-init.json has no listen-port');
    runtime = { ...detected.runtime, originListenPort: port };
    const doctor = doctorPassRows();
    if (doctor.pass !== 6) throw new Error(`precondition: strict doctor not 6 PASS: ${doctor.rows.join(' | ')}`);
    tempBefore = logosTempCount();
    procsBefore = logosProcessCount(runtime.originConfigDir);
    scratchDir = mkdtempSync(path.join(SCRATCH_ROOT, 'ssf-origin-stop-'));
  }, 300_000);

  afterAll(async () => {
    // Safety net only: the test's own finally restarts A. Never touches B.
    if (runtime && logosNode('status').stdout.trim() !== 'node-a running') {
      restartedOk = false;
      logosNode('start');
    }
    if (scratchDir) rmSync(scratchDir, { recursive: true, force: true });
    if (!restartedOk) throw new Error('node A had to be restarted by afterAll');
  }, 600_000);

  test('stop A -> new adapter/catalogue fetches from B only -> buyer decrypt hash matches -> restart A', async () => {
    const plaintext = new Uint8Array(randomBytes(FIRST_RELEASE_MAX_PLAINTEXT_BYTES));
    expect(plaintext.byteLength).toBe(41);
    const credentials = createCredentialAdapter();
    const buyer = await credentials.createPurchaseCredential();
    const crypto = createCryptoAdapter({ credentials });
    const dbPath = path.join(scratchDir, 'seller.sqlite');
    const version = `origin-stop-${randomBytes(4).toString('hex')}`;

    // Step 1: publish through origin A with the live adapter.
    const publishLog: CallRecord[] = [];
    const publishRunner = recordingRunner(defaultLogosRunner(runtime.logosctlPath), publishLog);
    const peerB = await publishRunner.call(runtime.replicaConfigDir, 'peerId');
    expect(typeof peerB).toBe('string');
    const publisher = createLogosStorageAdapter(runtime, {
      runner: publishRunner,
      workDir: mkdtempSync(path.join(scratchDir, 'publish-')),
    });
    const published = await publishProduct({
      dbPath,
      version,
      description: 'R2.3 origin-stop payload',
      amountZat: '100000000',
      network: 'test',
      plaintext,
      crypto,
      storage: publisher,
      replicaId: runtime.replicaConfigDir,
    });
    const cid = published.ciphertextCid as string;
    expect(cid.length).toBeGreaterThan(0);
    expect(publishLog.some((r) => r.configDir === runtime.originConfigDir && r.op === 'call:uploadUrl')).toBe(true);
    console.log(`[R2.3] cid=${cid} peerB=${String(peerB)}`);

    let stopped = false;
    // runWithRestore: a restart/re-proof/doctor failure in the restore step never
    // hides the body's assertion error (both are kept in an AggregateError).
    await runWithRestore(async () => {
      // Step 2: stop origin A and prove it is down.
      const stop = logosNode('stop');
      stopped = true;
      expect(stop.code, `logos-node stop failed: ${stop.stderr.trim()}`).toBe(0);
      expect(stop.stdout.trim()).toBe('node-a stopped');
      expect(logosNode('status').stdout.trim()).toBe('node-a stopped');
      await expect(defaultLogosRunner(runtime.logosctlPath).call(runtime.originConfigDir, 'peerId')).rejects.toThrow();

      // Step 3: brand-new adapter + catalogue (fresh workDir, no upload buffer).
      const fetchLog: CallRecord[] = [];
      const reader = createLogosStorageAdapter(runtime, {
        runner: recordingRunner(defaultLogosRunner(runtime.logosctlPath), fetchLog),
        workDir: mkdtempSync(path.join(scratchDir, 'fetch-')),
      });
      const catalogue = openCatalogue({ dbPath, storage: reader });
      let fetched: Uint8Array;
      try {
        // Direct fetch path (no verifyReplica swallowing): a B failure surfaces verbatim.
        fetched = await catalogue.getPublishedCiphertext(version);
      } finally {
        catalogue.close();
      }
      expect(fetched.byteLength).toBe(FIRST_RELEASE_MAX_CIPHERTEXT_BYTES);
      expect(fetchLog.length).toBeGreaterThan(0);
      expect(new Set(fetchLog.map((r) => r.configDir))).toEqual(new Set([runtime.replicaConfigDir]));
      expect(fetchLog.some((r) => r.op === 'call:downloadToUrl')).toBe(true);

      const sealed = await crypto.sealDelivery({
        orderId: 'r23-order',
        productVersion: version,
        buyerKeyId: buyer.buyerKeyId,
        productKeyRef: published.sellerKeyRef as string,
      });
      const blob = await decryptDownload({
        orderId: 'r23-order',
        productVersion: version,
        buyerKeyId: buyer.buyerKeyId,
        encryptedEnvelope: sealed,
      }, fetched, { crypto, credentialId: buyer.credentialId });
      const decrypted = new Uint8Array(await blob.arrayBuffer());
      expect(sha256(decrypted)).toBe(sha256(plaintext));
      console.log(`[R2.3] fetch-phase dirs=${[...new Set(fetchLog.map((r) => path.basename(r.configDir)))].join(',')} ops=${fetchLog.length} hash-match=true`);
    }, async () => {
      // Step 4: always restart A, then wait for strict doctor 6 PASS.
      if (stopped) {
        const start = logosNode('start');
        if (start.code !== 0 || start.stdout.trim() !== 'node-a started') {
          restartedOk = false;
          throw new Error(`logos-node start failed (exit ${start.code}): ${start.stderr.trim()}`);
        }
        await reproveReplication(runtime, mkdtempSync(path.join(scratchDir, 'reprove-')));
      }
      const rows = await waitDoctorAllPass();
      console.log(`[R2.3] doctor after restart: ${rows.length} rows all PASS`);
    });

    // Leak check: no extra processes, no new ssf-logos-* temp dirs.
    expect(logosTempCount()).toBe(tempBefore);
    const procsAfter = logosProcessCount(runtime.originConfigDir);
    expect(procsAfter.watches).toBeLessThanOrEqual(procsBefore.watches);
    expect(procsAfter.nodeA).toBe(procsBefore.nodeA);
  }, TEST_TIMEOUT_MS);
});

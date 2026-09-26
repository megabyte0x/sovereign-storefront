import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { consensusFingerprint } from '../../src/contracts/consensus.ts';
import {
  classifyAdapters,
  classifyCheckout,
  classifyPayment,
  classifyRecover,
  classifyReplicaRetrieve,
  evaluatePreflight,
  isOverallPass,
  runDemoCheck,
  type PreflightInput,
} from '../../scripts/demo-check.ts';

const DESTINATION =
  'uregtest1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq';

function baseInput(overrides: Partial<PreflightInput> = {}): PreflightInput {
  return {
    nodeVersion: 'v26.9.0',
    env: {
      SSF_MODE: 'real-demo',
      SSF_NETWORK: 'regtest',
      SSF_MIN_CONFIRMATIONS: '10',
      SSF_MAX_HEALTH_AGE_MS: '120000',
      SSF_MAX_CIPHERTEXT_BYTES: '73',
      SSF_MAX_PLAINTEXT_BYTES: '41',
      SSF_INVOICE_TTL_MS: '86400000',
      SSF_DB_PATH: '/tmp/ssf-demo.sqlite',
      // Legacy substituted env: real-demo rejects inline SSF_ADMIN_TOKEN /
      // SSF_SELLER_KEY_ID, and the live keys are absent (typed SKIP).
      SSF_DESTINATION: DESTINATION,
      SSF_ADAPTER_MESSAGING: 'real',
      SSF_ADAPTER_STORAGE: 'real',
      SSF_ADAPTER_SCANNER: 'real',
    },
    ths: {
      running: true,
      version: '0.2.1',
      dashboard: 'http://127.0.0.1:32771',
      nodeChain: 'test',
      network: 'Regtest',
      healthy: true,
      caughtUp: true,
      height: 127,
    },
    logos: { ok: true, independentPeers: true },
    chromiumPath: '/usr/bin/chromium',
    tlsTerminatedByApp: false,
    ...overrides,
  };
}

test('preflight fails fast when ths is not running and does not claim pass', () => {
  const result = evaluatePreflight(baseInput({ ths: { running: false } }));
  expect(result.ok).toBe(false);
  expect(result.checks.find((item) => item.id === 'scanner')?.status).toBe('FAIL');
  expect(isOverallPass(result.checks)).toBe(false);
});

test('replica absence fails fast and does not count as passing', () => {
  const result = evaluatePreflight(baseInput({
    logos: { ok: false, reason: 'live two-node Logos is not running in this worktree' },
  }));
  expect(result.checks.find((item) => item.id === 'replica')?.status).toBe('FAIL');
  expect(isOverallPass(result.checks)).toBe(false);
  expect(result.ok).toBe(false);
});

test('two logos nodes without origin-stop retrieve is not replica PASS', () => {
  const result = evaluatePreflight(baseInput({
    logos: { ok: true, independentPeers: true },
  }));
  expect(result.checks.find((item) => item.id === 'replica')?.status).not.toBe('PASS');
  expect(result.ok).toBe(false);
});

test('chromium present but not launched is not PASS', () => {
  const result = evaluatePreflight(baseInput({ chromiumPath: '/usr/bin/chromium' }));
  expect(result.checks.find((item) => item.id === 'chromium')?.status).not.toBe('PASS');
});

test('fixture adapters fail before any live settlement claim', () => {
  const result = evaluatePreflight(baseInput({
    env: {
      ...baseInput().env,
      SSF_ADAPTER_MESSAGING: 'fixture',
      SSF_ADAPTER_STORAGE: 'real',
      SSF_ADAPTER_SCANNER: 'real',
    },
  }));
  expect(result.ok).toBe(false);
  expect(result.checks.find((item) => item.id === 'adapters')?.status).toBe('FAIL');
});

test('preflight adapters is not PASS when live constructs memory adapters', () => {
  const classified = classifyAdapters({
    configReal: true,
    liveMessaging: 'memory',
    liveStorage: 'memory',
    liveScanner: 'memory',
  });
  expect(classified.status).not.toBe('PASS');
  expect(classified.detail).toMatch(/MemoryScanner/);
  expect(classified.detail).toMatch(/createMemoryMessaging/);
  expect(classified.detail).toMatch(/createMemoryStorageAdapter/);

  const result = evaluatePreflight(baseInput({
    liveAdapters: { messaging: 'memory', storage: 'memory', scanner: 'memory' },
  }));
  expect(result.checks.find((item) => item.id === 'adapters')?.status).not.toBe('PASS');
  expect(result.ok).toBe(false);
});

test('mainnet selection fails preflight', () => {
  const result = evaluatePreflight(baseInput({
    env: { ...baseInput().env, SSF_NETWORK: 'mainnet' },
  }));
  expect(result.ok).toBe(false);
  expect(result.checks.find((item) => item.id === 'network')?.status).toBe('FAIL');
});

test('real-demo records minConfirmations 10 and rejects 0 or 1', () => {
  const ok = evaluatePreflight(baseInput());
  expect(ok.minConfirmations).toBe(10);
  expect(evaluatePreflight(baseInput({
    env: { ...baseInput().env, SSF_MIN_CONFIRMATIONS: '0' },
  })).ok).toBe(false);
  expect(evaluatePreflight(baseInput({
    env: { ...baseInput().env, SSF_MIN_CONFIRMATIONS: '1' },
  })).checks.find((item) => item.id === 'confirmations')?.status).toBe('FAIL');
});

test('healthy caught-up zakura/regtest is labelled regtest even when node.chain is test', () => {
  const result = evaluatePreflight(baseInput());
  expect(result.ok).toBe(false);
  expect(result.networkLabel).toBe('zakura/regtest');
  expect(result.nodeChain).toBe('test');
  expect(result.publicTestnet).toBe(false);
  expect(result.walletReadWired).toBe(false);
  expect(result.checks.find((item) => item.id === 'network')?.status).toBe('PASS');
  expect(result.checks.find((item) => item.id === 'scanner')?.status).toBe('PASS');
});

test('demo-check does not run live steps or claim pass when preflight fails', async () => {
  let liveCalled = false;
  const result = await runDemoCheck({
    preflight: baseInput({ ths: { running: false } }),
    runLive: async () => {
      liveCalled = true;
      return { steps: [{ id: 'payment', status: 'PASS' as const, detail: 'fake' }] };
    },
  });
  expect(liveCalled).toBe(false);
  expect(result.ok).toBe(false);
  expect(result.liveAttempted).toBe(false);
  expect(isOverallPass([...result.preflight, ...result.steps])).toBe(false);
});

test('demo-check fails fast and does not run live when replica is absent', async () => {
  let liveCalled = false;
  const result = await runDemoCheck({
    preflight: baseInput({
      logos: { ok: false, reason: 'live two-node Logos is not running in this worktree' },
    }),
    runLive: async () => {
      liveCalled = true;
      return { steps: [{ id: 'replica-retrieve', status: 'SKIP' as const, detail: 'fake retrieve' }] };
    },
  });
  expect(liveCalled).toBe(false);
  expect(result.ok).toBe(false);
  expect(result.liveAttempted).toBe(false);
  expect(result.preflight.find((item) => item.id === 'replica')?.status).toBe('FAIL');
});

test('memory-scanner injection cannot be labelled payment PASS', () => {
  const result = classifyPayment({
    scannerKind: 'memory',
    injectedObservation: true,
    outputIndexKnown: false,
  });
  expect(result.id).toBe('payment');
  expect(result.status).not.toBe('PASS');
});

test('http-only checkout cannot be labelled PASS', () => {
  const result = classifyCheckout({
    browserLaunched: false,
    httpOnly: true,
  });
  expect(result.id).toBe('checkout');
  expect(result.status).not.toBe('PASS');
});

test('unrun replica retrieve cannot be labelled PASS', () => {
  const absent = classifyReplicaRetrieve({
    twoNodesDetected: false,
    originStopped: false,
    retrieved: false,
    reason: 'live two-node Logos is not proven in this run',
  });
  expect(absent.id).toBe('replica-retrieve');
  expect(absent.status).toBe('FAIL');

  const twoNodesUnrun = classifyReplicaRetrieve({
    twoNodesDetected: true,
    originStopped: false,
    retrieved: false,
  });
  expect(twoNodesUnrun.status).toBe('FAIL');
  expect(twoNodesUnrun.detail.toLowerCase()).not.toMatch(/\bpass\b/);
  expect(twoNodesUnrun.detail.toLowerCase()).not.toMatch(/\bskip\b/);
});

test('origin-stop retrieve skips only with an explicit unsafe reason', () => {
  const unsafe = classifyReplicaRetrieve({
    twoNodesDetected: true,
    originStopped: false,
    retrieved: false,
    originStopUnsafeReason: 'origin-stop is unsafe because another process needs the node',
  });
  expect(unsafe.status).toBe('SKIP');
  expect(unsafe.detail).toMatch(/another process needs the node/);
});

test('http recover after memory-scanner injection cannot be labelled PASS', () => {
  const result = classifyRecover({
    usedInjectedObservation: true,
    browserReopened: false,
  });
  expect(result.id).toBe('recover');
  expect(result.status).not.toBe('PASS');
});

test('substituted live steps keep overall ok false and record faucet tx as chain evidence', async () => {
  const result = await runDemoCheck({
    preflight: baseInput(),
    runLive: async () => ({
      steps: [
        classifyCheckout({ browserLaunched: false, httpOnly: true }),
        classifyPayment({
          scannerKind: 'memory',
          injectedObservation: true,
          outputIndexKnown: false,
        }),
        classifyRecover({ usedInjectedObservation: true, browserReopened: false }),
        classifyReplicaRetrieve({
          twoNodesDetected: true,
          originStopped: false,
          retrieved: false,
        }),
      ],
      txid: 'e1bf91f52e90f358fd69c4542f95f1aa0d08623268715c10d1cd2160b30ebcb2',
      faucetConfirmations: 1,
      policyConfirmations: 10,
    }),
  });
  expect(result.ok).toBe(false);
  expect(result.txid).toBe('e1bf91f52e90f358fd69c4542f95f1aa0d08623268715c10d1cd2160b30ebcb2');
  expect(result.faucetConfirmations).toBe(1);
  expect(result.steps.find((item) => item.id === 'payment')?.status).not.toBe('PASS');
  expect(result.steps.find((item) => item.id === 'checkout')?.status).not.toBe('PASS');
  expect(result.steps.find((item) => item.id === 'recover')?.status).not.toBe('PASS');
  expect(result.steps.find((item) => item.id === 'replica-retrieve')?.status).not.toBe('PASS');
});

// --- Fix round 1 (Important #2): only a typed missing-live-key error may SKIP.
const LIVE_ACTIVATIONS = {
  overwinter: 1, sapling: 1, blossom: 1, heartwood: 1, canopy: 1, nu5: 1, nu6: 1,
  'nu6-1': null, 'nu6-2': null, 'nu6-3': null,
};

function liveFile(dir: string, name: string, contents: string, mode = 0o600): string {
  const path = join(dir, name);
  writeFileSync(path, contents, { mode });
  chmodSync(path, mode);
  return path;
}

let liveFileCounter = 0;
function liveScannerConfig(dir: string, chain: Record<string, unknown> = {}, mode = 0o600): string {
  liveFileCounter += 1;
  return liveFile(dir, `${liveFileCounter}-scanner.json`, JSON.stringify({
    ufvk: 'not-a-real-ufvk',
    runtime: {
      chain: { network: 'regtest', genesisHash: 'ab'.repeat(32), consensusFingerprint: consensusFingerprint('regtest', LIVE_ACTIVATIONS), ...chain },
      activations: LIVE_ACTIVATIONS,
    },
  }), mode);
}

function substitutedLiveInput(dir: string, env: Record<string, string | undefined>): PreflightInput {
  const base = baseInput().env;
  const merged: Record<string, string | undefined> = {
    ...base,
    SSF_DESTINATION: undefined,
    SSF_ADMIN_TOKEN: undefined,
    SSF_SELLER_KEY_ID: undefined,
    SSF_ADMIN_TOKEN_FILE: liveFile(dir, `${++liveFileCounter}-admin.token`, 'admin-secret\n'),
    SSF_SCANNER_SOCKET: '/run/ssf/scanner.sock',
    SSF_SCANNER_ACCOUNT_ID: 'seller-account-0',
    SSF_SCANNER_CONFIG: liveScannerConfig(dir),
    SSF_WAKU_CONTENT_TOPIC: '/ssf/1/live-run/proto',
    WAKU_BOOTSTRAP_PEERS: '/dns4/a.example/tcp/8000/wss/p2p/16Uiu2HAmA',
    LOGOSCTL: '/opt/logos/logosctl',
    LOGOS_NODE_A: '/var/lib/ssf/logos/node-a',
    LOGOS_NODE_B: '/var/lib/ssf/logos/node-b',
    ...env,
  };
  return baseInput({ env: merged, liveAdapters: { messaging: 'memory', storage: 'memory', scanner: 'memory' } });
}

function adaptersStatus(input: PreflightInput): string | undefined {
  return evaluatePreflight(input).checks.find((item) => item.id === 'adapters')?.status;
}

let liveDir = '';
beforeEach(() => { liveDir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), 'ssf-demo-live-')); });
afterEach(() => { rmSync(liveDir, { recursive: true, force: true }); });

test('substituted path SKIPs only for a missing live key', () => {
  for (const key of ['SSF_ADMIN_TOKEN_FILE', 'SSF_SCANNER_SOCKET', 'SSF_SCANNER_CONFIG', 'WAKU_BOOTSTRAP_PEERS', 'LOGOS_NODE_B']) {
    expect(adaptersStatus(substitutedLiveInput(liveDir, { [key]: undefined })), key).toBe('SKIP');
  }
});

test('substituted path FAILs on a group/world-readable secret file', () => {
  const loose = liveFile(liveDir, 'loose.token', 'admin-secret\n', 0o644);
  expect(adaptersStatus(substitutedLiveInput(liveDir, { SSF_ADMIN_TOKEN_FILE: loose }))).toBe('FAIL');
  expect(adaptersStatus(substitutedLiveInput(liveDir, { SSF_SCANNER_CONFIG: liveScannerConfig(liveDir, {}, 0o644) }))).toBe('FAIL');
});

test('substituted path FAILs on a consensus fingerprint mismatch or raw digest', () => {
  expect(adaptersStatus(substitutedLiveInput(liveDir, { SSF_SCANNER_CONFIG: liveScannerConfig(liveDir, { consensusFingerprint: 'cd'.repeat(32) }) }))).toBe('FAIL');
  expect(adaptersStatus(substitutedLiveInput(liveDir, { SSF_CONSENSUS_FINGERPRINT: 'cd'.repeat(32) }))).toBe('FAIL');
});

test('substituted path FAILs on network drift and secret-policy violations', () => {
  expect(adaptersStatus(substitutedLiveInput(liveDir, { SSF_SCANNER_CONFIG: liveScannerConfig(liveDir, { network: 'test' }) }))).toBe('FAIL');
  expect(adaptersStatus(substitutedLiveInput(liveDir, { SSF_ADMIN_TOKEN: 'inline-secret' }))).toBe('FAIL');
  expect(adaptersStatus(substitutedLiveInput(liveDir, { SSF_SELLER_KEY_ID: 'seller-key-1' }))).toBe('FAIL');
});

test('substituted path FAILs on invalid (present but malformed) live values', () => {
  expect(adaptersStatus(substitutedLiveInput(liveDir, { WAKU_BOOTSTRAP_PEERS: '/dns4/a.example/tcp/8000/ws/p2p/16Uiu2HAmA' }))).toBe('FAIL');
  expect(adaptersStatus(substitutedLiveInput(liveDir, { SSF_SCANNER_SOCKET: 'relative/scanner.sock' }))).toBe('FAIL');
  expect(adaptersStatus(substitutedLiveInput(liveDir, { SSF_NETWORK: undefined }))).toBe('FAIL');
});

// --- R4.5: demo:live harness (file-based real-demo config, strict report) ---
import { readFileSync as readSource } from 'node:fs';
import { validateLiveReport, L_MATRIX_IDS, WORKFLOW_STAGE_IDS, type LiveStage } from '../../scripts/live-report.ts';
import {
  D4_TESTNET_REASON,
  assembleLiveReport,
  buildDemoLiveEnv,
  deriveMatrixRows,
  parseSellerLine,
  readBuildProvenance,
  runDemoLive,
  sanitizeEvidence,
  type DemoLiveDeps,
} from '../../scripts/demo-check.ts';

const EMPTY_DIFF_SHA = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
const COMMIT = 'bd5e53ca343c5de53ad2e5b99dc8bd85a58fe930';

test('main() sets no inline SSF_ADMIN_TOKEN / SSF_SELLER_KEY_ID', () => {
  const source = readSource(new URL('../../scripts/demo-check.ts', import.meta.url), 'utf8');
  const mainBody = source.slice(source.indexOf('async function main('));
  expect(mainBody.length).toBeGreaterThan(0);
  expect(mainBody).not.toMatch(/SSF_ADMIN_TOKEN\s*:/);
  expect(mainBody).not.toMatch(/SSF_SELLER_KEY_ID\s*:/);
  expect(source).not.toMatch(/SSF_ADMIN_TOKEN:\s*'/);
  expect(source).not.toMatch(/SSF_SELLER_KEY_ID:\s*'/);
});

test('buildDemoLiveEnv uses the file-based real-demo config and drops inline secrets', () => {
  const env = buildDemoLiveEnv('SSF_SCANNER_SOCKET=/run/s.sock\nSSF_ADMIN_TOKEN=x\n', {
    SSF_ADMIN_TOKEN: 'inline', SSF_SELLER_KEY_ID: 'k', PATH: '/usr/bin',
  }, { dbPath: '/d/seller.sqlite', adminTokenFile: '/d/admin.token', scannerConfig: '/s/scanner.json', publicPort: 41001, adminPort: 41002 });
  expect(env.SSF_ADMIN_TOKEN).toBeUndefined();
  expect(env.SSF_SELLER_KEY_ID).toBeUndefined();
  expect(env.SSF_MODE).toBe('real-demo');
  expect(env.SSF_NETWORK).toBe('regtest');
  expect(env.SSF_ADMIN_TOKEN_FILE).toBe('/d/admin.token');
  expect(env.SSF_SCANNER_CONFIG).toBe('/s/scanner.json');
  expect(env.SSF_DB_PATH).toBe('/d/seller.sqlite');
  expect(env.SSF_MIN_CONFIRMATIONS).toBe('10');
  expect(env.SSF_PUBLIC_PORT).toBe('41001');
  expect(env.SSF_ADMIN_PORT).toBe('41002');
  expect(env.SSF_PUBLIC_HOST).toBe('127.0.0.1');
  expect(env.SSF_SCANNER_SOCKET).toBe('/run/s.sock');
});

test('readBuildProvenance requires a build:clean build-info and maps the dirty digest', () => {
  const info = { sourceCommit: COMMIT, dirtyDiffDigest: 'ab'.repeat(32), buildTimestamp: '2026-09-26T10:00:00.000Z' };
  expect(readBuildProvenance(info, EMPTY_DIFF_SHA)).toEqual({
    commit: COMMIT, dirty: true, diffSha256: 'ab'.repeat(32), cleanBuild: true, builtAt: '2026-09-26T10:00:00.000Z',
  });
  expect(readBuildProvenance({ ...info, dirtyDiffDigest: EMPTY_DIFF_SHA }, EMPTY_DIFF_SHA))
    .toEqual({ commit: COMMIT, dirty: false, cleanBuild: true, builtAt: '2026-09-26T10:00:00.000Z' });
  expect(() => readBuildProvenance({ sourceCommit: 'nope' }, EMPTY_DIFF_SHA)).toThrow(/build-info/);
});

test('parseSellerLine reads public/admin/ready lines only', () => {
  expect(parseSellerLine('public http://127.0.0.1:41001')).toEqual({ kind: 'public', url: 'http://127.0.0.1:41001' });
  expect(parseSellerLine('admin http://127.0.0.1:41002')).toEqual({ kind: 'admin', url: 'http://127.0.0.1:41002' });
  expect(parseSellerLine('ready scanner=true messaging=true checkout=false products=0'))
    .toEqual({ kind: 'ready', scanner: true, messaging: true, checkout: false, products: 0 });
  expect(parseSellerLine('startup failed: ConfigError')).toEqual({ kind: 'failed', reason: 'startup failed: ConfigError' });
  expect(parseSellerLine('{"event":"x"}')).toBeUndefined();
});

test('sanitizeEvidence refuses payment URIs, addresses, keys and tokens', () => {
  expect(sanitizeEvidence(['cid=zDvZ', 'peerB=16Uiu2HAm', 'confirmations=10'])).toEqual(['cid=zDvZ', 'peerB=16Uiu2HAm', 'confirmations=10']);
  for (const bad of ['zcash:uregtest1abc?amount=1', 'to=uregtest1qqqq', 'uviewregtest1xyz', 'token=abc', 'secret-extended-key-x', 'mnemonic words']) {
    expect(() => sanitizeEvidence([bad]), bad).toThrow(/sensitive/);
  }
});

/** Per-row named suite evidence (the matrix gate column); global ok alone passes nothing. */
function suitesFor(ok = true) {
  return { ok, evidence: ['x'], rows: Object.fromEntries(L_MATRIX_IDS.map((id) => [id, { ok, evidence: [`${id} suite`] }])) };
}

function pass(id: string): LiveStage {
  return { id: id as LiveStage['id'], status: 'PASS', evidence: [`${id}=observed`] };
}

test('deriveMatrixRows passes an L row only when every mapped stage and suite passed', () => {
  const stages = WORKFLOW_STAGE_IDS.map(pass);
  const all = deriveMatrixRows(stages, { suites: suitesFor(), provenanceOk: true, adaptersOk: true });
  expect(all.map((row) => row.id)).toEqual([...L_MATRIX_IDS]);
  expect(all.every((row) => row.status === 'PASS' && (row.evidence?.length ?? 0) > 0)).toBe(true);

  const noOriginStop = deriveMatrixRows(stages.filter((s) => s.id !== 'origin-stop'), { suites: suitesFor(), provenanceOk: true, adaptersOk: true });
  expect(noOriginStop.find((r) => r.id === 'L12')?.status).not.toBe('PASS');
  const noSuites = deriveMatrixRows(stages, { suites: suitesFor(false), provenanceOk: true, adaptersOk: true });
  expect(noSuites.find((r) => r.id === 'L02')?.status).not.toBe('PASS');
  const noProvenance = deriveMatrixRows(stages, { suites: suitesFor(), provenanceOk: false, adaptersOk: true });
  expect(noProvenance.find((r) => r.id === 'L01')?.status).not.toBe('PASS');
});

const IDENTITY = {
  scanner: { kind: 'ssf-scanner-unix-socket', version: '0.1.0' },
  storage: { kind: 'logos-storage-module', version: '2.1.2' },
  messaging: { kind: 'waku-light-push', version: '0.0.36' },
};

test('assembleLiveReport fills unreached stages as NOT_RUN and T01 NOT_RUN (D4)', () => {
  const build = { commit: COMMIT, dirty: false, cleanBuild: true as const, builtAt: '2026-09-26T10:00:00.000Z' };
  const partial = assembleLiveReport({ build, adapters: IDENTITY, stages: [pass('publish')], suites: suitesFor(), adaptersOk: true });
  const t01 = partial.stages.find((s) => s.id === 'T01');
  expect(t01).toEqual({ id: 'T01', status: 'NOT_RUN', reason: D4_TESTNET_REASON });
  expect(partial.stages.find((s) => s.id === 'origin-stop')?.status).toBe('NOT_RUN');
  expect(validateLiveReport(partial).ok).toBe(false);

  const full = assembleLiveReport({ build, adapters: IDENTITY, stages: WORKFLOW_STAGE_IDS.map(pass), suites: suitesFor(), adaptersOk: true });
  expect(validateLiveReport(full)).toEqual({ ok: true, errors: [] });
});

function fakeDeps(overrides: Partial<DemoLiveDeps> = {}): { deps: DemoLiveDeps; calls: string[]; written: unknown[] } {
  const calls: string[] = [];
  const written: unknown[] = [];
  const build = { commit: COMMIT, dirty: false, cleanBuild: true as const, builtAt: '2026-09-26T10:00:00.000Z' };
  const deps: DemoLiveDeps = {
    cleanBuild: async () => { calls.push('build'); return build; },
    doctor: async () => { calls.push('doctor'); return { ok: true, rows: ['zcash PASS'] }; },
    startSeller: async () => { calls.push('seller'); return { publicUrl: 'http://127.0.0.1:1', adminUrl: 'http://127.0.0.1:2' }; },
    runSuites: async () => { calls.push('suites'); return suitesFor(); },
    runPlaywright: async () => { calls.push('playwright'); return { exitCode: 0 }; },
    readStages: async () => { calls.push('stages'); return WORKFLOW_STAGE_IDS.map(pass); },
    adapters: () => IDENTITY,
    writeReport: async (report) => { calls.push('write'); written.push(report); },
    cleanup: async () => { calls.push('cleanup'); return { ok: true }; },
    log: () => undefined,
    ...overrides,
  };
  return { deps, calls, written };
}

test('runDemoLive runs build -> doctor -> seller -> playwright -> report -> validate, cleanup last', async () => {
  const { deps, calls, written } = fakeDeps();
  const result = await runDemoLive(deps);
  expect(calls).toEqual(['build', 'doctor', 'seller', 'suites', 'playwright', 'stages', 'write', 'cleanup']);
  expect(result.exitCode).toBe(0);
  expect(validateLiveReport(written[0]).ok).toBe(true);
});

test('runDemoLive exits nonzero and still cleans up when a stage is missing', async () => {
  const { deps, calls } = fakeDeps({ readStages: async () => WORKFLOW_STAGE_IDS.filter((id) => id !== 'origin-stop').map(pass) });
  const result = await runDemoLive(deps);
  expect(result.exitCode).not.toBe(0);
  expect(result.errors.join('\n')).toMatch(/origin-stop/);
  expect(calls.at(-1)).toBe('cleanup');
});

test('runDemoLive does not start a seller when strict doctor fails, and never reports ok', async () => {
  const { deps, calls, written } = fakeDeps({ doctor: async () => ({ ok: false, rows: ['waku FAIL down'] }) });
  const result = await runDemoLive(deps);
  expect(calls).not.toContain('seller');
  expect(calls).not.toContain('playwright');
  expect(calls.at(-1)).toBe('cleanup');
  expect(result.exitCode).not.toBe(0);
  expect(validateLiveReport(written[0]).ok).toBe(false);
});

test('runDemoLive cleans up when the seller or playwright throws, and a playwright failure is nonzero', async () => {
  const thrown = fakeDeps({ startSeller: async () => { throw new Error('seller did not become ready'); } });
  const r1 = await runDemoLive(thrown.deps);
  expect(r1.exitCode).not.toBe(0);
  expect(thrown.calls.at(-1)).toBe('cleanup');

  const pw = fakeDeps({ runPlaywright: async () => ({ exitCode: 1 }) });
  const r2 = await runDemoLive(pw.deps);
  expect(r2.exitCode).not.toBe(0);
  expect(pw.calls.at(-1)).toBe('cleanup');

  const dirty = fakeDeps({ cleanup: async () => ({ ok: false }) });
  expect((await runDemoLive(dirty.deps)).exitCode).not.toBe(0);
});

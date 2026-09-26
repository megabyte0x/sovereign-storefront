// R4 review fixes (task-R4-review.md): each test failed before its fix.
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { validateLiveReport, WORKFLOW_STAGE_IDS, L_MATRIX_IDS, type LiveStage } from '../../scripts/live-report.ts';
import {
  assembleLiveReport,
  deriveMatrixRows,
  runDemoLive,
  sanitizeEvidence,
  type DemoLiveDeps,
  type SuitesResult,
} from '../../scripts/demo-check.ts';
import { createLiveResourceRegistry, type ProcessLayer } from '../../scripts/live-resources.ts';
import { runLivePay } from '../../scripts/live-pay.ts';
import { createLiveReceiptSource } from '../../src/adapters/live.ts';

const COMMIT = 'bd5e53ca343c5de53ad2e5b99dc8bd85a58fe930';
const BUILD = { commit: COMMIT, dirty: false, cleanBuild: true as const, builtAt: '2026-09-26T10:00:00.000Z' };
const IDENTITY = {
  scanner: { kind: 'ssf-scanner-unix-socket', version: '0.1.0' },
  storage: { kind: 'logos-storage-module', version: '2.1.2' },
  messaging: { kind: 'waku-light-push', version: '0.0.36' },
};
const pass = (id: string): LiveStage => ({ id: id as LiveStage['id'], status: 'PASS', evidence: [`${id}=observed`] });
function allSuites(): SuitesResult {
  return {
    ok: true,
    evidence: ['vitest ok'],
    rows: Object.fromEntries(L_MATRIX_IDS.map((id) => [id, { ok: true, evidence: [`${id} suite evidence`] }])),
  };
}
const fullReport = () => assembleLiveReport({ build: BUILD, adapters: IDENTITY, stages: WORKFLOW_STAGE_IDS.map(pass), suites: allSuites(), adaptersOk: true });

test('the validator rejects camelCase memory/fixture/fake adapter kinds', () => {
  expect(validateLiveReport(fullReport()).ok).toBe(true);
  for (const kind of ['MemoryScanner', 'FixtureStorage', 'fakeWaku', 'InMemoryMessaging', 'mockScanner']) {
    expect(validateLiveReport({ ...fullReport(), scanner: { kind, version: '1' } }).ok, kind).toBe(false);
  }
});

test('assembleLiveReport sanitizes evidence: a refused row fails and the value never reaches the report', () => {
  const uri = 'zcash:uregtest1qqqqabcdefgh?amount=1';
  const stages = WORKFLOW_STAGE_IDS.map(pass).map((stage) => (stage.id === 'fund-a' ? { ...stage, evidence: [`paid ${uri}`] } : stage));
  const report = assembleLiveReport({ build: BUILD, adapters: IDENTITY, stages, suites: allSuites(), adaptersOk: true });
  expect(JSON.stringify(report)).not.toContain('uregtest1qqqq');
  expect(report.stages.find((stage) => stage.id === 'fund-a')?.status).toBe('FAIL');
  expect(validateLiveReport(report).ok).toBe(false);
});

test('sanitizeEvidence catches address/key/bearer shapes and never echoes the refused value', () => {
  for (const bad of ['addr_uregtest1qqqqabc', 'zregtestsapling1qqqqabc', 'to=tmXk3sG9aBcDeFgHiJkLmNoPqRsTuVwXyZ1', 't1Kx9AbCdEfGhIjKlMnOpQrStUvWxYz12345', 'Authorization: Bearer abc.def']) {
    let message = '';
    try { sanitizeEvidence(['ok', bad]); } catch (error) { message = String(error); }
    expect(message, bad).toMatch(/sensitive evidence refused at index 1/);
    expect(message).not.toContain(bad.slice(0, 8));
  }
});

test('deriveMatrixRows needs per-row suite evidence, and a failed suite row is FAIL', () => {
  const stages = WORKFLOW_STAGE_IDS.map(pass);
  const rows = deriveMatrixRows(stages, { suites: allSuites(), provenanceOk: true, adaptersOk: true });
  expect(rows.every((row) => row.status === 'PASS')).toBe(true);

  const globalOnly: SuitesResult = { ok: true, evidence: ['vitest ok'] };
  const weak = deriveMatrixRows(stages, { suites: globalOnly, provenanceOk: true, adaptersOk: true });
  for (const id of ['L02', 'L06', 'L08', 'L13', 'L14', 'L15'] as const) {
    expect(weak.find((row) => row.id === id)?.status, id).not.toBe('PASS');
  }

  const suites = allSuites();
  suites.rows!.L06 = { ok: false, evidence: ['fork tests failed'] };
  expect(deriveMatrixRows(stages, { suites, provenanceOk: true, adaptersOk: true }).find((row) => row.id === 'L06')?.status).toBe('FAIL');
});

function deps(overrides: Partial<DemoLiveDeps>): { deps: DemoLiveDeps; logs: string[] } {
  const logs: string[] = [];
  return {
    logs,
    deps: {
      cleanBuild: async () => BUILD,
      doctor: async () => ({ ok: true, rows: [] }),
      startSeller: async () => ({ publicUrl: 'http://127.0.0.1:1', adminUrl: 'http://127.0.0.1:2' }),
      runSuites: async () => allSuites(),
      runPlaywright: async () => ({ exitCode: 0 }),
      readStages: async () => WORKFLOW_STAGE_IDS.map(pass),
      adapters: () => IDENTITY,
      writeReport: async () => {},
      cleanup: async () => ({ ok: true }),
      log: (line) => logs.push(line),
      ...overrides,
    },
  };
}

test('runDemoLive judges adapter identity with the validator rule and logs doctor row ids only', async () => {
  const fixture = deps({ adapters: () => ({ ...IDENTITY, scanner: { kind: 'MemoryScanner', version: '1' } }) });
  const result = await runDemoLive(fixture.deps);
  expect(result.exitCode).not.toBe(0);
  expect(result.report?.stages.find((stage) => stage.id === 'L01')?.status).not.toBe('PASS');

  const doctor = deps({ doctor: async () => ({ ok: false, rows: ['waku FAIL peer wss://secret-host:8000 down'] }) });
  await runDemoLive(doctor.deps);
  expect(doctor.logs.join('\n')).toContain('waku');
  expect(doctor.logs.join('\n')).not.toContain('secret-host');
});

const scratch: string[] = [];
afterEach(() => { for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true }); });

test('cleanup does not follow a parent directory swapped for a symlink out of the roots', async () => {
  const base = mkdtempSync(path.join(tmpdir(), 'ssf-r4fix-'));
  scratch.push(base);
  const root = path.join(base, 'root');
  const outside = path.join(base, 'outside');
  mkdirSync(path.join(root, 'parent', 'owned'), { recursive: true });
  mkdirSync(path.join(outside, 'owned'), { recursive: true });
  writeFileSync(path.join(outside, 'owned', 'keep.txt'), 'keep');
  const processes: ProcessLayer = { readCmdline: () => undefined, kill: () => {}, isAlive: () => false, sleep: async () => {} };
  const registry = createLiveResourceRegistry({ path: path.join(base, 'demo', 'resources.json'), processes, scratchRoots: [root] });
  registry.registerScratchDir({ path: path.join(root, 'parent', 'owned'), label: 'owned' });
  rmSync(path.join(root, 'parent'), { recursive: true });
  symlinkSync(outside, path.join(root, 'parent'));
  await registry.cleanup();
  expect(existsSync(path.join(outside, 'owned', 'keep.txt'))).toBe(true);
});

test('live-pay takes the txid only from the JSON field, never any hex in stdout', async () => {
  const lines: string[] = [];
  const uri = 'zcash:uregtest1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq?amount=0.0123';
  const code = await runLivePay(['fund', '--uri', uri], {
    env: { THS_ENV_NAME: 'ssf-live' },
    runner: async () => ({ code: 0, stdout: `block ${'ab'.repeat(32)} mined\n`, stderr: '' }),
    log: (line) => lines.push(line),
  });
  expect(code).toBe(0);
  expect(lines.join('\n')).toContain('txid=unknown');
});

test('a microsecond-scale expiresAt is rejected before any scanner I/O', async () => {
  const source = createLiveReceiptSource({ scannerSocket: '/nonexistent/ssf.sock', chain: 'regtest' as never, scannerAccountId: 'acct' });
  const error = await source.allocateReceiver({ allocationId: 'a', chain: 'regtest', accountId: 'acct', amountZat: '1', expiresAt: 1_790_000_000_000_000 } as never)
    .catch((caught: unknown) => caught);
  expect(error).toBeInstanceOf(TypeError);
});

import { expect, test } from 'vitest';
import {
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
      SSF_SELLER_KEY_ID: 'seller-key-1',
      SSF_DESTINATION: DESTINATION,
      SSF_ADAPTER_MESSAGING: 'real',
      SSF_ADAPTER_STORAGE: 'real',
      SSF_ADAPTER_SCANNER: 'real',
      SSF_ADMIN_TOKEN: 'admin-secret-not-for-browser',
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

test('a skipped replica check does not count as passing', () => {
  const result = evaluatePreflight(baseInput({
    logos: { ok: false, reason: 'live two-node Logos is not running in this worktree' },
  }));
  expect(result.checks.find((item) => item.id === 'replica')?.status).not.toBe('PASS');
  expect(isOverallPass(result.checks)).toBe(false);
  expect(result.ok).toBe(false);
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
  expect(result.ok).toBe(true);
  expect(result.networkLabel).toBe('zakura/regtest');
  expect(result.nodeChain).toBe('test');
  expect(result.publicTestnet).toBe(false);
  expect(result.walletReadWired).toBe(false);
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

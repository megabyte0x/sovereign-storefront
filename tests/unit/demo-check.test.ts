import { expect, test } from 'vitest';
import {
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
  expect(absent.status).not.toBe('PASS');

  const twoNodesUnrun = classifyReplicaRetrieve({
    twoNodesDetected: true,
    originStopped: false,
    retrieved: false,
  });
  expect(twoNodesUnrun.status).not.toBe('PASS');
  expect(twoNodesUnrun.detail.toLowerCase()).not.toMatch(/\bpass\b/);
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

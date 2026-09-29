import { describe, expect, it } from 'vitest';
import {
  L_MATRIX_IDS,
  WORKFLOW_STAGE_IDS,
  validateLiveReport,
  type LiveReport,
} from '../../scripts/live-report.ts';

// SYNTHETIC UNIT FIXTURE ONLY. This is never run evidence and must never be
// written to docs/, .runtime/ or any report target.
function syntheticPassingReport(): LiveReport {
  return {
    schemaVersion: 1,
    liveAttempted: true,
    network: 'regtest',
    build: {
      commit: 'a'.repeat(40),
      dirty: true,
      diffSha256: 'b'.repeat(64),
      cleanBuild: true,
      builtAt: '2026-09-26T00:00:00.000Z',
    },
    scanner: { kind: 'zcash-scanner-socket', version: '0.1.0' },
    storage: { kind: 'logos-storage', version: '0.2.0' },
    messaging: { kind: 'waku-lightpush-filter', version: '0.0.30' },
    stages: [
      ...[...L_MATRIX_IDS, ...WORKFLOW_STAGE_IDS].map((id) => ({
        id,
        status: 'PASS' as const,
        evidence: [`synthetic ${id}`],
      })),
      { id: 'T01', status: 'NOT_RUN' as const, reason: 'no public testnet wallet/lightwalletd available' },
    ],
  };
}

const passingReport = syntheticPassingReport();

function withStage(id: string, patch: Record<string, unknown>): unknown {
  return {
    ...passingReport,
    stages: passingReport.stages.map((stage) => (stage.id === id ? { ...stage, ...patch } : stage)),
  };
}

describe('validateLiveReport', () => {
  it('accepts the synthetic fully-passing report', () => {
    expect(validateLiveReport(passingReport)).toEqual({ ok: true, errors: [] });
  });

  it('names every L01-L16 row and the Task 12 workflow stages', () => {
    expect(L_MATRIX_IDS).toHaveLength(16);
    expect(L_MATRIX_IDS[0]).toBe('L01');
    expect(L_MATRIX_IDS[15]).toBe('L16');
    expect(WORKFLOW_STAGE_IDS).toEqual([
      'publish', 'replica-b', 'two-invoices', 'fund-a', 'below-threshold', 'threshold', 'interrupt', 'restart',
      'waku-recover', 'origin-stop', 'gateway-restart', 'fresh-context-import', 'decrypt-equal', 'ack',
      'b-stays-locked', 'normal-delivery', 'response-loss-reconnect',
    ]);
  });

  it('rejects the plan RED cases', () => {
    expect(validateLiveReport({ ...passingReport, liveAttempted: false }).ok).toBe(false);
    expect(validateLiveReport({ ...passingReport, scanner: { kind: 'fixture' } }).ok).toBe(false);
    expect(validateLiveReport({
      ...passingReport,
      stages: passingReport.stages.filter((stage) => stage.id !== 'origin-stop'),
    }).ok).toBe(false);
  });

  it('rejects non-objects', () => {
    for (const value of [null, undefined, 1, 'PASS', [], true]) {
      expect(validateLiveReport(value).ok).toBe(false);
    }
  });

  it('rejects a missing matrix row', () => {
    const result = validateLiveReport({
      ...passingReport,
      stages: passingReport.stages.filter((stage) => stage.id !== 'L12'),
    });
    expect(result.ok).toBe(false);
    expect(result.errors.join('\n')).toMatch(/L12/);
  });

  it.each(['SKIP', 'skip', 'unavailable', 'UNSUPPORTED', 'fixture', 'NOT_RUN', 'FAIL', undefined])(
    'rejects stage status %s on L rows and workflow stages',
    (status) => {
      expect(validateLiveReport(withStage('L05', { status })).ok).toBe(false);
      expect(validateLiveReport(withStage('threshold', { status })).ok).toBe(false);
    },
  );

  it('rejects a PASS stage without evidence (flags alone are not evidence)', () => {
    expect(validateLiveReport(withStage('ack', { evidence: [] })).ok).toBe(false);
    expect(validateLiveReport(withStage('ack', { evidence: undefined })).ok).toBe(false);
    expect(validateLiveReport(withStage('ack', { evidence: [''] })).ok).toBe(false);
  });

  it('rejects duplicate and unknown stage ids', () => {
    expect(validateLiveReport({ ...passingReport, stages: [...passingReport.stages, passingReport.stages[0]] }).ok).toBe(false);
    expect(validateLiveReport({
      ...passingReport,
      stages: [...passingReport.stages, { id: 'L17', status: 'PASS', evidence: ['x'] }],
    }).ok).toBe(false);
  });

  it.each(['scanner', 'storage', 'messaging'] as const)('requires a concrete %s adapter kind and version', (key) => {
    for (const adapter of [
      undefined,
      {},
      { kind: 'memory', version: '1' },
      { kind: 'fixture', version: '1' },
      { kind: 'fake-scanner', version: '1' },
      { kind: 'unavailable', version: '1' },
      { kind: 'zcash-scanner-socket' },
      { kind: 'zcash-scanner-socket', version: '' },
      { kind: 'zcash-scanner-socket', version: 'unknown' },
      { kind: '', version: '1' },
    ]) {
      expect(validateLiveReport({ ...passingReport, [key]: adapter }).ok, JSON.stringify(adapter)).toBe(false);
    }
  });

  it('requires build provenance', () => {
    const { build: _build, ...noBuild } = passingReport;
    expect(validateLiveReport(noBuild).ok).toBe(false);
    expect(validateLiveReport({ ...passingReport, build: { ...passingReport.build, commit: 'nothex' } }).ok).toBe(false);
    expect(validateLiveReport({ ...passingReport, build: { ...passingReport.build, cleanBuild: false } }).ok).toBe(false);
    expect(validateLiveReport({ ...passingReport, build: { ...passingReport.build, builtAt: 'yesterday' } }).ok).toBe(false);
    expect(validateLiveReport({ ...passingReport, build: { ...passingReport.build, diffSha256: undefined } }).ok).toBe(false);
    expect(validateLiveReport({
      ...passingReport,
      build: { commit: 'c'.repeat(40), dirty: false, cleanBuild: true, builtAt: '2026-09-26T00:00:00.000Z' },
    }).ok).toBe(true);
  });

  it('requires the local regtest network and schema version for L evidence', () => {
    expect(validateLiveReport({ ...passingReport, network: 'test' }).ok).toBe(false);
    expect(validateLiveReport({ ...passingReport, schemaVersion: 2 }).ok).toBe(false);
  });

  it('rejects a report explicitly marked synthetic', () => {
    expect(validateLiveReport({ ...passingReport, synthetic: true }).ok).toBe(false);
  });

  describe('T01', () => {
    const testnet = {
      network: 'test',
      wallet: 'ExternalWallet',
      walletVersion: '1.2.3',
      lightwalletd: 'lwd.example:9067',
      txid: 'd'.repeat(64),
      confirmations: 10,
    };

    it('requires a T01 row', () => {
      expect(validateLiveReport({
        ...passingReport,
        stages: passingReport.stages.filter((stage) => stage.id !== 'T01'),
      }).ok).toBe(false);
    });

    it('rejects T01 PASS without a testnet evidence block', () => {
      expect(validateLiveReport(withStage('T01', { status: 'PASS', evidence: ['paid'], reason: undefined })).ok).toBe(false);
    });

    it('rejects T01 PASS with an incomplete or non-testnet block', () => {
      for (const block of [
        { ...testnet, network: 'regtest' },
        { ...testnet, txid: 'short' },
        { ...testnet, confirmations: 9 },
        { ...testnet, walletVersion: '' },
        { ...testnet, lightwalletd: undefined },
      ]) {
        expect(validateLiveReport(withStage('T01', { status: 'PASS', evidence: ['paid'], testnet: block })).ok).toBe(false);
      }
    });

    it('accepts T01 PASS with a complete testnet block', () => {
      expect(validateLiveReport(withStage('T01', { status: 'PASS', evidence: ['paid'], reason: undefined, testnet })).ok).toBe(true);
    });

    it('requires a reason for T01 NOT_RUN and rejects other T01 statuses', () => {
      expect(validateLiveReport(withStage('T01', { reason: '' })).ok).toBe(false);
      expect(validateLiveReport(withStage('T01', { reason: undefined })).ok).toBe(false);
      expect(validateLiveReport(withStage('T01', { status: 'SKIP' })).ok).toBe(false);
    });
  });
});

describe('public profile', () => {
  const adapters = {
    scanner: { kind: 'zcash-scanner-socket', version: '0.1.0' },
    storage: { kind: 'logos-storage', version: '0.2.0' },
    messaging: { kind: 'waku-lightpush-filter', version: '0.0.30' },
  };
  const stages = [
    'embed-invoice',
    'receipt-observed',
    'three-confirmations',
    'bytes-match',
    'recover-without-repay',
    'restart-between',
    'origin-stop',
    'funds-received',
  ].map((id) => ({ id, status: 'PASS' as const, evidence: [`synthetic ${id}`] }));
  const report = {
    schemaVersion: 1,
    liveAttempted: true,
    profile: 'public' as const,
    network: 'test' as const,
    build: passingReport.build,
    ...adapters,
    stages: [
      ...stages,
      {
        id: 'T01',
        status: 'PASS' as const,
        evidence: ['three confirmations'],
        testnet: {
          network: 'test',
          wallet: 'ExternalWallet',
          walletVersion: '1.2.3',
          lightwalletd: 'lwd.example:9067',
          txid: 'd'.repeat(64),
          confirmations: 3,
        },
      },
    ],
  };

  it('accepts three confirmations and rejects two', () => {
    expect(validateLiveReport(report)).toEqual({ ok: true, errors: [] });
    const short = {
      ...report,
      stages: report.stages.map((stage) => stage.id === 'T01' && 'testnet' in stage
        ? { ...stage, testnet: { ...stage.testnet, confirmations: 2 } }
        : stage),
    };
    expect(validateLiveReport(short).ok).toBe(false);
  });

  it('does not accept a public report that is missing a stage', () => {
    expect(validateLiveReport({ ...report, stages: report.stages.filter((stage) => stage.id !== 'funds-received') }).ok).toBe(false);
  });
});

import { describe, expect, it } from 'vitest';
import { checkSocketPath, classify, parseEnvFile, replicationVerdict, scannerSnapshotFresh, summarize } from '../../scripts/live-infra/doctor.ts';

describe('live-infra doctor', () => {
  it('overlong scanner socket path is a config FAIL, not an unreachable SKIP', () => {
    expect(checkSocketPath(`/${'a'.repeat(100)}`)).toEqual({ status: 'FAIL', reason: 'socket path too long' });
    expect(checkSocketPath(`/${'a'.repeat(79)}`)).toBeUndefined();
  });
  it('treats scanner checkedAt as unix seconds when judging freshness', () => {
    const nowMs = 1_790_270_422_406;
    expect(scannerSnapshotFresh(1_790_270_421, nowMs)).toBe(true);
    expect(scannerSnapshotFresh(1_790_270_421 - 121, nowMs)).toBe(false);
    expect(scannerSnapshotFresh(1_790_270_421 + 60, nowMs)).toBe(false);
    expect(scannerSnapshotFresh('1790270421', nowMs)).toBe(false);
  });
  it('parses KEY=value lines and ignores comments/blank lines', () => {
    expect(parseEnvFile('# c\nA=1\n\nB=/x=y\n')).toEqual({ A: '1', B: '/x=y' });
  });
  it('rejects malformed lines instead of guessing', () => {
    expect(() => parseEnvFile('NOVALUE\n')).toThrow('malformed env line 1');
  });
  it('unreachable dependency is SKIP when lenient and FAIL when strict, never PASS', () => {
    expect(classify(undefined, 'socket missing', false)).toEqual({ status: 'SKIP', reason: 'socket missing' });
    expect(classify(undefined, 'socket missing', true)).toEqual({ status: 'FAIL', reason: 'socket missing' });
    expect(classify(false, 'health=unavailable', false).status).toBe('FAIL');
    expect(classify(true, 'ok', true).status).toBe('PASS');
  });
  it('strict summary fails on any SKIP; lenient summary fails only on FAIL', () => {
    const rows = [
      { id: 'zcash', status: 'PASS', reason: 'ok' },
      { id: 'waku', status: 'SKIP', reason: 'no peers' },
    ] as const;
    expect(summarize([...rows], true)).toEqual({ ok: false, exitCode: 1 });
    expect(summarize([...rows], false)).toEqual({ ok: true, exitCode: 0 });
  });

  describe('replicationVerdict', () => {
    const current = {
      a: { peerIdPrefix: '16Uiu2HAmAAAA', startedAt: '2026-09-24T10:00:00Z#pid100' },
      b: { peerIdPrefix: '16Uiu2HAmBBBB', startedAt: '2026-09-24T10:00:05Z#pid200' },
    };
    const proof = {
      provedAt: '2026-09-24T10:01:00.000Z',
      nodeAPeerIdPrefix: '16Uiu2HAmAAAA',
      nodeBPeerIdPrefix: '16Uiu2HAmBBBB',
      cidPrefix: 'zDvZRwzmABCD',
      bytes: 41,
      digestMatch: true,
      daemonStartedAt: { a: '2026-09-24T10:00:00Z#pid100', b: '2026-09-24T10:00:05Z#pid200' },
    };
    it('missing or malformed proof is SKIP when lenient and FAIL when strict', () => {
      expect(replicationVerdict(undefined, current, false)).toEqual({ status: 'SKIP', reason: 'not yet proven this run' });
      expect(replicationVerdict(undefined, current, true)).toEqual({ status: 'FAIL', reason: 'not yet proven this run' });
      expect(replicationVerdict({ digestMatch: true }, current, false)).toEqual({ status: 'SKIP', reason: 'not yet proven this run' });
    });
    it('digestMatch false is FAIL in both modes', () => {
      const bad = { ...proof, digestMatch: false };
      expect(replicationVerdict(bad, current, false)).toEqual({ status: 'FAIL', reason: 'digest mismatch' });
      expect(replicationVerdict(bad, current, true)).toEqual({ status: 'FAIL', reason: 'digest mismatch' });
    });
    it('a proof from a restarted daemon is stale: SKIP lenient, FAIL strict', () => {
      const restarted = { ...current, a: { ...current.a, startedAt: '2026-09-24T11:00:00Z#pid300' } };
      const reason = 'replication proof predates current daemons';
      expect(replicationVerdict(proof, restarted, false)).toEqual({ status: 'SKIP', reason });
      expect(replicationVerdict(proof, restarted, true)).toEqual({ status: 'FAIL', reason });
      const newPeer = { ...current, b: { ...current.b, peerIdPrefix: '16Uiu2HAmCCCC' } };
      expect(replicationVerdict(proof, newPeer, true)).toEqual({ status: 'FAIL', reason });
      expect(replicationVerdict(proof, undefined, false).status).toBe('SKIP');
    });
    it('a matching proof is PASS with only cidPrefix and bytes as evidence', () => {
      expect(replicationVerdict(proof, current, true)).toEqual({
        status: 'PASS',
        reason: 'ok',
        evidence: { cidPrefix: 'zDvZRwzmABCD', bytes: 41 },
      });
    });
  });
});

import { describe, expect, it } from 'vitest';
import { storageInit, ARCHIVE_SHA256, replicationProof, daemonIdentity, parseDaemonStatus, cidFromManifests } from '../../scripts/live-infra/logos-up.ts';

describe('logos-up', () => {
  it('cidFromManifests finds the uploaded file by filename in a `manifests` response', () => {
    const resp = { result: { success: true, value: [
      { cid: 'zOther', filename: 'other.bin', datasetSize: 3 },
      { cid: 'zSmoke', filename: 'smoke-1.bin', datasetSize: 41 },
    ] } };
    expect(cidFromManifests(resp, 'smoke-1.bin')).toBe('zSmoke');
    expect(cidFromManifests(resp, 'missing.bin')).toBeUndefined();
    expect(cidFromManifests({ result: { success: false, value: null } }, 'smoke-1.bin')).toBeUndefined();
    expect(cidFromManifests(undefined, 'smoke-1.bin')).toBeUndefined();
  });
  it('parseDaemonStatus reads the status even from a non-zero `daemon status` exit', () => {
    // logosctl 0.2.3 exits 1 with this stdout before the first `daemon start`.
    expect(parseDaemonStatus('{"daemon":{"status":"not_configured"}}\n')).toBe('not_configured');
    expect(parseDaemonStatus('{"daemon":{"status":"running"}}')).toBe('running');
    expect(parseDaemonStatus('')).toBeUndefined();
    expect(parseDaemonStatus('garbage')).toBeUndefined();
    expect(parseDaemonStatus('{"daemon":{}}')).toBeUndefined();
  });
  it('writes absolute, node-separated storage configs on fixed ports', () => {
    const a = storageInit('/abs/logos/node-a', 18091, 18090);
    const b = storageInit('/abs/logos/node-b', 18191, 18190);
    expect(a).toEqual({ 'data-dir': '/abs/logos/node-a/storage-data', 'log-file': '/abs/logos/node-a/storage-data/storage.log',
      'log-level': 'INFO', 'listen-port': 18091, 'disc-port': 18090, network: 'logos.test' });
    expect(a['data-dir']).not.toBe(b['data-dir']);
    expect(() => storageInit('relative/dir', 1, 2)).toThrow('absolute');
  });
  it('pins the verified archive digest', () => {
    expect(ARCHIVE_SHA256).toBe('f1ed1debcac20a9943ae2786021f574e439af42f853db0e753a365acb45eb3c3');
  });
  it('replicationProof records only prefixes and rejects a full CID', () => {
    const base = {
      provedAt: '2026-09-24T10:01:00.000Z',
      peerIdA: '16Uiu2HAmAAAAxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
      peerIdB: '16Uiu2HAmBBBBxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
      bytes: 41,
      digestMatch: true,
      daemonStartedAt: { a: 't1#pid1', b: 't2#pid2' },
    };
    expect(replicationProof({ ...base, cidPrefix: 'zDvZRwzmABCD' })).toEqual({
      provedAt: '2026-09-24T10:01:00.000Z',
      nodeAPeerIdPrefix: '16Uiu2HAmAAA',
      nodeBPeerIdPrefix: '16Uiu2HAmBBB',
      cidPrefix: 'zDvZRwzmABCD',
      bytes: 41,
      digestMatch: true,
      daemonStartedAt: { a: 't1#pid1', b: 't2#pid2' },
    });
    expect(() => replicationProof({ ...base, cidPrefix: 'zDvZRwzmABCDEFGHIJKLMNOPQRSTUVWXYZ' })).toThrow('cid prefix');
  });
  it('daemonIdentity combines logosctl state started_at and pid, undefined when not alive', () => {
    const state = JSON.stringify({ pid: 1234, started_at: '2026-09-24T10:00:00Z' });
    expect(daemonIdentity(state, () => true)).toBe('2026-09-24T10:00:00Z#pid1234');
    expect(daemonIdentity(state, () => false)).toBeUndefined();
    expect(daemonIdentity('{}', () => true)).toBeUndefined();
    expect(daemonIdentity('not json', () => true)).toBeUndefined();
  });
});

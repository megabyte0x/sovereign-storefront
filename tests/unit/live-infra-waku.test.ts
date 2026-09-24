import { describe, expect, it } from 'vitest';
import { browserDialable, dialableFromPeers, pollDialable } from '../../scripts/live-infra/waku-peers.ts';

// Real codecs from node_modules/@waku/core/dist/lib/{light_push/constants,filter/filter}.js
const LIGHTPUSH_V3 = '/vac/waku/lightpush/3.0.0';
const LIGHTPUSH_V2 = '/vac/waku/lightpush/2.0.0-beta1';
const FILTER_SUBSCRIBE = '/vac/waku/filter-subscribe/2.0.0-beta1';
const FILTER_PUSH = '/vac/waku/filter-push/2.0.0-beta1';

describe('waku-peers', () => {
  it('keeps only secure-websocket multiaddrs that carry a peer id, deduplicated', () => {
    const p = '/p2p/16Uiu2HAmTest';
    expect(browserDialable([
      `/dns4/node-01.example.org/tcp/8000/wss${p}`,
      `/dns4/node-01.example.org/tcp/8000/wss${p}`,
      `/ip4/1.2.3.4/tcp/30303${p}`,
      '/dns4/node-02.example.org/tcp/443/wss',
      `/ip4/127.0.0.1/tcp/8000/ws${p}`,
    ])).toEqual([`/dns4/node-01.example.org/tcp/8000/wss${p}`]);
  });

  describe('dialableFromPeers', () => {
    it('excludes a peer that supports only lightpush', () => {
      expect(dialableFromPeers([
        { id: '16Uiu2HAmPushOnly', protocols: [LIGHTPUSH_V3], addrs: ['/dns4/a.example.org/tcp/8000/wss'] },
      ])).toEqual([]);
    });

    it('excludes a peer that supports only filter', () => {
      expect(dialableFromPeers([
        { id: '16Uiu2HAmFilterOnly', protocols: [FILTER_SUBSCRIBE], addrs: ['/dns4/a.example.org/tcp/8000/wss'] },
      ])).toEqual([]);
    });

    it('keeps a both-protocol peer and appends /p2p/<id> to a wss addr lacking it', () => {
      expect(dialableFromPeers([
        { id: '16Uiu2HAmBoth', protocols: [LIGHTPUSH_V2, FILTER_SUBSCRIBE, FILTER_PUSH], addrs: ['/dns4/b.example.org/tcp/8000/wss'] },
      ])).toEqual(['/dns4/b.example.org/tcp/8000/wss/p2p/16Uiu2HAmBoth']);
    });

    it('does not double-append /p2p/ when the addr already carries it', () => {
      expect(dialableFromPeers([
        { id: '16Uiu2HAmBoth', protocols: [LIGHTPUSH_V3, FILTER_SUBSCRIBE], addrs: ['/dns4/b.example.org/tcp/443/wss/p2p/16Uiu2HAmBoth'] },
      ])).toEqual(['/dns4/b.example.org/tcp/443/wss/p2p/16Uiu2HAmBoth']);
    });

    it('dedupes duplicate peers', () => {
      const peer = { id: '16Uiu2HAmDup', protocols: [LIGHTPUSH_V3, FILTER_SUBSCRIBE], addrs: ['/dns4/c.example.org/tcp/8000/wss'] };
      expect(dialableFromPeers([peer, { ...peer }])).toEqual(['/dns4/c.example.org/tcp/8000/wss/p2p/16Uiu2HAmDup']);
    });

    it('excludes a ws-only peer', () => {
      expect(dialableFromPeers([
        { id: '16Uiu2HAmWs', protocols: [LIGHTPUSH_V3, FILTER_SUBSCRIBE], addrs: ['/dns4/d.example.org/tcp/8000/ws', '/ip4/1.2.3.4/tcp/8000/ws'] },
      ])).toEqual([]);
    });
  });

  describe('pollDialable', () => {
    function clock() {
      let t = 0;
      return { now: () => t, sleep: async (ms: number) => { t += ms; } };
    }

    it('keeps sampling until the minimum is reached', async () => {
      const samples = [['a'], ['a'], ['a', 'b']];
      let i = 0;
      const c = clock();
      const r = await pollDialable(async () => samples[Math.min(i++, samples.length - 1)], { min: 2, intervalMs: 2000, deadlineMs: 60000, ...c });
      expect(r).toEqual({ peers: ['a', 'b'], attempts: 3 });
    });

    it('returns the last short sample at the deadline', async () => {
      const c = clock();
      const r = await pollDialable(async () => ['a'], { min: 2, intervalMs: 2000, deadlineMs: 6000, ...c });
      expect(r.peers).toEqual(['a']);
      expect(r.attempts).toBe(4);
    });

    it('samples once when already satisfied', async () => {
      const c = clock();
      const r = await pollDialable(async () => ['a', 'b'], { min: 2, intervalMs: 2000, deadlineMs: 60000, ...c });
      expect(r.attempts).toBe(1);
    });
  });
});

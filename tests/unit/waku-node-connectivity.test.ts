import { generatePrivateKey } from '@waku/message-encryption';
import { expect, test } from 'vitest';
import { createWakuSession, withLibp2pConnectivity, type WakuNode } from '../../src/adapters/waku.ts';

// Task 10.7 live finding: under Node 22 `globalThis.navigator` exists without
// `onLine`, so @waku/core's NetworkMonitor reports isConnected() === false and
// dispatches every `waku:connection` event with detail=false even while
// libp2p holds live peer connections. Seller readiness stayed messaging=false.
function quirkyNode(connections: unknown[]) {
  const listeners = new Set<(event: { detail: unknown }) => void>();
  const node = {
    async waitForPeers() { return; },
    lightPush: { async send() { return { successes: ['peer'], failures: [] }; } },
    filter: { async subscribe() { return true; }, async unsubscribe() { return true; } },
    events: {
      addEventListener(type: string, listener: (event: { detail: unknown }) => void) {
        if (type === 'waku:connection') listeners.add(listener);
      },
      removeEventListener(type: string, listener: (event: { detail: unknown }) => void) {
        if (type === 'waku:connection') listeners.delete(listener);
      },
    },
    async stop() { return; },
    isConnected: () => false, // navigator.onLine === undefined
    libp2p: { getConnections: () => connections },
  };
  return {
    node,
    emit: () => { for (const listener of listeners) listener({ detail: false }); },
    listenerCount: () => listeners.size,
  };
}

const config = { contentTopic: '/ssf/1/test/proto', bootstrapPeers: [], peerTimeoutMs: 1000 };

test('connectivity follows libp2p connections, not the navigator-derived flag', async () => {
  const connections: unknown[] = ['peer-a'];
  const fake = quirkyNode(connections);
  const node = withLibp2pConnectivity(fake.node as unknown as WakuNode);
  expect(node.isConnected?.()).toBe(true);
  const seen: unknown[] = [];
  const listener = (event: { detail: unknown }) => seen.push(event.detail);
  node.events.addEventListener('waku:connection', listener);
  fake.emit();
  connections.length = 0;
  fake.emit();
  expect(seen).toEqual([true, false]);
  expect(node.isConnected?.()).toBe(false);
  node.events.removeEventListener('waku:connection', listener);
  expect(fake.listenerCount()).toBe(0);
});

test('a session over the quirky node is ready while libp2p is connected', async () => {
  const fake = quirkyNode(['peer-a']);
  const session = createWakuSession(config, generatePrivateKey(), {
    createNode: async () => withLibp2pConnectivity(fake.node as unknown as WakuNode),
  });
  expect(await session.ready()).toBe(true);
  fake.emit(); // the SDK's spurious detail=false event
  expect(await session.ready()).toBe(true);
  await session.close();
});

test('a node without libp2p is returned unchanged', () => {
  const fake = quirkyNode([]);
  const { libp2p: _drop, ...bare } = fake.node;
  expect(withLibp2pConnectivity(bare as unknown as WakuNode)).toBe(bare);
});

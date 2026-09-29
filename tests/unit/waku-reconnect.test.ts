import { generatePrivateKey } from '@waku/message-encryption';
import { expect, test } from 'vitest';
import { createWakuSession, withLibp2pConnectivity, type WakuNode } from '../../src/adapters/waku.ts';

// Public-testnet finding: the seller's libp2p lost every Waku peer at
// 2026-09-29T03:17Z and never redialled. `ensureStarted()` kept returning the
// cached, peerless node, so readiness stayed false and every delivery push
// failed with "delivered to zero peers" until a process restart.
function peerNode(connections: unknown[]) {
  let pushes = 0;
  let stopped = false;
  const node = {
    async waitForPeers() { return; },
    lightPush: {
      async send() {
        pushes += 1;
        return connections.length > 0 ? { successes: ['peer'], failures: [] } : { successes: [], failures: ['no peer'] };
      },
    },
    filter: { async subscribe() { return true; }, async unsubscribe() { return true; } },
    events: { addEventListener() { return; }, removeEventListener() { return; } },
    async stop() { stopped = true; },
    libp2p: { getConnections: () => connections },
  };
  return { node, pushes: () => pushes, stopped: () => stopped };
}

const config = { contentTopic: '/ssf/1/test/proto', bootstrapPeers: [], peerTimeoutMs: 1000 };
const body = {
  version: 1, messageId: 'm', inReplyTo: 'm', sellerKeyId: 'aa', buyerKeyId: 'bb', network: 'test',
  issuedAt: 1, expiresAt: 2, type: 'delivery', packageId: 'p',
  package: { orderId: 'o', productVersion: 'v', buyerKeyId: 'bb', encryptedEnvelope: new Uint8Array([1]) },
} as never;

function sessionOver(nodes: ReturnType<typeof peerNode>[]) {
  let created = 0;
  const session = createWakuSession(config, generatePrivateKey(), {
    retryIntervalMs: 0,
    createNode: async () => {
      const next = nodes[created];
      if (!next) throw new Error('no more fake nodes');
      created += 1;
      return withLibp2pConnectivity(next.node as unknown as WakuNode);
    },
  });
  return { session, created: () => created };
}

test('ready() replaces a node that has lost every peer', async () => {
  const firstConnections: unknown[] = ['peer-a'];
  const first = peerNode(firstConnections);
  const second = peerNode(['peer-b']);
  const { session, created } = sessionOver([first, second]);
  expect(await session.ready()).toBe(true);
  firstConnections.length = 0; // libp2p dropped every peer and never redials
  expect(await session.ready()).toBe(true);
  expect(created()).toBe(2);
  expect(first.stopped()).toBe(true);
  await session.close();
});

test('send() over a peerless node recreates it and delivers once', async () => {
  const firstConnections: unknown[] = ['peer-a'];
  const first = peerNode(firstConnections);
  const second = peerNode(['peer-b']);
  const { session, created } = sessionOver([first, second]);
  expect(await session.ready()).toBe(true);
  firstConnections.length = 0;
  await expect(session.send('02' + '11'.repeat(32), body)).resolves.toBeUndefined();
  expect(created()).toBe(2);
  expect(first.pushes()).toBe(0);
  expect(second.pushes()).toBe(1);
  await session.close();
});

test('concurrent callers share one replacement node', async () => {
  const firstConnections: unknown[] = ['peer-a'];
  const first = peerNode(firstConnections);
  const second = peerNode(['peer-b']);
  const third = peerNode(['peer-c']);
  const { session, created } = sessionOver([first, second, third]);
  expect(await session.ready()).toBe(true);
  firstConnections.length = 0;
  const results = await Promise.all([session.ready(), session.ready(), session.ready()]);
  expect(results).toEqual([true, true, true]);
  expect(created()).toBe(2);
  expect(third.stopped()).toBe(false);
  await session.close();
});

test('a connected node is reused, not recreated', async () => {
  const only = peerNode(['peer-a']);
  const { session, created } = sessionOver([only]);
  expect(await session.ready()).toBe(true);
  expect(await session.ready()).toBe(true);
  await session.send('02' + '11'.repeat(32), body);
  expect(created()).toBe(1);
  await session.close();
});

test('a failed replacement leaves the session retryable on the next call', async () => {
  const firstConnections: unknown[] = ['peer-a'];
  const first = peerNode(firstConnections);
  const second = peerNode(['peer-b']);
  let calls = 0;
  const session = createWakuSession(config, generatePrivateKey(), {
    retryIntervalMs: 0,
    createNode: async () => {
      calls += 1;
      if (calls === 1) return withLibp2pConnectivity(first.node as unknown as WakuNode);
      if (calls === 2) throw new Error('waku node startup timed out');
      return withLibp2pConnectivity(second.node as unknown as WakuNode);
    },
  });
  expect(await session.ready()).toBe(true);
  firstConnections.length = 0;
  await expect(session.ready()).rejects.toThrow('waku node startup timed out');
  expect(await session.ready()).toBe(true);
  expect(calls).toBe(3);
  await session.close();
});

import { describe, expect, test } from 'vitest';
import { generatePrivateKey } from '@waku/message-encryption';
import { createWakuSession, type WakuNode } from '../../src/adapters/waku.ts';
import { encodeMessage } from '../../src/contracts/messages.ts';

// The live @waku/sdk filter passes fromProtoObj's result to the subscriber
// even when it is `undefined` (a message on our topic that we cannot decrypt).
// The seller must drop it, not crash on an unhandled rejection.
function nodeCapturingCallback(): { node: WakuNode; deliver: (msg: unknown) => unknown } {
  let callback: ((msg: unknown) => unknown) | null = null;
  const node = {
    async waitForPeers() {},
    lightPush: { async send() { return { successes: ['p'], failures: [] }; } },
    filter: {
      async subscribe(_decoder: unknown, cb: (msg: unknown) => unknown) { callback = cb; return true; },
      async unsubscribe() { return true; },
    },
    events: { addEventListener() {}, removeEventListener() {} },
    async stop() {},
  } as unknown as WakuNode;
  return { node, deliver: (msg) => callback!(msg) };
}

describe('waku session: undecodable filter deliveries', () => {
  test.each([
    ['undefined', undefined],
    ['null', null],
    ['message without signature fields', { payload: new Uint8Array([1]) }],
    ['message whose verifier throws', {
      payload: new Uint8Array([1]),
      signature: new Uint8Array([1]),
      signaturePublicKey: new Uint8Array([2]),
      verifySignature() { throw new Error('boom'); },
    }],
  ])('drops %s without rejecting or invoking the handler', async (_label, message) => {
    const { node, deliver } = nodeCapturingCallback();
    const session = await createWakuSession(
      { contentTopic: '/ssf/1/undecodable/proto', bootstrapPeers: [], peerTimeoutMs: 1000 },
      generatePrivateKey(),
      { createNode: async () => node },
    );
    let calls = 0;
    await session.subscribe(async () => { calls += 1; });
    await expect(Promise.resolve(deliver(message))).resolves.toBeUndefined();
    expect(calls).toBe(0);
    await session.close();
  });

  test('a throwing handler does not surface as a rejection from the filter callback', async () => {
    const { node, deliver } = nodeCapturingCallback();
    const session = await createWakuSession(
      { contentTopic: '/ssf/1/undecodable/proto', bootstrapPeers: [], peerTimeoutMs: 1000 },
      generatePrivateKey(),
      { createNode: async () => node },
    );
    await session.subscribe(async () => { throw new Error('handler failed'); });
    const forged = {
      payload: new Uint8Array([1]),
      signature: new Uint8Array([1]),
      signaturePublicKey: new Uint8Array([2]),
      verifySignature: () => true,
    };
    await expect(Promise.resolve(deliver(forged))).resolves.toBeUndefined();
    await session.close();
  });

  test('a throwing handler is reported through onHandlerError with no payload or message', async () => {
    const { node, deliver } = nodeCapturingCallback();
    const reports: unknown[][] = [];
    const session = await createWakuSession(
      { contentTopic: '/ssf/1/undecodable/proto', bootstrapPeers: [], peerTimeoutMs: 1000 },
      generatePrivateKey(),
      { createNode: async () => node, onHandlerError: (...args: unknown[]) => { reports.push(args); } },
    );
    let calls = 0;
    await session.subscribe(async () => { calls += 1; throw new Error('handler failed with secret detail'); });
    const valid = encodeMessage({
      version: 1, messageId: 'message-1', sellerKeyId: 'seller-key-1', network: 'regtest',
      issuedAt: 1_000, expiresAt: 2_000, type: 'status', orderId: 'order-1',
    });
    const signed = {
      payload: valid,
      proto: { payload: new Uint8Array([9]), contentTopic: '/ssf/1/undecodable/proto' },
      signature: new Uint8Array([1]),
      signaturePublicKey: new Uint8Array([2]),
      verifySignature: () => true,
    };
    await expect(Promise.resolve(deliver(signed))).resolves.toBeUndefined();
    expect(calls).toBe(1);
    expect(reports).toEqual([[]]);

    // Undecodable deliveries are dropped silently: they are not handler errors.
    await expect(Promise.resolve(deliver(undefined))).resolves.toBeUndefined();
    expect(reports).toEqual([[]]);
    await session.close();
  });

  test('a throwing onHandlerError never becomes a rejection either', async () => {
    const { node, deliver } = nodeCapturingCallback();
    const session = await createWakuSession(
      { contentTopic: '/ssf/1/undecodable/proto', bootstrapPeers: [], peerTimeoutMs: 1000 },
      generatePrivateKey(),
      { createNode: async () => node, onHandlerError: () => { throw new Error('reporter failed'); } },
    );
    await session.subscribe(async () => { throw new Error('handler failed'); });
    const signed = {
      payload: encodeMessage({
        version: 1, messageId: 'message-2', sellerKeyId: 'seller-key-1', network: 'regtest',
        issuedAt: 1_000, expiresAt: 2_000, type: 'status', orderId: 'order-2',
      }),
      signature: new Uint8Array([1]),
      signaturePublicKey: new Uint8Array([3]),
      verifySignature: () => true,
    };
    await expect(Promise.resolve(deliver(signed))).resolves.toBeUndefined();
    await session.close();
  });
});

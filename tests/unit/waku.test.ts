import { describe, expect, test, vi } from 'vitest';
import { generatePrivateKey, getPublicKey } from '@waku/message-encryption';
import { bytesToHex } from '@waku/utils/bytes';
import type { BuyerRequest, WakuConfig } from '../../src/contracts/messages.ts';
import { createDecoder, createEncoder } from '@waku/message-encryption/ecies';
import { createWakuSession, type WakuNode } from '../../src/adapters/waku.ts';

type EciesEncoder = ReturnType<typeof createEncoder>;
type EciesDecoder = ReturnType<typeof createDecoder>;

const CONTENT_TOPIC = '/ssf/1/test-run/proto';

function freshConfig(): WakuConfig {
  return { contentTopic: CONTENT_TOPIC, bootstrapPeers: [], peerTimeoutMs: 1000 };
}

function makeRequest(overrides: Partial<Extract<BuyerRequest, { type: 'status' }>> = {}): BuyerRequest {
  const now = Date.now();
  return {
    version: 1,
    messageId: 'msg-1',
    sellerKeyId: 'seller-key',
    network: 'regtest',
    issuedAt: now,
    expiresAt: now + 60_000,
    type: 'status',
    orderId: 'order-1',
    ...overrides,
  };
}

/** A minimal fake transport implementing only what WakuSession needs; routes
 * lightPush.send through real encoder.toProtoObj → decoder.fromProtoObj so
 * the whole ECIES round trip is exercised end to end, not just wiring. */
function makeFakeNode(): {
  node: WakuNode;
  subscribers: Array<{ decoder: EciesDecoder; callback: (msg: unknown) => unknown }>;
  sent: unknown[];
  emitConnection: (up: boolean) => void;
} {
  const subscribers: Array<{ decoder: EciesDecoder; callback: (msg: unknown) => unknown }> = [];
  const sent: unknown[] = [];
  const listeners = new Map<string, Set<(event: { detail: unknown }) => void>>();
  const node: WakuNode = {
    async waitForPeers() {
      return;
    },
    lightPush: {
      async send(encoder: EciesEncoder, message: { payload: Uint8Array }) {
        sent.push(message);
        const proto = await encoder.toProtoObj(message);
        if (proto) {
          for (const { decoder, callback } of subscribers) {
            const decoded = await decoder.fromProtoObj(encoder.pubsubTopic, proto);
            if (decoded) await callback(decoded);
          }
        }
        return { successes: ['peer-a'], failures: [] } as never;
      },
    } as never,
    filter: {
      async subscribe(decoder: EciesDecoder, callback: (msg: unknown) => unknown) {
        subscribers.push({ decoder, callback });
        return true;
      },
      async unsubscribe() {
        return true;
      },
    } as never,
    events: {
      addEventListener(type: string, listener: never) {
        if (!listeners.has(type)) listeners.set(type, new Set());
        listeners.get(type)!.add(listener as never);
      },
      removeEventListener(type: string, listener: never) {
        listeners.get(type)?.delete(listener as never);
      },
    } as never,
    async stop() {
      return;
    },
  };
  return {
    node,
    subscribers,
    sent,
    emitConnection(up: boolean) {
      for (const listener of listeners.get('waku:connection') ?? []) {
        (listener as (event: { detail: unknown }) => void)({ detail: up });
      }
    },
  };
}

describe('waku session', () => {
  test('ready() waits for peers and subscribes its own decoder before resolving true', async () => {
    const { node, subscribers } = makeFakeNode();
    const identity = generatePrivateKey();
    const session = createWakuSession(freshConfig(), identity, { createNode: async () => node });
    expect(await session.ready()).toBe(true);
    expect(subscribers.length).toBe(1);
  });

  test('send/subscribe round-trips a real ECIES-encoded, signed message end to end', async () => {
    const { node } = makeFakeNode();
    const sellerIdentity = generatePrivateKey();
    const buyerIdentity = generatePrivateKey();
    const sellerSession = createWakuSession(freshConfig(), sellerIdentity, { createNode: async () => node });
    await sellerSession.ready();

    const received: unknown[] = [];
    await sellerSession.subscribe(async (message) => {
      received.push(message);
    });

    // Simulate the buyer's own session encoding+sending directly through the same fake transport.
    const buyerSession = createWakuSession(freshConfig(), buyerIdentity, { createNode: async () => node });
    await buyerSession.ready();
    await buyerSession.send(bytesToHex(getPublicKey(sellerIdentity)), makeRequest());

    expect(received).toHaveLength(1);
    const message = received[0] as { signerKeyId: string; body: BuyerRequest };
    expect(message.signerKeyId).toBe(bytesToHex(getPublicKey(buyerIdentity)));
    expect(message.body.type).toBe('status');
    expect((message.body as Extract<BuyerRequest, { type: 'status' }>).orderId).toBe('order-1');
  });

  test('rejects a message whose signature does not verify against its own claimed public key', async () => {
    const { node, subscribers } = makeFakeNode();
    const sellerIdentity = generatePrivateKey();
    const session = createWakuSession(freshConfig(), sellerIdentity, { createNode: async () => node });
    await session.ready();
    const received: unknown[] = [];
    await session.subscribe(async (message) => {
      received.push(message);
    });

    // Deliver a decoder-shaped object with no signature at all (not a real decoded envelope).
    await subscribers[0]!.callback({
      payload: new TextEncoder().encode(JSON.stringify(makeRequest())),
      verifySignature: () => true,
      signaturePublicKey: undefined,
      signature: undefined,
    });

    expect(received).toHaveLength(0);
  });

  test('rejects a message that claims a public key but fails self-verification', async () => {
    const { node, subscribers } = makeFakeNode();
    const sellerIdentity = generatePrivateKey();
    const session = createWakuSession(freshConfig(), sellerIdentity, { createNode: async () => node });
    await session.ready();
    const received: unknown[] = [];
    await session.subscribe(async (message) => {
      received.push(message);
    });

    await subscribers[0]!.callback({
      payload: new TextEncoder().encode(JSON.stringify(makeRequest())),
      verifySignature: () => false,
      signaturePublicKey: getPublicKey(generatePrivateKey()),
      signature: new Uint8Array(64),
    });

    expect(received).toHaveLength(0);
  });

  test('rejects malformed JSON payloads without throwing out of the subscription callback', async () => {
    const { node, subscribers } = makeFakeNode();
    const sellerIdentity = generatePrivateKey();
    const session = createWakuSession(freshConfig(), sellerIdentity, { createNode: async () => node });
    await session.ready();
    const received: unknown[] = [];
    await session.subscribe(async (message) => {
      received.push(message);
    });
    const attackerKey = generatePrivateKey();

    await subscribers[0]!.callback({
      payload: new TextEncoder().encode('not json'),
      verifySignature: (pub: Uint8Array) => bytesToHex(pub) === bytesToHex(getPublicKey(attackerKey)),
      signaturePublicKey: getPublicKey(attackerKey),
      signature: new Uint8Array(64),
    });
    expect(received).toHaveLength(0);
  });

  test('enforces a per-signer rate limit and bounded-rejects excess requests instead of unbounded work', async () => {
    const { node, subscribers } = makeFakeNode();
    const sellerIdentity = generatePrivateKey();
    const session = createWakuSession(freshConfig(), sellerIdentity, { createNode: async () => node });
    await session.ready();
    let handled = 0;
    await session.subscribe(async () => {
      handled += 1;
    });
    const attackerKey = generatePrivateKey();
    const attackerPublicKey = getPublicKey(attackerKey);
    const fakeSigned = () => ({
      payload: new TextEncoder().encode(JSON.stringify(makeRequest({ messageId: `m-${Math.random()}` }))),
      verifySignature: (pub: Uint8Array) => bytesToHex(pub) === bytesToHex(attackerPublicKey),
      signaturePublicKey: attackerPublicKey,
      signature: new Uint8Array(64),
    });

    for (let i = 0; i < 70; i += 1) {
      await subscribers[0]!.callback(fakeSigned());
    }

    expect(handled).toBeLessThanOrEqual(60);
  });

  test('send throws when transport reports zero successful peer deliveries', async () => {
    const { node } = makeFakeNode();
    node.lightPush = {
      async send() {
        return { successes: [], failures: [{ error: 'NO_PEER_AVAILABLE' }] } as never;
      },
    } as never;
    const identity = generatePrivateKey();
    const session = createWakuSession(freshConfig(), identity, { createNode: async () => node });
    await session.ready();
    await expect(session.send(bytesToHex(getPublicKey(generatePrivateKey())), makeRequest())).rejects.toThrow();
  });

  test('resubscribes its own decoder after a reconnect event', async () => {
    const { node, subscribers, emitConnection } = makeFakeNode();
    const identity = generatePrivateKey();
    const session = createWakuSession(freshConfig(), identity, { createNode: async () => node });
    await session.ready();
    expect(subscribers.length).toBe(1);
    emitConnection(false);
    emitConnection(true);
    expect(subscribers.length).toBe(2);
  });

  test('decodeStored round-trips a real wire envelope and rejects a byte mutation', async () => {
    const { node } = makeFakeNode();
    const sellerIdentity = generatePrivateKey();
    const buyerIdentity = generatePrivateKey();
    const senderSession = createWakuSession(freshConfig(), buyerIdentity, { createNode: async () => node });
    await senderSession.ready();

    const wireEnvelope = await senderSession.toWireForTest(
      bytesToHex(getPublicKey(sellerIdentity)),
      makeRequest(),
    );

    const recipientSession = createWakuSession(freshConfig(), sellerIdentity, { createNode: async () => node });
    await recipientSession.ready();
    const decoded = await recipientSession.decodeStored(wireEnvelope);
    expect(decoded.signerKeyId).toBe(bytesToHex(getPublicKey(buyerIdentity)));
    expect(decoded.body.type).toBe('status');
    expect((decoded.body as Extract<BuyerRequest, { type: 'status' }>).orderId).toBe('order-1');

    const mutated = new Uint8Array(wireEnvelope);
    mutated[mutated.length - 1] ^= 0xff;
    await expect(recipientSession.decodeStored(mutated)).rejects.toThrow();
  });

  test('close() stops the underlying node and unsubscribes', async () => {
    const { node } = makeFakeNode();
    const stopSpy = vi.spyOn(node, 'stop');
    const identity = generatePrivateKey();
    const session = createWakuSession(freshConfig(), identity, { createNode: async () => node });
    await session.ready();
    await session.close();
    expect(stopSpy).toHaveBeenCalled();
  });

  test('send retries a bounded number of times on zero-peer failures, then throws', async () => {
    const { node } = makeFakeNode();
    let attempts = 0;
    node.lightPush = {
      async send() {
        attempts += 1;
        return { successes: [], failures: [{ error: 'NO_PEER_AVAILABLE' }] } as never;
      },
    } as never;
    const identity = generatePrivateKey();
    const session = createWakuSession(freshConfig(), identity, { createNode: async () => node, retryIntervalMs: 0 });
    await session.ready();
    await expect(session.send(bytesToHex(getPublicKey(generatePrivateKey())), makeRequest())).rejects.toThrow();
    expect(attempts).toBeGreaterThan(1);
    expect(attempts).toBeLessThanOrEqual(4);
  });

  test('send succeeds without exhausting retries once a later attempt reaches a peer', async () => {
    const { node } = makeFakeNode();
    let attempts = 0;
    node.lightPush = {
      async send() {
        attempts += 1;
        if (attempts < 2) return { successes: [], failures: [{ error: 'NO_PEER_AVAILABLE' }] } as never;
        return { successes: ['peer-a'], failures: [] } as never;
      },
    } as never;
    const identity = generatePrivateKey();
    const session = createWakuSession(freshConfig(), identity, { createNode: async () => node, retryIntervalMs: 0 });
    await session.ready();
    await expect(session.send(bytesToHex(getPublicKey(generatePrivateKey())), makeRequest())).resolves.toBeUndefined();
    expect(attempts).toBe(2);
  });

  test('ready() aborts with a bounded timeout instead of hanging forever when node creation never resolves', async () => {
    const identity = generatePrivateKey();
    const session = createWakuSession(
      { contentTopic: CONTENT_TOPIC, bootstrapPeers: [], peerTimeoutMs: 20 },
      identity,
      { createNode: () => new Promise(() => {}) },
    );
    await expect(session.ready()).rejects.toThrow(/timed out|timeout/i);
  });

  test('the wire envelope never leaks order/buyer/product identifiers outside the encrypted payload', async () => {
    const { node } = makeFakeNode();
    const sellerIdentity = generatePrivateKey();
    const buyerIdentity = generatePrivateKey();
    const session = createWakuSession(freshConfig(), buyerIdentity, { createNode: async () => node });
    await session.ready();

    const secretOrderId = 'order-TOP-SECRET-marker';
    const wireEnvelope = await session.toWireForTest(
      bytesToHex(getPublicKey(sellerIdentity)),
      makeRequest({ orderId: secretOrderId }),
    );

    // Only the ciphertext payload should exist on the wire; nothing else in the
    // serialized envelope bytes should contain the plaintext order id.
    const raw = new TextDecoder('utf-8', { fatal: false }).decode(wireEnvelope);
    expect(raw).not.toContain(secretOrderId);
  });
});

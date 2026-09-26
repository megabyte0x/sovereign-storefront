import { expect, test } from 'vitest';
import { generatePrivateKey, getPublicKey } from '@waku/message-encryption';
import { createDecoder, createEncoder } from '@waku/message-encryption/ecies';
import { bytesToHex } from '@waku/utils/bytes';
import type { BuyerRequest, DecodedWakuMessage } from '../../src/contracts/messages.ts';
import { createWakuSession, type WakuNode } from '../../src/adapters/waku.ts';

type EciesEncoder = ReturnType<typeof createEncoder>;
type EciesDecoder = ReturnType<typeof createDecoder>;

// Routes lightPush.send through the real ECIES toProtoObj -> fromProtoObj path.
function realEciesNode(): WakuNode {
  const subscribers: Array<{ decoder: EciesDecoder; callback: (msg: unknown) => unknown }> = [];
  return {
    async waitForPeers() {},
    lightPush: {
      async send(encoder: EciesEncoder, message: { payload: Uint8Array }) {
        const proto = await encoder.toProtoObj(message);
        if (proto) {
          for (const { decoder, callback } of subscribers) {
            const decoded = await decoder.fromProtoObj(encoder.pubsubTopic, proto);
            if (decoded) await callback(decoded);
          }
        }
        return { successes: ['peer-a'], failures: [] };
      },
    },
    filter: {
      async subscribe(decoder: EciesDecoder, callback: (msg: unknown) => unknown) {
        subscribers.push({ decoder, callback });
        return true;
      },
      async unsubscribe() { return true; },
    },
    events: { addEventListener() {}, removeEventListener() {} },
    async stop() {},
  } as unknown as WakuNode;
}

test('a received message carries the signed ECIES wire envelope, which decodeStored re-verifies', async () => {
  const node = realEciesNode();
  const config = { contentTopic: '/ssf/1/wire-envelope/proto', bootstrapPeers: [], peerTimeoutMs: 1000 };
  const sellerKey = generatePrivateKey();
  const buyerKey = generatePrivateKey();
  const seller = createWakuSession(config, sellerKey, { createNode: async () => node });
  const buyer = createWakuSession(config, buyerKey, { createNode: async () => node });
  const received: DecodedWakuMessage[] = [];
  await seller.subscribe(async (message) => { received.push(message); });
  await buyer.ready();

  const now = Date.now();
  const request: BuyerRequest = {
    version: 1, messageId: 'wire-1', sellerKeyId: bytesToHex(getPublicKey(sellerKey)), network: 'regtest',
    issuedAt: now, expiresAt: now + 60_000, type: 'status', orderId: 'order-1',
  };
  await buyer.send(bytesToHex(getPublicKey(sellerKey)), request);

  expect(received).toHaveLength(1);
  const stored = await seller.decodeStored(received[0]!.wireEnvelope);
  expect(stored.signerKeyId).toBe(bytesToHex(getPublicKey(buyerKey)));
  expect(stored.body).toEqual(received[0]!.body);
  await seller.close();
  await buyer.close();
});

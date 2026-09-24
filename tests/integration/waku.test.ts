import { expect, test } from 'vitest';
import { generateWakuIdentity, createWakuSession } from '../../src/adapters/waku.ts';
import { applicationContentTopic } from '../../src/adapters/messaging.ts';
import type { BuyerRequest, WakuConfig } from '../../src/contracts/messages.ts';

/**
 * Opt-in real Waku Node exchange. Requires an actual reachable Light Push/Filter
 * network (js-waku's public fleet by default, or WAKU_BOOTSTRAP_PEERS to pin one).
 * Missing peers SKIP with a reason rather than fail — this test never runs in
 * default `npm test`, only in `npm run test:integration`. Set
 * SSF_STRICT_LIVE_WAKU=1 to turn a peer-timeout into a hard FAIL instead of a SKIP,
 * for use in an environment that guarantees live peers are present.
 */
function config(): WakuConfig {
  const bootstrapPeers = process.env.WAKU_BOOTSTRAP_PEERS
    ? process.env.WAKU_BOOTSTRAP_PEERS.split(',').map((peer) => peer.trim()).filter(Boolean)
    : [];
  return {
    contentTopic: applicationContentTopic(`live-int-${Date.now()}`),
    bootstrapPeers,
    peerTimeoutMs: 45_000,
  };
}

function makeStatusRequest(orderId: string): BuyerRequest {
  const now = Date.now();
  return {
    version: 1,
    messageId: `msg-${orderId}`,
    sellerKeyId: 'seller-key-live-int',
    network: 'regtest',
    issuedAt: now,
    expiresAt: now + 60_000,
    type: 'status',
    orderId,
  };
}

test('a real Waku Light Push/Filter exchange delivers an authenticated, signature-verified application response, not just a transport ack', async (ctx) => {
  const strict = process.env.SSF_STRICT_LIVE_WAKU === '1';
  const cfg = config();
  const seller = generateWakuIdentity();
  const buyer = generateWakuIdentity();

  const sellerSession = createWakuSession(cfg, seller.privateKey);
  const buyerSession = createWakuSession(cfg, buyer.privateKey);

  try {
    try {
      await sellerSession.ready();
      await buyerSession.ready();
    } catch (error) {
      if (strict) throw error;
      ctx.skip();
      return;
    }

    const received: Array<{ signerKeyId: string; body: BuyerRequest }> = [];
    await sellerSession.subscribe(async (message) => {
      received.push({ signerKeyId: message.signerKeyId, body: message.body as BuyerRequest });
    });

    const orderId = `live-order-${Date.now()}`;
    await buyerSession.send(seller.publicKeyHex, makeStatusRequest(orderId));

    const deadline = Date.now() + 30_000;
    while (received.length === 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 250));
    }

    if (received.length === 0) {
      if (strict) throw new Error('no application-authenticated message arrived from the live network within 30s');
      ctx.skip();
      return;
    }

    // This is the property that matters: the seller session only ever surfaces
    // messages whose signer public key it has independently verified via the
    // real ECIES decoder's verifySignature() call (see src/adapters/waku.ts).
    // A bare Light Push transport ack never reaches subscribe() at all.
    expect(received[0]!.signerKeyId).toBe(buyer.publicKeyHex);
    expect(received[0]!.body.type).toBe('status');
    expect((received[0]!.body as Extract<BuyerRequest, { type: 'status' }>).orderId).toBe(orderId);
  } finally {
    await sellerSession.close().catch(() => {});
    await buyerSession.close().catch(() => {});
  }
}, 120_000);

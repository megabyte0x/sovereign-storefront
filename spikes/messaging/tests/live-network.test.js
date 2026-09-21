import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test } from "node:test";
import { bytesToHex } from "@waku/utils/bytes";
import { acceptApplicationResponse } from "../src/application-response.js";
import { probeContentTopic, ROUTING_MARKERS } from "../src/routing.js";
import {
  createBuyerSession,
  createSellerSession,
  generateIdentity,
  startNetworkNode
} from "../src/waku-session.js";

test(
  "encrypted request and authenticated response travel over the real Logos network",
  { timeout: 180_000 },
  async (t) => {
  const contentTopic = probeContentTopic(bytesToHex(randomBytes(8)));
  const sellerIdentity = generateIdentity();
  const buyerIdentity = generateIdentity();
  const authorization = bytesToHex(randomBytes(16));
  const requestId = "live-order-1";

  const sellerNode = await startNetworkNode({ contentTopic, timeoutMs: 120_000 });
  const buyerNode = await startNetworkNode({ contentTopic, timeoutMs: 120_000 });
  t.after(async () => {
    await buyerNode.node.stop();
    await sellerNode.node.stop();
  });

  const seller = createSellerSession({
    contentTopic,
    sellerIdentity,
    expectedAuthorization: authorization
  });
  const buyer = createBuyerSession({
    contentTopic,
    buyerIdentity,
    sellerPublicKey: sellerIdentity.publicKey
  });
  await seller.start(sellerNode.node);
  await buyer.start(buyerNode.node);

  const t0 = Date.now();
  const ack = await buyer.sendRequest({
    type: "order-request",
    requestId,
    authorization,
    buyerPublicKeyHex: buyerIdentity.publicKeyHex,
    ORDER_MARK: "ORDER_MARK",
    BUYER_MARK: "BUYER_MARK",
    PRODUCT_MARK: "PRODUCT_MARK"
  });
  assert.equal(acceptApplicationResponse(ack, sellerIdentity.publicKey).ok, false);
  assert.ok(ack.successCount > 0, "lightpush must reach at least one Logos peer");

  const accepted = await buyer.waitAccepted(120_000);
  const latencyMs = Date.now() - t0;
  assert.equal(accepted.ok, true);
  assert.equal(accepted.payload.requestId, requestId);
  assert.equal(accepted.payload.logicalCount, 1);

  const retryAck = await buyer.sendRequest({
    type: "order-request",
    requestId,
    authorization,
    buyerPublicKeyHex: buyerIdentity.publicKeyHex,
    ORDER_MARK: "ORDER_MARK",
    BUYER_MARK: "BUYER_MARK",
    PRODUCT_MARK: "PRODUCT_MARK"
  });
  assert.ok(retryAck.successCount > 0);
  const retried = await buyer.waitAccepted(120_000);
  assert.notEqual(retried, accepted, "retry must observe a new accepted message");
  assert.equal(retried.payload.responseId, accepted.payload.responseId);
  assert.equal(retried.payload.logicalCount, 1);

  for (const inspection of [...buyer.routingInspections, ...seller.routingInspections]) {
    assert.equal(inspection.ok, true);
    assert.deepEqual(inspection.found, []);
  }
  for (const marker of ROUTING_MARKERS) {
    assert.equal(contentTopic.includes(marker), false);
  }
  console.log(
    JSON.stringify({
      liveNetwork: true,
      lightPushSuccesses: ack.successCount,
      latencyMs,
      contentTopic,
      routingOk: true
    })
  );
});

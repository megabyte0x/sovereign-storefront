import assert from "node:assert/strict";
import { test } from "node:test";
import { createBuyerSession, generateIdentity } from "../src/waku-session.js";

function buyerSession() {
  const buyerIdentity = generateIdentity();
  const seller = generateIdentity();
  return createBuyerSession({
    contentTopic: "/ssf-probe/1/wait/proto",
    buyerIdentity,
    sellerPublicKey: seller.publicKey
  });
}

test("waitAccepted times out on a second wait when no new message arrives", async () => {
  const buyer = buyerSession();
  buyer.accepted.push({
    ok: true,
    payload: { requestId: "order-1", responseId: "resp-1", logicalCount: 1 }
  });
  const first = await buyer.waitAccepted(200);
  assert.equal(first.payload.responseId, "resp-1");
  await assert.rejects(
    () => buyer.waitAccepted(300),
    /timed out waiting for accepted application response/
  );
});

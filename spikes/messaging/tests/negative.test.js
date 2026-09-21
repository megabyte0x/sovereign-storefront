import assert from "node:assert/strict";
import { test } from "node:test";
import { generatePrivateKey, getPublicKey } from "@waku/message-encryption";
import { createDecoder, createEncoder } from "@waku/message-encryption/ecies";
import { createEncoder as createPlainEncoder } from "@waku/sdk";
import { DefaultNetworkConfig } from "@waku/interfaces";
import { createRoutingInfo } from "@waku/utils";
import { utf8ToBytes } from "@waku/utils/bytes";
import { acceptApplicationResponse } from "../src/application-response.js";

const CONTENT_TOPIC = "/ssf-probe/1/checkout/proto";
const ROUTING = createRoutingInfo(DefaultNetworkConfig, {
  contentTopic: CONTENT_TOPIC
});

async function encodeSignedForBuyer({
  sellerPrivateKey,
  buyerPublicKey,
  buyerPrivateKey,
  payload
}) {
  const encoder = createEncoder({
    contentTopic: CONTENT_TOPIC,
    routingInfo: ROUTING,
    publicKey: buyerPublicKey,
    sigPrivKey: sellerPrivateKey
  });
  const decoder = createDecoder(CONTENT_TOPIC, ROUTING, buyerPrivateKey);
  const proto = await encoder.toProtoObj({ payload: utf8ToBytes(payload) });
  return decoder.fromProtoObj(ROUTING.pubsubTopic, proto);
}

test("rejects a response signed by the wrong seller identity", async () => {
  const expectedSellerPrivate = generatePrivateKey();
  const expectedSellerPublic = getPublicKey(expectedSellerPrivate);
  const impostorPrivate = generatePrivateKey();
  const buyerPrivate = generatePrivateKey();
  const buyerPublic = getPublicKey(buyerPrivate);

  const decoded = await encodeSignedForBuyer({
    sellerPrivateKey: impostorPrivate,
    buyerPublicKey: buyerPublic,
    buyerPrivateKey: buyerPrivate,
    payload: JSON.stringify({ type: "order-response", requestId: "req-1" })
  });

  const result = acceptApplicationResponse(decoded, expectedSellerPublic);
  assert.equal(result.ok, false);
  assert.match(result.reason, /seller identity/i);
});

test("does not treat a plain delivery acknowledgement as a decrypted application response", async () => {
  const sellerPublic = getPublicKey(generatePrivateKey());
  const lightPushAck = {
    successes: ["16Uiu2HAmtransportpeer"],
    failures: []
  };

  const result = acceptApplicationResponse(lightPushAck, sellerPublic);
  assert.equal(result.ok, false);
  assert.match(result.reason, /not a decrypted application response/i);
});

test("does not treat an unencrypted version-0 payload as a decrypted application response", async () => {
  const sellerPublic = getPublicKey(generatePrivateKey());
  const encoder = createPlainEncoder({
    contentTopic: CONTENT_TOPIC,
    routingInfo: ROUTING
  });
  const proto = await encoder.toProtoObj({
    payload: utf8ToBytes(
      JSON.stringify({ type: "order-response", requestId: "req-1" })
    )
  });

  const result = acceptApplicationResponse(
    {
      version: proto.version ?? 0,
      payload: proto.payload,
      contentTopic: proto.contentTopic,
      pubsubTopic: ROUTING.pubsubTopic,
      timestamp: undefined,
      rateLimitProof: proto.rateLimitProof,
      ephemeral: proto.ephemeral,
      meta: proto.meta
    },
    sellerPublic
  );
  assert.equal(result.ok, false);
  assert.match(result.reason, /not a decrypted application response/i);
});

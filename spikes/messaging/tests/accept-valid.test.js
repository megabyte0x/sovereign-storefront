import assert from "node:assert/strict";
import { test } from "node:test";
import { generatePrivateKey, getPublicKey } from "@waku/message-encryption";
import { createDecoder, createEncoder } from "@waku/message-encryption/ecies";
import { DefaultNetworkConfig } from "@waku/interfaces";
import { createRoutingInfo } from "@waku/utils";
import { utf8ToBytes } from "@waku/utils/bytes";
import { acceptApplicationResponse } from "../src/application-response.js";

const CONTENT_TOPIC = "/ssf-probe/1/checkout/proto";
const ROUTING = createRoutingInfo(DefaultNetworkConfig, {
  contentTopic: CONTENT_TOPIC
});

test("accepts a decrypted order-response signed by the expected seller", async () => {
  const sellerPrivate = generatePrivateKey();
  const sellerPublic = getPublicKey(sellerPrivate);
  const buyerPrivate = generatePrivateKey();
  const encoder = createEncoder({
    contentTopic: CONTENT_TOPIC,
    routingInfo: ROUTING,
    publicKey: getPublicKey(buyerPrivate),
    sigPrivKey: sellerPrivate
  });
  const decoder = createDecoder(CONTENT_TOPIC, ROUTING, buyerPrivate);
  const proto = await encoder.toProtoObj({
    payload: utf8ToBytes(
      JSON.stringify({ type: "order-response", requestId: "req-ok" })
    )
  });
  const decoded = await decoder.fromProtoObj(ROUTING.pubsubTopic, proto);
  const result = acceptApplicationResponse(decoded, sellerPublic);
  assert.equal(result.ok, true);
  assert.equal(result.payload.requestId, "req-ok");
});

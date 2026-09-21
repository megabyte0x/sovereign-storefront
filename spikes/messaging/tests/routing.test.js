import assert from "node:assert/strict";
import { test } from "node:test";
import { generatePrivateKey, getPublicKey } from "@waku/message-encryption";
import { createEncoder } from "@waku/message-encryption/ecies";
import { DefaultNetworkConfig } from "@waku/interfaces";
import { createRoutingInfo } from "@waku/utils";
import { utf8ToBytes } from "@waku/utils/bytes";
import {
  inspectPublicRouting,
  probeContentTopic,
  ROUTING_MARKERS
} from "../src/routing.js";

const RUN_ID = "7f3c9a12";
const CLEAN_TOPIC = probeContentTopic(RUN_ID);
const MARKER_PAYLOAD = JSON.stringify({
  type: "order-request",
  requestId: "req-mark",
  ORDER_MARK: "ORDER_MARK",
  BUYER_MARK: "BUYER_MARK",
  PRODUCT_MARK: "PRODUCT_MARK"
});

test("public topics and unencrypted envelope fields do not contain routing markers", async () => {
  const routing = createRoutingInfo(DefaultNetworkConfig, {
    contentTopic: CLEAN_TOPIC
  });
  const encoder = createEncoder({
    contentTopic: CLEAN_TOPIC,
    routingInfo: routing,
    publicKey: getPublicKey(generatePrivateKey()),
    sigPrivKey: generatePrivateKey()
  });
  const proto = await encoder.toProtoObj({ payload: utf8ToBytes(MARKER_PAYLOAD) });
  const inspection = inspectPublicRouting({
    contentTopic: encoder.contentTopic,
    pubsubTopic: encoder.pubsubTopic,
    version: proto.version,
    timestamp: proto.timestamp,
    ephemeral: proto.ephemeral,
    meta: proto.meta,
    rateLimitProof: proto.rateLimitProof
  });
  assert.equal(inspection.ok, true);
  assert.deepEqual(inspection.found, []);
  for (const marker of ROUTING_MARKERS) {
    assert.equal(CLEAN_TOPIC.includes(marker), false);
    assert.equal(encoder.pubsubTopic.includes(marker), false);
  }
});

test("fails inspection when a routing marker is placed on the content topic", () => {
  const dirtyTopic = `/ssf-probe/1/ORDER_MARK/proto`;
  const routing = createRoutingInfo(DefaultNetworkConfig, {
    contentTopic: dirtyTopic
  });
  const inspection = inspectPublicRouting({
    contentTopic: dirtyTopic,
    pubsubTopic: routing.pubsubTopic,
    version: 1,
    timestamp: undefined,
    ephemeral: false,
    meta: undefined,
    rateLimitProof: undefined
  });
  assert.equal(inspection.ok, false);
  assert.deepEqual(inspection.found, ["ORDER_MARK"]);
});

import assert from "node:assert/strict";
import { test } from "node:test";
import { createSellerFulfillment } from "../src/fulfillment.js";

test("resending the same request returns one logical order response", () => {
  const seller = createSellerFulfillment({
    expectedAuthorization: "auth-1"
  });
  const request = {
    requestId: "order-9",
    authorization: "auth-1"
  };
  const first = seller.handleRequest(request);
  const second = seller.handleRequest(request);
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.equal(first.responseId, second.responseId);
  assert.equal(first.logicalCount, 1);
  assert.equal(second.logicalCount, 1);
});

test("rejects incorrect credentials", () => {
  const seller = createSellerFulfillment({
    expectedAuthorization: "auth-1"
  });
  const result = seller.handleRequest({
    requestId: "order-bad",
    authorization: "wrong"
  });
  assert.equal(result.ok, false);
  assert.match(result.reason, /incorrect credentials/i);
});

test("rejects replayed authorization on a new request", () => {
  const seller = createSellerFulfillment({
    expectedAuthorization: "auth-1"
  });
  const first = seller.handleRequest({
    requestId: "order-a",
    authorization: "auth-1"
  });
  const replay = seller.handleRequest({
    requestId: "order-b",
    authorization: "auth-1"
  });
  assert.equal(first.ok, true);
  assert.equal(replay.ok, false);
  assert.match(replay.reason, /replayed authorization/i);
});

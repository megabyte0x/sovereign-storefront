import assert from "node:assert/strict";
import { test } from "node:test";
import { indexedDB } from "fake-indexeddb";
import { generatePrivateKey, getPublicKey } from "@waku/message-encryption";
import { bytesToHex, hexToBytes } from "@waku/utils/bytes";
import {
  exportRecoveryMaterial,
  importRecoveryMaterial,
  loadPurchaseCredentials,
  persistPurchaseCredentials,
  provePossession
} from "../src/credentials.js";

if (!globalThis.indexedDB) {
  globalThis.indexedDB = indexedDB;
}

test("persists purchase credentials in IndexedDB and proves possession after reload", async () => {
  const privateKey = generatePrivateKey();
  const publicKey = getPublicKey(privateKey);
  const record = {
    id: "purchase-1",
    privateKey,
    publicKey
  };
  const wrote = await persistPurchaseCredentials(record);
  assert.equal(wrote, true);
  const loaded = await loadPurchaseCredentials("purchase-1");
  assert.ok(loaded);
  assert.equal(provePossession(loaded.privateKey, publicKey), true);
});

test("exports recovery material and restores possession in a fresh store", async () => {
  const privateKey = generatePrivateKey();
  const publicKey = getPublicKey(privateKey);
  await persistPurchaseCredentials({
    id: "purchase-export",
    privateKey,
    publicKey
  });
  const loaded = await loadPurchaseCredentials("purchase-export");
  const exported = exportRecoveryMaterial(loaded);
  assert.equal(typeof exported, "string");
  assert.equal(exported.includes(bytesToHex(privateKey)), true);

  const restored = importRecoveryMaterial(exported);
  assert.ok(restored);
  assert.equal(provePossession(restored.privateKey, publicKey), true);
  assert.deepEqual(restored.publicKey, publicKey);
});

test("rejects incorrect credentials", () => {
  const expected = getPublicKey(generatePrivateKey());
  const other = generatePrivateKey();
  assert.equal(provePossession(other, expected), false);
  assert.equal(provePossession(hexToBytes("00".repeat(32)), expected), false);
});

import assert from "node:assert/strict";
import { test } from "node:test";
import { decrypt, encrypt, generateKey, MAX_PLAINTEXT_BYTES } from "./crypto.mjs";

test("decrypt rejects modified ciphertext before exposing plaintext", async () => {
  const key = await generateKey();
  const plaintext = new TextEncoder().encode("harmless-fixture-v1");
  const ciphertext = await encrypt(key, plaintext);
  const modified = new Uint8Array(ciphertext);
  modified[modified.length - 1] ^= 0xff;

  await assert.rejects(
    () => decrypt(key, modified),
    (err) => {
      assert.equal(err.name, "DecryptionFailed");
      assert.equal(err.plaintextExposed, false);
      return true;
    },
  );
});

test("encrypt then decrypt round-trips the fixture", async () => {
  const key = await generateKey();
  const plaintext = new TextEncoder().encode("harmless-fixture-v1");
  const ciphertext = await encrypt(key, plaintext);
  const out = await decrypt(key, ciphertext);
  assert.deepEqual(out, plaintext);
});

test("encrypt rejects payloads above the recorded maximum", async () => {
  const key = await generateKey();
  const tooBig = new Uint8Array(MAX_PLAINTEXT_BYTES + 1);
  await assert.rejects(() => encrypt(key, tooBig), { name: "PayloadTooLarge" });
});

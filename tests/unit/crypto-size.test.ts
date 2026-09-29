import { expect, test } from 'vitest';
import { PUBLIC_MAX_PLAINTEXT_BYTES } from '../../src/contracts/public.ts';
import {
  DecryptionFailed,
  FIRST_RELEASE_MAX_CIPHERTEXT_BYTES,
  FIRST_RELEASE_MAX_PLAINTEXT_BYTES,
  PayloadTooLarge,
  createCryptoAdapter,
  decryptProduct,
  encryptProduct,
  generateAesKey,
} from '../../src/adapters/crypto.ts';

const PUBLIC_CAP = PUBLIC_MAX_PLAINTEXT_BYTES;

test('8 MiB round trip succeeds and 8 MiB + 1 byte is rejected', async () => {
  const key = await generateAesKey();
  const plaintext = new Uint8Array(PUBLIC_CAP);
  plaintext[0] = 0x11;
  plaintext[PUBLIC_CAP - 1] = 0x22;

  const ciphertext = await encryptProduct(plaintext, key, PUBLIC_CAP);
  expect(ciphertext.byteLength).toBe(PUBLIC_CAP + (FIRST_RELEASE_MAX_CIPHERTEXT_BYTES - FIRST_RELEASE_MAX_PLAINTEXT_BYTES));
  await expect(decryptProduct(ciphertext, key, PUBLIC_CAP)).resolves.toEqual(plaintext);

  const over = new Uint8Array(PUBLIC_CAP + 1);
  await expect(encryptProduct(over, key, PUBLIC_CAP)).rejects.toBeInstanceOf(PayloadTooLarge);
}, 60_000);
test('cap 41 still rejects 42 and the real-demo defaults are unchanged', async () => {
  expect(FIRST_RELEASE_MAX_PLAINTEXT_BYTES).toBe(41);
  expect(FIRST_RELEASE_MAX_CIPHERTEXT_BYTES).toBe(73);
  expect(PUBLIC_CAP).toBe(8 * 1024 * 1024);

  const key = await generateAesKey();
  await expect(encryptProduct(new Uint8Array(42), key, 41)).rejects.toBeInstanceOf(PayloadTooLarge);
  await expect(encryptProduct(new Uint8Array(42), key, FIRST_RELEASE_MAX_PLAINTEXT_BYTES)).rejects.toBeInstanceOf(PayloadTooLarge);

  const adapter = createCryptoAdapter();
  await expect(adapter.encryptProduct(new Uint8Array(42))).rejects.toBeInstanceOf(PayloadTooLarge);
});

test('a tampered ciphertext byte fails closed as DecryptionFailed', async () => {
  const key = await generateAesKey();
  const ciphertext = await encryptProduct(new Uint8Array([1, 2, 3, 4]), key, PUBLIC_CAP);
  const tampered = new Uint8Array(ciphertext);
  tampered[tampered.byteLength - 1] ^= 0xff;
  await expect(decryptProduct(tampered, key, PUBLIC_CAP)).rejects.toBeInstanceOf(DecryptionFailed);

  const tooLong = new Uint8Array(PUBLIC_CAP + (FIRST_RELEASE_MAX_CIPHERTEXT_BYTES - FIRST_RELEASE_MAX_PLAINTEXT_BYTES) + 1);
  await expect(decryptProduct(tooLong, key, PUBLIC_CAP)).rejects.toBeInstanceOf(PayloadTooLarge);
});

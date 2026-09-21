const MAGIC = new TextEncoder().encode("SSF1");
export const ALG = "AES-GCM";
export const KEY_BITS = 256;
export const NONCE_BYTES = 12;
export const MAX_PLAINTEXT_BYTES = 8 * 1024 * 1024;

export class DecryptionFailed extends Error {
  constructor(message = "authenticated decryption failed") {
    super(message);
    this.name = "DecryptionFailed";
    this.plaintextExposed = false;
  }
}

export class PayloadTooLarge extends Error {
  constructor(bytes) {
    super(`payload ${bytes} exceeds MAX_PLAINTEXT_BYTES ${MAX_PLAINTEXT_BYTES}`);
    this.name = "PayloadTooLarge";
  }
}

export async function generateKey() {
  return crypto.subtle.generateKey(
    { name: ALG, length: KEY_BITS },
    true,
    ["encrypt", "decrypt"],
  );
}

export async function importKey(raw) {
  return crypto.subtle.importKey("raw", raw, { name: ALG }, true, [
    "encrypt",
    "decrypt",
  ]);
}

export async function exportKey(key) {
  return new Uint8Array(await crypto.subtle.exportKey("raw", key));
}

export async function encrypt(key, plaintext) {
  const bytes = plaintext instanceof Uint8Array ? plaintext : new Uint8Array(plaintext);
  if (bytes.byteLength > MAX_PLAINTEXT_BYTES) {
    throw new PayloadTooLarge(bytes.byteLength);
  }
  const nonce = crypto.getRandomValues(new Uint8Array(NONCE_BYTES));
  const sealed = new Uint8Array(
    await crypto.subtle.encrypt({ name: ALG, iv: nonce }, key, bytes),
  );
  const out = new Uint8Array(MAGIC.length + nonce.length + sealed.length);
  out.set(MAGIC, 0);
  out.set(nonce, MAGIC.length);
  out.set(sealed, MAGIC.length + nonce.length);
  return out;
}

export async function decrypt(key, ciphertext) {
  const bytes =
    ciphertext instanceof Uint8Array ? ciphertext : new Uint8Array(ciphertext);
  try {
    if (bytes.byteLength < MAGIC.length + NONCE_BYTES + 16) {
      throw new DecryptionFailed("ciphertext too short");
    }
    for (let i = 0; i < MAGIC.length; i += 1) {
      if (bytes[i] !== MAGIC[i]) {
        throw new DecryptionFailed("unknown ciphertext format");
      }
    }
    const nonce = bytes.subarray(MAGIC.length, MAGIC.length + NONCE_BYTES);
    const sealed = bytes.subarray(MAGIC.length + NONCE_BYTES);
    const plain = await crypto.subtle.decrypt(
      { name: ALG, iv: nonce },
      key,
      sealed,
    );
    return new Uint8Array(plain);
  } catch (err) {
    if (err instanceof DecryptionFailed) {
      throw err;
    }
    throw new DecryptionFailed();
  }
}

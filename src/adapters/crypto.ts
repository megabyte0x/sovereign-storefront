import { sha256 } from '@noble/hashes/sha256';
import { type webcrypto } from 'node:crypto';
import { ecies } from '@waku/message-encryption/crypto';
import { bytesToHex, hexToBytes } from '@waku/utils/bytes';
import type { CredentialAdapter, CryptoAdapter, ManifestVerifier } from '../contracts/types.ts';

type AesKey = webcrypto.CryptoKey;

export const ALG = 'AES-GCM';
export const KEY_BITS = 256;
export const NONCE_BYTES = 12;
export const SSF1_MAGIC = new TextEncoder().encode('SSF1');
export const FILE_FORMAT_VERSION = 'SSF1';
export const FIRST_RELEASE_MAX_PLAINTEXT_BYTES = 41;
export const FIRST_RELEASE_MAX_CIPHERTEXT_BYTES = 73;
export const LOCAL_AE_MAX_PLAINTEXT_BYTES = 8 * 1024 * 1024;

const ENVELOPE_MAGIC = new TextEncoder().encode('SSDL');

export class DecryptionFailed extends Error {
  readonly plaintextExposed = false;
  constructor(message = 'authenticated decryption failed') {
    super(message);
    this.name = 'DecryptionFailed';
  }
}

export class PayloadTooLarge extends Error {
  constructor(bytes: number, max: number) {
    super(`payload ${bytes} exceeds max ${max}`);
    this.name = 'PayloadTooLarge';
  }
}

export function sha256Hex(bytes: Uint8Array): string {
  return bytesToHex(sha256(bytes));
}

function randomBytes(size: number): Uint8Array {
  const bytes = new Uint8Array(size);
  globalThis.crypto.getRandomValues(bytes);
  return bytes;
}

export function hasSsf1Magic(bytes: Uint8Array): boolean {
  if (bytes.byteLength < SSF1_MAGIC.length) return false;
  return SSF1_MAGIC.every((value, index) => bytes[index] === value);
}

export async function generateAesKey(): Promise<AesKey> {
  return crypto.subtle.generateKey({ name: ALG, length: KEY_BITS }, true, ['encrypt', 'decrypt']);
}

export async function importAesKey(raw: Uint8Array): Promise<AesKey> {
  return crypto.subtle.importKey('raw', raw, { name: ALG }, true, ['encrypt', 'decrypt']);
}

export async function exportAesKey(key: AesKey): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.exportKey('raw', key));
}

const AEAD_TAG_BYTES = 16;
const SSF1_OVERHEAD = SSF1_MAGIC.length + NONCE_BYTES + AEAD_TAG_BYTES;
export const MAX_PUBLIC_TESTNET_CIPHERTEXT_BYTES = LOCAL_AE_MAX_PLAINTEXT_BYTES + SSF1_OVERHEAD;

export async function encryptProduct(plaintext: Uint8Array, key: AesKey, capBytes: number): Promise<Uint8Array> {
  if (!Number.isSafeInteger(capBytes) || capBytes < 0 || plaintext.byteLength > capBytes) {
    throw new PayloadTooLarge(plaintext.byteLength, capBytes);
  }
  const nonce = crypto.getRandomValues(new Uint8Array(NONCE_BYTES));
  const sealed = new Uint8Array(await crypto.subtle.encrypt({ name: ALG, iv: nonce }, key, plaintext));
  const out = new Uint8Array(SSF1_MAGIC.length + nonce.length + sealed.length);
  out.set(SSF1_MAGIC, 0);
  out.set(nonce, SSF1_MAGIC.length);
  out.set(sealed, SSF1_MAGIC.length + nonce.length);
  const maxCiphertext = capBytes + SSF1_OVERHEAD;
  if (out.byteLength > maxCiphertext) {
    throw new PayloadTooLarge(out.byteLength, maxCiphertext);
  }
  return out;
}

export async function encryptSsf1(key: AesKey, plaintext: Uint8Array): Promise<Uint8Array> {
  return encryptProduct(plaintext, key, FIRST_RELEASE_MAX_PLAINTEXT_BYTES);
}

export async function decryptSsf1(key: AesKey, ciphertext: Uint8Array): Promise<Uint8Array> {
  try {
    if (ciphertext.byteLength < SSF1_MAGIC.length + NONCE_BYTES + 16) {
      throw new DecryptionFailed('ciphertext too short');
    }
    if (!hasSsf1Magic(ciphertext)) {
      throw new DecryptionFailed('unknown ciphertext format');
    }
    const nonce = ciphertext.subarray(SSF1_MAGIC.length, SSF1_MAGIC.length + NONCE_BYTES);
    const sealed = ciphertext.subarray(SSF1_MAGIC.length + NONCE_BYTES);
    const plain = await crypto.subtle.decrypt({ name: ALG, iv: nonce }, key, sealed);
    return new Uint8Array(plain);
  } catch (err) {
    if (err instanceof DecryptionFailed) throw err;
    throw new DecryptionFailed();
  }
}

export async function decryptProduct(bytes: Uint8Array, key: AesKey, capBytes: number): Promise<Uint8Array> {
  const maxCiphertext = capBytes + SSF1_OVERHEAD;
  if (!Number.isSafeInteger(capBytes) || capBytes < 0 || bytes.byteLength > maxCiphertext) {
    throw new PayloadTooLarge(bytes.byteLength, maxCiphertext);
  }
  const plaintext = await decryptSsf1(key, bytes);
  if (plaintext.byteLength > capBytes) {
    throw new PayloadTooLarge(plaintext.byteLength, capBytes);
  }
  return plaintext;
}

export type DeliveryHeader = {
  orderId: string;
  productVersion: string;
  buyerKeyId: string;
  digestHex: string;
};

type KeyRecord = {
  key: AesKey;
  raw: Uint8Array;
  digestHex: string;
};

export function encodeDeliveryEnvelope(header: DeliveryHeader, wrappedKey: Uint8Array): Uint8Array {
  const headerBytes = new TextEncoder().encode(JSON.stringify(header));
  const out = new Uint8Array(ENVELOPE_MAGIC.length + 2 + headerBytes.length + wrappedKey.length);
  out.set(ENVELOPE_MAGIC, 0);
  new DataView(out.buffer).setUint16(ENVELOPE_MAGIC.length, headerBytes.length, false);
  out.set(headerBytes, ENVELOPE_MAGIC.length + 2);
  out.set(wrappedKey, ENVELOPE_MAGIC.length + 2 + headerBytes.length);
  return out;
}

export function splitDeliveryEnvelope(envelope: Uint8Array): { header: DeliveryHeader; wrappedKey: Uint8Array } {
  if (envelope.byteLength < ENVELOPE_MAGIC.length + 2) {
    throw new DecryptionFailed('envelope too short');
  }
  for (let i = 0; i < ENVELOPE_MAGIC.length; i += 1) {
    if (envelope[i] !== ENVELOPE_MAGIC[i]) {
      throw new DecryptionFailed('unknown envelope format');
    }
  }
  const headerLen = new DataView(envelope.buffer, envelope.byteOffset, envelope.byteLength)
    .getUint16(ENVELOPE_MAGIC.length, false);
  const headerStart = ENVELOPE_MAGIC.length + 2;
  const headerEnd = headerStart + headerLen;
  if (headerEnd > envelope.byteLength) {
    throw new DecryptionFailed('truncated envelope');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(envelope.subarray(headerStart, headerEnd)));
  } catch {
    throw new DecryptionFailed('malformed envelope');
  }
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    !('orderId' in parsed) ||
    !('productVersion' in parsed) ||
    !('buyerKeyId' in parsed) ||
    !('digestHex' in parsed) ||
    typeof parsed.orderId !== 'string' ||
    typeof parsed.productVersion !== 'string' ||
    typeof parsed.buyerKeyId !== 'string' ||
    typeof parsed.digestHex !== 'string'
  ) {
    throw new DecryptionFailed('malformed envelope');
  }
  return {
    header: {
      orderId: parsed.orderId,
      productVersion: parsed.productVersion,
      buyerKeyId: parsed.buyerKeyId,
      digestHex: parsed.digestHex,
    },
    wrappedKey: envelope.subarray(headerEnd),
  };
}

export function encodeManifest(input: {
  productVersion: string;
  digestHex: string;
  fileSize: number;
}): Uint8Array {
  return new TextEncoder().encode(JSON.stringify({
    fileFormatVersion: FILE_FORMAT_VERSION,
    productVersion: input.productVersion,
    digestHex: input.digestHex,
    fileSize: input.fileSize,
  }));
}

export function createManifestVerifier(maxCiphertextBytes = FIRST_RELEASE_MAX_CIPHERTEXT_BYTES): ManifestVerifier {
  if (!Number.isSafeInteger(maxCiphertextBytes) || maxCiphertextBytes < 0 || maxCiphertextBytes > MAX_PUBLIC_TESTNET_CIPHERTEXT_BYTES) {
    throw new RangeError('invalid manifest ciphertext limit');
  }
  return {
    async verify(manifest, ciphertext) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(new TextDecoder().decode(manifest));
      } catch {
        return false;
      }
      if (
        typeof parsed !== 'object' ||
        parsed === null ||
        !('fileFormatVersion' in parsed) ||
        !('digestHex' in parsed) ||
        !('fileSize' in parsed) ||
        parsed.fileFormatVersion !== FILE_FORMAT_VERSION ||
        typeof parsed.digestHex !== 'string' ||
        typeof parsed.fileSize !== 'number'
      ) {
        return false;
      }
      if (ciphertext.byteLength > maxCiphertextBytes) return false;
      if (!hasSsf1Magic(ciphertext)) return false;
      if (parsed.fileSize !== ciphertext.byteLength) return false;
      return parsed.digestHex === sha256Hex(ciphertext);
    },
  };
}

export function createCryptoAdapter(options?: {
  credentials?: CredentialAdapter;
  /** Defaults to 41 so real-demo is unchanged. */
  maxPlaintextBytes?: number;
}): CryptoAdapter & {
  decryptProduct(keyRef: string, ciphertext: Uint8Array): Promise<Uint8Array>;
  exportProductKey(keyRef: string): Promise<Uint8Array>;
  importProductKey(keyRef: string, raw: Uint8Array, digestHex: string): Promise<void>;
} {
  const keys = new Map<string, KeyRecord>();
  const credentials = options?.credentials;
  const maxPlaintextBytes = options?.maxPlaintextBytes ?? FIRST_RELEASE_MAX_PLAINTEXT_BYTES;
  const sealPlaintext = encryptProduct;
  const openPlaintext = decryptProduct;
  return {
    async encryptProduct(plaintext) {
      if (!(plaintext instanceof Uint8Array)) {
        throw new Error('malformed payload: plaintext');
      }
      const key = await generateAesKey();
      const ciphertext = await sealPlaintext(plaintext, key, maxPlaintextBytes);
      const raw = await exportAesKey(key);
      const keyRef = bytesToHex(randomBytes(16));
      keys.set(keyRef, { key, raw, digestHex: sha256Hex(ciphertext) });
      return { ciphertext, keyRef };
    },
    async sealDelivery(input) {
      const record = keys.get(input.productKeyRef);
      if (!record) {
        throw new Error('unknown product key');
      }
      const header: DeliveryHeader = {
        orderId: input.orderId,
        productVersion: input.productVersion,
        buyerKeyId: input.buyerKeyId,
        digestHex: record.digestHex,
      };
      const recipient = hexToBytes(input.buyerKeyId);
      const wrappedKey = await ecies.encrypt(recipient, record.raw);
      return encodeDeliveryEnvelope(header, wrappedKey);
    },
    async openDelivery(envelope, credentialId) {
      if (!credentials) {
        throw new DecryptionFailed('credentials required');
      }
      const split = splitDeliveryEnvelope(envelope);
      try {
        const productKey = await credentials.decryptWrapped(credentialId, split.wrappedKey);
        return { productKey };
      } catch (err) {
        if (err instanceof DecryptionFailed) throw err;
        throw new DecryptionFailed();
      }
    },
    async decryptProduct(keyRef, ciphertext) {
      const record = keys.get(keyRef);
      if (!record) {
        throw new Error('unknown product key');
      }
      return openPlaintext(ciphertext, record.key, maxPlaintextBytes);
    },
    async exportProductKey(keyRef) {
      const record = keys.get(keyRef);
      if (!record) {
        throw new Error('unknown product key');
      }
      return new Uint8Array(record.raw);
    },
    async importProductKey(keyRef, raw, digestHex) {
      const key = await importAesKey(raw);
      keys.set(keyRef, { key, raw: new Uint8Array(raw), digestHex });
    },
  };
}

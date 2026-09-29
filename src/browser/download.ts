import {
  DecryptionFailed,
  createManifestVerifier,
  decryptSsf1,
  encodeManifest,
  importAesKey,
  MAX_PUBLIC_TESTNET_CIPHERTEXT_BYTES,
  sha256Hex,
  splitDeliveryEnvelope,
} from '../adapters/crypto.ts';
import type { CryptoAdapter, DeliveryPackage } from '../contracts/types.ts';

export const ATTACHMENT_CONTENT_TYPE = 'application/octet-stream';

export function attachmentDisposition(filename: string): string {
  const safe = filename.replace(/[^A-Za-z0-9._-]+/g, '_');
  return `attachment; filename="${safe}"`;
}

export async function decryptDownload(
  pkg: DeliveryPackage,
  ciphertext: Uint8Array,
  access: { crypto: Pick<CryptoAdapter, 'openDelivery'>; credentialId: string; maxCiphertextBytes?: number },
): Promise<Blob> {
  const maxCiphertextBytes = access.maxCiphertextBytes ?? PUBLIC_TESTNET_MAX_CIPHERTEXT_BYTES;
  if (!Number.isSafeInteger(maxCiphertextBytes) || maxCiphertextBytes < 0 || maxCiphertextBytes > PUBLIC_TESTNET_MAX_CIPHERTEXT_BYTES) {
    throw new DecryptionFailed('invalid ciphertext limit');
  }
  if (ciphertext.byteLength > maxCiphertextBytes) {
    throw new DecryptionFailed('ciphertext too large');
  }
  const { header } = splitDeliveryEnvelope(pkg.encryptedEnvelope);
  if (header.productVersion !== pkg.productVersion) {
    throw new DecryptionFailed('product version mismatch');
  }
  const { productKey } = await access.crypto.openDelivery(pkg.encryptedEnvelope, access.credentialId);
  const manifest = encodeManifest({
    productVersion: pkg.productVersion,
    digestHex: header.digestHex,
    fileSize: ciphertext.byteLength,
  });
  const verified = await createManifestVerifier(maxCiphertextBytes).verify(manifest, ciphertext);
  if (!verified) {
    throw new DecryptionFailed('manifest mismatch');
  }
  const key = await importAesKey(productKey);
  const plaintext = await decryptSsf1(key, ciphertext);
  return new Blob([plaintext], { type: ATTACHMENT_CONTENT_TYPE });
}

export const PUBLIC_TESTNET_MAX_CIPHERTEXT_BYTES = MAX_PUBLIC_TESTNET_CIPHERTEXT_BYTES;

export async function downloadCiphertext(
  url: string,
  expectedDigest: string,
  onProgress?: (loaded: number, total: number) => void,
  maxBytes = PUBLIC_TESTNET_MAX_CIPHERTEXT_BYTES,
  fetchImpl: typeof fetch = (input, init) => fetch(input, init),
): Promise<Uint8Array> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
    throw new DecryptionFailed('invalid ciphertext limit');
  }
  const limit = Math.min(maxBytes, PUBLIC_TESTNET_MAX_CIPHERTEXT_BYTES);
  const response = await fetchImpl(url);
  if (!response.ok) {
    throw new Error(`ciphertext download failed: ${response.status}`);
  }
  const declaredLength = Number(response.headers.get('content-length') ?? '');
  const total = Number.isFinite(declaredLength) && declaredLength > 0 ? declaredLength : 0;
  if (total > limit) throw new DecryptionFailed('ciphertext too large');
  const reader = response.body?.getReader();
  if (!reader) throw new DecryptionFailed('ciphertext streaming unavailable');
  const chunks: Uint8Array[] = [];
  let loaded = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value || value.byteLength === 0) continue;
      loaded += value.byteLength;
      if (loaded > limit) {
        await reader.cancel();
        throw new DecryptionFailed('ciphertext too large');
      }
      chunks.push(value);
      onProgress?.(loaded, total || loaded);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(loaded);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const actual = sha256Hex(bytes);
  const expected = expectedDigest.trim().replace(/^W\//i, '').replace(/^"+|"+$/g, '').trim().toLowerCase();
  if (actual !== expected) {
    throw new Error('ciphertext digest mismatch');
  }
  return bytes;
}

import type { CryptoAdapter, DeliveryPackage } from '../contracts/types.ts';
import {
  DecryptionFailed,
  createManifestVerifier,
  decryptSsf1,
  encodeManifest,
  importAesKey,
  splitDeliveryEnvelope,
} from '../adapters/crypto.ts';

export const ATTACHMENT_CONTENT_TYPE = 'application/octet-stream';

export function attachmentDisposition(filename: string): string {
  const safe = filename.replace(/[^A-Za-z0-9._-]+/g, '_');
  return `attachment; filename="${safe}"`;
}

export async function decryptDownload(
  pkg: DeliveryPackage,
  ciphertext: Uint8Array,
  access: { crypto: Pick<CryptoAdapter, 'openDelivery'>; credentialId: string },
): Promise<Blob> {
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
  const verified = await createManifestVerifier().verify(manifest, ciphertext);
  if (!verified) {
    throw new DecryptionFailed('manifest mismatch');
  }
  const key = await importAesKey(productKey);
  const plaintext = await decryptSsf1(key, ciphertext);
  return new Blob([plaintext], { type: ATTACHMENT_CONTENT_TYPE });
}

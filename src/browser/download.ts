import { Blob } from 'node:buffer';
import type { DeliveryPackage } from '../contracts/types.ts';
import {
  DecryptionFailed,
  createManifestVerifier,
  decryptSsf1,
  encodeManifest,
  importAesKey,
  openDisclosedEnvelope,
} from '../adapters/crypto.ts';

export const ATTACHMENT_CONTENT_TYPE = 'application/octet-stream';

export function attachmentDisposition(filename: string): string {
  const safe = filename.replace(/[^A-Za-z0-9._-]+/g, '_');
  return `attachment; filename="${safe}"`;
}

export async function decryptDownload(
  pkg: DeliveryPackage,
  ciphertext: Uint8Array,
): Promise<Blob> {
  const opened = await openDisclosedEnvelope(pkg.encryptedEnvelope);
  if (opened.header.productVersion !== pkg.productVersion) {
    throw new DecryptionFailed('product version mismatch');
  }
  const manifest = encodeManifest({
    productVersion: pkg.productVersion,
    digestHex: opened.header.digestHex,
    fileSize: ciphertext.byteLength,
  });
  const verified = await createManifestVerifier().verify(manifest, ciphertext);
  if (!verified) {
    throw new DecryptionFailed('manifest mismatch');
  }
  const key = await importAesKey(opened.productKey);
  const plaintext = await decryptSsf1(key, ciphertext);
  return new Blob([plaintext], { type: ATTACHMENT_CONTENT_TYPE });
}

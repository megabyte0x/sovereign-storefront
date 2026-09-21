import type { CryptoAdapter, StorageAdapter } from '../contracts/types.ts';
import {
  FILE_FORMAT_VERSION,
  FIRST_RELEASE_MAX_CIPHERTEXT_BYTES,
  FIRST_RELEASE_MAX_PLAINTEXT_BYTES,
  PayloadTooLarge,
  sha256Hex,
} from '../adapters/crypto.ts';
import { openCatalogue, type ProductManifest } from './catalogue.ts';

export type PublishInput = {
  dbPath: string;
  version: string;
  description: string;
  amountZat: string;
  network: 'test' | 'regtest';
  plaintext: Uint8Array;
  crypto: CryptoAdapter;
  storage: StorageAdapter;
  replicaId: string;
};

async function exportWrappedKey(crypto: CryptoAdapter, keyRef: string): Promise<Uint8Array> {
  if ('exportProductKey' in crypto && typeof crypto.exportProductKey === 'function') {
    return (crypto as CryptoAdapter & { exportProductKey: (keyRef: string) => Promise<Uint8Array> })
      .exportProductKey(keyRef);
  }
  return new TextEncoder().encode(keyRef);
}

export async function publishProduct(input: PublishInput): Promise<ProductManifest> {
  if (!(input.plaintext instanceof Uint8Array)) {
    throw new Error('malformed payload: plaintext');
  }
  if (input.plaintext.byteLength > FIRST_RELEASE_MAX_PLAINTEXT_BYTES) {
    throw new PayloadTooLarge(input.plaintext.byteLength, FIRST_RELEASE_MAX_PLAINTEXT_BYTES);
  }
  const catalogue = openCatalogue({ dbPath: input.dbPath, storage: input.storage });
  try {
    catalogue.beginPublication({
      version: input.version,
      description: input.description,
      amountZat: input.amountZat,
      network: input.network,
    });
    const { ciphertext, keyRef } = await input.crypto.encryptProduct(input.plaintext);
    if (ciphertext.byteLength > FIRST_RELEASE_MAX_CIPHERTEXT_BYTES) {
      throw new PayloadTooLarge(ciphertext.byteLength, FIRST_RELEASE_MAX_CIPHERTEXT_BYTES);
    }
    const ciphertextCid = await input.storage.publish(ciphertext);
    const replicaOk = await input.storage.verifyReplica(ciphertextCid, input.replicaId);
    if (!replicaOk) {
      throw new Error('replica verification failed');
    }
    return catalogue.completePublication({
      version: input.version,
      ciphertextCid,
      ciphertextDigest: sha256Hex(ciphertext),
      fileSize: ciphertext.byteLength,
      sellerKeyRef: keyRef,
      wrappedKey: await exportWrappedKey(input.crypto, keyRef),
    });
  } finally {
    catalogue.close();
  }
}

export { FILE_FORMAT_VERSION };

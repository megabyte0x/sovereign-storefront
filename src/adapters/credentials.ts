import { generatePrivateKey, getPublicKey } from '@waku/message-encryption';
import { bytesToHex, hexToBytes } from '@waku/utils/bytes';
import type { CredentialAdapter } from '../contracts/types.ts';

function randomBytes(size: number): Uint8Array {
  const bytes = new Uint8Array(size);
  globalThis.crypto.getRandomValues(bytes);
  return bytes;
}

type StoredCredential = {
  credentialId: string;
  privateKey: Uint8Array;
  publicKeyHex: string;
};

function encodeBackup(record: StoredCredential): Uint8Array {
  return new TextEncoder().encode(JSON.stringify({
    v: 1,
    privateKeyHex: bytesToHex(record.privateKey),
    publicKeyHex: record.publicKeyHex,
  }));
}

function decodeBackup(data: Uint8Array): { privateKeyHex: string; publicKeyHex: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(data));
  } catch {
    throw new Error('malformed backup');
  }
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    !('privateKeyHex' in parsed) ||
    !('publicKeyHex' in parsed) ||
    typeof parsed.privateKeyHex !== 'string' ||
    typeof parsed.publicKeyHex !== 'string'
  ) {
    throw new Error('malformed backup');
  }
  return { privateKeyHex: parsed.privateKeyHex, publicKeyHex: parsed.publicKeyHex };
}

function createStoredAdapter(options: {
  generate: () => { privateKey: Uint8Array; publicKeyHex: string };
  publicKeyFromPrivate: (privateKey: Uint8Array) => string;
}): CredentialAdapter {
  const byId = new Map<string, StoredCredential>();

  function store(privateKey: Uint8Array, publicKeyHex: string): StoredCredential {
    const record: StoredCredential = {
      credentialId: bytesToHex(randomBytes(16)),
      privateKey,
      publicKeyHex,
    };
    byId.set(record.credentialId, record);
    return record;
  }

  return {
    async createPurchaseCredential() {
      const material = options.generate();
      const record = store(material.privateKey, material.publicKeyHex);
      return {
        credentialId: record.credentialId,
        buyerKeyId: record.publicKeyHex,
        exportable: true,
      };
    },
    async provePossession(credentialId) {
      const record = byId.get(credentialId);
      if (!record) {
        throw new Error('unknown credential');
      }
      return new Uint8Array(record.privateKey);
    },
    async verifyPossession(buyerKeyId, proof) {
      try {
        return options.publicKeyFromPrivate(proof) === buyerKeyId;
      } catch {
        return false;
      }
    },
    async exportBackupMaterial(credentialId) {
      const record = byId.get(credentialId);
      if (!record) {
        throw new Error('unknown credential');
      }
      return encodeBackup(record);
    },
    async importBackupMaterial(data) {
      const backup = decodeBackup(data);
      const privateKey = hexToBytes(backup.privateKeyHex);
      const publicKeyHex = options.publicKeyFromPrivate(privateKey);
      if (publicKeyHex !== backup.publicKeyHex) {
        throw new Error('malformed backup');
      }
      const record = store(privateKey, publicKeyHex);
      return { credentialId: record.credentialId, buyerKeyId: record.publicKeyHex };
    },
  };
}

export function createCredentialAdapter(): CredentialAdapter {
  return createStoredAdapter({
    generate() {
      const privateKey = generatePrivateKey();
      return { privateKey, publicKeyHex: bytesToHex(getPublicKey(privateKey)) };
    },
    publicKeyFromPrivate(privateKey) {
      return bytesToHex(getPublicKey(privateKey));
    },
  });
}

export function createTestCredentialAdapter(): CredentialAdapter {
  const publicFromPrivate = new Map<string, string>();
  return createStoredAdapter({
    generate() {
      const privateKey = randomBytes(32);
      const publicKeyHex = bytesToHex(randomBytes(32));
      publicFromPrivate.set(bytesToHex(privateKey), publicKeyHex);
      return { privateKey, publicKeyHex };
    },
    publicKeyFromPrivate(privateKey) {
      const publicKeyHex = publicFromPrivate.get(bytesToHex(privateKey));
      if (!publicKeyHex) {
        throw new Error('unknown key');
      }
      return publicKeyHex;
    },
  });
}

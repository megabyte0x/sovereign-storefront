import { generatePrivateKey, getPublicKey } from '@waku/message-encryption';
import { ecies, sha256, sign } from '@waku/message-encryption/crypto';
import { recoverPublicKey } from '@noble/secp256k1';
import { bytesToHex, hexToBytes } from '@waku/utils/bytes';
import type { CredentialAdapter, PossessionChallenge } from '../contracts/types.ts';

const PROOF_MAGIC = new TextEncoder().encode('SSPF');
const NONCE_BYTES = 16;

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

function challengeBytes(challenge: PossessionChallenge, nonce: Uint8Array): Uint8Array {
  return new TextEncoder().encode(`ssf-possess-v1|${challenge.orderId}|${bytesToHex(nonce)}`);
}

function encodeProof(nonce: Uint8Array, signature: Uint8Array): Uint8Array {
  const out = new Uint8Array(PROOF_MAGIC.length + nonce.length + signature.length);
  out.set(PROOF_MAGIC, 0);
  out.set(nonce, PROOF_MAGIC.length);
  out.set(signature, PROOF_MAGIC.length + nonce.length);
  return out;
}

function splitProof(proof: Uint8Array): { nonce: Uint8Array; signature: Uint8Array } | null {
  const header = PROOF_MAGIC.length + NONCE_BYTES;
  if (proof.byteLength <= header) return null;
  for (let i = 0; i < PROOF_MAGIC.length; i += 1) {
    if (proof[i] !== PROOF_MAGIC[i]) return null;
  }
  return {
    nonce: proof.subarray(PROOF_MAGIC.length, header),
    signature: proof.subarray(header),
  };
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
    async provePossession(credentialId, challenge) {
      const record = byId.get(credentialId);
      if (!record) {
        throw new Error('unknown credential');
      }
      const nonce = randomBytes(NONCE_BYTES);
      const digest = await sha256(challengeBytes(challenge, nonce));
      const signature = await sign(digest, record.privateKey);
      return encodeProof(nonce, signature);
    },
    async verifyPossession(buyerKeyId, proof, challenge) {
      const split = splitProof(proof);
      if (!split || split.signature.byteLength < 65) return false;
      try {
        const digest = await sha256(challengeBytes(challenge, split.nonce));
        const recovered = recoverPublicKey(
          digest,
          split.signature.subarray(0, 64),
          split.signature[64] ?? 0,
        );
        return bytesToHex(recovered) === buyerKeyId;
      } catch {
        return false;
      }
    },
    async decryptWrapped(credentialId, wrappedKey) {
      const record = byId.get(credentialId);
      if (!record) {
        throw new Error('unknown credential');
      }
      return ecies.decrypt(record.privateKey, wrappedKey);
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
  return createCredentialAdapter();
}

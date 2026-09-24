import { generatePrivateKey, getPublicKey } from '@waku/message-encryption';
import { bytesToHex, hexToBytes } from '@waku/utils/bytes';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export type SellerIdentity = {
  privateKeyHex: string;
  publicKeyHex: string;
};

export function identityPath(dbPath: string): string {
  return join(dirname(dbPath), 'seller-identity.json');
}

export function loadOrCreateSellerIdentity(
  dbPath: string,
  options: { expectedPublicKeyHex?: string } = {},
): SellerIdentity {
  const path = identityPath(dbPath);
  let identity: SellerIdentity;
  if (existsSync(path)) {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as SellerIdentity;
    if (typeof parsed.privateKeyHex !== 'string' || typeof parsed.publicKeyHex !== 'string') {
      throw new Error('malformed seller identity');
    }
    const derivedPublicKeyHex = bytesToHex(getPublicKey(hexToBytes(parsed.privateKeyHex)));
    if (derivedPublicKeyHex !== parsed.publicKeyHex) {
      throw new Error('seller identity mismatch: stored public key does not match its private key');
    }
    identity = parsed;
  } else {
    const privateKey = generatePrivateKey();
    identity = {
      privateKeyHex: bytesToHex(privateKey),
      publicKeyHex: bytesToHex(getPublicKey(privateKey)),
    };
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(identity), { mode: 0o600, flag: 'wx' });
  }
  if (options.expectedPublicKeyHex !== undefined && options.expectedPublicKeyHex !== identity.publicKeyHex) {
    throw new Error('seller identity pin mismatch: configured public key does not match the persisted identity');
  }
  return identity;
}

export function writeSellerIdentity(dbPath: string, identity: SellerIdentity): void {
  mkdirSync(dirname(dbPath), { recursive: true });
  writeFileSync(identityPath(dbPath), JSON.stringify(identity), { mode: 0o600 });
}

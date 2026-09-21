import { generatePrivateKey, getPublicKey } from '@waku/message-encryption';
import { bytesToHex } from '@waku/utils/bytes';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export type SellerIdentity = {
  privateKeyHex: string;
  publicKeyHex: string;
};

export function identityPath(dbPath: string): string {
  return join(dirname(dbPath), 'seller-identity.json');
}

export function loadOrCreateSellerIdentity(dbPath: string): SellerIdentity {
  const path = identityPath(dbPath);
  if (existsSync(path)) {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as SellerIdentity;
    if (typeof parsed.privateKeyHex !== 'string' || typeof parsed.publicKeyHex !== 'string') {
      throw new Error('malformed seller identity');
    }
    return parsed;
  }
  const privateKey = generatePrivateKey();
  const identity: SellerIdentity = {
    privateKeyHex: bytesToHex(privateKey),
    publicKeyHex: bytesToHex(getPublicKey(privateKey)),
  };
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(identity), { mode: 0o600 });
  return identity;
}

export function writeSellerIdentity(dbPath: string, identity: SellerIdentity): void {
  mkdirSync(dirname(dbPath), { recursive: true });
  writeFileSync(identityPath(dbPath), JSON.stringify(identity), { mode: 0o600 });
}

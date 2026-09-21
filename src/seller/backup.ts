import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { identityPath, loadOrCreateSellerIdentity, writeSellerIdentity, type SellerIdentity } from './identity.ts';

const ALG = 'AES-GCM';
const NONCE_BYTES = 12;
const MAGIC = new TextEncoder().encode('SSBK');

export const SELLER_BACKUP_KIND = 'sovereign-storefront-seller-backup';
export const SELLER_BACKUP_VERSION = 1 as const;

export type SellerBackupMeta = {
  sellerKeyId: string;
  spendingKeysPresent: false;
  identityPublicKeyHex: string;
};

type BackupPlaintext = {
  version: typeof SELLER_BACKUP_VERSION;
  kind: typeof SELLER_BACKUP_KIND;
  sellerKeyId: string;
  spendingKeysPresent: false;
  identity: SellerIdentity;
  database: string;
};

type AesKey = Awaited<ReturnType<typeof crypto.subtle.importKey>>;

async function importKey(raw: Uint8Array): Promise<AesKey> {
  if (raw.byteLength !== 32) {
    throw new Error('backup key must be 32 bytes');
  }
  return crypto.subtle.importKey('raw', raw, { name: ALG }, false, ['encrypt', 'decrypt']);
}

async function encryptBackup(key: AesKey, plaintext: Uint8Array): Promise<Uint8Array> {
  const nonce = crypto.getRandomValues(new Uint8Array(NONCE_BYTES));
  const sealed = new Uint8Array(await crypto.subtle.encrypt({ name: ALG, iv: nonce }, key, plaintext));
  const out = new Uint8Array(MAGIC.length + nonce.length + sealed.length);
  out.set(MAGIC, 0);
  out.set(nonce, MAGIC.length);
  out.set(sealed, MAGIC.length + nonce.length);
  return out;
}

async function decryptBackup(key: AesKey, ciphertext: Uint8Array): Promise<Uint8Array> {
  if (ciphertext.byteLength < MAGIC.length + NONCE_BYTES + 16) {
    throw new Error('backup ciphertext too short');
  }
  for (let i = 0; i < MAGIC.length; i += 1) {
    if (ciphertext[i] !== MAGIC[i]) {
      throw new Error('unknown backup format');
    }
  }
  const nonce = ciphertext.subarray(MAGIC.length, MAGIC.length + NONCE_BYTES);
  const sealed = ciphertext.subarray(MAGIC.length + NONCE_BYTES);
  return new Uint8Array(await crypto.subtle.decrypt({ name: ALG, iv: nonce }, key, sealed));
}

function checkpoint(dbPath: string): void {
  const db = new DatabaseSync(dbPath);
  try {
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  } finally {
    db.close();
  }
}

export async function exportSellerBackup(input: {
  dbPath: string;
  sellerKeyId: string;
  key: Uint8Array;
}): Promise<Uint8Array> {
  checkpoint(input.dbPath);
  const identity = loadOrCreateSellerIdentity(input.dbPath);
  const database = readFileSync(input.dbPath).toString('base64');
  const payload: BackupPlaintext = {
    version: SELLER_BACKUP_VERSION,
    kind: SELLER_BACKUP_KIND,
    sellerKeyId: input.sellerKeyId,
    spendingKeysPresent: false,
    identity,
    database,
  };
  const key = await importKey(input.key);
  return encryptBackup(key, new TextEncoder().encode(JSON.stringify(payload)));
}

export async function restoreSellerBackup(input: {
  encrypted: Uint8Array;
  key: Uint8Array;
  destDbPath: string;
}): Promise<SellerBackupMeta> {
  const key = await importKey(input.key);
  const plain = await decryptBackup(key, input.encrypted);
  const parsed = JSON.parse(new TextDecoder().decode(plain)) as BackupPlaintext;
  if (parsed.kind !== SELLER_BACKUP_KIND || parsed.version !== SELLER_BACKUP_VERSION) {
    throw new Error('unsupported seller backup');
  }
  if (parsed.spendingKeysPresent !== false) {
    throw new Error('backup must not include spending keys');
  }
  mkdirSync(dirname(input.destDbPath), { recursive: true });
  writeFileSync(input.destDbPath, Buffer.from(parsed.database, 'base64'));
  writeSellerIdentity(input.destDbPath, parsed.identity);
  return {
    sellerKeyId: parsed.sellerKeyId,
    spendingKeysPresent: false,
    identityPublicKeyHex: parsed.identity.publicKeyHex,
  };
}

export function sellerIdentityExists(dbPath: string): boolean {
  return existsSync(identityPath(dbPath));
}

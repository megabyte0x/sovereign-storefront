import { getPublicKey } from '@waku/message-encryption';
import { bytesToHex, hexToBytes } from '@waku/utils/bytes';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, posix, resolve, sep } from 'node:path';
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

// ---------------------------------------------------------------------------
// Version 2: coordinated seller + scanner archive.
//
// The archive reuses the v1 SSBK envelope (MAGIC || nonce || AES-256-GCM) and
// seals a single JSON document `{ manifest, files }`, where `files` maps each
// manifest relPath to the base64 plaintext bytes of that entry. Scanner files
// are copied as opaque bytes: this module never opens `wallet.sqlite` or
// `scanner.sqlite` with SQL. The scanner must be stopped (their WAL files
// absent or empty); the seller DB is checkpointed with wal_checkpoint(TRUNCATE).
// ---------------------------------------------------------------------------

export const COORDINATED_BACKUP_KIND = 'sovereign-storefront-coordinated-backup';
export const COORDINATED_BACKUP_VERSION = 2 as const;

export type CoordinatedBackupEntry = {
  role: 'seller-db' | 'seller-identity' | 'scanner-config' | 'scanner-wallet-db' | 'scanner-app-db';
  relPath: string;
  sha256: string;
  size: number;
};

export type CoordinatedBackupManifest = {
  kind: 'sovereign-storefront-coordinated-backup';
  version: 2;
  createdAt: string;
  sellerIdentityPublicKeyHex: string;
  scanner: { accountId: string; sourceId: string; network: 'regtest' | 'test' };
  reservedHighWater: string;
  entries: CoordinatedBackupEntry[];
};

type CoordinatedPlaintext = {
  manifest: CoordinatedBackupManifest;
  files: Record<string, string>;
};

export type BackupDescription =
  | { version: 1; kind: typeof SELLER_BACKUP_KIND; complete: false; limitations: string[] }
  | { version: 2; kind: typeof COORDINATED_BACKUP_KIND; complete: true; limitations: string[]; manifest: CoordinatedBackupManifest };

const V1_LIMITATIONS = [
  'seller-only archive: lacks scanner allocation state and reserved-address high-water mark',
  'lacks scanner config (UFVK/birthday) and wallet state; restoring it live can reissue receivers',
  'not a complete live restore; use a version-2 coordinated backup',
];

const ROLES: readonly CoordinatedBackupEntry['role'][] = [
  'seller-db', 'seller-identity', 'scanner-config', 'scanner-wallet-db', 'scanner-app-db',
];
const WALLET_DB = 'wallet.sqlite';
const SCANNER_APP_DB = 'scanner.sqlite';
const SELLER_PREFIX = 'seller';
const SCANNER_PREFIX = 'scanner';
const SAFE_NAME = /^[A-Za-z0-9._-]+$/;
const HEX64 = /^[0-9a-f]{64}$/;
const SPENDING_TEXT_MARKERS = [/secret-extended-key/i, /mnemonic/i, /\bseed\b/i, /spending[_-]?key/i, /\bextsk\b/i];
const SPENDING_KEY_NAMES = /seed|mnemonic|spending|extsk|secret|xsk|privatekey|private_key/i;

function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function currentUid(): number | undefined {
  return typeof process.getuid === 'function' ? process.getuid() : undefined;
}

/** Reads a 32-byte key (64 hex chars, or 32 raw bytes) from an owner-only regular file. */
export function readBackupKeyFile(path: string): Uint8Array {
  let stat;
  try {
    stat = statSync(path);
  } catch {
    throw new Error('unreadable backup key file');
  }
  if (!stat.isFile()) throw new Error('backup key file must be a regular file');
  if ((stat.mode & 0o077) !== 0) throw new Error('backup key file must be owner-only (permission 0600)');
  const uid = currentUid();
  if (uid !== undefined && stat.uid !== uid) throw new Error('backup key file must be owned by the current uid');
  const raw = readFileSync(path);
  const text = raw.toString('latin1').trim();
  if (/^[0-9a-fA-F]+$/.test(text)) {
    if (text.length !== 64) throw new Error('backup key must be 32 bytes');
    return Uint8Array.from(Buffer.from(text, 'hex'));
  }
  if (raw.byteLength !== 32) throw new Error('backup key must be 32 bytes');
  return new Uint8Array(raw);
}

function assertSafeName(name: string, what: string): void {
  if (!SAFE_NAME.test(name) || name === '.' || name === '..') {
    throw new Error(`invalid ${what} file name`);
  }
}

function nonEmptyFile(path: string): boolean {
  try {
    return statSync(path).size > 0;
  } catch {
    return false;
  }
}

function checkpointTruncate(dbPath: string): void {
  const db = new DatabaseSync(dbPath);
  try {
    const row = db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get() as { busy?: number } | undefined;
    if (row !== undefined && row.busy !== 0) throw new Error('seller database checkpoint was blocked');
  } finally {
    db.close();
  }
  if (nonEmptyFile(`${dbPath}-wal`)) throw new Error('seller database WAL is not empty after checkpoint');
}

function assertNoSpendingMaterial(value: unknown, path = ''): void {
  if (typeof value === 'string') {
    for (const marker of SPENDING_TEXT_MARKERS) {
      if (marker.test(value)) throw new Error(`scanner config contains spending material at ${path || '<root>'}`);
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoSpendingMaterial(item, `${path}[${index}]`));
    return;
  }
  if (value !== null && typeof value === 'object') {
    for (const [key, inner] of Object.entries(value)) {
      if (SPENDING_KEY_NAMES.test(key)) throw new Error(`scanner config contains spending material key ${path}.${key}`);
      assertNoSpendingMaterial(inner, `${path}.${key}`);
    }
  }
}

function validateSellerIdentity(bytes: Uint8Array): SellerIdentity {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new Error('malformed seller identity');
  }
  const identity = parsed as SellerIdentity;
  if (typeof identity?.privateKeyHex !== 'string' || typeof identity?.publicKeyHex !== 'string') {
    throw new Error('malformed seller identity');
  }
  if (bytesToHex(getPublicKey(hexToBytes(identity.privateKeyHex))) !== identity.publicKeyHex) {
    throw new Error('seller identity mismatch: public key does not match its private key');
  }
  return identity;
}

function scannerStateDirName(configName: string): string {
  return `.${configName}.live-state`;
}

function expectedLayout(sellerDbName: string, configName: string): Record<CoordinatedBackupEntry['role'], string> {
  const state = scannerStateDirName(configName);
  return {
    'seller-db': posix.join(SELLER_PREFIX, sellerDbName),
    'seller-identity': posix.join(SELLER_PREFIX, basename(identityPath(sellerDbName))),
    'scanner-config': posix.join(SCANNER_PREFIX, configName),
    'scanner-wallet-db': posix.join(SCANNER_PREFIX, state, WALLET_DB),
    'scanner-app-db': posix.join(SCANNER_PREFIX, state, SCANNER_APP_DB),
  };
}

function validateScannerInfo(info: { accountId: unknown; sourceId: unknown; network: unknown }): void {
  if (typeof info.accountId !== 'string' || !/^(\d+|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/.test(info.accountId)) throw new Error('invalid scanner accountId');
  if (typeof info.sourceId !== 'string' || info.sourceId.length === 0) throw new Error('invalid scanner sourceId');
  if (info.network !== 'regtest' && info.network !== 'test') throw new Error('invalid scanner network');
}

export async function exportCoordinatedBackup(input: {
  sellerDbPath: string;
  scannerConfigPath: string;
  scannerStateDir: string;
  backupKeyFile: string;
  outPath: string;
  scannerInfo: { accountId: string; sourceId: string; network: 'regtest' | 'test'; reservedHighWater: string };
  assertStopped: () => Promise<void>;
}): Promise<CoordinatedBackupManifest> {
  // Nothing (not even a WAL checkpoint) happens before the caller proves both services are stopped.
  await input.assertStopped();

  const rawKey = readBackupKeyFile(input.backupKeyFile);
  if (existsSync(input.outPath)) throw new Error('backup archive already exists; refusing to overwrite');
  validateScannerInfo(input.scannerInfo);
  if (!/^\d+$/.test(input.scannerInfo.reservedHighWater)) throw new Error('invalid reservedHighWater');

  const sellerDbName = basename(input.sellerDbPath);
  const configName = basename(input.scannerConfigPath);
  assertSafeName(sellerDbName, 'seller database');
  assertSafeName(configName, 'scanner config');
  if (basename(input.scannerStateDir) !== scannerStateDirName(configName)) {
    throw new Error('scanner state dir does not belong to the scanner config');
  }

  // The seller cannot checkpoint scanner-owned SQLite files; a stopped scanner leaves no WAL frames.
  for (const db of [WALLET_DB, SCANNER_APP_DB]) {
    for (const suffix of ['-wal', '-journal']) {
      if (nonEmptyFile(join(input.scannerStateDir, `${db}${suffix}`))) {
        throw new Error(`scanner is not stopped: ${db}${suffix} is not empty`);
      }
    }
  }

  const configBytes = readFileSync(input.scannerConfigPath);
  let config: unknown;
  try {
    config = JSON.parse(configBytes.toString('utf8'));
  } catch {
    throw new Error('scanner config is not valid JSON');
  }
  assertNoSpendingMaterial(config);
  const configSourceId = (config as { runtime?: { sourceId?: unknown } } | null)?.runtime?.sourceId;
  if (configSourceId !== undefined && configSourceId !== input.scannerInfo.sourceId) {
    throw new Error('scanner sourceId does not match the scanner config');
  }

  const identityFile = identityPath(input.sellerDbPath);
  if (!existsSync(identityFile)) throw new Error('seller identity is missing');
  const identityBytes = readFileSync(identityFile);
  const identity = validateSellerIdentity(identityBytes);

  checkpointTruncate(input.sellerDbPath);
  const sellerDbBytes = readFileSync(input.sellerDbPath);
  const walletBytes = readFileSync(join(input.scannerStateDir, WALLET_DB));
  const appBytes = readFileSync(join(input.scannerStateDir, SCANNER_APP_DB));

  const layout = expectedLayout(sellerDbName, configName);
  const contents: Record<CoordinatedBackupEntry['role'], Uint8Array> = {
    'seller-db': sellerDbBytes,
    'seller-identity': identityBytes,
    'scanner-config': configBytes,
    'scanner-wallet-db': walletBytes,
    'scanner-app-db': appBytes,
  };
  const files: Record<string, string> = {};
  const entries: CoordinatedBackupEntry[] = ROLES.map(role => {
    const bytes = contents[role];
    files[layout[role]] = Buffer.from(bytes).toString('base64');
    return { role, relPath: layout[role], sha256: sha256Hex(bytes), size: bytes.byteLength };
  });
  const manifest: CoordinatedBackupManifest = {
    kind: COORDINATED_BACKUP_KIND,
    version: COORDINATED_BACKUP_VERSION,
    createdAt: new Date().toISOString(),
    sellerIdentityPublicKeyHex: identity.publicKeyHex,
    scanner: {
      accountId: input.scannerInfo.accountId,
      sourceId: input.scannerInfo.sourceId,
      network: input.scannerInfo.network,
    },
    reservedHighWater: input.scannerInfo.reservedHighWater,
    entries,
  };
  const payload: CoordinatedPlaintext = { manifest, files };
  const sealed = await encryptBackup(await importKey(rawKey), new TextEncoder().encode(JSON.stringify(payload)));

  mkdirSync(dirname(input.outPath), { recursive: true, mode: 0o700 });
  writeFileSync(input.outPath, sealed, { mode: 0o600, flag: 'wx' });
  chmodSync(input.outPath, 0o600);
  return manifest;
}

function assertSafeRelPath(relPath: unknown): asserts relPath is string {
  if (typeof relPath !== 'string' || relPath.length === 0) throw new Error('invalid manifest relPath');
  if (relPath.startsWith('/') || relPath.includes('\\') || /^[A-Za-z]:/.test(relPath)) {
    throw new Error('invalid manifest relPath: absolute path');
  }
  const segments = relPath.split('/');
  if (segments.some(segment => segment === '' || segment === '.' || segment === '..')) {
    throw new Error('invalid manifest relPath: traversal or non-normalized path');
  }
  if (posix.normalize(relPath) !== relPath) throw new Error('invalid manifest relPath: not normalized');
}

function decodeCoordinated(parsed: unknown): { manifest: CoordinatedBackupManifest; bytes: Map<CoordinatedBackupEntry['role'], Uint8Array> } {
  const payload = parsed as Partial<CoordinatedPlaintext> | null;
  const manifest = payload?.manifest as CoordinatedBackupManifest | undefined;
  if (manifest?.kind !== COORDINATED_BACKUP_KIND || manifest.version !== COORDINATED_BACKUP_VERSION) {
    throw new Error('unsupported coordinated backup');
  }
  if (typeof payload?.files !== 'object' || payload.files === null || !Array.isArray(manifest.entries)) {
    throw new Error('malformed coordinated backup');
  }
  validateScannerInfo(manifest.scanner ?? ({} as never));
  if (typeof manifest.reservedHighWater !== 'string' || !/^\d+$/.test(manifest.reservedHighWater)) {
    throw new Error('invalid reservedHighWater');
  }
  if (typeof manifest.sellerIdentityPublicKeyHex !== 'string') throw new Error('invalid seller identity in manifest');

  const seenPaths = new Set<string>();
  const byRole = new Map<CoordinatedBackupEntry['role'], CoordinatedBackupEntry>();
  for (const entry of manifest.entries) {
    assertSafeRelPath(entry?.relPath);
    if (seenPaths.has(entry.relPath)) throw new Error(`duplicate manifest relPath ${entry.relPath}`);
    seenPaths.add(entry.relPath);
    if (!ROLES.includes(entry.role)) throw new Error('unknown manifest role');
    if (byRole.has(entry.role)) throw new Error(`duplicate manifest role ${entry.role}`);
    byRole.set(entry.role, entry);
  }
  if (byRole.size !== ROLES.length) throw new Error('coordinated backup is missing entries');
  const sellerDbName = byRole.get('seller-db')!.relPath.split('/').pop()!;
  const configName = byRole.get('scanner-config')!.relPath.split('/').pop()!;
  assertSafeName(sellerDbName, 'seller database');
  assertSafeName(configName, 'scanner config');
  const layout = expectedLayout(sellerDbName, configName);
  for (const role of ROLES) {
    if (byRole.get(role)!.relPath !== layout[role]) throw new Error(`invalid manifest relPath for ${role}`);
  }
  const fileKeys = Object.keys(payload.files);
  if (fileKeys.length !== ROLES.length || fileKeys.some(key => !seenPaths.has(key))) {
    throw new Error('coordinated backup files do not match the manifest');
  }

  const bytes = new Map<CoordinatedBackupEntry['role'], Uint8Array>();
  for (const role of ROLES) {
    const entry = byRole.get(role)!;
    const encoded = payload.files[entry.relPath];
    if (typeof encoded !== 'string') throw new Error(`missing bytes for ${role}`);
    const data = Uint8Array.from(Buffer.from(encoded, 'base64'));
    if (data.byteLength !== entry.size) throw new Error(`size mismatch for ${role}`);
    if (typeof entry.sha256 !== 'string' || !HEX64.test(entry.sha256) || sha256Hex(data) !== entry.sha256) {
      throw new Error(`checksum mismatch for ${role}`);
    }
    bytes.set(role, data);
  }
  const identity = validateSellerIdentity(bytes.get('seller-identity')!);
  if (identity.publicKeyHex !== manifest.sellerIdentityPublicKeyHex) {
    throw new Error('seller identity does not match the manifest');
  }
  let config: unknown;
  try {
    config = JSON.parse(new TextDecoder().decode(bytes.get('scanner-config')!));
  } catch {
    throw new Error('scanner config is not valid JSON');
  }
  assertNoSpendingMaterial(config);
  return { manifest, bytes };
}

async function openAnyBackup(encrypted: Uint8Array, rawKey: Uint8Array): Promise<unknown> {
  const plain = await decryptBackup(await importKey(rawKey), encrypted);
  try {
    return JSON.parse(new TextDecoder().decode(plain));
  } catch {
    throw new Error('malformed backup');
  }
}

function isV1(parsed: unknown): boolean {
  const value = parsed as { kind?: unknown; version?: unknown } | null;
  return value?.kind === SELLER_BACKUP_KIND && value.version === SELLER_BACKUP_VERSION;
}

/** Classifies a decrypted archive. v1 seller-only archives are never a complete live restore. */
export async function describeBackup(input: { encrypted: Uint8Array; key: Uint8Array }): Promise<BackupDescription> {
  const parsed = await openAnyBackup(input.encrypted, input.key);
  if (isV1(parsed)) {
    return { version: 1, kind: SELLER_BACKUP_KIND, complete: false, limitations: [...V1_LIMITATIONS] };
  }
  const { manifest } = decodeCoordinated(parsed);
  return { version: 2, kind: COORDINATED_BACKUP_KIND, complete: true, limitations: [], manifest };
}

function assertFreshTarget(dir: string): void {
  let stat;
  try {
    stat = lstatSync(dir);
  } catch {
    return;
  }
  if (!stat.isDirectory()) throw new Error(`restore target ${dir} is not a directory`);
  if (readdirSync(dir).length > 0) throw new Error(`restore target ${dir} is not empty; refusing to overwrite`);
}

function isWithin(parent: string, child: string): boolean {
  return child === parent || child.startsWith(parent.endsWith(sep) ? parent : parent + sep);
}

function makePrivateDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
}

export async function restoreCoordinatedBackup(input: {
  archivePath: string;
  backupKeyFile: string;
  sellerDir: string;
  scannerDir: string;
  expect?: { accountId?: string; network?: 'regtest' | 'test'; sellerIdentityPublicKeyHex?: string };
}): Promise<CoordinatedBackupManifest> {
  const rawKey = readBackupKeyFile(input.backupKeyFile);
  const parsed = await openAnyBackup(readFileSync(input.archivePath), rawKey);
  if (isV1(parsed)) {
    throw new Error('not a complete coordinated backup: v1 seller-only archive lacks scanner allocation state');
  }
  const { manifest, bytes } = decodeCoordinated(parsed);
  const expected = input.expect ?? {};
  if (expected.accountId !== undefined && expected.accountId !== manifest.scanner.accountId) {
    throw new Error('backup scanner account does not match the expected account');
  }
  if (expected.network !== undefined && expected.network !== manifest.scanner.network) {
    throw new Error('backup scanner network does not match the expected network');
  }
  if (expected.sellerIdentityPublicKeyHex !== undefined
    && expected.sellerIdentityPublicKeyHex !== manifest.sellerIdentityPublicKeyHex) {
    throw new Error('backup seller identity does not match the expected identity');
  }

  const sellerDir = resolve(input.sellerDir);
  const scannerDir = resolve(input.scannerDir);
  if (isWithin(sellerDir, scannerDir) || isWithin(scannerDir, sellerDir)) {
    throw new Error('seller and scanner restore targets must be separate directories');
  }
  assertFreshTarget(sellerDir);
  assertFreshTarget(scannerDir);

  // All validation is complete; only now touch the filesystem.
  const entries = new Map(manifest.entries.map(entry => [entry.role, entry]));
  for (const role of ROLES) {
    const relPath = entries.get(role)!.relPath;
    const [prefix, ...rest] = relPath.split('/');
    const root = prefix === SELLER_PREFIX ? sellerDir : scannerDir;
    let dir = root;
    makePrivateDir(dir);
    for (const segment of rest.slice(0, -1)) {
      dir = join(dir, segment);
      makePrivateDir(dir);
    }
    const target = join(root, ...rest);
    if (!isWithin(root, target)) throw new Error('invalid manifest relPath: escapes restore target');
    writeFileSync(target, bytes.get(role)!, { mode: 0o600, flag: 'wx' });
    chmodSync(target, 0o600);
  }
  return manifest;
}

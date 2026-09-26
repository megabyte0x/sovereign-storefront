import { createHash, randomBytes } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, test } from 'vitest';
import {
  COORDINATED_BACKUP_VERSION,
  describeBackup,
  exportCoordinatedBackup,
  exportSellerBackup,
  restoreCoordinatedBackup,
  type CoordinatedBackupManifest,
} from '../../src/seller/backup.ts';
import { loadOrCreateSellerIdentity } from '../../src/seller/identity.ts';

const SPENDING_MARKERS = [/secret-extended-key/i, /mnemonic/i, /\bseed\b/i];

let roots: string[] = [];
afterEach(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  roots = [];
});

type Fixture = {
  root: string;
  sellerDbPath: string;
  scannerConfigPath: string;
  scannerStateDir: string;
  backupKeyFile: string;
  key: Buffer;
  identityPublicKeyHex: string;
  outPath: string;
  scannerInfo: { accountId: string; sourceId: string; network: 'regtest' | 'test'; reservedHighWater: string };
  sellerDb: DatabaseSync;
};

function writeKeyFile(path: string, key: Buffer, mode = 0o600): void {
  writeFileSync(path, key.toString('hex') + '\n', { mode });
  chmodSync(path, mode);
}

function fixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), 'ssf-live-backup-'));
  roots.push(root);
  const sellerDir = join(root, 'seller');
  mkdirSync(sellerDir, { mode: 0o700 });
  const sellerDbPath = join(sellerDir, 'seller.sqlite');
  // Keep one connection open so the WAL survives until export checkpoints it.
  const sellerDb = new DatabaseSync(sellerDbPath);
  sellerDb.exec('PRAGMA journal_mode=WAL');
  sellerDb.exec('CREATE TABLE marker (v TEXT)');
  sellerDb.exec("INSERT INTO marker VALUES ('seller-row-1')");
  const identity = loadOrCreateSellerIdentity(sellerDbPath);

  const scannerDir = join(root, 'scanner');
  mkdirSync(scannerDir, { mode: 0o700 });
  const scannerConfigPath = join(scannerDir, 'scanner.json');
  writeFileSync(scannerConfigPath, JSON.stringify({
    ufvk: 'uviewregtest1fixtureonlyfullviewingkey',
    birthday: 1,
    runtime: { sourceId: 'src-1', chain: { network: 'regtest' }, lightwalletd: 'http://127.0.0.1:9067', activations: {} },
  }), { mode: 0o600 });
  const scannerStateDir = join(scannerDir, '.scanner.json.live-state');
  mkdirSync(scannerStateDir, { mode: 0o700 });
  writeFileSync(join(scannerStateDir, 'wallet.sqlite'), Buffer.from('wallet-opaque-bytes'), { mode: 0o600 });
  writeFileSync(join(scannerStateDir, 'scanner.sqlite'), Buffer.from('scanner-opaque-bytes'), { mode: 0o600 });
  writeFileSync(join(scannerStateDir, 'wallet.sqlite-wal'), Buffer.alloc(0), { mode: 0o600 });

  const key = randomBytes(32);
  const backupKeyFile = join(root, 'backup.key');
  writeKeyFile(backupKeyFile, key);
  return {
    root,
    sellerDbPath,
    scannerConfigPath,
    scannerStateDir,
    backupKeyFile,
    key,
    identityPublicKeyHex: identity.publicKeyHex,
    outPath: join(root, 'out', 'backup.ssbk'),
    scannerInfo: { accountId: '0', sourceId: 'src-1', network: 'regtest', reservedHighWater: '7' },
    sellerDb,
  };
}

async function exportFixture(f: Fixture): Promise<CoordinatedBackupManifest> {
  return exportCoordinatedBackup({
    sellerDbPath: f.sellerDbPath,
    scannerConfigPath: f.scannerConfigPath,
    scannerStateDir: f.scannerStateDir,
    backupKeyFile: f.backupKeyFile,
    outPath: f.outPath,
    scannerInfo: f.scannerInfo,
    assertStopped: async () => {},
  });
}

// Test-side reimplementation of the documented SSBK envelope (MAGIC || nonce || AES-GCM),
// used only to craft malicious-but-authentic archives.
const MAGIC = Buffer.from('SSBK');
async function openArchive(bytes: Buffer, key: Buffer): Promise<{ manifest: CoordinatedBackupManifest; files: Record<string, string> }> {
  const k = await crypto.subtle.importKey('raw', key, { name: 'AES-GCM' }, false, ['decrypt']);
  const nonce = bytes.subarray(4, 16);
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: nonce }, k, bytes.subarray(16));
  return JSON.parse(Buffer.from(plain).toString('utf8'));
}
async function sealArchive(payload: unknown, key: Buffer): Promise<Buffer> {
  const k = await crypto.subtle.importKey('raw', key, { name: 'AES-GCM' }, false, ['encrypt']);
  const nonce = randomBytes(12);
  const sealed = Buffer.from(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, k, Buffer.from(JSON.stringify(payload))));
  return Buffer.concat([MAGIC, nonce, sealed]);
}

function restoreTargets(f: Fixture): { sellerDir: string; scannerDir: string } {
  return { sellerDir: join(f.root, 'restored', 'seller'), scannerDir: join(f.root, 'restored', 'scanner') };
}

describe('coordinated v2 backup', () => {
  test('fixture files carry no spending-key material', () => {
    const f = fixture();
    const files = [
      f.scannerConfigPath,
      join(f.scannerStateDir, 'wallet.sqlite'),
      join(f.scannerStateDir, 'scanner.sqlite'),
      join(f.root, 'seller', 'seller-identity.json'),
    ];
    for (const file of files) {
      const text = readFileSync(file).toString('latin1');
      for (const marker of SPENDING_MARKERS) expect(text).not.toMatch(marker);
    }
    f.sellerDb.close();
  });

  test('v1 seller-only archive is described as incomplete for live restore and refused by coordinated restore', async () => {
    const f = fixture();
    const encrypted = await exportSellerBackup({ dbPath: f.sellerDbPath, sellerKeyId: 'seller-key-1', key: f.key });
    f.sellerDb.close();
    const described = await describeBackup({ encrypted, key: f.key });
    expect(described.version).toBe(1);
    expect(described.complete).toBe(false);
    expect(described.limitations.join(' ')).toMatch(/allocation/);
    const archivePath = join(f.root, 'v1.ssbk');
    writeFileSync(archivePath, encrypted, { mode: 0o600 });
    await expect(restoreCoordinatedBackup({ archivePath, backupKeyFile: f.backupKeyFile, ...restoreTargets(f) }))
      .rejects.toThrow(/not a complete coordinated backup/);
  });

  test('export -> restore preserves identity, bytes and permissions; describe says complete', async () => {
    const f = fixture();
    const walBefore = statSync(`${f.sellerDbPath}-wal`).size;
    expect(walBefore).toBeGreaterThan(0);
    const manifest = await exportFixture(f);
    // WAL checkpointed (TRUNCATE) before snapshot.
    expect(statSync(`${f.sellerDbPath}-wal`).size).toBe(0);
    f.sellerDb.close();

    expect(manifest.kind).toBe('sovereign-storefront-coordinated-backup');
    expect(manifest.version).toBe(COORDINATED_BACKUP_VERSION);
    expect(manifest.sellerIdentityPublicKeyHex).toBe(f.identityPublicKeyHex);
    expect(manifest.reservedHighWater).toBe('7');
    expect(manifest.scanner).toEqual({ accountId: '0', sourceId: 'src-1', network: 'regtest' });
    expect(manifest.entries.map(e => e.role).sort()).toEqual(
      ['scanner-app-db', 'scanner-config', 'scanner-wallet-db', 'seller-db', 'seller-identity'],
    );
    expect(statSync(f.outPath).mode & 0o777).toBe(0o600);

    const archive = readFileSync(f.outPath);
    expect(archive.toString('latin1')).not.toContain('uviewregtest1');
    const described = await describeBackup({ encrypted: archive, key: f.key });
    expect(described).toMatchObject({ version: 2, complete: true });

    // Archive plaintext has no spending-key markers.
    const opened = await openArchive(archive, f.key);
    const plaintext = JSON.stringify(opened.manifest) + Object.values(opened.files)
      .map(b64 => Buffer.from(b64, 'base64').toString('latin1')).join('');
    for (const marker of SPENDING_MARKERS) expect(plaintext).not.toMatch(marker);

    const targets = restoreTargets(f);
    const restored = await restoreCoordinatedBackup({
      archivePath: f.outPath,
      backupKeyFile: f.backupKeyFile,
      ...targets,
      expect: { accountId: '0', network: 'regtest', sellerIdentityPublicKeyHex: f.identityPublicKeyHex },
    });
    expect(restored.sellerIdentityPublicKeyHex).toBe(f.identityPublicKeyHex);
    const restoredDb = join(targets.sellerDir, 'seller.sqlite');
    expect(loadOrCreateSellerIdentity(restoredDb).publicKeyHex).toBe(f.identityPublicKeyHex);
    const db = new DatabaseSync(restoredDb);
    expect(db.prepare('SELECT v FROM marker').all()).toEqual([{ v: 'seller-row-1' }]);
    db.close();
    const restoredState = join(targets.scannerDir, '.scanner.json.live-state');
    expect(readFileSync(join(restoredState, 'wallet.sqlite'), 'utf8')).toBe('wallet-opaque-bytes');
    expect(readFileSync(join(restoredState, 'scanner.sqlite'), 'utf8')).toBe('scanner-opaque-bytes');
    expect(readFileSync(join(targets.scannerDir, 'scanner.json'))).toEqual(readFileSync(f.scannerConfigPath));
    for (const dir of [targets.sellerDir, targets.scannerDir, restoredState]) {
      expect(statSync(dir).mode & 0o777).toBe(0o700);
    }
    for (const file of [
      join(targets.sellerDir, 'seller.sqlite'),
      join(targets.sellerDir, 'seller-identity.json'),
      join(targets.scannerDir, 'scanner.json'),
      join(restoredState, 'wallet.sqlite'),
      join(restoredState, 'scanner.sqlite'),
    ]) {
      expect(statSync(file).mode & 0o777).toBe(0o600);
    }
  });

  test('assertStopped rejection aborts export before any file is written', async () => {
    const f = fixture();
    const walBefore = statSync(`${f.sellerDbPath}-wal`).size;
    await expect(exportCoordinatedBackup({
      sellerDbPath: f.sellerDbPath,
      scannerConfigPath: f.scannerConfigPath,
      scannerStateDir: f.scannerStateDir,
      backupKeyFile: f.backupKeyFile,
      outPath: f.outPath,
      scannerInfo: f.scannerInfo,
      assertStopped: async () => { throw new Error('seller still running'); },
    })).rejects.toThrow(/seller still running/);
    expect(existsSync(f.outPath)).toBe(false);
    expect(existsSync(join(f.root, 'out'))).toBe(false);
    expect(statSync(`${f.sellerDbPath}-wal`).size).toBe(walBefore);
    f.sellerDb.close();
  });

  test('non-empty scanner WAL (scanner not stopped) aborts export', async () => {
    const f = fixture();
    f.sellerDb.close();
    writeFileSync(join(f.scannerStateDir, 'scanner.sqlite-wal'), Buffer.from('pending-frames'));
    await expect(exportFixture(f)).rejects.toThrow(/scanner\.sqlite-wal/);
    expect(existsSync(f.outPath)).toBe(false);
  });

  test('scanner config with spending material is refused', async () => {
    const f = fixture();
    f.sellerDb.close();
    writeFileSync(f.scannerConfigPath, JSON.stringify({ ufvk: 'uview1x', birthday: 1, mnemonic: 'abandon abandon' }));
    await expect(exportFixture(f)).rejects.toThrow(/spending/);
    expect(existsSync(f.outPath)).toBe(false);
  });

  test('backup key file must be protected and 32 bytes', async () => {
    const f = fixture();
    f.sellerDb.close();
    chmodSync(f.backupKeyFile, 0o644);
    await expect(exportFixture(f)).rejects.toThrow(/backup key file/);
    writeKeyFile(f.backupKeyFile, randomBytes(16));
    await expect(exportFixture(f)).rejects.toThrow(/backup key/);
    expect(existsSync(f.outPath)).toBe(false);
  });

  test('export refuses to overwrite an existing archive', async () => {
    const f = fixture();
    f.sellerDb.close();
    mkdirSync(join(f.root, 'out'));
    writeFileSync(f.outPath, 'existing');
    await expect(exportFixture(f)).rejects.toThrow(/exists/);
    expect(readFileSync(f.outPath, 'utf8')).toBe('existing');
  });

  test('corrupted archive, wrong key, wrong account, wrong network and wrong identity are rejected', async () => {
    const f = fixture();
    await exportFixture(f);
    f.sellerDb.close();
    const archive = readFileSync(f.outPath);
    const targets = restoreTargets(f);

    const corrupted = Buffer.from(archive);
    corrupted[corrupted.length - 5] ^= 0xff;
    const corruptPath = join(f.root, 'corrupt.ssbk');
    writeFileSync(corruptPath, corrupted);
    await expect(restoreCoordinatedBackup({ archivePath: corruptPath, backupKeyFile: f.backupKeyFile, ...targets }))
      .rejects.toThrow();

    const wrongKeyFile = join(f.root, 'wrong.key');
    writeKeyFile(wrongKeyFile, randomBytes(32));
    await expect(restoreCoordinatedBackup({ archivePath: f.outPath, backupKeyFile: wrongKeyFile, ...targets }))
      .rejects.toThrow();

    await expect(restoreCoordinatedBackup({
      archivePath: f.outPath, backupKeyFile: f.backupKeyFile, ...targets, expect: { accountId: '1' },
    })).rejects.toThrow(/account/);
    await expect(restoreCoordinatedBackup({
      archivePath: f.outPath, backupKeyFile: f.backupKeyFile, ...targets, expect: { network: 'test' },
    })).rejects.toThrow(/network/);
    await expect(restoreCoordinatedBackup({
      archivePath: f.outPath, backupKeyFile: f.backupKeyFile, ...targets, expect: { sellerIdentityPublicKeyHex: '04ab' },
    })).rejects.toThrow(/identity/);

    // Nothing was written by any failed restore.
    expect(existsSync(join(f.root, 'restored'))).toBe(false);
  });

  test('tampered entry bytes fail the checksum', async () => {
    const f = fixture();
    await exportFixture(f);
    f.sellerDb.close();
    const opened = await openArchive(readFileSync(f.outPath), f.key);
    const walletEntry = opened.manifest.entries.find(e => e.role === 'scanner-wallet-db')!;
    opened.files[walletEntry.relPath] = Buffer.from('tampered').toString('base64');
    const path = join(f.root, 'tampered.ssbk');
    writeFileSync(path, await sealArchive(opened, f.key));
    await expect(restoreCoordinatedBackup({ archivePath: path, backupKeyFile: f.backupKeyFile, ...restoreTargets(f) }))
      .rejects.toThrow(/checksum|size/);
    expect(existsSync(join(f.root, 'restored'))).toBe(false);
  });

  test.each([
    ['dot-dot', (m: CoordinatedBackupManifest) => { m.entries[0]!.relPath = 'seller/../../escape'; }, /relPath/],
    ['absolute', (m: CoordinatedBackupManifest) => { m.entries[0]!.relPath = '/etc/passwd'; }, /relPath/],
    ['duplicate', (m: CoordinatedBackupManifest) => { m.entries[1]!.relPath = m.entries[0]!.relPath; }, /duplicate/],
  ])('manifest entry with %s relPath is rejected', async (_name, mutate, error) => {
    const f = fixture();
    await exportFixture(f);
    f.sellerDb.close();
    const opened = await openArchive(readFileSync(f.outPath), f.key);
    const originalRel = opened.manifest.entries[0]!.relPath;
    mutate(opened.manifest);
    opened.files[opened.manifest.entries[0]!.relPath] = opened.files[originalRel]!;
    const path = join(f.root, 'evil.ssbk');
    writeFileSync(path, await sealArchive(opened, f.key));
    await expect(restoreCoordinatedBackup({ archivePath: path, backupKeyFile: f.backupKeyFile, ...restoreTargets(f) }))
      .rejects.toThrow(error);
    expect(existsSync(join(f.root, 'restored'))).toBe(false);
    expect(existsSync(join(f.root, 'escape'))).toBe(false);
  });

  test('restore refuses a non-empty target directory and does not overwrite', async () => {
    const f = fixture();
    await exportFixture(f);
    f.sellerDb.close();
    const targets = restoreTargets(f);
    mkdirSync(targets.scannerDir, { recursive: true });
    writeFileSync(join(targets.scannerDir, 'scanner.json'), 'keep-me');
    await expect(restoreCoordinatedBackup({ archivePath: f.outPath, backupKeyFile: f.backupKeyFile, ...targets }))
      .rejects.toThrow(/not empty/);
    expect(readFileSync(join(targets.scannerDir, 'scanner.json'), 'utf8')).toBe('keep-me');
    expect(existsSync(targets.sellerDir)).toBe(false);
    expect(readdirSync(targets.scannerDir)).toEqual(['scanner.json']);
  });

  test('manifest checksum matches plaintext entry bytes', async () => {
    const f = fixture();
    const manifest = await exportFixture(f);
    f.sellerDb.close();
    const config = manifest.entries.find(e => e.role === 'scanner-config')!;
    const bytes = readFileSync(f.scannerConfigPath);
    expect(config.sha256).toBe(createHash('sha256').update(bytes).digest('hex'));
    expect(config.size).toBe(bytes.length);
  });

  test('accepts the UUID account id the scanner backup-info reports, rejects other shapes', async () => {
    const uuid = '3f2c9a4e-8b1d-4c7a-9e2f-0a1b2c3d4e5f';
    const f = fixture();
    const manifest = await exportCoordinatedBackup({
      sellerDbPath: f.sellerDbPath, scannerConfigPath: f.scannerConfigPath, scannerStateDir: f.scannerStateDir,
      backupKeyFile: f.backupKeyFile, outPath: f.outPath,
      scannerInfo: { ...f.scannerInfo, accountId: uuid }, assertStopped: async () => {},
    });
    expect(manifest.scanner.accountId).toBe(uuid);
    const g = fixture();
    await expect(exportCoordinatedBackup({
      sellerDbPath: g.sellerDbPath, scannerConfigPath: g.scannerConfigPath, scannerStateDir: g.scannerStateDir,
      backupKeyFile: g.backupKeyFile, outPath: g.outPath,
      scannerInfo: { ...g.scannerInfo, accountId: 'acct/../1' }, assertStopped: async () => {},
    })).rejects.toThrow(/invalid scanner accountId/);
    f.sellerDb.close();
    g.sellerDb.close();
  });
});

describe('runbook: coordinated restore procedure', () => {
  const runbook = readFileSync(join(import.meta.dirname, '../../docs/runbook.md'), 'utf8');
  const restore = runbook.slice(runbook.indexOf('### Restore (into fresh directories)'), runbook.indexOf('## Logging'));

  test('retires the original stack before the restored stack starts, permanently', () => {
    const retire = restore.search(/retire\s+the\s+original/i);
    const ack = restore.indexOf('restore-ack');
    const serve = restore.indexOf('serve --config');
    expect(retire).toBeGreaterThanOrEqual(0);
    expect(retire).toBeLessThan(ack);
    expect(retire).toBeLessThan(serve);
    expect(restore).toMatch(/same\s+viewing\s+key\s+must\s+never\s+allocate/i);
    expect(restore).toMatch(/must\s+not\s+be\s+restarted/i);
  });

  test('restore-ack requires --reserve-gap and the runbook explains the gap', () => {
    expect(restore).toMatch(/restore-ack --config \S+ --new-epoch --reserve-gap \d+/);
    expect(restore).toMatch(/--reserve-gap N/);
    expect(restore).toMatch(/after\s+the\s+backup/i);
    expect(restore).toMatch(/1000/);
    expect(restore).toMatch(/never\s+reissued/i);
  });

  test('backup-info refuses state never opened by a binding-aware scanner', () => {
    expect(runbook).toMatch(/restart\s+scanner\s+once\s+before\s+backup/);
  });
});

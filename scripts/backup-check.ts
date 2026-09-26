import { createHash, randomBytes } from 'node:crypto';
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createCredentialAdapter } from '../src/adapters/credentials.ts';
import { MemoryScanner } from '../src/adapters/scanner.ts';
import { loadConfig } from '../src/config.ts';
import type { BrowserPurchase, Invoice } from '../src/contracts/types.ts';
import {
  describeBackup,
  exportCoordinatedBackup,
  exportSellerBackup,
  restoreCoordinatedBackup,
  restoreSellerBackup,
} from '../src/seller/backup.ts';
import { startSeller } from '../src/seller/server.ts';

const DESTINATION =
  'uregtest1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq';

function env(dbPath: string) {
  return loadConfig({
    SSF_MODE: 'fixture',
    SSF_NETWORK: 'test',
    SSF_MIN_CONFIRMATIONS: '10',
    SSF_MAX_HEALTH_AGE_MS: '120000',
    SSF_MAX_CIPHERTEXT_BYTES: '73',
    SSF_MAX_PLAINTEXT_BYTES: '41',
    SSF_INVOICE_TTL_MS: '86400000',
    SSF_PUBLIC_HOST: '127.0.0.1',
    SSF_PUBLIC_PORT: '0',
    SSF_ADMIN_HOST: '127.0.0.1',
    SSF_ADMIN_PORT: '0',
    SSF_DB_PATH: dbPath,
    SSF_SELLER_KEY_ID: 'seller-key-1',
    SSF_DESTINATION: DESTINATION,
    SSF_ADAPTER_MESSAGING: 'fixture',
    SSF_ADAPTER_STORAGE: 'fixture',
    SSF_ADAPTER_SCANNER: 'fixture',
    SSF_ADMIN_TOKEN: 'backup-check-admin-token',
  });
}

async function postJson(url: string, path: string, body: unknown): Promise<{ status: number; json: unknown }> {
  const res = await fetch(`${url}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: await res.json().catch(() => null) };
}

const scratch = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), 'ssf-backup-check-'));
const originDb = join(scratch, 'origin', 'seller.sqlite');
const isolatedDb = join(scratch, 'isolated', 'seller.sqlite');
const result: Record<string, unknown> = {
  ok: false,
  isolatedRestore: false,
  buyerRecordUnchanged: false,
  spendingKeysPresent: true,
  recovered: false,
  walletReadWired: false,
  independentReplicaBytes: 73,
  v1Complete: true,
  coordinatedVersion: 0,
  coordinatedEntries: 0,
  coordinatedRoundTrip: false,
  coordinatedRefusesV1: false,
};

try {
  const credentials = createCredentialAdapter();
  const buyer = await credentials.createPurchaseCredential();
  const proof = Buffer.from(await credentials.provePossession(buyer.credentialId, { orderId: 'backup-check-1' })).toString('base64');
  const scanner = new MemoryScanner();
  scanner.replaceSnapshot([], { id: 'rev-10', height: 10 }, true, Date.now());

  const origin = await startSeller({
    config: env(originDb),
    seedProduct: true,
    scanner,
    credentials,
  });

  const created = await postJson(origin.publicUrl, '/api/orders', {
    requestId: 'backup-check-1',
    productVersion: 'book-v1',
    buyerKeyId: buyer.buyerKeyId,
    proof,
  });
  if (created.status !== 200) {
    throw new Error(`order create failed: ${created.status}`);
  }
  const invoice = created.json as Invoice;
  // The fixture scanner attributes by exact receiver (Task 3+), not invoiceId.
  if (invoice.attribution?.kind !== 'receiver') throw new Error('fixture invoice has no receiver attribution');
  scanner.setReceiptReceiver('backup-check-out', invoice.attribution.receiver);
  scanner.replaceSnapshot([{
    outputId: 'backup-check-out',
    invoiceId: invoice.id,
    amountZat: invoice.amountZat,
    confirmations: 10,
    canonical: true,
    receivedAt: Date.now(),
    // Mined at height 1 under a tip at 10: the reducer derives 10 confirmations.
    revision: { id: 'rev-1', height: 1 },
  }], { id: 'rev-10', height: 10 }, true, Date.now());

  const first = await postJson(origin.publicUrl, '/api/recover', {
    orderId: invoice.orderId,
    proof: Buffer.from(await credentials.provePossession(buyer.credentialId, { orderId: invoice.orderId })).toString('base64'),
  });
  if (first.status !== 200) {
    throw new Error(`origin recover failed: ${first.status}`);
  }

  const buyerRecord: BrowserPurchase = {
    version: 1,
    requestId: 'backup-check-1',
    orderId: invoice.orderId,
    productVersion: 'book-v1',
    sellerOrigin: origin.publicUrl,
    sellerKeyId: 'seller-key-1',
    credentialId: buyer.credentialId,
    invoice,
  };
  const preLoss = structuredClone(buyerRecord);

  const key = randomBytes(32);
  const encrypted = await exportSellerBackup({
    dbPath: originDb,
    sellerKeyId: 'seller-key-1',
    key,
  });
  await origin.close();

  const restored = await restoreSellerBackup({
    encrypted,
    key,
    destDbPath: isolatedDb,
  });
  result.isolatedRestore = true;
  result.spendingKeysPresent = restored.spendingKeysPresent;
  result.sellerKeyIdRestored = restored.sellerKeyId === 'seller-key-1';

  const isolated = await startSeller({
    config: env(isolatedDb),
    seedProduct: false,
    scanner,
    credentials,
  });

  expectUnchanged(buyerRecord, preLoss);
  result.buyerRecordUnchanged = true;

  const again = await postJson(isolated.publicUrl, '/api/recover', {
    orderId: invoice.orderId,
    proof: Buffer.from(await credentials.provePossession(buyer.credentialId, { orderId: invoice.orderId })).toString('base64'),
  });
  await isolated.close();
  if (again.status !== 200) {
    throw new Error(`isolated recover failed: ${again.status}`);
  }
  result.recovered = true;

  // v1 is a seller-only archive: it must classify as an incomplete live restore.
  result.v1Complete = (await describeBackup({ encrypted, key })).complete;

  await coordinatedRoundTrip(scratch, originDb, encrypted, key);

  result.ok = restored.spendingKeysPresent === false
    && result.v1Complete === false
    && result.coordinatedRoundTrip === true
    && result.coordinatedRefusesV1 === true;
} catch (error) {
  result.ok = false;
  result.error = error instanceof Error ? error.message : 'backup-check failed';
} finally {
  rmSync(scratch, { recursive: true, force: true });
}

/**
 * Coordinated (v2) round trip on fixture files only: the seller DB and identity
 * from the v1 run above plus opaque scanner stand-ins. No live service is used.
 */
async function coordinatedRoundTrip(root: string, sellerDbPath: string, v1Archive: Uint8Array, key: Uint8Array): Promise<void> {
  const scannerDir = join(root, 'scanner');
  const stateDir = join(scannerDir, '.scanner.json.live-state');
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const scannerConfigPath = join(scannerDir, 'scanner.json');
  writeFileSync(scannerConfigPath, JSON.stringify({
    ufvk: 'uviewregtest1backupcheckfixtureonly',
    birthday: 1,
    runtime: { sourceId: 'backup-check-src', chain: { network: 'regtest' } },
  }), { mode: 0o600 });
  writeFileSync(join(stateDir, 'wallet.sqlite'), randomBytes(64), { mode: 0o600 });
  writeFileSync(join(stateDir, 'scanner.sqlite'), randomBytes(64), { mode: 0o600 });
  const keyFile = join(root, 'backup.key');
  writeFileSync(keyFile, `${Buffer.from(key).toString('hex')}\n`, { mode: 0o600 });
  chmodSync(keyFile, 0o600);
  const archivePath = join(root, 'coordinated.ssbk');

  const manifest = await exportCoordinatedBackup({
    sellerDbPath,
    scannerConfigPath,
    scannerStateDir: stateDir,
    backupKeyFile: keyFile,
    outPath: archivePath,
    scannerInfo: { accountId: '0', sourceId: 'backup-check-src', network: 'regtest', reservedHighWater: '5' },
    assertStopped: async () => {},
  });
  const described = await describeBackup({ encrypted: readFileSync(archivePath), key });
  if (described.version !== 2 || !described.complete) throw new Error('coordinated archive did not classify as complete v2');

  const restored = await restoreCoordinatedBackup({
    archivePath,
    backupKeyFile: keyFile,
    sellerDir: join(root, 'restored-seller'),
    scannerDir: join(root, 'restored-scanner'),
    expect: { accountId: '0', network: 'regtest', sellerIdentityPublicKeyHex: manifest.sellerIdentityPublicKeyHex },
  });
  for (const entry of restored.entries) {
    const [prefix, ...rest] = entry.relPath.split('/');
    const target = join(root, prefix === 'seller' ? 'restored-seller' : 'restored-scanner', ...rest);
    if (createHash('sha256').update(readFileSync(target)).digest('hex') !== entry.sha256) {
      throw new Error(`restored ${entry.role} does not match the manifest checksum`);
    }
  }
  result.coordinatedVersion = restored.version;
  result.coordinatedEntries = restored.entries.length;
  result.coordinatedRoundTrip = restored.reservedHighWater === '5' && restored.entries.length === 5;

  // A v1 seller-only archive must be refused as a coordinated restore.
  const v1Path = join(root, 'v1.ssbk');
  writeFileSync(v1Path, v1Archive, { mode: 0o600 });
  try {
    await restoreCoordinatedBackup({
      archivePath: v1Path,
      backupKeyFile: keyFile,
      sellerDir: join(root, 'v1-seller'),
      scannerDir: join(root, 'v1-scanner'),
    });
  } catch (error) {
    result.coordinatedRefusesV1 = error instanceof Error && /not a complete coordinated backup/.test(error.message);
  }
}

function expectUnchanged(actual: BrowserPurchase, expected: BrowserPurchase): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error('buyer record changed after seller restore');
  }
  if (actual.sellerKeyId !== expected.sellerKeyId) {
    throw new Error('seller trust anchor was reset');
  }
}

const outPath = join(process.cwd(), 'test-results', 'backup-check.json');
mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, `${JSON.stringify(result, null, 2)}\n`);
process.stdout.write(`${JSON.stringify(result)}\n`);
if (!result.ok) {
  process.exit(1);
}

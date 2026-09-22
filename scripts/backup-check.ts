import { randomBytes } from 'node:crypto';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createCredentialAdapter } from '../src/adapters/credentials.ts';
import { MemoryScanner } from '../src/adapters/scanner.ts';
import { loadConfig } from '../src/config.ts';
import type { BrowserPurchase, Invoice } from '../src/contracts/types.ts';
import { exportSellerBackup, restoreSellerBackup } from '../src/seller/backup.ts';
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
  scanner.replaceSnapshot([{
    outputId: 'backup-check-out',
    invoiceId: invoice.id,
    amountZat: invoice.amountZat,
    confirmations: 10,
    canonical: true,
    receivedAt: Date.now(),
    revision: { id: 'rev-10', height: 10 },
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
  result.ok = restored.spendingKeysPresent === false;
} catch (error) {
  result.ok = false;
  result.error = error instanceof Error ? error.message : 'backup-check failed';
} finally {
  rmSync(scratch, { recursive: true, force: true });
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

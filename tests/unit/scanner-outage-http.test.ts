// Fix round 1 (Critical #1): HTTP /api/status and /api/recover behave like the
// Waku dispatcher during a scanner outage (status with verification
// unavailable; recover reports unavailable), never a generic 400.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { createCredentialAdapter } from '../../src/adapters/credentials.ts';
import { createMemoryMessaging } from '../../src/adapters/messaging.ts';
import { MemoryScanner } from '../../src/adapters/scanner.ts';
import { WalletScannerUnavailableError } from '../../src/adapters/wallet-scanner.ts';
import { loadConfig } from '../../src/config.ts';
import { startSeller, type SellerServer } from '../../src/seller/server.ts';

const DESTINATION =
  'uregtest1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq';

let scratchDir = '';
let seller: SellerServer | undefined;

afterEach(async () => {
  await seller?.close().catch(() => undefined);
  seller = undefined;
  if (scratchDir) rmSync(scratchDir, { recursive: true, force: true });
  scratchDir = '';
});

test('HTTP status/recover during a scanner outage match the Waku dispatcher', async () => {
  scratchDir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), 'ssf-outage-http-'));
  const credentials = createCredentialAdapter();
  const buyer = await credentials.createPurchaseCredential();
  const scanner = new MemoryScanner();
  scanner.replaceSnapshot([], { id: 'rev-10', height: 10 }, true, Date.now());
  const config = loadConfig({
    SSF_MODE: 'fixture', SSF_NETWORK: 'test', SSF_MIN_CONFIRMATIONS: '10', SSF_MAX_HEALTH_AGE_MS: '120000',
    SSF_MAX_CIPHERTEXT_BYTES: '73', SSF_MAX_PLAINTEXT_BYTES: '41', SSF_INVOICE_TTL_MS: '86400000',
    SSF_PUBLIC_HOST: '127.0.0.1', SSF_PUBLIC_PORT: '0', SSF_ADMIN_HOST: '127.0.0.1', SSF_ADMIN_PORT: '0',
    SSF_DB_PATH: join(scratchDir, 'seller.sqlite'), SSF_SELLER_KEY_ID: 'seller-key-1', SSF_DESTINATION: DESTINATION,
    SSF_ADAPTER_MESSAGING: 'fixture', SSF_ADAPTER_STORAGE: 'fixture', SSF_ADAPTER_SCANNER: 'fixture',
    SSF_ADMIN_TOKEN: 'admin-token-not-a-credential-example',
  });
  seller = await startSeller({ config, seedProduct: true, scanner, credentials, messaging: createMemoryMessaging(), startLoops: false });
  const proof = async (orderId: string) => Buffer.from(await credentials.provePossession(buyer.credentialId, { orderId })).toString('base64');
  const created = await fetch(`${seller.publicUrl}/api/orders`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ requestId: 'req-outage-http', productVersion: 'book-v1', buyerKeyId: buyer.buyerKeyId, proof: await proof('req-outage-http') }),
  });
  expect(created.status).toBe(200);
  const invoice = await created.json() as { orderId: string };

  scanner.snapshot = async () => { throw new WalletScannerUnavailableError(); };
  const status = await fetch(`${seller.publicUrl}/api/status`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ orderId: invoice.orderId, proof: await proof(invoice.orderId) }),
  });
  expect(status.status).toBe(200);
  expect(await status.json()).toMatchObject({ verification: 'unavailable' });

  const recover = await fetch(`${seller.publicUrl}/api/recover`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ orderId: invoice.orderId, proof: await proof(invoice.orderId) }),
  });
  expect(recover.status).toBe(503);
  const body = await recover.json() as { error: string };
  expect(body.error).toBe('verification unavailable');
});

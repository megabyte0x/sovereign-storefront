import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { createMemoryMessaging, MESSAGING_MAPPING } from '../../src/adapters/messaging.ts';
import { MemoryScanner, SCANNER_MAPPING } from '../../src/adapters/scanner.ts';
import { createTestCredentialAdapter } from '../../src/adapters/credentials.ts';
import { openStore } from '../../src/seller/db.ts';
import { createFulfillment } from '../../src/seller/fulfillment.ts';
import { DEFAULT_POLICY, createPayments } from '../../src/seller/payments.ts';

const scratchRoot = process.env.TMPDIR ?? tmpdir();

test('labelled fixtures: scanner is not compact-block WalletRead and not public testnet', () => {
  expect(SCANNER_MAPPING.walletReadWired).toBe(false);
  expect(SCANNER_MAPPING.compactBlockScan).toBe(false);
  expect(SCANNER_MAPPING.publicTestnet).toBe(false);
  expect(SCANNER_MAPPING.liveAttribution).toBe('destination-ua');
  expect(SCANNER_MAPPING.reducerAttribution).toContain('invoiceId');
  expect(MESSAGING_MAPPING.logosChat).toBe(false);
  expect(DEFAULT_POLICY.minConfirmations).toBe(10);
});

test('labelled dashboard double: invoiceId memo path settles, authorizes once, and dispatches', async () => {
  const scratchDir = mkdtempSync(join(scratchRoot, 'ssf-pay-int-'));
  const dbPath = join(scratchDir, 'seller.sqlite');
  const store = await openStore(dbPath);
  try {
    const credentials = createTestCredentialAdapter();
    const buyer = await credentials.createPurchaseCredential();
    const order = await store.createOrder({
      requestId: 'fixture-order',
      buyerKeyId: buyer.buyerKeyId,
      productVersion: 'book-v1',
    });
    const invoice = await store.getOrCreateInvoice({
      orderId: order.id,
      buyerKeyId: buyer.buyerKeyId,
      productVersion: 'book-v1',
      now: 1_000,
      availability: { productPublished: true, messaging: true, storageReplica: true, scanner: true },
    });
    const scanner = new MemoryScanner();
    const fixtureReceipt = {
      outputId: 'labelled-fixture:orchard',
      invoiceId: invoice.id,
      amountZat: invoice.amountZat,
      confirmations: DEFAULT_POLICY.minConfirmations,
      canonical: true,
      receivedAt: 1_000,
      revision: { id: 'labelled-rev', height: 10 },
    };
    scanner.replaceSnapshot([fixtureReceipt], fixtureReceipt.revision, true, 1_000);
    const payments = createPayments({
      store,
      scanner,
      now: () => 1_000,
      preparePackage: async (inv) => ({
        orderId: inv.orderId,
        productVersion: inv.productVersion,
        buyerKeyId: inv.buyerKeyId,
        encryptedEnvelope: new Uint8Array([4, 1, 1]),
      }),
    });
    payments.cacheInvoice(invoice);
    await payments.reconcileFromScanner();
    const messaging = createMemoryMessaging();
    const fulfillment = createFulfillment({ store, payments, messaging, credentials });
    await fulfillment.dispatchPending();
    expect(await store.getDelivery(order.id)).toBe('sent_unacknowledged');
    expect(messaging.sent).toHaveLength(1);
    const recovered = await fulfillment.recover(order.id, buyer.credentialId);
    expect(recovered.reason).toBe('replay');
    expect(recovered.disclose).toBe(true);
  } finally {
    await store.close().catch(() => undefined);
    rmSync(scratchDir, { recursive: true, force: true });
  }
});

test.skip('live public Zcash testnet settlement is not executed in this task', () => {
  expect.fail('do not claim public testnet settlement');
});

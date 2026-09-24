import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { createMemoryMessaging, MESSAGING_MAPPING } from '../../src/adapters/messaging.ts';
import { MemoryScanner, SCANNER_MAPPING } from '../../src/adapters/scanner.ts';
import { createTestCredentialAdapter } from '../../src/adapters/credentials.ts';
import { createMemoryStorageAdapter } from '../../src/adapters/storage.ts';
import { openCatalogue } from '../../src/seller/catalogue.ts';
import { openStore } from '../../src/seller/db.ts';
import { createFulfillment } from '../../src/seller/fulfillment.ts';
import { createInvoiceIssuer } from '../../src/seller/issuance.ts';
import { DEFAULT_POLICY, createPayments } from '../../src/seller/payments.ts';
import type { ChainIdentity } from '../../src/contracts/live.ts';

const scratchRoot = process.env.TMPDIR ?? tmpdir();
const chain: ChainIdentity = { network: 'regtest', genesisHash: 'a'.repeat(64), consensusFingerprint: 'c'.repeat(64) };

test('labelled fixtures: scanner is not compact-block WalletRead and not public testnet', () => {
  expect(SCANNER_MAPPING.walletReadWired).toBe(false);
  expect(SCANNER_MAPPING.compactBlockScan).toBe(false);
  expect(SCANNER_MAPPING.publicTestnet).toBe(false);
  expect(SCANNER_MAPPING.liveAttribution).toBe('destination-ua');
  expect(MESSAGING_MAPPING.logosChat).toBe(false);
  expect(DEFAULT_POLICY.minConfirmations).toBe(10);
});

test('receiver-invoice path: full snapshot reconciliation settles, authorizes once, and dispatches', async () => {
  const scratchDir = mkdtempSync(join(scratchRoot, 'ssf-pay-int-'));
  const dbPath = join(scratchDir, 'seller.sqlite');
  const catalogue = openCatalogue({ dbPath, storage: createMemoryStorageAdapter() });
  catalogue.beginPublication({ version: 'book-v1', description: 'fixture', amountZat: '100', network: chain.network });
  catalogue.completePublication({
    version: 'book-v1', ciphertextCid: 'fixture-cid', ciphertextDigest: 'a'.repeat(64), fileSize: 1,
    sellerKeyRef: 'fixture-key', wrappedKey: new Uint8Array([1]),
  });
  catalogue.close();

  const store = await openStore(dbPath);
  try {
    const credentials = createTestCredentialAdapter();
    const buyer = await credentials.createPurchaseCredential();
    const scanner = new MemoryScanner();
    const issuer = createInvoiceIssuer({
      store, scanner, chain, accountId: 'fixture-account', ttlMs: 60_000, now: () => 1_000,
      availability: async () => ({ productPublished: true, messaging: true, storageReplica: true, scanner: true }),
    });
    const invoice = await issuer.issue({
      requestId: 'fixture-order', buyerKeyId: buyer.buyerKeyId, productVersion: 'book-v1', expectedAmountZat: '100',
    });
    if (invoice.attribution?.kind !== 'receiver') throw new Error('receiver invoice required');

    const minedRev = { id: 'rev-1', height: 1 };
    const tipRev = { id: `rev-${DEFAULT_POLICY.minConfirmations}`, height: DEFAULT_POLICY.minConfirmations };
    scanner.setReceiptReceiver('labelled-fixture:orchard', invoice.attribution.receiver);
    scanner.replaceSnapshot(
      [{
        outputId: 'labelled-fixture:orchard', invoiceId: null, amountZat: invoice.amountZat,
        confirmations: 0, canonical: true, receivedAt: 1_000, revision: minedRev,
      }],
      tipRev,
      true,
      1_000,
    );
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
    await payments.reconcileFromScanner();
    const messaging = createMemoryMessaging();
    const fulfillment = createFulfillment({ store, payments, messaging, credentials });
    await fulfillment.dispatchPending();
    expect(await store.getDelivery(invoice.orderId)).toBe('sent_unacknowledged');
    expect(messaging.sent).toHaveLength(1);
    const recovered = await fulfillment.recover(invoice.orderId, buyer.credentialId);
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

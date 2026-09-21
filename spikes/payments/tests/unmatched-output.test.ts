import assert from 'node:assert/strict';
import { test } from 'node:test';
import { reduceInvoice } from '../src/reduce-invoice.ts';
import type { Invoice, Observation, Policy, ScanHealth } from '../src/types.ts';

const now = 1_700_000_000_000;
const revision = { id: 'blockhash-100', height: 100 };
const policy: Policy = { minConfirmations: 10, maxHealthAgeMs: 120_000 };
const health: ScanHealth = {
  healthy: true,
  checkedAt: now,
  revision,
  caughtUp: true,
};

const invoice: Invoice = {
  id: 'inv-1',
  orderId: 'ord-1',
  productVersion: 'pv-1',
  buyerKeyId: 'buyer-1',
  network: 'test',
  amountZat: '100000000',
  destination: 'utest1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq',
  attributionRef: 'attr-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  expiresAt: now + 86_400_000,
};

test('unmatched output cannot release an invoice even with equal amount and confirmations', () => {
  const unmatched: Observation = {
    outputId: 'aa'.repeat(32) + ':orchard:0',
    invoiceId: null,
    amountZat: invoice.amountZat,
    confirmations: 10,
    canonical: true,
    receivedAt: now,
    revision,
  };

  const settlement = reduceInvoice(invoice, [unmatched], health, policy, now);

  assert.equal(settlement.releaseEligible, false);
  assert.notEqual(settlement.payment, 'confirmed');
  assert.equal(settlement.backingOutputIds.length, 0);
  assert.ok(
    settlement.exceptions.some((record) => record.code === 'unmatched'),
    'unmatched output must surface unmatched, not a paid invoice',
  );
});

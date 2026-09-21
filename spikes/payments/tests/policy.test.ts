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
  destination: 'ua-test',
  attributionRef: 'attr-1',
  expiresAt: now + 86_400_000,
};

test('zero-confirmation receipt cannot authorize release', () => {
  const receipt: Observation = {
    outputId: '99'.repeat(32) + ':orchard:0',
    invoiceId: invoice.id,
    amountZat: invoice.amountZat,
    confirmations: 0,
    canonical: true,
    receivedAt: now,
    revision,
  };
  const settlement = reduceInvoice(invoice, [receipt], health, policy, now);
  assert.equal(settlement.releaseEligible, false);
  assert.notEqual(settlement.payment, 'confirmed');
});

test('late receipt after expiry is retained for review and does not fulfill', () => {
  const receipt: Observation = {
    outputId: '88'.repeat(32) + ':orchard:0',
    invoiceId: invoice.id,
    amountZat: invoice.amountZat,
    confirmations: 10,
    canonical: true,
    receivedAt: invoice.expiresAt + 1,
    revision,
  };
  const settlement = reduceInvoice(invoice, [receipt], health, policy, now);
  assert.equal(settlement.releaseEligible, false);
  assert.ok(settlement.exceptions.some((record) => record.code === 'late'));
});

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { reduceInvoice } from '../src/reduce-invoice.ts';
import type { Invoice, Observation, Policy, ScanHealth } from '../src/types.ts';

const now = 1_700_000_000_000;
const policy: Policy = { minConfirmations: 10, maxHealthAgeMs: 120_000 };
const health: ScanHealth = {
  healthy: true,
  checkedAt: now,
  revision: { id: 'blockhash-110', height: 110 },
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

test('synthetic: later non-canonical update replaces chain state rather than creating a second claim', () => {
  const outputId = 'ee'.repeat(32) + ':orchard:0';
  const canonical: Observation = {
    outputId,
    invoiceId: invoice.id,
    amountZat: invoice.amountZat,
    confirmations: 10,
    canonical: true,
    receivedAt: now,
    revision: { id: 'blockhash-100', height: 100 },
  };
  const reorged: Observation = {
    ...canonical,
    canonical: false,
    confirmations: 0,
    revision: { id: 'blockhash-110', height: 110 },
  };

  const first = reduceInvoice(invoice, [canonical], health, policy, now);
  assert.equal(first.releaseEligible, true);
  assert.deepEqual(first.backingOutputIds, [outputId]);

  const after = reduceInvoice(invoice, [canonical, reorged], health, policy, now);
  assert.equal(after.releaseEligible, false);
  assert.equal(after.payment, 'reorged');
  assert.equal(after.backingOutputIds.length, 0);
});

test('synthetic: one of two sufficient receipts reorging leaves the remaining receipt confirmed', () => {
  const keep: Observation = {
    outputId: '11'.repeat(32) + ':orchard:0',
    invoiceId: invoice.id,
    amountZat: invoice.amountZat,
    confirmations: 10,
    canonical: true,
    receivedAt: now,
    revision: { id: 'blockhash-100', height: 100 },
  };
  const dropped: Observation = {
    outputId: '22'.repeat(32) + ':orchard:0',
    invoiceId: invoice.id,
    amountZat: invoice.amountZat,
    confirmations: 10,
    canonical: false,
    receivedAt: now,
    revision: { id: 'blockhash-110', height: 110 },
  };
  const settlement = reduceInvoice(invoice, [keep, dropped], health, policy, now);
  assert.equal(settlement.releaseEligible, true);
  assert.deepEqual(settlement.backingOutputIds, [keep.outputId]);
  assert.ok(settlement.exceptions.some((record) => record.code === 'duplicate') === false);
});

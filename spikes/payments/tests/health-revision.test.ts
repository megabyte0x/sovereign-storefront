import assert from 'node:assert/strict';
import { test } from 'node:test';
import { reduceInvoice } from '../src/reduce-invoice.ts';
import type { Invoice, Observation, Policy, ScanHealth } from '../src/types.ts';

const now = 1_700_000_000_000;
const revision = { id: 'blockhash-100', height: 100 };
const policy: Policy = { minConfirmations: 10, maxHealthAgeMs: 120_000 };

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

function receipt(overrides: Partial<Observation> = {}): Observation {
  return {
    outputId: 'dd'.repeat(32) + ':orchard:0',
    invoiceId: invoice.id,
    amountZat: invoice.amountZat,
    confirmations: 10,
    canonical: true,
    receivedAt: now,
    revision,
    ...overrides,
  };
}

test('healthy=true with caughtUp=false cannot authorize release', () => {
  const health: ScanHealth = {
    healthy: true,
    checkedAt: now,
    revision,
    caughtUp: false,
  };
  const settlement = reduceInvoice(invoice, [receipt()], health, policy, now);
  assert.equal(settlement.releaseEligible, false);
});

test('health revision that does not cover a stored receipt cannot authorize release', () => {
  const health: ScanHealth = {
    healthy: true,
    checkedAt: now,
    revision: { id: 'blockhash-50', height: 50 },
    caughtUp: true,
  };
  const settlement = reduceInvoice(
    invoice,
    [receipt({ revision: { id: 'blockhash-100', height: 100 } })],
    health,
    policy,
    now,
  );
  assert.equal(settlement.releaseEligible, false);
});

test('stale health cannot authorize release', () => {
  const health: ScanHealth = {
    healthy: true,
    checkedAt: now - policy.maxHealthAgeMs - 1,
    revision,
    caughtUp: true,
  };
  const settlement = reduceInvoice(invoice, [receipt()], health, policy, now);
  assert.equal(settlement.releaseEligible, false);
});

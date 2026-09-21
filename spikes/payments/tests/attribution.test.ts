import assert from 'node:assert/strict';
import { test } from 'node:test';
import { attributeOutput, claimOutput } from '../src/attribution.ts';
import { reduceInvoice } from '../src/reduce-invoice.ts';
import type { Invoice, Policy, ScanHealth } from '../src/types.ts';

const now = 1_700_000_000_000;
const revision = { id: 'blockhash-100', height: 100 };
const policy: Policy = { minConfirmations: 10, maxHealthAgeMs: 120_000 };
const health: ScanHealth = {
  healthy: true,
  checkedAt: now,
  revision,
  caughtUp: true,
};

function invoice(id: string, ref: string): Invoice {
  return {
    id,
    orderId: `ord-${id}`,
    productVersion: 'pv-1',
    buyerKeyId: 'buyer-1',
    network: 'test',
    amountZat: '100000000',
    destination: 'shared-ua',
    attributionRef: ref,
    expiresAt: now + 86_400_000,
  };
}

test('equal-amount payment with a different memo does not match the invoice', () => {
  const inv = invoice('inv-1', 'attr-expected-ref');
  const other = attributeOutput(
    {
      outputId: 'aa'.repeat(32) + ':orchard:0',
      amountZat: inv.amountZat,
      confirmations: 10,
      canonical: true,
      receivedAt: now,
      revision,
      memoText: 'attr-other-ref',
    },
    [inv],
  );

  assert.equal(other.invoiceId, null);
  const settlement = reduceInvoice(inv, [other], health, policy, now);
  assert.equal(settlement.releaseEligible, false);
  assert.ok(settlement.exceptions.some((record) => record.code === 'unmatched'));
});

test('memo attributionRef match binds a single invoice even when amounts collide', () => {
  const inv = invoice('inv-1', 'attr-expected-ref');
  const matched = attributeOutput(
    {
      outputId: 'bb'.repeat(32) + ':orchard:0',
      amountZat: inv.amountZat,
      confirmations: 10,
      canonical: true,
      receivedAt: now,
      revision,
      memoText: 'attr-expected-ref',
    },
    [inv],
  );
  assert.equal(matched.invoiceId, 'inv-1');
  const settlement = reduceInvoice(inv, [matched], health, policy, now);
  assert.equal(settlement.releaseEligible, true);
  assert.equal(settlement.payment, 'confirmed');
});

test('replayed output cannot be claimed by a second invoice', () => {
  const claimed = new Map<string, string>();
  const outputId = 'cc'.repeat(32) + ':orchard:0';
  assert.equal(claimOutput(claimed, outputId, 'inv-1'), true);
  assert.equal(claimOutput(claimed, outputId, 'inv-2'), false);
  assert.equal(claimOutput(claimed, outputId, 'inv-1'), true);
});

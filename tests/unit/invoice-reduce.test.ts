import { expect, test } from 'vitest';
import { DEFAULT_POLICY, reduceInvoice } from '../../src/seller/payments.ts';
import type { Invoice, Observation, Policy, ScanHealth } from '../../src/contracts/types.ts';

const invoice: Invoice = {id:'i1', orderId:'o1', productVersion:'v1', buyerKeyId:'b1',
  network:'test', amountZat:'100', destination:'fixture-only', attributionRef:'r1', expiresAt:2000};
const rev = {id:'rev-2', height:2};
const receipt: Observation = {outputId:'out-a', invoiceId:'i1', amountZat:'100',
  confirmations:2, canonical:true, receivedAt:1000, revision:rev};
const health: ScanHealth = {healthy:true, checkedAt:1000, revision:rev, caughtUp:true};
const policy: Policy = {minConfirmations:2, maxHealthAgeMs:100};

function settle(receipts: Observation[], healthOverride: ScanHealth = health, now = 1000) {
  return reduceInvoice(invoice, receipts, healthOverride, policy, now);
}

test('fixture policy is test-only; app default minConfirmations is 10', () => {
  expect(policy.minConfirmations).toBe(2);
  expect(DEFAULT_POLICY.minConfirmations).toBe(10);
  expect(DEFAULT_POLICY.maxHealthAgeMs).toBe(120_000);
});

test('exact confirmed receipt with covering caught-up health is release eligible', () => {
  expect(reduceInvoice(invoice, [receipt], health, policy, 1000).releaseEligible).toBe(true);
  expect(reduceInvoice(invoice, [{...receipt, confirmations:0}], health, policy, 1000).releaseEligible).toBe(false);
  expect(reduceInvoice(invoice, [{...receipt, invoiceId:null}], health, policy, 1000).releaseEligible).toBe(false);
  expect(reduceInvoice(invoice, [receipt], {...health, caughtUp:false}, policy, 1000).releaseEligible).toBe(false);
  expect(reduceInvoice(invoice, [receipt], {...health, revision:{id:'rev-1', height:1}}, policy, 1000).releaseEligible).toBe(false);
});

test('zero-confirmation matched receipt is detected, not confirmed', () => {
  const settlement = settle([{...receipt, confirmations:0}]);
  expect(settlement.payment).toBe('detected');
  expect(settlement.backingOutputIds).toEqual([]);
});

test('unmatched output never confirms an invoice', () => {
  const settlement = settle([{...receipt, invoiceId:null}]);
  expect(settlement.payment).not.toBe('confirmed');
  expect(settlement.exceptions.some((record) => record.code === 'unmatched')).toBe(true);
});

test('stale or unhealthy health cannot authorize release and does not mark a confirmed receipt unpaid', () => {
  const stale = settle([receipt], {...health, checkedAt: 1000 - policy.maxHealthAgeMs - 1});
  expect(stale.releaseEligible).toBe(false);
  expect(stale.payment).toBe('confirmed');

  const down = settle([receipt], {...health, healthy: false});
  expect(down.releaseEligible).toBe(false);
  expect(down.payment).toBe('confirmed');
});

test('two observations of one outputId update chain state once regardless of arrival order', () => {
  const later: Observation = {
    ...receipt,
    confirmations: 3,
    revision: {id:'rev-3', height:3},
  };
  const covering: ScanHealth = {...health, revision: later.revision};
  const forward = reduceInvoice(invoice, [receipt, later], covering, policy, 1000);
  const reverse = reduceInvoice(invoice, [later, receipt], covering, policy, 1000);
  expect(forward.releaseEligible).toBe(true);
  expect(reverse.releaseEligible).toBe(true);
  expect(forward.backingOutputIds).toEqual(['out-a']);
  expect(reverse.backingOutputIds).toEqual(['out-a']);
  expect(forward.exceptions.some((record) => record.code === 'duplicate')).toBe(false);
  expect(reverse.exceptions.some((record) => record.code === 'duplicate')).toBe(false);
});

test('two distinct exact outputs: one entitlement plus duplicate exception', () => {
  const other: Observation = {...receipt, outputId:'out-b'};
  const forward = settle([receipt, other]);
  const reverse = settle([other, receipt]);
  expect(forward.releaseEligible).toBe(true);
  expect(reverse.releaseEligible).toBe(true);
  expect(forward.payment).toBe('confirmed');
  expect(forward.backingOutputIds).toHaveLength(1);
  expect(reverse.backingOutputIds).toEqual(forward.backingOutputIds);
  expect(forward.exceptions.some((record) => record.code === 'duplicate')).toBe(true);
  expect(reverse.exceptions.some((record) => record.code === 'duplicate')).toBe(true);
  expect(forward.exceptions.filter((record) => record.code === 'duplicate')).toHaveLength(1);
});

test('two partial outputs: underpayment, no release, no aggregation', () => {
  const first: Observation = {...receipt, outputId:'out-p1', amountZat:'40'};
  const second: Observation = {...receipt, outputId:'out-p2', amountZat:'60'};
  const forward = settle([first, second]);
  const reverse = settle([second, first]);
  expect(forward.releaseEligible).toBe(false);
  expect(reverse.releaseEligible).toBe(false);
  expect(forward.payment).toBe('review_required');
  expect(reverse.payment).toBe('review_required');
  expect(forward.backingOutputIds).toEqual([]);
  expect(forward.exceptions.filter((record) => record.code === 'underpayment')).toHaveLength(2);
  expect(reverse.exceptions.filter((record) => record.code === 'underpayment')).toHaveLength(2);
});

test('exact payment then a small or late extra remains confirmed with extra exception and no second entitlement', () => {
  const small: Observation = {...receipt, outputId:'out-extra', amountZat:'1'};
  const late: Observation = {...receipt, outputId:'out-late', receivedAt: invoice.expiresAt + 1};
  const withSmall = settle([receipt, small]);
  const withLate = settle([small, receipt, late]);
  expect(withSmall.releaseEligible).toBe(true);
  expect(withLate.releaseEligible).toBe(true);
  expect(withSmall.payment).toBe('confirmed');
  expect(withLate.payment).toBe('confirmed');
  expect(withSmall.backingOutputIds).toEqual(['out-a']);
  expect(withLate.backingOutputIds).toEqual(['out-a']);
  expect(withSmall.exceptions.some((record) => record.code === 'underpayment')).toBe(true);
  expect(withLate.exceptions.some((record) => record.code === 'late')).toBe(true);
  expect(withSmall.exceptions.some((record) => record.code === 'duplicate')).toBe(false);
  expect(withLate.exceptions.some((record) => record.code === 'duplicate')).toBe(false);
});

test('two sufficient outputs, one later canonical=false: still confirmed on the remaining output', () => {
  const keep = receipt;
  const dropped: Observation = {
    ...receipt,
    outputId:'out-b',
    canonical:false,
    confirmations:0,
    revision:{id:'rev-3', height:3},
  };
  const covering: ScanHealth = {...health, revision: dropped.revision};
  const forward = reduceInvoice(invoice, [keep, dropped], covering, policy, 1000);
  const reverse = reduceInvoice(invoice, [dropped, keep], covering, policy, 1000);
  expect(forward.releaseEligible).toBe(true);
  expect(reverse.releaseEligible).toBe(true);
  expect(forward.payment).toBe('confirmed');
  expect(forward.backingOutputIds).toEqual(['out-a']);
  expect(reverse.backingOutputIds).toEqual(['out-a']);
  expect(forward.exceptions.some((record) => record.code === 'duplicate')).toBe(false);
});

test('sole sufficient output later non-canonical before disclosure: reorged, not eligible', () => {
  const reorged: Observation = {
    ...receipt,
    canonical:false,
    confirmations:0,
    revision:{id:'rev-3', height:3},
  };
  const covering: ScanHealth = {...health, revision: reorged.revision};
  const forward = reduceInvoice(invoice, [receipt, reorged], covering, policy, 1000);
  const reverse = reduceInvoice(invoice, [reorged, receipt], covering, policy, 1000);
  expect(forward.releaseEligible).toBe(false);
  expect(reverse.releaseEligible).toBe(false);
  expect(forward.payment).toBe('reorged');
  expect(reverse.payment).toBe('reorged');
  expect(forward.backingOutputIds).toEqual([]);
});

test('observation time after expiresAt with no prior confirmation: late, not eligible', () => {
  const late: Observation = {...receipt, receivedAt: invoice.expiresAt + 1};
  const settlement = settle([late]);
  expect(settlement.releaseEligible).toBe(false);
  expect(settlement.payment).not.toBe('confirmed');
  expect(settlement.exceptions.some((record) => record.code === 'late')).toBe(true);
});

test('overpayment on the backing receipt fulfills one entitlement and records overpayment', () => {
  const over: Observation = {...receipt, amountZat:'150'};
  const settlement = settle([over]);
  expect(settlement.releaseEligible).toBe(true);
  expect(settlement.payment).toBe('confirmed');
  expect(settlement.backingOutputIds).toEqual(['out-a']);
  expect(settlement.exceptions.some((record) => record.code === 'overpayment')).toBe(true);
});

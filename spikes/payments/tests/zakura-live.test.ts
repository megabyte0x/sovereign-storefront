import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { reduceInvoice } from '../src/reduce-invoice.ts';
import {
  LIVE_PROBE_POLICY,
  attributeLiveOutput,
  faucetOrchard,
  fetchTransaction,
  loadZakuraAccounts,
  loadZakuraHealth,
  observeActivity,
  waitForConfirmations,
} from '../src/zakura-live.ts';
import type { Invoice } from '../src/types.ts';

const AMOUNT_ZAT = '1234567';

function invoiceFor(destination: string, attributionRef: string): Invoice {
  return {
    id: 'inv-zakura-live',
    orderId: 'ord-zakura-live',
    productVersion: 'pv-1',
    buyerKeyId: 'buyer-live',
    network: 'test',
    amountZat: AMOUNT_ZAT,
    destination,
    attributionRef,
    expiresAt: Date.now() + 86_400_000,
  };
}

test(
  'live zakura/regtest: equal-amount orchard payment to a different UA cannot release',
  { timeout: 180_000 },
  async () => {
    const accounts = await loadZakuraAccounts();
    const invoiceUa = accounts.get(2);
    const unmatchedUa = accounts.get(3);
    assert.ok(invoiceUa, 'account 2 UA required');
    assert.ok(unmatchedUa, 'account 3 UA required');
    assert.notEqual(invoiceUa, unmatchedUa);

    const invoice = invoiceFor(invoiceUa, `attr-${randomBytes(16).toString('hex')}`);
    const funded = await faucetOrchard({
      accountId: 3,
      amountZat: AMOUNT_ZAT,
      idempotencyKey: `gate-c-unmatched-${randomUUID()}`,
    });
    assert.equal(funded.destinationPool, 'orchard');
    assert.equal(funded.amountZat, AMOUNT_ZAT);

    const tx = await fetchTransaction(funded.txid);
    assert.equal(tx.vinCount, 0);
    assert.equal(tx.voutCount, 0);
    assert.ok(tx.orchardActions > 0, 'receipt must be orchard-shielded');
    assert.equal(tx.inActiveChain, true);

    const receipt = await observeActivity(funded, accounts);
    assert.equal(receipt.networkLabel, 'zakura/regtest');
    assert.notEqual(receipt.destinationUa, invoice.destination);

    const observation = attributeLiveOutput(receipt, invoice);
    const health = await loadZakuraHealth();
    const settlement = reduceInvoice(
      invoice,
      [observation],
      health,
      LIVE_PROBE_POLICY,
      Date.now(),
    );

    assert.equal(observation.invoiceId, null);
    assert.equal(settlement.releaseEligible, false);
    assert.equal(settlement.backingOutputIds.length, 0);
    assert.ok(settlement.exceptions.some((record) => record.code === 'unmatched'));
  },
);

test(
  'live zakura/regtest: shielded orchard payment to the invoice UA releases after minConfirmations',
  { timeout: 180_000 },
  async () => {
    const accounts = await loadZakuraAccounts();
    const invoiceUa = accounts.get(2);
    assert.ok(invoiceUa, 'account 2 UA required');

    const attributionRef = `attr-${randomBytes(16).toString('hex')}`;
    const invoice = invoiceFor(invoiceUa, attributionRef);
    const funded = await faucetOrchard({
      accountId: 2,
      amountZat: AMOUNT_ZAT,
      idempotencyKey: `gate-c-matched-${randomUUID()}`,
      memoText: attributionRef,
    });
    assert.equal(funded.destinationPool, 'orchard');
    assert.equal(funded.amountZat, AMOUNT_ZAT);
    assert.equal(funded.toAccount, 2);

    const tx = await fetchTransaction(funded.txid);
    assert.equal(tx.vinCount, 0);
    assert.equal(tx.voutCount, 0);
    assert.ok(tx.orchardActions > 0, 'receipt must be orchard-shielded');
    assert.equal(tx.inActiveChain, true);
    assert.ok(tx.confirmations >= 1);
    assert.ok(tx.blockHash);

    const receipt = await observeActivity(funded, accounts);
    assert.equal(receipt.networkLabel, 'zakura/regtest');
    assert.equal(receipt.network, 'Regtest');
    assert.equal(receipt.nodeChain, 'test');
    assert.equal(receipt.destinationUa, invoice.destination);

    const observation = attributeLiveOutput(receipt, invoice);
    let health = await loadZakuraHealth();
    const first = reduceInvoice(
      invoice,
      [observation],
      health,
      LIVE_PROBE_POLICY,
      Date.now(),
    );
    assert.equal(LIVE_PROBE_POLICY.minConfirmations, 1);
    assert.equal(observation.invoiceId, invoice.id);
    assert.equal(first.releaseEligible, true);
    assert.equal(first.payment, 'confirmed');
    assert.deepEqual(first.backingOutputIds, [observation.outputId]);

    const progression = await waitForConfirmations(funded.txid, 2);
    assert.ok(
      progression.after >= progression.before,
      'confirmations must not regress',
    );
    assert.ok(progression.after >= LIVE_PROBE_POLICY.minConfirmations);

    const later = await observeActivity(funded, accounts);
    health = await loadZakuraHealth();
    const afterMine = reduceInvoice(
      invoice,
      [attributeLiveOutput(later, invoice)],
      health,
      LIVE_PROBE_POLICY,
      Date.now(),
    );
    assert.equal(afterMine.releaseEligible, true);
    assert.ok(later.confirmations >= observation.confirmations);
    assert.equal(health.caughtUp, true);
  },
);

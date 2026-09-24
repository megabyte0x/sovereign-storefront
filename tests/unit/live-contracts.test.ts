import { expect, test } from 'vitest';
import {
  eligibleSnapshot,
  sameReceiver,
  validateAllocation,
  validateSnapshot,
} from '../../src/contracts/live-validation.ts';
import { fixtureAllocation, fixtureSnapshot } from '../support/live-fixtures.ts';
import { decodeMessage, encodeMessage } from '../../src/contracts/messages.ts';

test('validates a complete snapshot bound to one exact chain and account', () => {
  const snapshot = fixtureSnapshot();
  expect(validateSnapshot(snapshot)).toEqual(snapshot);
  expect(eligibleSnapshot(snapshot, 1_000_000, 120_000)).toBe(true);

  expect(() => validateSnapshot({ ...snapshot, receipts: new Array(10_001).fill(snapshot.receipts[0]) }))
    .toThrow(/receipt limit/);
  expect(() => validateSnapshot({ ...snapshot, receipts: [{ ...snapshot.receipts[0], accountId: 'another-account' }] }))
    .toThrow(/account/);
  expect(() => validateSnapshot({ ...snapshot, receipts: [snapshot.receipts[0], { ...snapshot.receipts[0], outputId: 'other-output' }] }))
    .toThrow(/identity/);
  expect(eligibleSnapshot({ ...snapshot, checkedAt: 1_000_001 }, 1_000_000, 120_000)).toBe(false);
  expect(eligibleSnapshot({ ...snapshot, complete: false }, 1_000_000, 120_000)).toBe(false);
  expect(eligibleSnapshot({ ...snapshot, scanned: { ...snapshot.scanned, hash: 'b'.repeat(64) } }, 1_000_000, 120_000)).toBe(false);
});

test('rejects malformed allocation material and compares canonical receiver bytes', () => {
  const allocation = fixtureAllocation();
  expect(validateAllocation(allocation)).toEqual(allocation);
  expect(sameReceiver(allocation.receiver, {
    ...allocation.receiver,
    diversifierIndex: 'ff'.repeat(11),
  })).toBe(true);
  expect(sameReceiver(allocation.receiver, {
    ...allocation.receiver,
    receiverHex: '00'.repeat(43),
  })).toBe(false);
  expect(() => validateAllocation({
    ...allocation,
    receiver: { ...allocation.receiver, diversifierIndex: '00'.repeat(10) },
  })).toThrow(/diversifier/);
  expect(() => validateAllocation({
    ...allocation,
    chain: { ...allocation.chain, network: 'main' as never },
  })).toThrow(/network/);
});

test('message codec rejects malformed headers, variants, nested bodies, and unknown fields', () => {
  const valid = {
    version: 1 as const, messageId: 'message-1', sellerKeyId: 'seller-key-1', network: 'regtest' as const,
    issuedAt: 1_000, expiresAt: 2_000, type: 'create' as const,
    requestId: 'request-1', productVersion: 'product-v1', expectedAmountZat: '100000000',
  };
  expect(decodeMessage(encodeMessage(valid))).toEqual(valid);
  expect(() => encodeMessage({ ...valid, ignored: true } as never)).toThrow(/unknown|malformed/);
  expect(() => encodeMessage({ ...valid, messageId: '' })).toThrow(/messageId/);
  expect(() => encodeMessage({ ...valid, expiresAt: valid.issuedAt - 1 })).toThrow(/expiresAt/);
  expect(() => encodeMessage({ ...valid, expectedAmountZat: '01' })).toThrow(/expectedAmountZat/);
  expect(() => decodeMessage(new TextEncoder().encode(JSON.stringify({ ...valid, type: 'other' })))).toThrow(/type/);
  expect(() => decodeMessage(new TextEncoder().encode(JSON.stringify({ ...valid, requestId: { value: 'request-1' } })))).toThrow(/requestId/);
  expect(() => decodeMessage(new Uint8Array(65_537))).toThrow(/size/);
});

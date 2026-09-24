import type { Invoice } from '../../src/contracts/types.ts';
import type { ReceiverAllocation, ScanSnapshot } from '../../src/contracts/live.ts';

const chain = {
  network: 'regtest' as const,
  genesisHash: 'a'.repeat(64),
  consensusFingerprint: 'c'.repeat(64),
};

export function fixtureAllocation(overrides: Partial<ReceiverAllocation> = {}): ReceiverAllocation {
  const allocation: ReceiverAllocation = {
    allocationId: 'allocation-1',
    chain: { ...chain },
    accountId: 'seller-account-0',
    amountZat: '100000000',
    expiresAt: 2_000_000,
    destination: 'uregtest1fixture-only-receiver',
    receiver: {
      accountId: 'seller-account-0',
      scope: 'external',
      pool: 'orchard',
      diversifierIndex: '01'.repeat(11),
      receiverHex: '02'.repeat(43),
    },
    paymentUri: 'zcash:uregtest1fixture-only-receiver?amount=1',
  };
  return {
    ...allocation,
    ...overrides,
    chain: { ...allocation.chain, ...overrides.chain },
    receiver: { ...allocation.receiver, ...overrides.receiver },
  };
}

export function fixtureSnapshot(overrides: Partial<ScanSnapshot> = {}): ScanSnapshot {
  const allocation = fixtureAllocation();
  const snapshot: ScanSnapshot = {
    version: 1,
    sourceId: 'fixture-scanner',
    generation: '1',
    chain: { ...chain },
    accountId: allocation.accountId,
    tip: { height: 20, hash: 'd'.repeat(64) },
    scanned: { height: 20, hash: 'd'.repeat(64) },
    checkedAt: 1_000_000,
    caughtUp: true,
    complete: true,
    health: 'ready',
    receipts: [{
      outputId: 'output-1',
      txid: 'e'.repeat(64),
      pool: 'orchard',
      outputIndex: 0,
      accountId: allocation.accountId,
      scope: 'external',
      receiverHex: allocation.receiver.receiverHex,
      amountZat: allocation.amountZat,
      firstSeenAt: 999_000,
      mined: { height: 20, hash: 'd'.repeat(64) },
      canonical: true,
    }],
  };
  return {
    ...snapshot,
    ...overrides,
    chain: { ...snapshot.chain, ...overrides.chain },
    tip: { ...snapshot.tip, ...overrides.tip },
    scanned: { ...snapshot.scanned, ...overrides.scanned },
    receipts: overrides.receipts ?? snapshot.receipts.map((receipt) => ({ ...receipt, mined: receipt.mined && { ...receipt.mined } })),
  };
}

export function fixtureInvoice(overrides: Partial<Invoice> = {}): Invoice {
  const allocation = fixtureAllocation();
  return {
    id: 'invoice-1',
    orderId: 'order-1',
    productVersion: 'product-v1',
    buyerKeyId: 'buyer-key-1',
    network: 'regtest',
    chain: allocation.chain,
    accountId: allocation.accountId,
    amountZat: allocation.amountZat,
    destination: allocation.destination,
    paymentUri: allocation.paymentUri,
    attribution: { kind: 'receiver', allocationId: allocation.allocationId, receiver: allocation.receiver },
    expiresAt: 2_000_000,
    ...overrides,
  };
}

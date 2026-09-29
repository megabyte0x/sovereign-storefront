export type Network = 'test' | 'regtest';

export type ChainIdentity = {
  network: Network;
  genesisHash: string;
  consensusFingerprint: string;
};

export type ReceiverRef = {
  accountId: string;
  scope: 'external';
  pool: 'orchard';
  /** Hex encoding of exactly 11 raw diversifier-index bytes. */
  diversifierIndex: string;
  /** Hex encoding of the decoded, library-serialized Orchard receiver bytes. */
  receiverHex: string;
};

export type AllocateReceiver = {
  allocationId: string;
  chain: ChainIdentity;
  accountId: string;
  amountZat: string;
  expiresAt: number;
};

export type ReceiverAllocation = AllocateReceiver & {
  destination: string;
  receiver: ReceiverRef;
  paymentUri: string;
};

/**
 * Pools whose notes pay the Orchard receiver the scanner allocates. After NU6.3
 * a payment to an Orchard receiver is recorded in the Ironwood pool.
 */
export const RECEIPT_POOLS = ['orchard', 'ironwood'] as const;
export type ReceiptPool = (typeof RECEIPT_POOLS)[number];

export function isReceiptPool(value: unknown): value is ReceiptPool {
  return typeof value === 'string' && (RECEIPT_POOLS as readonly string[]).includes(value);
}

export type Receipt = {
  outputId: string;
  txid: string;
  pool: string;
  outputIndex: number;
  accountId: string;
  scope: 'external' | 'internal';
  receiverHex: string;
  amountZat: string;
  firstSeenAt: number;
  mined: { height: number; hash: string } | null;
  canonical: boolean;
};

export type ScanSnapshot = {
  version: 1;
  sourceId: string;
  /** Strictly positive canonical decimal, ordered as an integer rather than height. */
  generation: string;
  chain: ChainIdentity;
  accountId: string;
  tip: { height: number; hash: string };
  scanned: { height: number; hash: string };
  checkedAt: number;
  caughtUp: boolean;
  complete: boolean;
  health: 'ready' | 'syncing' | 'unavailable';
  receipts: Receipt[];
};

export interface ReceiptSource {
  snapshot(): Promise<ScanSnapshot>;
  allocateReceiver(input: AllocateReceiver): Promise<ReceiverAllocation>;
  close(): Promise<void>;
}

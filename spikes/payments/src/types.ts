export type PaymentState =
  | 'awaiting'
  | 'detected'
  | 'confirming'
  | 'confirmed'
  | 'review_required'
  | 'reorged';

export type ReviewReason =
  | 'underpayment'
  | 'overpayment'
  | 'late'
  | 'unmatched'
  | 'duplicate';

export type ExceptionCode =
  | ReviewReason
  | 'reorg_after_release'
  | 'delivery_failed'
  | 'verification_unavailable';

export type ChainRevision = { id: string; height: number };
export type ScanCheckpoint = { revision: ChainRevision };

export type Invoice = {
  id: string;
  orderId: string;
  productVersion: string;
  buyerKeyId: string;
  network: 'test';
  amountZat: string;
  destination: string;
  attributionRef: string;
  expiresAt: number;
};

export type Observation = {
  outputId: string;
  invoiceId: string | null;
  amountZat: string;
  confirmations: number;
  canonical: boolean;
  receivedAt: number;
  revision: ChainRevision;
};

export type ScanHealth = {
  healthy: boolean;
  checkedAt: number;
  revision: ChainRevision;
  caughtUp: boolean;
};

export type Policy = {
  minConfirmations: number;
  maxHealthAgeMs: number;
};

export type ExceptionRecord = {
  id: string;
  orderId: string;
  code: ExceptionCode;
  createdAt: number;
  detail: string;
};

export type InvoiceSettlement = {
  payment: PaymentState;
  releaseEligible: boolean;
  backingOutputIds: string[];
  exceptions: ExceptionRecord[];
};

export interface Scanner {
  health(): Promise<ScanHealth>;
  observations(from: ScanCheckpoint | null): AsyncIterable<Observation>;
}

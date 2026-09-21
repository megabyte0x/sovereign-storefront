export type PaymentState =
  | 'awaiting' | 'detected' | 'confirming' | 'confirmed'
  | 'review_required' | 'reorged';
export type DeliveryState =
  | 'locked' | 'prepared' | 'queued'
  | 'sent_unacknowledged' | 'acknowledged' | 'retry_required';
export type ReviewReason =
  | 'underpayment' | 'overpayment' | 'late' | 'unmatched' | 'duplicate';
export type ExceptionCode =
  | ReviewReason | 'reorg_after_release' | 'delivery_failed' | 'verification_unavailable';
export type Verification = 'available' | 'unavailable' | 'stale';

export type ChainRevision = { id: string; height: number };
export type ScanCheckpoint = { revision: ChainRevision };

export type Invoice = {
  id: string; orderId: string; productVersion: string;
  buyerKeyId: string; network: 'test'; amountZat: string;
  destination: string; attributionRef: string;
  expiresAt: number;
};
export type Observation = {
  outputId: string; invoiceId: string | null; amountZat: string;
  confirmations: number; canonical: boolean; receivedAt: number;
  revision: ChainRevision;
};
export type ScanHealth = {
  healthy: boolean; checkedAt: number;
  revision: ChainRevision; caughtUp: boolean;
};
export type Policy = {
  minConfirmations: number; maxHealthAgeMs: number;
};
export type ExceptionRecord = {
  id: string; orderId: string; code: ExceptionCode;
  createdAt: number; detail: string;
};
export type InvoiceSettlement = {
  payment: PaymentState;
  releaseEligible: boolean;
  backingOutputIds: string[];
  exceptions: ExceptionRecord[];
};
export type OrderStatus = {
  payment: PaymentState;
  delivery: DeliveryState;
  verification: Verification;
  exceptions: Array<{ code: ExceptionCode }>;
};
export type BrowserPurchase = {
  version: 1; requestId: string; orderId: string | null;
  productVersion: string;
  sellerOrigin: string; sellerKeyId: string;
  credentialId: string; invoice: Invoice | null;
};
export type DeliveryPackage = {
  orderId: string; productVersion: string; buyerKeyId: string;
  encryptedEnvelope: Uint8Array;
};
export type ReleaseDecision = {
  disclose: boolean;
  reason: 'not_eligible' | 'first_release' | 'replay';
  delivery: DeliveryState;
  package: DeliveryPackage | null;
};
export type ServiceAvailability = {
  productPublished: boolean;
  messaging: boolean;
  storageReplica: boolean;
  scanner: boolean;
};
export function allowNewCheckout(a: ServiceAvailability): boolean {
  return a.productPublished && a.messaging && a.storageReplica && a.scanner;
}

export interface PurchaseStore {
  save(record: BrowserPurchase): Promise<void>;
  get(requestId: string): Promise<BrowserPurchase | null>;
  list(): Promise<BrowserPurchase[]>;
  exportBackup(requestId: string): Promise<Uint8Array>;
  importBackup(data: Uint8Array): Promise<BrowserPurchase>;
}
export interface Scanner {
  health(): Promise<ScanHealth>;
  observations(from: ScanCheckpoint | null): AsyncIterable<Observation>;
}
export interface StorageAdapter {
  publish(ciphertext: Uint8Array): Promise<string>;
  fetch(cid: string): Promise<Uint8Array>;
  verifyReplica(cid: string, replicaId: string): Promise<boolean>;
}
export interface OrderTransport {
  create(record: BrowserPurchase): Promise<Invoice>;
  status(orderId: string, credentialId: string): Promise<OrderStatus>;
  recover(orderId: string, credentialId: string): Promise<DeliveryPackage>;
}
export interface CredentialAdapter {
  createPurchaseCredential(): Promise<{ credentialId: string; buyerKeyId: string; exportable: boolean }>;
  provePossession(credentialId: string): Promise<Uint8Array>;
  verifyPossession(buyerKeyId: string, proof: Uint8Array): Promise<boolean>;
  exportBackupMaterial(credentialId: string): Promise<Uint8Array>;
  importBackupMaterial(data: Uint8Array): Promise<{ credentialId: string; buyerKeyId: string }>;
}
export interface CryptoAdapter {
  encryptProduct(plaintext: Uint8Array): Promise<{ ciphertext: Uint8Array; keyRef: string }>;
  sealDelivery(input: {
    orderId: string; productVersion: string; buyerKeyId: string; productKeyRef: string;
  }): Promise<Uint8Array>;
  openDelivery(envelope: Uint8Array, credentialId: string): Promise<{ productKey: Uint8Array }>;
}
export interface ManifestVerifier {
  verify(manifest: Uint8Array, ciphertext: Uint8Array): Promise<boolean>;
}
export interface SellerStore {
  createOrder(input: {
    requestId: string; buyerKeyId: string; productVersion: string;
  }): Promise<{ id: string }>;
  getOrCreateInvoice(input: {
    orderId: string; buyerKeyId: string; productVersion: string; now: number;
    availability: ServiceAvailability;
  }): Promise<Invoice>;
  getInvoice(orderId: string): Promise<Invoice | null>;
  getCheckpoint(): Promise<ScanCheckpoint | null>;
  commitReconciliation(input: {
    checkpoint: ScanCheckpoint;
    observations: Observation[];
    settlements: InvoiceSettlement[];
  }): Promise<void>;
  savePreparedPackage(pkg: DeliveryPackage): Promise<void>;
  getPreparedPackage(orderId: string): Promise<DeliveryPackage | null>;
  getDelivery(orderId: string): Promise<DeliveryState>;
  compareAndSetDelivery(orderId: string, expected: DeliveryState, next: DeliveryState, revision: ChainRevision): Promise<boolean>;
  recordSendAttempt(orderId: string): Promise<void>;
  recordException(record: ExceptionRecord): Promise<void>;
  listExceptions(orderId: string): Promise<ExceptionRecord[]>;
  close(): Promise<void>;
}

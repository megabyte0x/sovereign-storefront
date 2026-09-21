import type {
  BrowserPurchase,
  CredentialAdapter,
  Invoice,
  OrderTransport,
  PurchaseStore,
} from '../contracts/types.ts';

export type CheckoutDraft = Pick<
  BrowserPurchase,
  'version' | 'requestId' | 'productVersion' | 'sellerOrigin' | 'sellerKeyId'
>;

function assertCanonicalAmount(value: string): void {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]*)$/.test(value)) {
    throw new Error('amount must be a canonical unsigned decimal string');
  }
}

function assertInvoiceBinding(record: BrowserPurchase, invoice: Invoice): void {
  if (invoice.productVersion !== record.productVersion) {
    throw new Error('invoice product version does not match');
  }
  if (invoice.network !== 'test') {
    throw new Error('invoice network is not test');
  }
  assertCanonicalAmount(invoice.amountZat);
  if (!invoice.id || !invoice.orderId || !invoice.destination || !invoice.attributionRef) {
    throw new Error('invoice terms are incomplete');
  }
  if (!Number.isFinite(invoice.expiresAt)) {
    throw new Error('invoice expiry is invalid');
  }
}

async function requireUsableCredential(
  credentials: CredentialAdapter,
  credentialId: string,
): Promise<void> {
  const proof = await credentials.provePossession(credentialId);
  if (!(proof instanceof Uint8Array) || proof.byteLength === 0) {
    throw new Error('credential is not usable');
  }
}

function draftRecord(
  draft: CheckoutDraft,
  credentialId: string,
  existing?: BrowserPurchase | null,
): BrowserPurchase {
  return {
    version: 1,
    requestId: draft.requestId,
    productVersion: draft.productVersion,
    sellerOrigin: draft.sellerOrigin,
    sellerKeyId: draft.sellerKeyId,
    credentialId,
    orderId: existing?.orderId ?? null,
    invoice: existing?.invoice ?? null,
  };
}

export async function beginCheckout(
  store: PurchaseStore,
  transport: OrderTransport,
  credentials: CredentialAdapter,
  draft: CheckoutDraft,
): Promise<Invoice> {
  const existing = await store.get(draft.requestId);
  const credentialId = existing?.credentialId
    ? existing.credentialId
    : (await credentials.createPurchaseCredential()).credentialId;

  const pending = draftRecord(draft, credentialId, existing);
  await store.save(pending);
  const savedDraft = await store.get(draft.requestId);
  if (!savedDraft?.credentialId || savedDraft.productVersion !== draft.productVersion) {
    throw new Error('purchase draft was not persisted');
  }
  await requireUsableCredential(credentials, savedDraft.credentialId);

  if (savedDraft.invoice) {
    assertInvoiceBinding(savedDraft, savedDraft.invoice);
    const proof = await credentials.provePossession(savedDraft.credentialId);
    if (!await credentials.verifyPossession(savedDraft.invoice.buyerKeyId, proof)) {
      throw new Error('invoice is not bound to this buyer');
    }
    return savedDraft.invoice;
  }

  const invoice = await transport.create(savedDraft);
  assertInvoiceBinding(savedDraft, invoice);
  const proof = await credentials.provePossession(savedDraft.credentialId);
  if (!await credentials.verifyPossession(invoice.buyerKeyId, proof)) {
    throw new Error('invoice is not bound to this buyer');
  }

  const completed: BrowserPurchase = {
    ...savedDraft,
    orderId: invoice.orderId,
    invoice,
  };
  await store.save(completed);
  const saved = await store.get(draft.requestId);
  if (!saved?.invoice) {
    throw new Error('invoice was not persisted');
  }
  return saved.invoice;
}

export function paymentInstructions(
  purchase: BrowserPurchase,
  now: number,
): Invoice | null {
  if (!purchase.invoice) {
    return null;
  }
  if (purchase.invoice.expiresAt <= now) {
    return null;
  }
  return purchase.invoice;
}

export function renderPaymentInstructions(
  el: { textContent: string | null; dataset: Record<string, string> },
  purchase: BrowserPurchase,
  now: number,
): void {
  const invoice = paymentInstructions(purchase, now);
  if (!invoice) {
    el.textContent =
      'This invoice is expired and unpaid. Start a new checkout with a new request ID. Existing terms are kept for late-payment monitoring.';
    el.dataset.payment = 'blocked';
    return;
  }
  el.textContent = `Pay ${invoice.amountZat} zat to ${invoice.destination}`;
  el.dataset.payment = 'ready';
}

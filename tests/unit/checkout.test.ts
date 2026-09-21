import { expect, test, vi } from 'vitest';
import { beginCheckout, paymentInstructions } from '../../src/browser/checkout.ts';
import type {
  BrowserPurchase,
  CredentialAdapter,
  Invoice,
  OrderTransport,
  PurchaseStore,
} from '../../src/contracts/types.ts';

const draft: Pick<
  BrowserPurchase,
  'version' | 'requestId' | 'productVersion' | 'sellerOrigin' | 'sellerKeyId'
> = {
  version: 1,
  requestId: 'req-1',
  productVersion: 'book-v1',
  sellerOrigin: 'http://seller.example',
  sellerKeyId: 'seller-key-1',
};

function memoryStore(seed: BrowserPurchase[] = []): PurchaseStore {
  const records = new Map<string, BrowserPurchase>(seed.map((row) => [row.requestId, structuredClone(row)]));
  return {
    async save(record) {
      records.set(record.requestId, structuredClone(record));
    },
    async get(requestId) {
      const row = records.get(requestId);
      return row ? structuredClone(row) : null;
    },
    async list() {
      return [...records.values()].map((row) => structuredClone(row));
    },
    async exportBackup() {
      throw new Error('not used in unit tests');
    },
    async importBackup() {
      throw new Error('not used in unit tests');
    },
  };
}

function mockCredentials(): CredentialAdapter {
  let issued = 0;
  return {
    createPurchaseCredential: vi.fn(async () => {
      issued += 1;
      return {
        credentialId: `cred-${issued}`,
        buyerKeyId: `buyer-${issued}`,
        exportable: true,
      };
    }),
    provePossession: vi.fn(async () => new Uint8Array([1])),
    verifyPossession: vi.fn(async () => true),
    exportBackupMaterial: vi.fn(async () => new Uint8Array()),
    importBackupMaterial: vi.fn(async () => ({
      credentialId: 'cred-new',
      buyerKeyId: 'buyer-1',
    })),
  };
}

function mockTransport(invoice?: Invoice): OrderTransport {
  return {
    create: vi.fn(async (): Promise<Invoice> => invoice ?? {
      id: 'inv-1',
      orderId: 'ord-1',
      productVersion: 'book-v1',
      buyerKeyId: 'buyer-1',
      network: 'test',
      amountZat: '100000000',
      destination: 'uregtest1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq',
      attributionRef: 'attr-1',
      expiresAt: 86_400_000,
    }),
    status: vi.fn(),
    recover: vi.fn(),
  };
}

test('beginCheckout does not request an invoice when store.save rejects', async () => {
  const rejectingStore: PurchaseStore = {
    save: async () => {
      throw new Error('quota exceeded');
    },
    get: async () => null,
    list: async () => [],
    exportBackup: async () => {
      throw new Error('quota exceeded');
    },
    importBackup: async () => {
      throw new Error('quota exceeded');
    },
  };
  const transport = mockTransport();
  const credentials = mockCredentials();

  await expect(beginCheckout(rejectingStore, transport, credentials, draft)).rejects.toThrow();
  expect(transport.create).not.toHaveBeenCalled();
});

test('beginCheckout reuses a persisted credential and does not mint another', async () => {
  const store = memoryStore();
  const transport = mockTransport();
  const credentials = mockCredentials();

  await store.save({...draft, credentialId: 'cred-1', orderId: null, invoice: null, productVersion: 'book-v1'});
  expect((await store.get(draft.requestId))?.invoice).toBeNull();
  const invoice = await beginCheckout(store, transport, credentials, draft);
  expect(credentials.createPurchaseCredential).not.toHaveBeenCalled();
  expect(transport.create).toHaveBeenCalledWith(expect.objectContaining({
    requestId: draft.requestId, productVersion: 'book-v1', credentialId: 'cred-1',
  }));
  expect(invoice.productVersion).toBe('book-v1');
});

test('retrying the same requestId reuses the original credential and invoice terms', async () => {
  const store = memoryStore();
  const transport = mockTransport();
  const credentials = mockCredentials();

  const first = await beginCheckout(store, transport, credentials, draft);
  const second = await beginCheckout(store, transport, credentials, draft);

  expect(credentials.createPurchaseCredential).toHaveBeenCalledTimes(1);
  expect(second).toEqual(first);
  expect((await store.get(draft.requestId))?.credentialId).toBe('cred-1');
});

test('a second distinct checkout mints a new purchase credential', async () => {
  const store = memoryStore();
  const transport = mockTransport();
  const credentials = mockCredentials();
  const otherDraft = { ...draft, requestId: 'req-2' };

  await beginCheckout(store, transport, credentials, draft);
  await beginCheckout(store, transport, credentials, otherDraft);

  expect(credentials.createPurchaseCredential).toHaveBeenCalledTimes(2);
  expect((await store.get(draft.requestId))?.credentialId).toBe('cred-1');
  expect((await store.get(otherDraft.requestId))?.credentialId).toBe('cred-2');
});

test('a failed invoice save does not return payment instructions and can be replayed', async () => {
  const records = new Map<string, BrowserPurchase>();
  let failInvoiceSave = true;
  const store: PurchaseStore = {
    async save(record) {
      if (record.invoice && failInvoiceSave) {
        throw new Error('second save failed');
      }
      records.set(record.requestId, structuredClone(record));
    },
    async get(requestId) {
      const row = records.get(requestId);
      return row ? structuredClone(row) : null;
    },
    async list() {
      return [...records.values()].map((row) => structuredClone(row));
    },
    async exportBackup() {
      throw new Error('not used');
    },
    async importBackup() {
      throw new Error('not used');
    },
  };
  const transport = mockTransport();
  const credentials = mockCredentials();

  await expect(beginCheckout(store, transport, credentials, draft)).rejects.toThrow('second save failed');
  expect((await store.get(draft.requestId))?.invoice).toBeNull();
  expect((await store.get(draft.requestId))?.credentialId).toBe('cred-1');

  failInvoiceSave = false;
  const invoice = await beginCheckout(store, transport, credentials, draft);
  expect(credentials.createPurchaseCredential).toHaveBeenCalledTimes(1);
  expect(invoice.productVersion).toBe('book-v1');
  expect((await store.get(draft.requestId))?.invoice).toEqual(invoice);
});

test('expired unpaid invoices do not present ordinary payment instructions', () => {
  const invoice: Invoice = {
    id: 'inv-1',
    orderId: 'ord-1',
    productVersion: 'book-v1',
    buyerKeyId: 'buyer-1',
    network: 'test',
    amountZat: '100000000',
    destination: 'uregtest1qqqq',
    attributionRef: 'attr-1',
    expiresAt: 1000,
  };
  const purchase: BrowserPurchase = {
    ...draft,
    credentialId: 'cred-1',
    orderId: invoice.orderId,
    invoice,
  };
  expect(paymentInstructions(purchase, 1000)).toBeNull();
  expect(paymentInstructions(purchase, 1001)).toBeNull();
  expect(paymentInstructions({ ...purchase, invoice: { ...invoice, expiresAt: 2000 } }, 1000)).toEqual({
    ...invoice,
    expiresAt: 2000,
  });
});

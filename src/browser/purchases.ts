import type {
  BrowserPurchase,
  CredentialAdapter,
  Invoice,
  PurchaseStore,
} from '../contracts/types.ts';
import type { StoredDelivery } from '../contracts/messages.ts';

export const BEARER_SECRET_WARNING =
  'This file grants access to the purchase and is not an ordinary receipt. Treat it as a bearer secret.';

export const STORAGE_FAILURE_GUIDANCE =
  'Storage failed. Export a backup, re-import it to confirm recovery, then retry. Payment is blocked until the purchase is stored.';

export const BACKUP_KIND = 'sovereign-storefront-purchase-backup';
export const BACKUP_VERSION = 1 as const;
export const IDB_SCHEMA_VERSION = 1 as const;
export const DEFAULT_DB_NAME = 'sovereign-storefront-purchases';
const PURCHASE_STORE = 'purchases';

type PersistFn = () => Promise<boolean>;

type IDBRequestLike<T> = {
  result: T;
  error: Error | null;
  onsuccess: ((ev?: unknown) => void) | null;
  onerror: ((ev?: unknown) => void) | null;
};

type IDBObjectStoreLike = {
  put(value: unknown): IDBRequestLike<unknown>;
  get(key: string): IDBRequestLike<unknown>;
  getAll(): IDBRequestLike<unknown>;
};

type IDBTransactionLike = {
  objectStore(name: string): IDBObjectStoreLike;
  oncomplete: ((ev?: unknown) => void) | null;
  onerror: ((ev?: unknown) => void) | null;
  onabort: ((ev?: unknown) => void) | null;
  error: Error | null;
};

type IDBDatabaseLike = {
  objectStoreNames: { contains(name: string): boolean };
  createObjectStore(name: string, options: { keyPath: string }): unknown;
  transaction(name: string, mode: 'readonly' | 'readwrite'): IDBTransactionLike;
  close(): void;
};

type IDBOpenRequestLike = IDBRequestLike<IDBDatabaseLike> & {
  onupgradeneeded: ((ev?: unknown) => void) | null;
};

export type IDBFactoryLike = {
  open(name: string, version?: number): IDBOpenRequestLike;
};

export type PurchaseStoreOptions = {
  sellerOrigin: string;
  sellerKeyId: string;
  credentials: CredentialAdapter;
  indexedDB?: IDBFactoryLike;
  persist?: PersistFn | null;
  dbName?: string;
};

type StoredPurchase = {
  schemaVersion: typeof IDB_SCHEMA_VERSION;
  version: 1;
  requestId: string;
  orderId: string | null;
  productVersion: string;
  sellerOrigin: string;
  sellerKeyId: string;
  credentialId: string;
  invoice: Invoice | null;
  credentialMaterial: number[];
  delivery?: { packageId: string; wireEnvelope: number[] };
};

type BackupEnvelope = {
  version: number;
  kind: string;
  warning: string;
  sellerOrigin: string;
  sellerKeyId: string;
  purchase: {
    version: 1;
    requestId: string;
    orderId: string | null;
    productVersion: string;
    invoice: Invoice | null;
  };
  credential: {
    privateKeyHex: string;
    publicKeyHex: string;
  };
};

export type WarningTarget = {
  textContent: string | null;
  setAttribute(name: string, value: string): void;
};

function requiredString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`malformed backup: ${field}`);
  }
  return value;
}

function sanitizeInvoice(value: unknown): Invoice | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value !== 'object') {
    throw new Error('malformed backup: invoice');
  }
  const row = value as Record<string, unknown>;
  const network = requiredString(row.network, 'invoice.network');
  if (network !== 'test') {
    throw new Error('malformed backup: invoice.network');
  }
  const amountZat = requiredString(row.amountZat, 'invoice.amountZat');
  if (!/^(0|[1-9][0-9]*)$/.test(amountZat)) {
    throw new Error('malformed backup: invoice.amountZat');
  }
  const expiresAt = row.expiresAt;
  if (typeof expiresAt !== 'number' || !Number.isFinite(expiresAt)) {
    throw new Error('malformed backup: invoice.expiresAt');
  }
  return {
    id: requiredString(row.id, 'invoice.id'),
    orderId: requiredString(row.orderId, 'invoice.orderId'),
    productVersion: requiredString(row.productVersion, 'invoice.productVersion'),
    buyerKeyId: requiredString(row.buyerKeyId, 'invoice.buyerKeyId'),
    network: 'test',
    amountZat,
    destination: requiredString(row.destination, 'invoice.destination'),
    attributionRef: requiredString(row.attributionRef, 'invoice.attributionRef'),
    expiresAt,
  };
}

function toPurchase(row: StoredPurchase): BrowserPurchase {
  return {
    version: 1,
    requestId: row.requestId,
    orderId: row.orderId,
    productVersion: row.productVersion,
    sellerOrigin: row.sellerOrigin,
    sellerKeyId: row.sellerKeyId,
    credentialId: row.credentialId,
    invoice: row.invoice,
  };
}

function requestDone<T>(request: IDBRequestLike<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('idb request failed'));
  });
}

function transactionDone(tx: IDBTransactionLike): Promise<void> {
  return new Promise((resolve, reject) => {
    const fail = () => reject(tx.error ?? new Error('idb transaction failed'));
    tx.oncomplete = () => resolve();
    tx.onerror = fail;
    tx.onabort = fail;
  });
}

function openDatabase(factory: IDBFactoryLike, name: string): Promise<IDBDatabaseLike> {
  return new Promise((resolve, reject) => {
    const request = factory.open(name, IDB_SCHEMA_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(PURCHASE_STORE)) {
        db.createObjectStore(PURCHASE_STORE, { keyPath: 'requestId' });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('idb open failed'));
  });
}

function getIndexedDB(override?: IDBFactoryLike): IDBFactoryLike {
  if (override) {
    return override;
  }
  const factory = (globalThis as { indexedDB?: IDBFactoryLike }).indexedDB;
  if (!factory) {
    throw new Error('IndexedDB is unavailable');
  }
  return factory;
}

function parseGateACredential(data: Uint8Array): { privateKeyHex: string; publicKeyHex: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(data));
  } catch {
    throw new Error('malformed backup: credential');
  }
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error('malformed backup: credential');
  }
  const row = parsed as Record<string, unknown>;
  const privateKeyHex = requiredString(row.privateKeyHex, 'credential.privateKeyHex');
  const publicKeyHex = requiredString(row.publicKeyHex, 'credential.publicKeyHex');
  if (!/^[0-9a-f]+$/i.test(privateKeyHex) || !/^[0-9a-f]+$/i.test(publicKeyHex)) {
    throw new Error('malformed backup: credential hex');
  }
  return { privateKeyHex, publicKeyHex };
}

export async function requestPersistentStorage(
  persist?: PersistFn | null,
): Promise<'granted' | 'denied' | 'unsupported'> {
  let fn = persist;
  if (fn === null) {
    return 'unsupported';
  }
  if (fn === undefined) {
    const navPersist = (globalThis as {
      navigator?: { storage?: { persist?: PersistFn } };
    }).navigator?.storage?.persist;
    if (typeof navPersist !== 'function') {
      return 'unsupported';
    }
    fn = navPersist.bind(
      (globalThis as unknown as { navigator: { storage: { persist: PersistFn } } }).navigator.storage,
    );
  }
  try {
    return (await fn()) ? 'granted' : 'denied';
  } catch {
    return 'denied';
  }
}

export function renderBackupGuidance(el: WarningTarget): void {
  el.textContent = `${BEARER_SECRET_WARNING} Password protection is optional and not required.`;
  el.setAttribute('data-backup-kind', 'bearer-secret');
  el.setAttribute('data-password-required', 'false');
}

export function renderStorageFailureGuidance(el: WarningTarget): void {
  el.textContent = STORAGE_FAILURE_GUIDANCE;
  el.setAttribute('data-payment', 'blocked');
}

export async function recoverFromBackupBeforePayment(
  store: PurchaseStore,
  backup: Uint8Array,
): Promise<BrowserPurchase> {
  const imported = await store.importBackup(backup);
  const read = await store.get(imported.requestId);
  if (!read?.credentialId) {
    throw new Error('re-import required before payment');
  }
  return read;
}

export async function openPurchaseStore(options: PurchaseStoreOptions): Promise<PurchaseStore> {
  await requestPersistentStorage(options.persist);
  const db = await openDatabase(getIndexedDB(options.indexedDB), options.dbName ?? DEFAULT_DB_NAME);
  const restored = new Map<string, string>();

  async function readStored(requestId: string): Promise<StoredPurchase | null> {
    const tx = db.transaction(PURCHASE_STORE, 'readonly');
    const request = tx.objectStore(PURCHASE_STORE).get(requestId);
    const row = await requestDone(request);
    return (row as StoredPurchase | undefined) ?? null;
  }

  async function writeStored(row: StoredPurchase): Promise<void> {
    const tx = db.transaction(PURCHASE_STORE, 'readwrite');
    const done = transactionDone(tx);
    tx.objectStore(PURCHASE_STORE).put(row);
    await done;
  }

  function assertSameSeller(origin: string, keyId: string): void {
    if (origin !== options.sellerOrigin) {
      throw new Error('stored origin does not match this seller');
    }
    if (keyId !== options.sellerKeyId) {
      throw new Error('stored seller identity does not match');
    }
  }

  async function hydrate(row: StoredPurchase): Promise<BrowserPurchase> {
    if (row.schemaVersion !== IDB_SCHEMA_VERSION) {
      throw new Error('unsupported purchase schema');
    }
    assertSameSeller(row.sellerOrigin, row.sellerKeyId);
    let credentialId = restored.get(row.requestId) ?? row.credentialId;
    if (!restored.has(row.requestId) && row.credentialMaterial?.length) {
      const imported = await options.credentials.importBackupMaterial(
        Uint8Array.from(row.credentialMaterial),
      );
      credentialId = imported.credentialId;
      restored.set(row.requestId, credentialId);
    }
    return toPurchase({ ...row, credentialId });
  }

  const store: PurchaseStore = {
    async save(record: BrowserPurchase): Promise<void> {
      assertSameSeller(record.sellerOrigin, record.sellerKeyId);
      const existing = await readStored(record.requestId);
      if (existing) {
        assertSameSeller(existing.sellerOrigin, existing.sellerKeyId);
      }
      const material = await options.credentials.exportBackupMaterial(record.credentialId);
      await writeStored({
        schemaVersion: IDB_SCHEMA_VERSION,
        version: 1,
        requestId: record.requestId,
        orderId: record.orderId,
        productVersion: record.productVersion,
        sellerOrigin: record.sellerOrigin,
        sellerKeyId: record.sellerKeyId,
        credentialId: record.credentialId,
        invoice: record.invoice,
        credentialMaterial: Array.from(material),
      });
      restored.set(record.requestId, record.credentialId);
      const read = await readStored(record.requestId);
      if (!read || read.credentialId !== record.credentialId || read.productVersion !== record.productVersion) {
        throw new Error('purchase was not persisted');
      }
    },
    async get(requestId: string): Promise<BrowserPurchase | null> {
      const row = await readStored(requestId);
      if (!row) {
        return null;
      }
      return hydrate(row);
    },
    async list(): Promise<BrowserPurchase[]> {
      const tx = db.transaction(PURCHASE_STORE, 'readonly');
      const request = tx.objectStore(PURCHASE_STORE).getAll();
      const rows = (await requestDone(request)) as StoredPurchase[];
      const out: BrowserPurchase[] = [];
      for (const row of rows ?? []) {
        out.push(await hydrate(row));
      }
      return out;
    },
    async exportBackup(requestId: string): Promise<Uint8Array> {
      const purchase = await store.get(requestId);
      if (!purchase) {
        throw new Error('unknown purchase');
      }
      const material = await options.credentials.exportBackupMaterial(purchase.credentialId);
      const credential = parseGateACredential(material);
      const envelope: BackupEnvelope = {
        version: BACKUP_VERSION,
        kind: BACKUP_KIND,
        warning: BEARER_SECRET_WARNING,
        sellerOrigin: options.sellerOrigin,
        sellerKeyId: options.sellerKeyId,
        purchase: {
          version: 1,
          requestId: purchase.requestId,
          orderId: purchase.orderId,
          productVersion: purchase.productVersion,
          invoice: purchase.invoice,
        },
        credential,
      };
      return new TextEncoder().encode(JSON.stringify(envelope));
    },
    async importBackup(data: Uint8Array): Promise<BrowserPurchase> {
      let parsed: unknown;
      try {
        parsed = JSON.parse(new TextDecoder().decode(data));
      } catch {
        throw new Error('malformed backup');
      }
      if (typeof parsed !== 'object' || parsed === null) {
        throw new Error('malformed backup');
      }
      const envelope = parsed as Record<string, unknown>;
      if (envelope.version !== BACKUP_VERSION) {
        throw new Error('unsupported backup version');
      }
      if (envelope.kind !== BACKUP_KIND) {
        throw new Error('malformed backup: kind');
      }
      const sellerOrigin = requiredString(envelope.sellerOrigin, 'sellerOrigin');
      const sellerKeyId = requiredString(envelope.sellerKeyId, 'sellerKeyId');
      if (sellerOrigin !== options.sellerOrigin) {
        throw new Error('backup origin does not match this seller');
      }
      if (sellerKeyId !== options.sellerKeyId) {
        throw new Error('imported seller identity does not match');
      }
      const currentOrigin = (globalThis as { location?: { origin?: string } }).location?.origin;
      if (currentOrigin && sellerOrigin !== currentOrigin) {
        throw new Error('backup origin does not match this site');
      }
      if (typeof envelope.purchase !== 'object' || envelope.purchase === null) {
        throw new Error('malformed backup: purchase');
      }
      if (typeof envelope.credential !== 'object' || envelope.credential === null) {
        throw new Error('malformed backup: credential');
      }
      const purchaseRow = envelope.purchase as Record<string, unknown>;
      const credential = envelope.credential as Record<string, unknown>;
      const privateKeyHex = requiredString(credential.privateKeyHex, 'credential.privateKeyHex');
      const publicKeyHex = requiredString(credential.publicKeyHex, 'credential.publicKeyHex');
      if (!/^[0-9a-f]+$/i.test(privateKeyHex) || !/^[0-9a-f]+$/i.test(publicKeyHex)) {
        throw new Error('malformed backup: credential hex');
      }
      const material = new TextEncoder().encode(JSON.stringify({
        v: 1,
        privateKeyHex,
        publicKeyHex,
      }));
      const imported = await options.credentials.importBackupMaterial(material);
      const record: BrowserPurchase = {
        version: 1,
        requestId: requiredString(purchaseRow.requestId, 'purchase.requestId'),
        orderId: purchaseRow.orderId === null || purchaseRow.orderId === undefined
          ? null
          : requiredString(purchaseRow.orderId, 'purchase.orderId'),
        productVersion: requiredString(purchaseRow.productVersion, 'purchase.productVersion'),
        sellerOrigin: options.sellerOrigin,
        sellerKeyId: options.sellerKeyId,
        credentialId: imported.credentialId,
        invoice: sanitizeInvoice(purchaseRow.invoice),
      };
      await store.save(record);
      const read = await store.get(record.requestId);
      if (!read) {
        throw new Error('imported purchase was not persisted');
      }
      return read;
    },
    async saveDelivery(orderId: string, delivery: StoredDelivery): Promise<void> {
      if (!delivery.packageId || !(delivery.wireEnvelope instanceof Uint8Array) || delivery.wireEnvelope.byteLength === 0) {
        throw new Error('malformed delivery');
      }
      const tx = db.transaction(PURCHASE_STORE, 'readonly');
      const rows = (await requestDone(tx.objectStore(PURCHASE_STORE).getAll())) as StoredPurchase[];
      const row = rows.find((candidate) => candidate.orderId === orderId);
      if (!row) throw new Error('unknown purchase order');
      await writeStored({ ...row, delivery: { packageId: delivery.packageId, wireEnvelope: Array.from(delivery.wireEnvelope) } });
    },
    async getDelivery(orderId: string): Promise<StoredDelivery | null> {
      const tx = db.transaction(PURCHASE_STORE, 'readonly');
      const rows = (await requestDone(tx.objectStore(PURCHASE_STORE).getAll())) as StoredPurchase[];
      const delivery = rows.find((candidate) => candidate.orderId === orderId)?.delivery;
      return delivery ? { packageId: delivery.packageId, wireEnvelope: Uint8Array.from(delivery.wireEnvelope) } : null;
    },
  };
  return store;
}

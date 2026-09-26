import type {
  BrowserPurchase,
  CredentialAdapter,
  Invoice,
  PurchaseStore,
} from '../contracts/types.ts';
import { MAX_MESSAGE_BYTES, type StoredDelivery } from '../contracts/messages.ts';
import type { ChainIdentity, Network, ReceiverRef } from '../contracts/live.ts';
import { validateChainIdentity, validateReceiver } from '../contracts/live-validation.ts';
import { hexToBytes } from '@waku/utils/bytes';
import { importVerifySession, verifyImportedDelivery } from './waku-transport.ts';

export const BEARER_SECRET_WARNING =
  'This file grants access to the purchase and is not an ordinary receipt. Treat it as a bearer secret.';

export const STORAGE_FAILURE_GUIDANCE =
  'Storage failed. Export a backup, re-import it to confirm recovery, then retry. Payment is blocked until the purchase is stored.';

export const BACKUP_KIND = 'sovereign-storefront-purchase-backup';
/**
 * Backup envelope version. v2 adds the retained signed delivery (package id +
 * original wire envelope); v1 backups (no delivery) are still importable.
 */
export const BACKUP_VERSION = 2 as const;
const LEGACY_BACKUP_VERSION = 1;
/**
 * Per-record schema version stored on every IndexedDB purchase row. v2 makes
 * the retained delivery an explicit field (`null` when absent). v1 rows are
 * migrated in place on first read without touching the credential material;
 * any other (future/unknown) version is refused and never overwritten.
 */
export const IDB_SCHEMA_VERSION = 2 as const;
const LEGACY_SCHEMA_VERSION = 1;
/** IndexedDB database version (object-store layout), independent of row schema. */
const IDB_DATABASE_VERSION = 1;
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
  /**
   * Content topic the retained delivery was sealed on. A v2 backup's delivery
   * is re-verified with decodeStored on this topic before it is stored; with
   * no topic, a delivery-bearing backup is rejected rather than trusted.
   */
  contentTopic?: string;
};

type StoredDeliveryRow = { packageId: string; wireEnvelope: number[] };

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
  delivery: StoredDeliveryRow | null;
};

/** A row as read from IndexedDB: any schema version may be on disk. */
type RawStoredPurchase = Omit<StoredPurchase, 'schemaVersion' | 'delivery'> & {
  schemaVersion: unknown;
  delivery?: StoredDeliveryRow | null;
};

type BackupEnvelope = {
  version: number;
  kind: string;
  warning: string;
  sellerOrigin: string;
  sellerKeyId: string;
  contentTopic?: string;
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
  delivery: StoredDeliveryRow | null;
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

/**
 * A live (real-demo) invoice: receiver-attributed, bound to a chain identity,
 * never carrying the legacy `attributionRef`. Chain and receiver checks reuse
 * the contract validators; any failure is reported as a malformed invoice.
 */
function sanitizeLiveInvoice(row: Record<string, unknown>): Invoice {
  const invalid = (field: string): never => { throw new Error(`malformed backup: invoice.${field}`); };
  const network = row.network;
  if (network !== 'test' && network !== 'regtest') invalid('network');
  if (row.attributionRef !== undefined) invalid('attributionRef');
  let chain: ChainIdentity;
  try { chain = validateChainIdentity(row.chain); } catch { return invalid('chain'); }
  if (chain.network !== network) invalid('chain');
  const accountId = requiredString(row.accountId, 'invoice.accountId');
  const attribution = row.attribution as Record<string, unknown>;
  if (attribution.kind !== 'receiver') invalid('attribution');
  const allocationId = requiredString(attribution.allocationId, 'invoice.attribution.allocationId');
  let receiver: ReceiverRef;
  try { receiver = validateReceiver(attribution.receiver, accountId); } catch { return invalid('attribution.receiver'); }
  const amountZat = requiredString(row.amountZat, 'invoice.amountZat');
  if (!/^[1-9][0-9]*$/.test(amountZat)) invalid('amountZat');
  const paymentUri = requiredString(row.paymentUri, 'invoice.paymentUri');
  if (!paymentUri.startsWith('zcash:')) invalid('paymentUri');
  const expiresAt = row.expiresAt;
  if (typeof expiresAt !== 'number' || !Number.isFinite(expiresAt)) invalid('expiresAt');
  return {
    id: requiredString(row.id, 'invoice.id'),
    orderId: requiredString(row.orderId, 'invoice.orderId'),
    productVersion: requiredString(row.productVersion, 'invoice.productVersion'),
    buyerKeyId: requiredString(row.buyerKeyId, 'invoice.buyerKeyId'),
    network: network as Network,
    chain,
    accountId,
    amountZat,
    destination: requiredString(row.destination, 'invoice.destination'),
    paymentUri,
    attribution: { kind: 'receiver', allocationId, receiver },
    expiresAt: expiresAt as number,
  };
}

function sanitizeInvoice(value: unknown): Invoice | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value !== 'object') {
    throw new Error('malformed backup: invoice');
  }
  const row = value as Record<string, unknown>;
  if (typeof row.attribution === 'object' && row.attribution !== null) {
    return sanitizeLiveInvoice(row);
  }
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

function sanitizeDelivery(value: unknown): StoredDeliveryRow | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('malformed backup: delivery');
  }
  const row = value as Record<string, unknown>;
  const packageId = row.packageId;
  const wire = row.wireEnvelope;
  if (typeof packageId !== 'string' || !/^[A-Za-z0-9._:-]{1,256}$/.test(packageId)) {
    throw new Error('malformed backup: delivery');
  }
  if (!Array.isArray(wire) || wire.length === 0 || wire.length > MAX_MESSAGE_BYTES
    || !wire.every((b) => typeof b === 'number' && Number.isInteger(b) && b >= 0 && b <= 255)) {
    throw new Error('malformed backup: delivery');
  }
  return { packageId, wireEnvelope: [...wire] as number[] };
}

/**
 * Brings a raw row to the current schema. Returns `migrated: true` when the
 * row was a legacy v1 row that must be written back. Throws (without any
 * write) for an unknown schema version.
 */
function upgradeRow(raw: RawStoredPurchase): { row: StoredPurchase; migrated: boolean } {
  if (raw.schemaVersion === IDB_SCHEMA_VERSION) {
    return { row: { ...raw, schemaVersion: IDB_SCHEMA_VERSION, delivery: raw.delivery ?? null }, migrated: false };
  }
  if (raw.schemaVersion === LEGACY_SCHEMA_VERSION) {
    // v1 → v2: only the schema tag changes and `delivery` becomes explicit.
    // Credential material and every other field are carried over verbatim.
    return { row: { ...raw, schemaVersion: IDB_SCHEMA_VERSION, delivery: raw.delivery ?? null }, migrated: true };
  }
  throw new Error('unsupported purchase schema');
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
    const request = factory.open(name, IDB_DATABASE_VERSION);
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

  async function readRaw(requestId: string): Promise<RawStoredPurchase | null> {
    const tx = db.transaction(PURCHASE_STORE, 'readonly');
    const request = tx.objectStore(PURCHASE_STORE).get(requestId);
    const row = await requestDone(request);
    return (row as RawStoredPurchase | undefined) ?? null;
  }

  async function readAllRaw(): Promise<RawStoredPurchase[]> {
    const tx = db.transaction(PURCHASE_STORE, 'readonly');
    const rows = (await requestDone(tx.objectStore(PURCHASE_STORE).getAll())) as RawStoredPurchase[] | undefined;
    return rows ?? [];
  }

  /** Reads and upgrades one row; a legacy row is migrated and written back. */
  async function upgradeAndPersist(raw: RawStoredPurchase): Promise<StoredPurchase> {
    const { row, migrated } = upgradeRow(raw);
    if (migrated) {
      await writeStored(row);
    }
    return row;
  }

  async function readStored(requestId: string): Promise<StoredPurchase | null> {
    const raw = await readRaw(requestId);
    return raw ? upgradeAndPersist(raw) : null;
  }

  async function findByOrder(orderId: string): Promise<StoredPurchase | null> {
    const raw = (await readAllRaw()).find((candidate) => candidate.orderId === orderId);
    return raw ? upgradeAndPersist(raw) : null;
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
      // readStored refuses (throws, no write) an unknown-version row, so a
      // future record is never clobbered by an older client.
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
        // Re-saving the same purchase must not drop its retained delivery.
        delivery: existing?.delivery ?? null,
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
      const rows = await readAllRaw();
      const out: BrowserPurchase[] = [];
      let skipped = 0;
      for (const raw of rows) {
        // One unknown-version row must not fail the whole list. It is counted
        // and left untouched — never upgraded, never overwritten.
        if (raw.schemaVersion !== IDB_SCHEMA_VERSION && raw.schemaVersion !== LEGACY_SCHEMA_VERSION) {
          skipped += 1;
          continue;
        }
        out.push(await hydrate(await upgradeAndPersist(raw)));
      }
      // A skipped count rides on the array so callers can surface a notice
      // without a second round trip. Zero stays off the array.
      if (skipped > 0) {
        Object.defineProperty(out, 'skipped', { value: skipped, enumerable: false });
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
      const stored = await readStored(requestId);
      const envelope: BackupEnvelope = {
        version: BACKUP_VERSION,
        kind: BACKUP_KIND,
        warning: BEARER_SECRET_WARNING,
        sellerOrigin: options.sellerOrigin,
        sellerKeyId: options.sellerKeyId,
        ...(options.contentTopic ? { contentTopic: options.contentTopic } : {}),
        purchase: {
          version: 1,
          requestId: purchase.requestId,
          orderId: purchase.orderId,
          productVersion: purchase.productVersion,
          invoice: purchase.invoice,
        },
        credential,
        delivery: stored?.delivery ?? null,
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
      if (envelope.version !== BACKUP_VERSION && envelope.version !== LEGACY_BACKUP_VERSION) {
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
      // v1 backups carry no delivery. A v2 delivery is re-verified with
      // decodeStored — seller signature, buyer binding, derived package id —
      // before any credential is imported or any row is written. Shape alone
      // is not enough, and a failure rejects the whole import.
      const delivery = envelope.version === BACKUP_VERSION ? sanitizeDelivery(envelope.delivery) : null;
      if (delivery && options.contentTopic) {
        const topic = options.contentTopic;
        if (typeof envelope.contentTopic === 'string' && envelope.contentTopic !== topic) {
          throw new Error('backup could not be imported');
        }
        const orderId = typeof purchaseRow.orderId === 'string' ? purchaseRow.orderId : null;
        const productVersion = typeof purchaseRow.productVersion === 'string' ? purchaseRow.productVersion : '';
        const invoiceNet = (typeof purchaseRow.invoice === 'object' && purchaseRow.invoice !== null)
          ? (purchaseRow.invoice as { network?: unknown }).network
          : undefined;
        if (orderId === null || productVersion.length === 0) throw new Error('backup could not be imported');
        const session = importVerifySession(topic, hexToBytes(privateKeyHex));
        try {
          await verifyImportedDelivery(session, {
            packageId: delivery.packageId,
            wireEnvelope: Uint8Array.from(delivery.wireEnvelope),
          }, {
            sellerKeyId,
            buyerKeyId: publicKeyHex,
            orderId,
            productVersion,
            network: invoiceNet === 'regtest' ? 'regtest' : 'test',
          });
        } finally {
          await session.close().catch(() => undefined);
        }
      }
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
      if (delivery && record.orderId === null) {
        throw new Error('malformed backup: delivery');
      }
      await store.save(record);
      if (delivery && record.orderId !== null) {
        await store.saveDelivery(record.orderId, {
          packageId: delivery.packageId,
          wireEnvelope: Uint8Array.from(delivery.wireEnvelope),
        });
      }
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
      const row = await findByOrder(orderId);
      if (!row) throw new Error('unknown purchase order');
      // Never overwrite a retained delivery with a different package. The same
      // packageId is a no-op (the push path's rule, now enforced here too).
      if (row.delivery) {
        if (row.delivery.packageId !== delivery.packageId) {
          throw new Error('delivery package id does not match the retained package');
        }
        return;
      }
      await writeStored({ ...row, delivery: { packageId: delivery.packageId, wireEnvelope: Array.from(delivery.wireEnvelope) } });
    },
    async getDelivery(orderId: string): Promise<StoredDelivery | null> {
      const delivery = (await findByOrder(orderId))?.delivery;
      return delivery ? { packageId: delivery.packageId, wireEnvelope: Uint8Array.from(delivery.wireEnvelope) } : null;
    },
  };
  return store;
}

import { describe, expect, test } from 'vitest';
import { createCredentialAdapter } from '../../src/adapters/credentials.ts';
import { generatePrivateKey, getPublicKey } from '@waku/message-encryption';
import { bytesToHex } from '@waku/utils/bytes';
import { createWakuSession } from '../../src/adapters/waku.ts';
import type { SellerResponse } from '../../src/contracts/messages.ts';
import {
  BACKUP_VERSION, IDB_SCHEMA_VERSION, openPurchaseStore, type IDBFactoryLike,
} from '../../src/browser/purchases.ts';
import type { BrowserPurchase, CredentialAdapter } from '../../src/contracts/types.ts';

const ORIGIN = 'http://127.0.0.1:8787';
const SELLER = 'seller-key-1';

type Rows = Map<string, Record<string, unknown>>;

/** Minimal IndexedDB double backed by a caller-visible Map, so a test can
 * seed legacy rows and observe exactly what was (not) written. */
function memoryIndexedDB(rows: Rows): IDBFactoryLike & { puts: number } {
  const factory = {
    puts: 0,
    open() {
      const db = {
        objectStoreNames: { contains: () => true },
        createObjectStore() {},
        transaction() {
          const tx = {
            oncomplete: null as ((ev?: unknown) => void) | null,
            onerror: null as ((ev?: unknown) => void) | null,
            onabort: null as ((ev?: unknown) => void) | null,
            error: null,
            objectStore() {
              const req = (result: unknown, effect?: () => void) => {
                const r = {
                  result, error: null,
                  onsuccess: null as ((ev?: unknown) => void) | null,
                  onerror: null as ((ev?: unknown) => void) | null,
                };
                queueMicrotask(() => { effect?.(); r.onsuccess?.(); if (effect) tx.oncomplete?.(); });
                return r;
              };
              return {
                put(value: { requestId: string }) {
                  return req(undefined, () => {
                    factory.puts += 1;
                    rows.set(value.requestId, structuredClone(value) as Record<string, unknown>);
                  });
                },
                get(key: string) { return req(structuredClone(rows.get(key))); },
                getAll() { return req([...rows.values()].map((v) => structuredClone(v))); },
              };
            },
          };
          return tx;
        },
        close() {},
      };
      const r = {
        result: db, error: null,
        onsuccess: null as ((ev?: unknown) => void) | null,
        onerror: null as ((ev?: unknown) => void) | null,
        onupgradeneeded: null as ((ev?: unknown) => void) | null,
      };
      queueMicrotask(() => { r.onupgradeneeded?.(); r.onsuccess?.(); });
      return r;
    },
  };
  return factory as IDBFactoryLike & { puts: number };
}

async function open(
  rows: Rows,
  credentials: CredentialAdapter = createCredentialAdapter(),
  extra: { contentTopic?: string; sellerKeyId?: string } = {},
) {
  const indexedDB = memoryIndexedDB(rows);
  const store = await openPurchaseStore({
    sellerOrigin: ORIGIN, sellerKeyId: extra.sellerKeyId ?? SELLER, credentials, indexedDB, persist: null, dbName: 'ssf-migration',
    ...(extra.contentTopic ? { contentTopic: extra.contentTopic } : {}),
  });
  return { store, indexedDB, credentials };
}

async function legacyV1Row(credentials: CredentialAdapter, requestId = 'req-v1') {
  const created = await credentials.createPurchaseCredential();
  const material = await credentials.exportBackupMaterial(created.credentialId);
  return {
    created,
    row: {
      schemaVersion: 1, version: 1, requestId, orderId: 'ord-v1', productVersion: 'book-v1',
      sellerOrigin: ORIGIN, sellerKeyId: SELLER, credentialId: created.credentialId, invoice: null,
      credentialMaterial: Array.from(material),
      delivery: { packageId: 'pkg-1', wireEnvelope: [1, 2, 3] },
    } as Record<string, unknown>,
  };
}

describe('purchase record schema versioning', () => {
  test('the store has an explicit schema version above the legacy v1', () => {
    expect(IDB_SCHEMA_VERSION).toBe(2);
    expect(BACKUP_VERSION).toBe(2);
  });

  test('a v1 record migrates to the current schema without losing the credential', async () => {
    const rows: Rows = new Map();
    const origin = createCredentialAdapter();
    const { created, row } = await legacyV1Row(origin);
    rows.set('req-v1', row);

    // A fresh adapter (new page load): the credential exists only in the row.
    const fresh = createCredentialAdapter();
    const { store } = await open(rows, fresh);
    const read = await store.get('req-v1');
    expect(read).not.toBeNull();
    expect(await fresh.publicKey(read!.credentialId)).toBe(await origin.publicKey(created.credentialId));

    const migrated = rows.get('req-v1')!;
    expect(migrated.schemaVersion).toBe(IDB_SCHEMA_VERSION);
    expect(migrated.credentialMaterial).toEqual(row.credentialMaterial);
    expect(migrated.delivery).toEqual(row.delivery);
    expect((await store.getDelivery('ord-v1'))!.packageId).toBe('pkg-1');
    expect(await store.list()).toHaveLength(1);
  });

  test('an unknown future record version is refused and never overwritten', async () => {
    const rows: Rows = new Map();
    const credentials = createCredentialAdapter();
    const { row } = await legacyV1Row(credentials, 'req-future');
    const future = { ...row, schemaVersion: 99, extra: 'from-the-future' };
    rows.set('req-future', future);
    const before = structuredClone(future);

    const { store, indexedDB } = await open(rows, credentials);
    await expect(store.get('req-future')).rejects.toThrow(/unsupported purchase schema/);
    // list() skips the unreadable row instead of failing the whole view, and
    // reports how many it skipped. It still writes nothing.
    const listed = await store.list() as BrowserPurchase[] & { skipped?: number };
    expect(listed).toEqual([]);
    expect(listed.skipped).toBe(1);
    const created = await credentials.createPurchaseCredential();
    const record: BrowserPurchase = {
      version: 1, requestId: 'req-future', orderId: 'ord-v1', productVersion: 'book-v1',
      sellerOrigin: ORIGIN, sellerKeyId: SELLER, credentialId: created.credentialId, invoice: null,
    };
    await expect(store.save(record)).rejects.toThrow(/unsupported purchase schema/);
    await expect(store.saveDelivery('ord-v1', { packageId: 'pkg-2', wireEnvelope: new Uint8Array([4]) }))
      .rejects.toThrow(/unsupported purchase schema/);
    expect(indexedDB.puts).toBe(0);
    expect(rows.get('req-future')).toEqual(before);
  });

  test('backup export/import round-trips the current version, including the stored delivery', async () => {
    const TOPIC = '/ssf/1/migration/proto';
    const rows: Rows = new Map();
    const sellerKey = generatePrivateKey();
    const sellerKeyId = bytesToHex(getPublicKey(sellerKey));
    const buyerKey = generatePrivateKey();
    const buyerKeyId = bytesToHex(getPublicKey(buyerKey));
    const credentials = createCredentialAdapter();
    // The store's credential must be the key the delivery was sealed to.
    const imported0 = await credentials.importBackupMaterial(new TextEncoder().encode(JSON.stringify({
      v: 1, privateKeyHex: bytesToHex(buyerKey), publicKeyHex: buyerKeyId,
    })));
    const seller = createWakuSession(
      { contentTopic: TOPIC, bootstrapPeers: [], peerTimeoutMs: 1 }, sellerKey,
      { createNode: async () => { throw new Error('no node'); } },
    );
    const envelopeBytes = new Uint8Array([7, 8, 9]);
    const packageId = (await import('node:crypto')).createHash('sha256')
      .update('ord-rt').update('\0').update('book-v1').update('\0').update(buyerKeyId).update('\0')
      .update(envelopeBytes).digest('hex');
    const now = Date.now();
    const wire = await seller.toWireForTest(buyerKeyId, {
      version: 1, messageId: `push-${packageId}`, inReplyTo: `push-${packageId}`,
      sellerKeyId, buyerKeyId, network: 'test', issuedAt: now, expiresAt: now + 60_000,
      type: 'delivery', packageId,
      package: { orderId: 'ord-rt', productVersion: 'book-v1', buyerKeyId, encryptedEnvelope: envelopeBytes },
    } satisfies SellerResponse);
    const { store } = await open(rows, credentials, { contentTopic: TOPIC, sellerKeyId });
    await store.save({
      version: 1, requestId: 'req-rt', orderId: 'ord-rt', productVersion: 'book-v1',
      sellerOrigin: ORIGIN, sellerKeyId, credentialId: imported0.credentialId, invoice: null,
    });
    await store.saveDelivery('ord-rt', { packageId, wireEnvelope: wire });
    const backup = await store.exportBackup('req-rt');
    const envelope = JSON.parse(new TextDecoder().decode(backup));
    expect(envelope.version).toBe(BACKUP_VERSION);
    expect(envelope.contentTopic).toBe(TOPIC);

    const otherRows: Rows = new Map();
    const other = createCredentialAdapter();
    const { store: restoredStore } = await open(otherRows, other, { contentTopic: TOPIC, sellerKeyId });
    const imported = await restoredStore.importBackup(backup);
    expect(await other.publicKey(imported.credentialId)).toBe(buyerKeyId);
    expect(otherRows.get('req-rt')!.schemaVersion).toBe(IDB_SCHEMA_VERSION);
    const delivery = await restoredStore.getDelivery('ord-rt');
    expect(delivery!.packageId).toBe(packageId);
    expect(Array.from(delivery!.wireEnvelope)).toEqual(Array.from(wire));
    await seller.close();
  });

  test('a legacy v1 backup still imports; a future backup version is refused', async () => {
    const credentials = createCredentialAdapter();
    const created = await credentials.createPurchaseCredential();
    const { store } = await open(new Map(), credentials);
    await store.save({
      version: 1, requestId: 'req-legacy', orderId: null, productVersion: 'book-v1',
      sellerOrigin: ORIGIN, sellerKeyId: SELLER, credentialId: created.credentialId, invoice: null,
    });
    const current = JSON.parse(new TextDecoder().decode(await store.exportBackup('req-legacy')));
    const { delivery: _drop, ...rest } = current;
    const v1 = new TextEncoder().encode(JSON.stringify({ ...rest, version: 1 }));
    const future = new TextEncoder().encode(JSON.stringify({ ...current, version: 3 }));

    const { store: target } = await open(new Map());
    const imported = await target.importBackup(v1);
    expect(imported.requestId).toBe('req-legacy');
    await expect(target.importBackup(future)).rejects.toThrow(/unsupported backup version/);
  });

  test('a v2 backup with a malformed delivery is rejected', async () => {
    const credentials = createCredentialAdapter();
    const created = await credentials.createPurchaseCredential();
    const { store } = await open(new Map(), credentials);
    await store.save({
      version: 1, requestId: 'req-bad', orderId: 'ord-bad', productVersion: 'book-v1',
      sellerOrigin: ORIGIN, sellerKeyId: SELLER, credentialId: created.credentialId, invoice: null,
    });
    const current = JSON.parse(new TextDecoder().decode(await store.exportBackup('req-bad')));
    const bad = new TextEncoder().encode(JSON.stringify({ ...current, delivery: { packageId: '', wireEnvelope: [999] } }));
    const { store: target } = await open(new Map());
    await expect(target.importBackup(bad)).rejects.toThrow(/malformed backup: delivery/);
  });
});

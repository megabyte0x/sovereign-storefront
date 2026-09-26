import { describe, expect, test } from 'vitest';
import { createCredentialAdapter } from '../../src/adapters/credentials.ts';
import { openPurchaseStore, type IDBFactoryLike } from '../../src/browser/purchases.ts';
import type { CredentialAdapter, Invoice } from '../../src/contracts/types.ts';

// A live (real-demo) backup carries the receiver-attributed regtest invoice the
// seller issued. The importer must accept it; it previously required the legacy
// `network: 'test'` + `attributionRef` shape, so every live backup was refused.

const ORIGIN = 'http://127.0.0.1:8787';
const SELLER = 'seller-key-1';
const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);
const ACCOUNT = 'e68c476c-f2f8-422a-b15d-010d2ef40d0b';

type Rows = Map<string, Record<string, unknown>>;

function memoryIndexedDB(rows: Rows): IDBFactoryLike {
  return {
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
                  return req(undefined, () => { rows.set(value.requestId, structuredClone(value) as Record<string, unknown>); });
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
  } as IDBFactoryLike;
}

async function open(rows: Rows, credentials: CredentialAdapter = createCredentialAdapter()) {
  return openPurchaseStore({
    sellerOrigin: ORIGIN, sellerKeyId: SELLER, credentials,
    indexedDB: memoryIndexedDB(rows), persist: null, dbName: 'ssf-live-invoice-import',
  });
}

function liveInvoice(buyerKeyId: string): Invoice {
  return {
    id: 'inv-live:draft',
    orderId: 'ord-live',
    productVersion: 'v-run2',
    buyerKeyId,
    network: 'regtest',
    chain: { network: 'regtest', genesisHash: HASH_A, consensusFingerprint: HASH_B },
    accountId: ACCOUNT,
    amountZat: '100000',
    destination: 'uregtest1destination',
    paymentUri: 'zcash:uregtest1destination?amount=0.001',
    attribution: {
      kind: 'receiver',
      allocationId: 'alloc-1',
      receiver: {
        accountId: ACCOUNT, scope: 'external', pool: 'orchard',
        diversifierIndex: '01'.repeat(11), receiverHex: '02'.repeat(43),
      },
    },
    expiresAt: 1_790_410_000_000,
  };
}

/** Export a backup of a purchase holding `invoice` from a fresh source store. */
async function backupWith(invoice: (buyerKeyId: string) => Invoice): Promise<{ bytes: Uint8Array; expected: Invoice }> {
  const credentials = createCredentialAdapter();
  const created = await credentials.createPurchaseCredential();
  const buyerKeyId = await credentials.publicKey(created.credentialId);
  const expected = invoice(buyerKeyId);
  const source = await open(new Map(), credentials);
  await source.save({
    version: 1, requestId: 'req-live', orderId: 'ord-live', productVersion: 'v-run2',
    sellerOrigin: ORIGIN, sellerKeyId: SELLER, credentialId: created.credentialId, invoice: expected,
  });
  return { bytes: await source.exportBackup('req-live'), expected };
}

function tamper(bytes: Uint8Array, edit: (invoice: Record<string, unknown>) => void): Uint8Array {
  const envelope = JSON.parse(new TextDecoder().decode(bytes));
  edit(envelope.purchase.invoice);
  return new TextEncoder().encode(JSON.stringify(envelope));
}

describe('importing a live receiver-attributed regtest invoice', () => {
  test('a fresh context imports the live backup and keeps the full live invoice', async () => {
    const { bytes, expected } = await backupWith(liveInvoice);
    const rows: Rows = new Map();
    const target = await open(rows);
    const imported = await target.importBackup(bytes);
    expect(imported.requestId).toBe('req-live');
    expect(imported.orderId).toBe('ord-live');
    expect(imported.invoice).toEqual(expected);
    expect(imported.invoice?.attributionRef).toBeUndefined();
    expect(rows.has('req-live')).toBe(true);
  });

  test('a live invoice whose chain network disagrees with its network is refused and writes nothing', async () => {
    const { bytes } = await backupWith(liveInvoice);
    const bad = tamper(bytes, (inv) => { (inv.chain as Record<string, unknown>).network = 'test'; });
    const rows: Rows = new Map();
    await expect((await open(rows)).importBackup(bad)).rejects.toThrow(/malformed backup: invoice/);
    expect(rows.size).toBe(0);
  });

  test('a live invoice whose receiver belongs to another account is refused', async () => {
    const { bytes } = await backupWith(liveInvoice);
    const bad = tamper(bytes, (inv) => {
      ((inv.attribution as Record<string, unknown>).receiver as Record<string, unknown>).accountId = 'other-account';
    });
    await expect((await open(new Map())).importBackup(bad)).rejects.toThrow(/malformed backup: invoice/);
  });

  test('a live invoice with a non-zcash payment URI or an unknown network is refused', async () => {
    const { bytes } = await backupWith(liveInvoice);
    const badUri = tamper(bytes, (inv) => { inv.paymentUri = 'http://example.invalid/pay'; });
    await expect((await open(new Map())).importBackup(badUri)).rejects.toThrow(/malformed backup: invoice/);
    const badNet = tamper(bytes, (inv) => { inv.network = 'main'; });
    await expect((await open(new Map())).importBackup(badNet)).rejects.toThrow(/malformed backup: invoice/);
  });

  test('the legacy test-network attributionRef invoice still imports unchanged', async () => {
    const legacy = (buyerKeyId: string): Invoice => ({
      id: 'inv-legacy', orderId: 'ord-live', productVersion: 'v-run2', buyerKeyId,
      network: 'test', amountZat: '100000', destination: 'utest1destination',
      attributionRef: 'memo-ref-1', expiresAt: 1_790_410_000_000,
    });
    const { bytes, expected } = await backupWith(legacy);
    const imported = await (await open(new Map())).importBackup(bytes);
    expect(imported.invoice).toEqual(expected);
  });
});

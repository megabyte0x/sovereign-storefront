import { createHash } from 'node:crypto';
import { describe, expect, test, vi } from 'vitest';
import { generatePrivateKey, getPublicKey } from '@waku/message-encryption';
import { createDecoder, createEncoder } from '@waku/message-encryption/ecies';
import { bytesToHex } from '@waku/utils/bytes';
import type { SellerResponse, WakuConfig, WakuSession } from '../../src/contracts/messages.ts';
import { createWakuSession, type WakuNode } from '../../src/adapters/waku.ts';
import { createCredentialAdapter } from '../../src/adapters/credentials.ts';
import type { BrowserPurchase, CredentialAdapter, OrderStatus, PurchaseStore } from '../../src/contracts/types.ts';
import { createBrowserTransport, startBrowserApp, type ProductViewModel } from '../../src/browser/app.ts';
import { createWakuOrderTransport } from '../../src/browser/waku-transport.ts';
import { openPurchaseStore, type IDBFactoryLike } from '../../src/browser/purchases.ts';

type EciesEncoder = ReturnType<typeof createEncoder>;
type EciesDecoder = ReturnType<typeof createDecoder>;

const ORIGIN = 'http://127.0.0.1:8787';
const SELLER = 'seller-key-1';
const HTTP_ORDER_PATHS = ['/api/orders', '/api/status', '/api/recover', '/api/acknowledge'];

const FIXTURE_PRODUCT: ProductViewModel = {
  version: 'book-v1', description: 'Book', amountZat: '100000', network: 'test',
  fileSize: null, fileFormatVersion: null, sellerKeyId: 'fixture-seller',
};
const DEMO_PRODUCT: ProductViewModel = { ...FIXTURE_PRODUCT, network: 'regtest', sellerKeyId: 'demo-seller' };
const AVAILABILITY = { productPublished: true, messaging: true, storageReplica: true, scanner: true };
const STATUS: OrderStatus = { payment: 'confirming', delivery: 'locked', verification: 'available', exceptions: [] };

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

type Listener = (event: { target: unknown }) => unknown;
function fakeRoot() {
  const listeners = new Map<string, Listener[]>();
  const root = {
    innerHTML: '',
    querySelector() { return null; },
    addEventListener(type: string, listener: Listener) {
      listeners.set(type, [...(listeners.get(type) ?? []), listener]);
    },
  };
  return {
    root,
    click(requestId: string) {
      for (const listener of listeners.get('click') ?? []) {
        listener({ target: { getAttribute: (name: string) => (name === 'data-request-id' ? requestId : null) } });
      }
    },
  };
}

function productFetch(product: ProductViewModel, wakuConfig: Response | (() => Response)) {
  const calls: string[] = [];
  const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const path = new URL(url, 'http://127.0.0.1').pathname;
    calls.push(`${init?.method ?? 'GET'} ${path}`);
    if (path === '/api/product') return json(product);
    if (path === '/api/availability') return json(AVAILABILITY);
    if (path === '/api/waku-config') return typeof wakuConfig === 'function' ? wakuConfig() : wakuConfig.clone();
    if (path === '/api/status') return json(STATUS);
    if (path === '/api/recover') return new Response('no', { status: 409 });
    return new Response('not found', { status: 404 });
  });
  return { fetchImpl: fetchImpl as unknown as typeof fetch, calls };
}

function memoryStore(records: BrowserPurchase[]): PurchaseStore {
  return {
    async save() {},
    async get(requestId) { return records.find((r) => r.requestId === requestId) ?? null; },
    async list() { return [...records]; },
    async exportBackup() { throw new Error('not used'); },
    async importBackup() { throw new Error('not used'); },
    async saveDelivery() {},
    async getDelivery() { return null; },
  };
}

async function purchaseFor(credentials: CredentialAdapter, sellerKeyId: string): Promise<BrowserPurchase> {
  const { credentialId } = await credentials.createPurchaseCredential();
  return {
    version: 1, requestId: 'req-a', orderId: 'order-a', productVersion: 'book-v1',
    sellerOrigin: ORIGIN, sellerKeyId, credentialId, invoice: null,
  };
}

describe('M1 fixture mode needs a fixture seller marker, not the 404 alone', () => {
  test('a 404 plus the fixture product marker (network test) selects fixture and uses HTTP', async () => {
    const credentials = createCredentialAdapter();
    const record = await purchaseFor(credentials, FIXTURE_PRODUCT.sellerKeyId);
    const { fetchImpl, calls } = productFetch(FIXTURE_PRODUCT, new Response('not found', { status: 404 }));
    const createSession = vi.fn(async (): Promise<WakuSession> => { throw new Error('must not be called'); });
    const { root, click } = fakeRoot();
    const app = await startBrowserApp(root, {
      fetch: fetchImpl, credentials, openStore: async () => memoryStore([record]), createSession, origin: '',
    });
    expect(app.transportMode).toBe('fixture');
    click('req-a');
    await vi.waitFor(() => expect(root.innerHTML).toContain('Confirming'));
    expect(calls).toContain('POST /api/status');
    expect(createSession).not.toHaveBeenCalled();
  });

  test('a 404 without the fixture marker selects unavailable, never HTTP', async () => {
    const credentials = createCredentialAdapter();
    const record = await purchaseFor(credentials, DEMO_PRODUCT.sellerKeyId);
    const { fetchImpl, calls } = productFetch(DEMO_PRODUCT, new Response('not found', { status: 404 }));
    const createSession = vi.fn(async (): Promise<WakuSession> => { throw new Error('must not be called'); });
    const { root, click } = fakeRoot();
    const app = await startBrowserApp(root, {
      fetch: fetchImpl, credentials, openStore: async () => memoryStore([record]), createSession, origin: '',
    });
    expect(app.transportMode).toBe('unavailable');
    click('req-a');
    await vi.waitFor(() => expect(root.innerHTML).toContain('data-verification="unavailable"'));
    expect(calls.filter((c) => HTTP_ORDER_PATHS.some((p) => c.endsWith(p)))).toEqual([]);
    expect(createSession).not.toHaveBeenCalled();
  });
});

describe('M7 malformed 200 waku-config selects unavailable', () => {
  const sellerKeyId = 'ab'.repeat(33);
  const good = { sellerKeyId, network: 'regtest', contentTopic: '/ssf/1/m7/proto', bootstrapPeers: ['/ip4/127.0.0.1/tcp/1'] };

  async function boot(product: ProductViewModel, body: unknown) {
    const credentials = createCredentialAdapter();
    const record = await purchaseFor(credentials, product.sellerKeyId);
    const { fetchImpl, calls } = productFetch(product, json(body));
    const createSession = vi.fn(async (): Promise<WakuSession> => { throw new Error('must not be called'); });
    const { root, click } = fakeRoot();
    const app = await startBrowserApp(root, {
      fetch: fetchImpl, credentials, openStore: async () => memoryStore([record]), createSession, origin: '',
    });
    click('req-a');
    await vi.waitFor(() => expect(root.innerHTML).toContain('data-verification="unavailable"'));
    return { app, calls, createSession };
  }

  test('a bad seller key selects unavailable', async () => {
    const { app, calls, createSession } = await boot(DEMO_PRODUCT, { ...good, sellerKeyId: 'not-a-key' });
    expect(app.transportMode).toBe('unavailable');
    expect(calls.filter((c) => HTTP_ORDER_PATHS.some((p) => c.endsWith(p)))).toEqual([]);
    expect(createSession).not.toHaveBeenCalled();
  });

  test('an unknown network selects unavailable', async () => {
    const { app, createSession } = await boot(DEMO_PRODUCT, { ...good, network: 'mainnet' });
    expect(app.transportMode).toBe('unavailable');
    expect(createSession).not.toHaveBeenCalled();
  });

  test('missing fields select unavailable', async () => {
    const { contentTopic: _drop, ...missing } = good;
    const { app } = await boot(DEMO_PRODUCT, missing);
    expect(app.transportMode).toBe('unavailable');
  });

  test('a sellerKeyId that differs from /api/product selects unavailable', async () => {
    const { app, createSession } = await boot({ ...DEMO_PRODUCT, sellerKeyId: 'cd'.repeat(33) }, good);
    expect(app.transportMode).toBe('unavailable');
    expect(createSession).not.toHaveBeenCalled();
  });
});

describe('M3 ack is sent only after a verified decrypt', () => {
  test('a failed decrypt sends no acknowledge request', async () => {
    const credentials = createCredentialAdapter();
    const { credentialId } = await credentials.createPurchaseCredential();
    const calls: string[] = [];
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const path = new URL(String(input), 'http://127.0.0.1').pathname;
      calls.push(`${init?.method ?? 'GET'} ${path}`);
      if (path === '/api/recover') {
        return json({
          orderId: 'order-a', productVersion: 'book-v1', buyerKeyId: 'buyer',
          encryptedEnvelope: Buffer.from('not-an-envelope').toString('base64'),
        });
      }
      if (path.startsWith('/ciphertext/')) return new Response(new Uint8Array([1, 2, 3]));
      return new Response('no', { status: 500 });
    });
    const transport = createBrowserTransport(credentials, '', fetchImpl as unknown as typeof fetch);
    const pkg = await transport.recover('order-a', credentialId);
    expect(pkg.encryptedEnvelope.byteLength).toBeGreaterThan(0);
    expect(calls.filter((c) => c.endsWith('/api/acknowledge'))).toEqual([]);
  });

  test('opening a purchase whose decrypt fails never acknowledges', async () => {
    const credentials = createCredentialAdapter();
    const record = await purchaseFor(credentials, FIXTURE_PRODUCT.sellerKeyId);
    const calls: string[] = [];
    let acks = 0;
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const path = new URL(String(input), 'http://127.0.0.1').pathname;
      calls.push(`${init?.method ?? 'GET'} ${path}`);
      if (path === '/api/product') return json(FIXTURE_PRODUCT);
      if (path === '/api/availability') return json(AVAILABILITY);
      if (path === '/api/waku-config') return new Response('not found', { status: 404 });
      if (path === '/api/status') return json({ ...STATUS, payment: 'confirmed', delivery: 'sent_unacknowledged' });
      if (path === '/api/recover') {
        return json({
          orderId: 'order-a', productVersion: 'book-v1', buyerKeyId: 'buyer',
          encryptedEnvelope: Buffer.from('not-an-envelope').toString('base64'),
          packageId: 'aa'.repeat(32),
        });
      }
      if (path.startsWith('/ciphertext/')) return new Response(new Uint8Array([1, 2, 3]));
      if (path === '/api/acknowledge') { acks += 1; return json({ ok: true }); }
      return new Response('not found', { status: 404 });
    });
    const decrypt = vi.fn(async () => { throw new Error('decrypt failed'); });
    const { root, click } = fakeRoot();
    await startBrowserApp(root, {
      fetch: fetchImpl as unknown as typeof fetch, credentials,
      openStore: async () => memoryStore([record]), origin: '', decrypt,
    });
    click('req-a');
    await vi.waitFor(() => expect(decrypt).toHaveBeenCalledTimes(1));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(acks).toBe(0);
    expect(calls.filter((c) => c.endsWith('/api/acknowledge'))).toEqual([]);
  });
});

const CONTENT_TOPIC = '/ssf/1/r3-minors/proto';
const NETWORK = 'regtest' as const;
const AMOUNT = '100';
const PRODUCT = 'book-v1';
const ORDER = 'ord-r3';

function makeFakeNode(): WakuNode {
  const subscribers: Array<{ decoder: EciesDecoder; callback: (msg: unknown) => unknown }> = [];
  return {
    async waitForPeers() { return; },
    lightPush: {
      async send(encoder: EciesEncoder, message: { payload: Uint8Array }) {
        const proto = await encoder.toProtoObj(message);
        if (proto) {
          for (const { decoder, callback } of subscribers) {
            const decoded = await decoder.fromProtoObj(encoder.pubsubTopic, proto);
            if (decoded) await callback(decoded);
          }
        }
        return { successes: ['peer-a'], failures: [] } as never;
      },
    } as never,
    filter: {
      async subscribe(decoder: EciesDecoder, callback: (msg: unknown) => unknown) {
        subscribers.push({ decoder, callback });
        return true;
      },
      async unsubscribe() { return true; },
    } as never,
    events: { addEventListener() {}, removeEventListener() {} } as never,
    async stop() { return; },
  };
}

function packageIdOf(orderId: string, productVersion: string, buyerKeyId: string, envelope: Uint8Array): string {
  return createHash('sha256')
    .update(orderId).update('\0').update(productVersion).update('\0').update(buyerKeyId).update('\0')
    .update(envelope).digest('hex');
}

function fakeCredentials(credentialId: string, publicKeyHex: string): CredentialAdapter {
  const unused = async (): Promise<never> => { throw new Error('not used'); };
  return {
    createPurchaseCredential: unused, provePossession: unused, verifyPossession: unused,
    decryptWrapped: unused, exportBackupMaterial: unused, importBackupMaterial: unused,
    async publicKey(id: string) {
      if (id !== credentialId) throw new Error('unknown credential');
      return publicKeyHex;
    },
    createWakuSession: unused,
  };
}

describe('M2 recover with a derivePackageId mismatch is rejected and nothing is saved', () => {
  test('a seller-signed delivery with a forged packageId rejects and saveDelivery is not called', async () => {
    const node = makeFakeNode();
    const config: WakuConfig = { contentTopic: CONTENT_TOPIC, bootstrapPeers: [], peerTimeoutMs: 1000 };
    const sellerKey = generatePrivateKey();
    const sellerKeyId = bytesToHex(getPublicKey(sellerKey));
    const seller = createWakuSession(config, sellerKey, { createNode: async () => node });
    const buyerKey = generatePrivateKey();
    const buyerKeyId = bytesToHex(getPublicKey(buyerKey));
    const credentialId = 'cred-r3';
    const buyer = createWakuSession(config, buyerKey, { createNode: async () => node });
    const envelope = new Uint8Array([9, 9, 9]);
    const forged = 'ff'.repeat(32);
    const saves: string[] = [];
    const purchases: PurchaseStore = {
      async save() {}, async get() { return null; }, async list() { return []; },
      async exportBackup() { throw new Error('not used'); },
      async importBackup() { throw new Error('not used'); },
      async saveDelivery(_orderId, record) { saves.push(record.packageId); },
      async getDelivery() { return null; },
    };
    await seller.subscribe(async (message) => {
      const now = Date.now();
      const body = message.body as { messageId: string };
      const response: SellerResponse = {
        version: 1, messageId: `resp-${body.messageId}`, inReplyTo: body.messageId,
        sellerKeyId, buyerKeyId, network: NETWORK, issuedAt: now, expiresAt: now + 60_000,
        type: 'delivery', packageId: forged,
        package: { orderId: ORDER, productVersion: PRODUCT, buyerKeyId, encryptedEnvelope: envelope },
      };
      await seller.send(buyerKeyId, response);
    });
    const transport = createWakuOrderTransport(fakeCredentials(credentialId, buyerKeyId), buyer, {
      sellerKeyId, network: NETWORK, amountZat: AMOUNT, productVersion: PRODUCT,
    }, purchases);
    await expect(transport.recover(ORDER, credentialId)).rejects.toThrow(/package id/i);
    expect(saves).toEqual([]);
    expect(packageIdOf(ORDER, PRODUCT, buyerKeyId, envelope)).not.toBe(forged);
    await seller.close();
    await buyer.close();
  });
});

describe('M4 saveDelivery refuses a different packageId and no-ops the same one', () => {
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
                  const r = { result, error: null, onsuccess: null as ((ev?: unknown) => void) | null, onerror: null as ((ev?: unknown) => void) | null };
                  queueMicrotask(() => { effect?.(); r.onsuccess?.(); if (effect) tx.oncomplete?.(); });
                  return r;
                };
                return {
                  put(value: { requestId: string }) { return req(undefined, () => { rows.set(value.requestId, structuredClone(value) as Record<string, unknown>); }); },
                  get(key: string) { return req(structuredClone(rows.get(key))); },
                  getAll() { return req([...rows.values()].map((v) => structuredClone(v))); },
                };
              },
            };
            return tx;
          },
          close() {},
        };
        const r = { result: db, error: null, onsuccess: null as ((ev?: unknown) => void) | null, onerror: null as ((ev?: unknown) => void) | null, onupgradeneeded: null as ((ev?: unknown) => void) | null };
        queueMicrotask(() => { r.onupgradeneeded?.(); r.onsuccess?.(); });
        return r;
      },
    } as unknown as IDBFactoryLike;
  }

  test('a different packageId is refused and the same packageId is a no-op', async () => {
    const credentials = createCredentialAdapter();
    const created = await credentials.createPurchaseCredential();
    const rows: Rows = new Map();
    const store = await openPurchaseStore({
      sellerOrigin: ORIGIN, sellerKeyId: SELLER, credentials, indexedDB: memoryIndexedDB(rows), persist: null,
    });
    await store.save({
      version: 1, requestId: 'req-m4', orderId: 'ord-m4', productVersion: PRODUCT,
      sellerOrigin: ORIGIN, sellerKeyId: SELLER, credentialId: created.credentialId, invoice: null,
    });
    await store.saveDelivery('ord-m4', { packageId: 'pkg-1', wireEnvelope: new Uint8Array([1, 2, 3]) });
    await expect(store.saveDelivery('ord-m4', { packageId: 'pkg-2', wireEnvelope: new Uint8Array([4]) }))
      .rejects.toThrow(/package/i);
    expect((await store.getDelivery('ord-m4'))!.packageId).toBe('pkg-1');
    const before = structuredClone(rows.get('req-m4'));
    await store.saveDelivery('ord-m4', { packageId: 'pkg-1', wireEnvelope: new Uint8Array([9, 9, 9]) });
    expect(rows.get('req-m4')).toEqual(before);
  });
});

describe('M5 an imported v2 delivery is re-verified before it is stored', () => {
  test('a tampered delivery rejects the whole import with the generic notice', async () => {
    // RED placeholder: a crafted backup whose delivery bytes are not a
    // seller-signed envelope must not be stored. The generic notice is what
    // the UI shows; the store rejects with a fixed message and writes nothing.
    const credentials = createCredentialAdapter();
    const created = await credentials.createPurchaseCredential();
    const material = JSON.parse(new TextDecoder().decode(await credentials.exportBackupMaterial(created.credentialId)));
    const backup = {
      version: 2, kind: 'sovereign-storefront-purchase-backup', warning: 'x',
      sellerOrigin: ORIGIN, sellerKeyId: SELLER,
      purchase: { version: 1, requestId: 'req-m5', orderId: 'ord-m5', productVersion: PRODUCT, invoice: null },
      credential: { privateKeyHex: material.privateKeyHex, publicKeyHex: material.publicKeyHex },
      delivery: { packageId: 'aa'.repeat(32), wireEnvelope: [1, 2, 3, 4] },
    };
    const rows = new Map<string, Record<string, unknown>>();
    const store = await openPurchaseStore({
      sellerOrigin: ORIGIN, sellerKeyId: SELLER, credentials: createCredentialAdapter(),
      indexedDB: {
        open() {
          const db = {
            objectStoreNames: { contains: () => true }, createObjectStore() {},
            transaction() {
              const tx = {
                oncomplete: null as ((ev?: unknown) => void) | null, onerror: null as ((ev?: unknown) => void) | null,
                onabort: null as ((ev?: unknown) => void) | null, error: null,
                objectStore() {
                  const req = (result: unknown, effect?: () => void) => {
                    const r = { result, error: null, onsuccess: null as ((ev?: unknown) => void) | null, onerror: null as ((ev?: unknown) => void) | null };
                    queueMicrotask(() => { effect?.(); r.onsuccess?.(); if (effect) tx.oncomplete?.(); });
                    return r;
                  };
                  return {
                    put(value: { requestId: string }) { return req(undefined, () => { rows.set(value.requestId, value as Record<string, unknown>); }); },
                    get(key: string) { return req(rows.get(key)); },
                    getAll() { return req([...rows.values()]); },
                  };
                },
              };
              return tx;
            },
            close() {},
          };
          const r = { result: db, error: null, onsuccess: null as ((ev?: unknown) => void) | null, onerror: null as ((ev?: unknown) => void) | null, onupgradeneeded: null as ((ev?: unknown) => void) | null };
          queueMicrotask(() => { r.onupgradeneeded?.(); r.onsuccess?.(); });
          return r;
        },
      } as unknown as IDBFactoryLike,
      persist: null,
      contentTopic: CONTENT_TOPIC,
    });
    await expect(store.importBackup(new TextEncoder().encode(JSON.stringify(backup)))).rejects.toThrow(/could not be imported/i);
    expect(rows.size).toBe(0);
  });
});

describe('M6 one unknown-version row is skipped, not thrown', () => {
  test('list returns the other rows plus a skipped count', async () => {
    const credentials = createCredentialAdapter();
    const good = await credentials.createPurchaseCredential();
    const material = Array.from(await credentials.exportBackupMaterial(good.credentialId));
    const rows = new Map<string, Record<string, unknown>>([
      ['req-good', {
        schemaVersion: 2, version: 1, requestId: 'req-good', orderId: 'ord-good', productVersion: PRODUCT,
        sellerOrigin: ORIGIN, sellerKeyId: SELLER, credentialId: good.credentialId, invoice: null,
        credentialMaterial: material, delivery: null,
      }],
      ['req-future', {
        schemaVersion: 99, version: 1, requestId: 'req-future', orderId: 'ord-future', productVersion: PRODUCT,
        sellerOrigin: ORIGIN, sellerKeyId: SELLER, credentialId: 'cred-future', invoice: null,
        credentialMaterial: [], delivery: null,
      }],
    ]);
    const store = await openPurchaseStore({
      sellerOrigin: ORIGIN, sellerKeyId: SELLER, credentials,
      indexedDB: {
        open() {
          const db = {
            objectStoreNames: { contains: () => true }, createObjectStore() {},
            transaction() {
              const tx = {
                oncomplete: null as ((ev?: unknown) => void) | null, onerror: null as ((ev?: unknown) => void) | null,
                onabort: null as ((ev?: unknown) => void) | null, error: null,
                objectStore() {
                  const req = (result: unknown, effect?: () => void) => {
                    const r = { result, error: null, onsuccess: null as ((ev?: unknown) => void) | null, onerror: null as ((ev?: unknown) => void) | null };
                    queueMicrotask(() => { effect?.(); r.onsuccess?.(); if (effect) tx.oncomplete?.(); });
                    return r;
                  };
                  return {
                    put(value: { requestId: string }) { return req(undefined, () => { rows.set(value.requestId, structuredClone(value) as Record<string, unknown>); }); },
                    get(key: string) { return req(structuredClone(rows.get(key))); },
                    getAll() { return req([...rows.values()].map((v) => structuredClone(v))); },
                  };
                },
              };
              return tx;
            },
            close() {},
          };
          const r = { result: db, error: null, onsuccess: null as ((ev?: unknown) => void) | null, onerror: null as ((ev?: unknown) => void) | null, onupgradeneeded: null as ((ev?: unknown) => void) | null };
          queueMicrotask(() => { r.onupgradeneeded?.(); r.onsuccess?.(); });
          return r;
        },
      } as unknown as IDBFactoryLike,
      persist: null,
    });
    const listed = await store.list() as BrowserPurchase[] & { skipped?: number };
    expect(listed.map((row) => row.requestId)).toEqual(['req-good']);
    expect(listed.skipped).toBe(1);
    // The unknown row is never written back.
    expect(rows.get('req-future')!.schemaVersion).toBe(99);
  });

  test('the purchases view shows a generic notice when a row was skipped', async () => {
    const record = {
      version: 1 as const, requestId: 'req-good', orderId: 'ord-good', productVersion: PRODUCT,
      sellerOrigin: ORIGIN, sellerKeyId: SELLER, credentialId: 'cred-good', invoice: null,
    };
    const listed = Object.assign([record], { skipped: 1 });
    const listeners = new Map<string, Array<(event: { target: unknown }) => unknown>>();
    const root = {
      innerHTML: '',
      querySelector() { return null; },
      addEventListener(type: string, listener: (event: { target: unknown }) => unknown) {
        listeners.set(type, [...(listeners.get(type) ?? []), listener]);
      },
    };
    await startBrowserApp(root, {
      fetch: productFetch(FIXTURE_PRODUCT, new Response('not found', { status: 404 })).fetchImpl,
      openStore: async () => ({ ...memoryStore([]), async list() { return listed; } }),
      origin: '',
    });
    await Promise.all((listeners.get('click') ?? []).map((listener) => listener({
      target: { id: 'nav-purchases', getAttribute: (name: string) => (name === 'id' ? 'nav-purchases' : null) },
    })));
    await vi.waitFor(() => expect(root.innerHTML).toContain('Some purchases could not be read'));
    expect(root.innerHTML).toContain('data-request-id="req-good"');
    expect(root.innerHTML).not.toContain('req-future');
  });
});

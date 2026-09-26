import { afterEach, describe, expect, test, vi } from 'vitest';
import { generatePrivateKey, getPublicKey } from '@waku/message-encryption';
import { createDecoder, createEncoder } from '@waku/message-encryption/ecies';
import { bytesToHex, hexToBytes } from '@waku/utils/bytes';
import type { BuyerRequest, SellerResponse, WakuConfig, WakuSession } from '../../src/contracts/messages.ts';
import type { BrowserPurchase, CredentialAdapter, OrderStatus, PurchaseStore } from '../../src/contracts/types.ts';
import { createCredentialAdapter } from '../../src/adapters/credentials.ts';
import { createWakuSession, type WakuNode } from '../../src/adapters/waku.ts';
import { startBrowserApp } from '../../src/browser/app.ts';

type EciesEncoder = ReturnType<typeof createEncoder>;
type EciesDecoder = ReturnType<typeof createDecoder>;

const CONTENT_TOPIC = '/ssf/1/transport-select/proto';
const HTTP_ORDER_PATHS = ['/api/orders', '/api/status', '/api/recover', '/api/acknowledge'];

/** Same fake node as tests/unit/waku.test.ts: real ECIES encode→decode
 * between every session sharing it. */
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
    events: { addEventListener() { }, removeEventListener() { } } as never,
    async stop() { return; },
  };
}

function memoryStore(records: BrowserPurchase[]): PurchaseStore {
  const saved = new Map(records.map((r) => [r.requestId, r]));
  return {
    async save(record) { saved.set(record.requestId, record); },
    async get(requestId) { return saved.get(requestId) ?? null; },
    async list() { return [...saved.values()]; },
    async exportBackup() { throw new Error('not used'); },
    async importBackup() { throw new Error('not used'); },
    async saveDelivery() { },
    async getDelivery() { return null; },
  };
}

type Listener = (event: { target: unknown }) => unknown;
function fakeRoot(): { root: { innerHTML: string; querySelector(): null; addEventListener(t: string, l: Listener): void }; click(requestId: string): void } {
  let listener: Listener | null = null;
  const root = {
    innerHTML: '',
    querySelector() { return null; },
    addEventListener(type: string, l: Listener) { if (type === 'click') listener = l; },
  };
  return {
    root,
    click(requestId) {
      listener?.({ target: { getAttribute: (name: string) => (name === 'data-request-id' ? requestId : null) } });
    },
  };
}

const PRODUCT = {
  version: 'book-v1', description: 'Book', amountZat: '100000', network: 'test' as const,
  fileSize: null, fileFormatVersion: null, sellerKeyId: '',
};
const AVAILABILITY = { productPublished: true, messaging: true, storageReplica: true, scanner: true };
const STATUS: OrderStatus = { payment: 'confirming', delivery: 'locked', verification: 'available', exceptions: [] };

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function makeFetch(wakuConfig: Response | (() => Response)) {
  const calls: string[] = [];
  const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const path = new URL(url, 'http://127.0.0.1').pathname;
    calls.push(`${init?.method ?? 'GET'} ${path}`);
    if (path === '/api/product') return json(PRODUCT);
    if (path === '/api/availability') return json(AVAILABILITY);
    if (path === '/api/waku-config') return typeof wakuConfig === 'function' ? wakuConfig() : wakuConfig.clone();
    if (path === '/api/status') return json(STATUS);
    if (path === '/api/recover') return new Response('no', { status: 409 });
    return new Response('not found', { status: 404 });
  });
  return { fetchImpl: fetchImpl as unknown as typeof fetch, calls };
}

async function purchaseFor(credentials: CredentialAdapter, requestId: string, orderId: string, sellerKeyId: string): Promise<BrowserPurchase> {
  const { credentialId } = await credentials.createPurchaseCredential();
  return {
    version: 1, requestId, orderId, productVersion: 'book-v1', network: 'regtest', amountZat: '100000',
    sellerOrigin: 'http://127.0.0.1', sellerKeyId, credentialId, invoice: null,
  };
}

async function privateKeyOf(credentials: CredentialAdapter, credentialId: string): Promise<Uint8Array> {
  const material = JSON.parse(new TextDecoder().decode(await credentials.exportBackupMaterial(credentialId))) as { privateKeyHex: string };
  return hexToBytes(material.privateKeyHex);
}

const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (closers.length) await closers.pop()!().catch(() => undefined);
});

describe('browser transport selection', () => {
  test('waku-config 200: opening two purchases uses Waku sessions scoped to each purchase credential, never HTTP', async () => {
    const node = makeFakeNode();
    const sellerPriv = generatePrivateKey();
    const sellerKeyId = bytesToHex(getPublicKey(sellerPriv));
    const config: WakuConfig = { contentTopic: CONTENT_TOPIC, bootstrapPeers: [], peerTimeoutMs: 1000 };
    const seller = createWakuSession(config, sellerPriv, { createNode: async () => node });
    closers.push(() => seller.close());
    const signersSeen: string[] = [];
    await seller.subscribe(async (message) => {
      const body = message.body as BuyerRequest;
      if (body.type === 'status') signersSeen.push(message.signerKeyId);
      const now = Date.now();
      const header = {
        version: 1 as const, messageId: `resp-${body.messageId}`, inReplyTo: body.messageId,
        sellerKeyId, buyerKeyId: message.signerKeyId, network: 'regtest' as const,
        issuedAt: now, expiresAt: now + 60_000,
      };
      const response: SellerResponse = body.type === 'status'
        ? { ...header, type: 'status', orderId: body.orderId, status: STATUS }
        : { ...header, type: 'error', code: 'not_eligible' };
      await seller.send(message.signerKeyId, response);
    });

    const credentials = createCredentialAdapter();
    const a = await purchaseFor(credentials, 'req-a', 'order-a', sellerKeyId);
    const b = await purchaseFor(credentials, 'req-b', 'order-b', sellerKeyId);
    const store = memoryStore([a, b]);
    const { fetchImpl, calls } = makeFetch(json({
      sellerKeyId, network: 'regtest', contentTopic: CONTENT_TOPIC, bootstrapPeers: ['/ip4/127.0.0.1/tcp/8000/ws/p2p/peer'],
    }));
    const sessionCalls: Array<{ credentialId: string; config: WakuConfig }> = [];
    const createSession = vi.fn(async (credentialId: string, cfg: WakuConfig): Promise<WakuSession> => {
      sessionCalls.push({ credentialId, config: cfg });
      const session = createWakuSession(cfg, await privateKeyOf(credentials, credentialId), { createNode: async () => node });
      closers.push(() => session.close());
      return session;
    });

    const { root, click } = fakeRoot();
    const app = await startBrowserApp(root, {
      fetch: fetchImpl, credentials, openStore: async () => store, createSession, origin: 'http://127.0.0.1',
    });
    expect(app.transportMode).toBe('waku');

    click('req-a');
    await vi.waitFor(() => expect(root.innerHTML).toContain('Confirming'), { timeout: 5000 });
    root.innerHTML = '';
    click('req-b');
    await vi.waitFor(() => expect(root.innerHTML).toContain('Confirming'), { timeout: 5000 });
    await vi.waitFor(() => expect(sessionCalls.length).toBeGreaterThanOrEqual(2));

    const credIds = [...new Set(sessionCalls.map((c) => c.credentialId))];
    expect(credIds).toEqual([a.credentialId, b.credentialId]);
    expect(sessionCalls[0]!.config.contentTopic).toBe(CONTENT_TOPIC);
    expect(sessionCalls[0]!.config.bootstrapPeers).toEqual(['/ip4/127.0.0.1/tcp/8000/ws/p2p/peer']);
    expect(sessionCalls[0]!.config.peerTimeoutMs).toBeGreaterThan(0);
    expect(signersSeen).toEqual([await credentials.publicKey(a.credentialId), await credentials.publicKey(b.credentialId)]);
    expect(new Set(signersSeen).size).toBe(2);
    expect(calls.filter((c) => HTTP_ORDER_PATHS.some((p) => c.endsWith(p)))).toEqual([]);
    expect(calls.filter((c) => c.endsWith('/api/waku-config'))).toHaveLength(1);
  });

  test('waku-config 404: fixture mode keeps the HTTP browser transport and never opens a Waku session', async () => {
    const credentials = createCredentialAdapter();
    const a = await purchaseFor(credentials, 'req-a', 'order-a', 'seller');
    const { fetchImpl, calls } = makeFetch(new Response('not found', { status: 404 }));
    const createSession = vi.fn(async (): Promise<WakuSession> => { throw new Error('must not be called'); });
    const { root, click } = fakeRoot();
    const app = await startBrowserApp(root, {
      fetch: fetchImpl, credentials, openStore: async () => memoryStore([a]), createSession, origin: '',
    });
    expect(app.transportMode).toBe('fixture');
    click('req-a');
    await vi.waitFor(() => expect(root.innerHTML).toContain('Confirming'));
    expect(calls).toContain('POST /api/status');
    expect(createSession).not.toHaveBeenCalled();
  });

  test('a failed Waku start shows verification unavailable and never falls back to HTTP', async () => {
    const credentials = createCredentialAdapter();
    const a = await purchaseFor(credentials, 'req-a', 'order-a', 'seller');
    const sellerKeyId = bytesToHex(getPublicKey(generatePrivateKey()));
    const { fetchImpl, calls } = makeFetch(json({
      sellerKeyId, network: 'regtest', contentTopic: CONTENT_TOPIC, bootstrapPeers: [],
    }));
    const createSession = vi.fn(async (credentialId: string, cfg: WakuConfig): Promise<WakuSession> => {
      const session = createWakuSession(cfg, await privateKeyOf(credentials, credentialId), {
        createNode: async () => { throw new Error('no peers'); },
      });
      closers.push(() => session.close());
      return session;
    });
    const { root, click } = fakeRoot();
    const app = await startBrowserApp(root, {
      fetch: fetchImpl, credentials, openStore: async () => memoryStore([a]), createSession, origin: '',
    });
    expect(app.transportMode).toBe('waku');
    click('req-a');
    await vi.waitFor(() => expect(root.innerHTML).toContain('data-verification="unavailable"'), { timeout: 5000 });
    expect(createSession).toHaveBeenCalledWith(a.credentialId, expect.objectContaining({ contentTopic: CONTENT_TOPIC }));
    expect(calls.filter((c) => HTTP_ORDER_PATHS.some((p) => c.endsWith(p)))).toEqual([]);
  });

  test('a non-404 waku-config failure is not treated as fixture mode', async () => {
    const credentials = createCredentialAdapter();
    const a = await purchaseFor(credentials, 'req-a', 'order-a', 'seller');
    const { fetchImpl, calls } = makeFetch(() => new Response('boom', { status: 503 }));
    const createSession = vi.fn(async (): Promise<WakuSession> => { throw new Error('must not be called'); });
    const { root, click } = fakeRoot();
    const app = await startBrowserApp(root, {
      fetch: fetchImpl, credentials, openStore: async () => memoryStore([a]), createSession, origin: '',
    });
    expect(app.transportMode).toBe('unavailable');
    click('req-a');
    await vi.waitFor(() => expect(root.innerHTML).toContain('data-verification="unavailable"'));
    expect(calls.filter((c) => HTTP_ORDER_PATHS.some((p) => c.endsWith(p)))).toEqual([]);
    expect(createSession).not.toHaveBeenCalled();
  });
});

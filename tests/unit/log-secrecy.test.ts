// R3.4: a full real-demo create -> pay -> recover -> ack cycle through the live
// composition (real wallet-scanner client over a Unix socket, real Logos
// storage adapter over a scripted runner, real Waku session over a fake node
// routed through real ECIES) with a capturing logger. The captured lines must
// not contain any of the actual secret or private values used in the run.
// Also: readiness never reports messaging=true before the Waku handler is
// attached (the default is false).
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generatePrivateKey, getPublicKey } from '@waku/message-encryption';
import { createDecoder, createEncoder } from '@waku/message-encryption/ecies';
import { bytesToHex } from '@waku/utils/bytes';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { createLiveAdapters, type LiveAdapters } from '../../src/adapters/live.ts';
import { createMemoryStorageAdapter } from '../../src/adapters/storage.ts';
import { createWakuSession, type WakuNode } from '../../src/adapters/waku.ts';
import { loadConfig, type RuntimeConfig } from '../../src/config.ts';
import { consensusFingerprint } from '../../src/contracts/consensus.ts';
import type { ScanSnapshot } from '../../src/contracts/live.ts';
import type { BuyerRequest, DecodedWakuMessage, SellerResponse } from '../../src/contracts/messages.ts';
import { createOperationalLogger } from '../../src/ops/log.ts';
import { startRuntime, type RuntimeFactories } from '../../src/runtime.ts';
import { openCatalogue } from '../../src/seller/catalogue.ts';
import { writeSellerIdentity } from '../../src/seller/identity.ts';

type EciesEncoder = ReturnType<typeof createEncoder>;
type EciesDecoder = ReturnType<typeof createDecoder>;

const ACTIVATIONS = { overwinter: 1, sapling: 1, blossom: 1, heartwood: 1, canopy: 1, nu5: 1, nu6: 1, 'nu6-1': null, 'nu6-2': null, 'nu6-3': null };
const CHAIN = { network: 'regtest' as const, genesisHash: 'ab'.repeat(32), consensusFingerprint: consensusFingerprint('regtest', ACTIVATIONS) };
const ACCOUNT = 'seller-account-0';
const TOPIC = '/ssf/1/log-secrecy/proto';

// Distinctive values so a leak is unambiguous.
const UFVK = 'uviewregtest1secrecyufvkzq8x7c6v5b4n3m2l1k0j9h8g7f6d5s4a3';
const ADMIN_TOKEN = 'admin-token-secrecy-7f3e9c1d2b';
const AMOUNT_ZAT = '31415926';
const AMOUNT_ZEC = '0.31415926';
const DIVERSIFIER = '5a'.repeat(11);
const RECEIVER_HEX = 'c3'.repeat(43);
const DESTINATION = 'uregtest1secrecydestinationqq9w8e7r6t5y4u3i2o1p';
const PLAINTEXT = 'secret-plaintext-body-zq91';
const DESCRIPTION = 'secrecy-description-x7k2';
const REQUEST_ID = 'req-secrecy-body-4d8a';

let scratch = '';
let servers: Server[] = [];
let snapshotReceipts: ScanSnapshot['receipts'] = [];
const allocations = new Map<string, unknown>();

function nowSeconds(): number { return Math.floor(Date.now() / 1000); }

function snapshotBody(): ScanSnapshot {
  const tip = { height: 30, hash: 'd'.repeat(64) };
  return {
    version: 1, sourceId: 'secrecy-scanner', generation: '1', chain: CHAIN, accountId: ACCOUNT,
    tip, scanned: tip, checkedAt: nowSeconds(), caughtUp: true, complete: true, health: 'ready',
    receipts: snapshotReceipts,
  };
}

/** Minimal HTTP-over-Unix-socket wallet scanner: GET /v1/snapshot, POST /v1/allocations. */
async function scannerSocket(): Promise<string> {
  const path = join(scratch, 's.sock');
  const server = createServer((socket) => {
    const chunks: Buffer[] = [];
    socket.on('data', (chunk: Buffer) => chunks.push(chunk));
    socket.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      const [head, payload = ''] = raw.split('\r\n\r\n');
      const line = head!.split('\r\n')[0]!;
      let body: unknown = { error: 'not found' };
      let status = 404;
      if (line.startsWith('GET /v1/snapshot')) {
        status = 200;
        body = snapshotBody();
      } else if (line.startsWith('POST /v1/allocations')) {
        const request = JSON.parse(payload) as { allocationId: string; amountZat: string; expiresAt: number };
        const allocation = allocations.get(request.allocationId) ?? {
          allocationId: request.allocationId, chain: CHAIN, accountId: ACCOUNT, amountZat: request.amountZat, expiresAt: request.expiresAt,
          destination: DESTINATION,
          receiver: { accountId: ACCOUNT, scope: 'external', pool: 'orchard', diversifierIndex: DIVERSIFIER, receiverHex: RECEIVER_HEX },
          paymentUri: `zcash:${DESTINATION}?amount=${AMOUNT_ZEC}`,
        };
        allocations.set(request.allocationId, allocation);
        status = 200;
        body = allocation;
      }
      const text = JSON.stringify(body);
      socket.end(`HTTP/1.1 ${status} test\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(text)}\r\n\r\n${text}`);
    });
  });
  await new Promise<void>((resolve, reject) => server.listen(path, resolve).once('error', reject));
  servers.push(server);
  return path;
}

function makeFakeNode() {
  const subscribers: Array<{ decoder: EciesDecoder; callback: (msg: unknown) => unknown }> = [];
  const node: WakuNode = {
    async waitForPeers() { return; },
    lightPush: {
      async send(encoder: EciesEncoder, message: { payload: Uint8Array }) {
        const proto = await encoder.toProtoObj(message);
        if (proto) {
          for (const { decoder, callback } of [...subscribers]) {
            const decoded = await decoder.fromProtoObj(encoder.pubsubTopic, proto);
            if (decoded) await callback(decoded);
          }
        }
        return { successes: ['peer-a'], failures: [] } as never;
      },
    } as never,
    filter: {
      async subscribe(decoder: EciesDecoder, callback: (msg: unknown) => unknown) { subscribers.push({ decoder, callback }); return true; },
      async unsubscribe() { return true; },
    } as never,
    events: { addEventListener() { return; }, removeEventListener() { return; } },
    async stop() { return; },
  };
  return node;
}

/** In-memory two-node Logos: uploads land on the origin, downloads materialize on the replica. */
function memoryLogosRunner() {
  const blobs = new Map<string, Uint8Array>();
  const waiting = new Map<string, Array<(event: Record<string, unknown>) => void>>();
  const fire = (name: string, event: Record<string, unknown>) => { for (const resolve of waiting.get(name)?.splice(0) ?? []) resolve(event); };
  let seq = 0;
  return {
    async call(configDir: string, method: string, args: string[] = []) {
      if (method === 'peerId') return configDir.endsWith('node-a') ? 'peer-a' : 'peer-b';
      if (method === 'manifests') return [];
      if (method === 'connect' || method === 'downloadManifest') return null;
      if (method === 'exists') return blobs.has(args[0]!);
      if (method === 'uploadUrl') {
        seq += 1;
        const cid = `cid-secrecy-${seq}`;
        blobs.set(cid, new Uint8Array(readFileSync(args[0]!)));
        const sessionId = `up-${seq}`;
        queueMicrotask(() => fire('storageUploadDone', { success: true, cid, sessionId }));
        return sessionId;
      }
      if (method === 'downloadToUrl') {
        seq += 1;
        writeFileSync(args[1]!, blobs.get(args[0]!) ?? new Uint8Array());
        const sessionId = `down-${seq}`;
        queueMicrotask(() => fire('storageDownloadDone', { success: true, sessionId }));
        return sessionId;
      }
      return null;
    },
    subscribe(_configDir: string, eventName: string) {
      const event = new Promise<Record<string, unknown> | null>((resolve) => {
        waiting.set(eventName, [...(waiting.get(eventName) ?? []), resolve]);
      });
      return { ready: Promise.resolve(), event, cancel() { return; } };
    },
  };
}

async function liveConfig(sellerKeyId: string): Promise<RuntimeConfig> {
  const scannerConfig = join(scratch, 'scanner.json');
  writeFileSync(scannerConfig, JSON.stringify({ ufvk: UFVK, runtime: { chain: CHAIN, activations: ACTIVATIONS, sourceId: 'secrecy-scanner' } }), { mode: 0o600 });
  chmodSync(scannerConfig, 0o600);
  const tokenFile = join(scratch, 'admin.token');
  writeFileSync(tokenFile, `${ADMIN_TOKEN}\n`, { mode: 0o600 });
  chmodSync(tokenFile, 0o600);
  return loadConfig({
    SSF_MODE: 'real-demo', SSF_NETWORK: 'regtest',
    SSF_MAX_HEALTH_AGE_MS: '120000', SSF_MAX_CIPHERTEXT_BYTES: '73', SSF_MAX_PLAINTEXT_BYTES: '41', SSF_INVOICE_TTL_MS: '86400000',
    SSF_PUBLIC_HOST: '127.0.0.1', SSF_PUBLIC_PORT: '0', SSF_ADMIN_HOST: '127.0.0.1', SSF_ADMIN_PORT: '0',
    SSF_DB_PATH: join(scratch, 'data', 'seller.sqlite'), SSF_ADMIN_TOKEN_FILE: tokenFile,
    SSF_ADAPTER_MESSAGING: 'real', SSF_ADAPTER_STORAGE: 'real', SSF_ADAPTER_SCANNER: 'real',
    SSF_SCANNER_SOCKET: await scannerSocket(), SSF_SCANNER_ACCOUNT_ID: ACCOUNT, SSF_SCANNER_CONFIG: scannerConfig,
    SSF_WAKU_CONTENT_TOPIC: TOPIC, WAKU_BOOTSTRAP_PEERS: '/dns4/peer.example/tcp/8000/wss/p2p/16Uiu2HAmFixturePeer',
    LOGOSCTL: '/opt/logos/logosctl', LOGOS_NODE_A: join(scratch, 'node-a'), LOGOS_NODE_B: join(scratch, 'node-b'),
    SSF_SELLER_PUBLIC_KEY: sellerKeyId,
  });
}

function browserDir(): string {
  const dir = join(scratch, 'browser');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'index.html'), '<!doctype html><title>ssf</title>');
  return dir;
}

function harness(node: WakuNode, lines: string[], wrap: (adapters: LiveAdapters) => LiveAdapters = (a) => a): RuntimeFactories {
  const workRoot = join(scratch, 'logos-work');
  mkdirSync(workRoot, { recursive: true });
  return {
    createLiveAdapters: async (config, options) => wrap(await createLiveAdapters(config, {
      ...options, wakuCreateNode: async () => node, logosRunner: memoryLogosRunner(), logosWorkRoot: workRoot,
    })),
    createFixtureAdapters: () => { throw new Error('fixture factory must not be reached'); },
    logger: createOperationalLogger((line) => lines.push(line)),
    loopIntervalMs: 60_000,
    publicDir: browserDir(),
  };
}

function toBase64(bytes: Uint8Array): string { return Buffer.from(bytes).toString('base64'); }

beforeEach(() => {
  scratch = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), 'ssf-log-secrecy-'));
  servers = [];
  snapshotReceipts = [];
  allocations.clear();
});

afterEach(async () => {
  await Promise.all(servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  rmSync(scratch, { recursive: true, force: true });
});

test('a full create -> pay -> recover -> ack cycle logs none of the secret or private values used', async () => {
  const sellerKey = generatePrivateKey();
  const sellerKeyId = bytesToHex(getPublicKey(sellerKey));
  const config = await liveConfig(sellerKeyId);
  writeSellerIdentity(config.dbPath, { privateKeyHex: bytesToHex(sellerKey), publicKeyHex: sellerKeyId });
  const node = makeFakeNode();
  const lines: string[] = [];
  const runtime = await startRuntime(config, harness(node, lines));
  const secrets: Record<string, string> = {
    'seller private key': bytesToHex(sellerKey),
    ufvk: UFVK,
    'admin token': ADMIN_TOKEN,
    'amount (zat)': AMOUNT_ZAT,
    'amount (zec)': AMOUNT_ZEC,
    'receiver hex': RECEIVER_HEX,
    'diversifier index': DIVERSIFIER,
    'payment destination': DESTINATION,
  };
  try {
    // Admin publish over HTTP: the request body carries plaintext + description.
    const plaintextBase64 = Buffer.from(PLAINTEXT).toString('base64');
    const published = await fetch(`${runtime.server!.adminUrl}/admin/products`, {
      method: 'POST',
      headers: { authorization: `Bearer ${ADMIN_TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({ version: 'book-v1', description: DESCRIPTION, amountZat: AMOUNT_ZAT, plaintextBase64 }),
    });
    expect(published.status).toBe(201);
    Object.assign(secrets, { 'publish plaintext': PLAINTEXT, 'publish plaintext (b64)': plaintextBase64, 'publish description': DESCRIPTION });
    const [productKey] = runtime.server!.core.catalogue.listProductKeys();
    secrets['product key (hex)'] = bytesToHex(new Uint8Array(productKey!.rawKey));
    secrets['product key (b64)'] = toBase64(new Uint8Array(productKey!.rawKey));

    const readiness = await runtime.refreshReadiness();
    expect(readiness).toMatchObject({ scanner: true, messaging: true, checkout: true, products: { 'book-v1': true } });

    // Buyer over Waku.
    const buyerKey = generatePrivateKey();
    const buyerKeyId = bytesToHex(getPublicKey(buyerKey));
    secrets['buyer credential'] = bytesToHex(buyerKey);
    const buyer = createWakuSession({ contentTopic: TOPIC, bootstrapPeers: [], peerTimeoutMs: 1000 }, buyerKey, { createNode: async () => node });
    const responses: DecodedWakuMessage[] = [];
    await buyer.subscribe(async (message) => { responses.push(message); });
    const reply = (messageId: string): SellerResponse => {
      const found = responses.find((m) => m.signerKeyId === sellerKeyId && (m.body as SellerResponse).inReplyTo === messageId);
      if (!found) throw new Error(`no reply to ${messageId}`);
      return found.body as SellerResponse;
    };
    const base = () => ({ version: 1 as const, sellerKeyId, network: 'regtest' as const, issuedAt: Date.now() - 1, expiresAt: Date.now() + 60_000 });

    const create: BuyerRequest = { ...base(), messageId: 'msg-secrecy-create', type: 'create', requestId: REQUEST_ID, productVersion: 'book-v1', expectedAmountZat: AMOUNT_ZAT };
    await buyer.send(sellerKeyId, create);
    const invoiceReply = reply(create.messageId);
    if (invoiceReply.type !== 'invoice') throw new Error(`expected invoice, got ${invoiceReply.type}`);
    expect(invoiceReply.invoice.attribution).toMatchObject({ kind: 'receiver', receiver: { receiverHex: RECEIVER_HEX } });
    secrets['request id'] = REQUEST_ID;
    secrets['payment uri'] = invoiceReply.invoice.paymentUri;

    // Pay: a canonical receipt with 11 confirmations on the allocated receiver.
    const txid = 'e7'.repeat(32);
    secrets.txid = txid;
    snapshotReceipts = [{
      outputId: 'output-secrecy', txid, pool: 'orchard', outputIndex: 0, accountId: ACCOUNT, scope: 'external',
      receiverHex: RECEIVER_HEX, amountZat: AMOUNT_ZAT, firstSeenAt: nowSeconds() - 1, mined: { height: 20, hash: 'f'.repeat(64) }, canonical: true,
    }];
    await runtime.runLoopsOnce();

    const status: BuyerRequest = { ...base(), messageId: 'msg-secrecy-status', type: 'status', orderId: invoiceReply.invoice.orderId };
    await buyer.send(sellerKeyId, status);
    expect(reply(status.messageId).type).toBe('status');

    const recover: BuyerRequest = { ...base(), messageId: 'msg-secrecy-recover', type: 'recover', orderId: invoiceReply.invoice.orderId };
    await buyer.send(sellerKeyId, recover);
    const delivery = reply(recover.messageId);
    if (delivery.type !== 'delivery') throw new Error(`expected delivery, got ${JSON.stringify(delivery)}`);
    secrets['wrapped package (hex)'] = bytesToHex(delivery.package.encryptedEnvelope);
    secrets['wrapped package (b64)'] = toBase64(delivery.package.encryptedEnvelope);

    const ack: BuyerRequest = { ...base(), messageId: 'msg-secrecy-ack', type: 'acknowledge', orderId: invoiceReply.invoice.orderId, packageId: delivery.packageId };
    await buyer.send(sellerKeyId, ack);
    expect(reply(ack.messageId)).toMatchObject({ type: 'acknowledged', packageId: delivery.packageId });
    await runtime.runLoopsOnce();
    await buyer.close();
  } finally {
    await runtime.stop();
  }

  // The logger actually captured the cycle (not a vacuous pass).
  const events = new Set(lines.map((line) => (JSON.parse(line) as { event: string }).event));
  for (const event of ['admin.auth', 'admin.publish', 'runtime.component', 'runtime.readiness', 'http.request']) {
    expect(events.has(event), `expected a ${event} line`).toBe(true);
  }
  const text = lines.join('\n');
  for (const [label, value] of Object.entries(secrets)) {
    expect(value.length, label).toBeGreaterThan(5);
    expect(text.includes(value), `log leaked ${label}`).toBe(false);
  }
});

test('readiness defaults to messaging=false until the runtime has attached the Waku handler and probed', async () => {
  // Catalogue default: no messaging probe supplied means not ready.
  const dbPath = join(scratch, 'cat', 'seller.sqlite');
  mkdirSync(join(scratch, 'cat'), { recursive: true });
  const catalogue = openCatalogue({ dbPath, storage: createMemoryStorageAdapter() });
  try {
    expect((await catalogue.currentAvailability()).messaging).toBe(false);
  } finally {
    catalogue.close();
  }

  const sellerKey = generatePrivateKey();
  const sellerKeyId = bytesToHex(getPublicKey(sellerKey));
  const config = await liveConfig(sellerKeyId);
  writeSellerIdentity(config.dbPath, { privateKeyHex: bytesToHex(sellerKey), publicKeyHex: sellerKeyId });

  // A Waku handler that fails to attach: startup fails, so no readiness is ever reported.
  const failing: string[] = [];
  await expect(startRuntime(config, harness(makeFakeNode(), failing, (adapters) => {
    adapters.waku.subscribe = async () => { throw new Error('handler attach failed'); };
    return adapters;
  }))).rejects.toThrow(/handler attach failed/);
  expect(failing.some((line) => /"runtime\.readiness"/.test(line) && /"ok":true/.test(line))).toBe(false);

  // Normal start: the handler is attached before the runtime is returned, and
  // the initial readiness is still the all-false default until a probe runs.
  let attached = false;
  const lines: string[] = [];
  const runtime = await startRuntime(config, harness(makeFakeNode(), lines, (adapters) => {
    const subscribe = adapters.waku.subscribe.bind(adapters.waku);
    adapters.waku.subscribe = async (callback) => { const off = await subscribe(callback); attached = true; return off; };
    return adapters;
  }));
  try {
    expect(attached).toBe(true);
    expect(runtime.readiness()).toEqual({ scanner: false, messaging: false, products: {}, checkout: false, checkedAt: 0 });
    expect((await runtime.refreshReadiness()).messaging).toBe(true);
  } finally {
    await runtime.stop();
  }
});

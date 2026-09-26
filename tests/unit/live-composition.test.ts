import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generatePrivateKey, getPublicKey } from '@waku/message-encryption';
import { createDecoder, createEncoder } from '@waku/message-encryption/ecies';
import { bytesToHex } from '@waku/utils/bytes';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { MemoryScanner } from '../../src/adapters/scanner.ts';
import { createMemoryStorageAdapter } from '../../src/adapters/storage.ts';
import { createLiveAdapters, type LiveAdapters } from '../../src/adapters/live.ts';
import { createWakuSession, type WakuNode } from '../../src/adapters/waku.ts';
import { loadConfig, type RuntimeConfig } from '../../src/config.ts';
import { consensusFingerprint } from '../../src/contracts/consensus.ts';
import type { ScanSnapshot } from '../../src/contracts/live.ts';
import type { BuyerRequest, DecodedWakuMessage } from '../../src/contracts/messages.ts';
import { createOperationalLogger } from '../../src/ops/log.ts';
import { startRuntime, type RuntimeFactories } from '../../src/runtime.ts';
import { writeSellerIdentity } from '../../src/seller/identity.ts';
import { fixtureAllocation, fixtureSnapshot } from '../support/live-fixtures.ts';

type EciesEncoder = ReturnType<typeof createEncoder>;
type EciesDecoder = ReturnType<typeof createDecoder>;

const ACTIVATIONS = {
  overwinter: 1, sapling: 1, blossom: 1, heartwood: 1, canopy: 1, nu5: 1, nu6: 1,
  'nu6-1': null, 'nu6-2': null, 'nu6-3': null,
};
const GENESIS = 'ab'.repeat(32);
const ACCOUNT = 'seller-account-0';
const TOPIC = '/ssf/1/composition-test/proto';
const CHAIN = { network: 'regtest' as const, genesisHash: GENESIS, consensusFingerprint: consensusFingerprint('regtest', ACTIVATIONS) };

let scratch = '';
let servers: Server[] = [];
let scannerReply: () => { status: number; body: unknown } = () => ({ status: 200, body: liveSnapshot() });

function liveSnapshot(overrides: Partial<ScanSnapshot> = {}): ScanSnapshot {
  // The live scanner reports checkedAt in Unix SECONDS.
  return fixtureSnapshot({ chain: CHAIN, accountId: ACCOUNT, receipts: [], checkedAt: Math.floor(Date.now() / 1000), ...overrides });
}

async function scannerSocket(): Promise<string> {
  const path = join(scratch, 's.sock');
  // A second liveConfig() in one test shares the already-listening socket.
  if (servers.some((server) => server.address() === path)) return path;
  const server = createServer((socket) => {
    socket.on('data', () => undefined);
    socket.on('end', () => {
      const reply = scannerReply();
      const body = JSON.stringify(reply.body);
      socket.end(`HTTP/1.1 ${reply.status} test\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
    });
  });
  await new Promise<void>((resolve, reject) => server.listen(path, resolve).once('error', reject));
  servers.push(server);
  return path;
}

function makeFakeNode(stopped: string[]) {
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
      async subscribe(decoder: EciesDecoder, callback: (msg: unknown) => unknown) {
        subscribers.push({ decoder, callback });
        return true;
      },
      async unsubscribe() { return true; },
    } as never,
    events: { addEventListener() { return; }, removeEventListener() { return; } },
    async stop() { stopped.push('waku-node'); },
  };
  return { node, subscribers };
}

function fakeLogosRunner(peers: { a: string; b: string }) {
  return {
    async call(configDir: string, method: string) {
      if (method === 'peerId') return configDir.endsWith('node-a') ? peers.a : peers.b;
      if (method === 'manifests') return [];
      return null;
    },
    subscribe() {
      return { ready: Promise.resolve(), event: Promise.resolve(null), cancel() { return; } };
    },
  };
}

async function liveConfig(overrides: Record<string, string | undefined> = {}): Promise<RuntimeConfig> {
  const scannerConfig = join(scratch, 'scanner.json');
  writeFileSync(scannerConfig, JSON.stringify({
    ufvk: 'not-a-real-ufvk',
    runtime: { chain: CHAIN, activations: ACTIVATIONS, sourceId: 'fixture-scanner' },
  }), { mode: 0o600 });
  chmodSync(scannerConfig, 0o600);
  const tokenFile = join(scratch, 'admin.token');
  writeFileSync(tokenFile, 'admin-secret-from-file\n', { mode: 0o600 });
  chmodSync(tokenFile, 0o600);
  return loadConfig({
    SSF_MODE: 'real-demo',
    SSF_NETWORK: 'regtest',
    SSF_MAX_HEALTH_AGE_MS: '120000',
    SSF_MAX_CIPHERTEXT_BYTES: '73',
    SSF_MAX_PLAINTEXT_BYTES: '41',
    SSF_INVOICE_TTL_MS: '86400000',
    SSF_PUBLIC_HOST: '127.0.0.1',
    SSF_PUBLIC_PORT: '0',
    SSF_ADMIN_HOST: '127.0.0.1',
    SSF_ADMIN_PORT: '0',
    SSF_DB_PATH: join(scratch, 'data', 'seller.sqlite'),
    SSF_ADMIN_TOKEN_FILE: tokenFile,
    SSF_ADAPTER_MESSAGING: 'real',
    SSF_ADAPTER_STORAGE: 'real',
    SSF_ADAPTER_SCANNER: 'real',
    SSF_SCANNER_SOCKET: await scannerSocket(),
    SSF_SCANNER_ACCOUNT_ID: ACCOUNT,
    SSF_SCANNER_CONFIG: scannerConfig,
    SSF_WAKU_CONTENT_TOPIC: TOPIC,
    WAKU_BOOTSTRAP_PEERS: '/dns4/peer.example/tcp/8000/wss/p2p/16Uiu2HAmFixturePeer',
    LOGOSCTL: '/opt/logos/logosctl',
    LOGOS_NODE_A: join(scratch, 'node-a'),
    LOGOS_NODE_B: join(scratch, 'node-b'),
    ...overrides,
  });
}

function stoppedFrom(lines: string[]): string[] {
  return lines
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .filter((record) => record.event === 'runtime.component' && record.status === 'stopped')
    .map((record) => String(record.component));
}

function browserDir(): string {
  const dir = join(scratch, 'browser');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'index.html'), '<!doctype html><title>ssf</title>');
  return dir;
}

/** Parent of every Logos workDir the live storage adapter creates in a test. */
function logosWorkRoot(): string {
  const dir = join(scratch, 'logos-work');
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** ssf-logos-* workDirs still present under the test's Logos work root. */
function logosWorkDirs(): string[] {
  const dir = join(scratch, 'logos-work');
  return existsSync(dir) ? readdirSync(dir).filter((name) => name.startsWith('ssf-logos-')) : [];
}

function harness(opts: { peers?: { a: string; b: string } } = {}) {
  const stopped: string[] = [];
  const fake = makeFakeNode(stopped);
  const logger = createOperationalLogger(() => undefined);
  let fixtureFactoryCalls = 0;
  const factories: RuntimeFactories = {
    createLiveAdapters: (config, options) => createLiveAdapters(config, {
      ...options,
      wakuCreateNode: async () => fake.node,
      logosRunner: fakeLogosRunner(opts.peers ?? { a: 'peer-a', b: 'peer-b' }),
      logosWorkRoot: logosWorkRoot(),
    }),
    createFixtureAdapters: () => {
      fixtureFactoryCalls += 1;
      return { scanner: new MemoryScanner(), storage: createMemoryStorageAdapter() };
    },
    logger,
    loopIntervalMs: 60_000,
    publicDir: browserDir(),
  };
  return { stopped, fake, logger, factories, fixtureCalls: () => fixtureFactoryCalls };
}

beforeEach(() => {
  scratch = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), 'ssf-live-comp-'));
  servers = [];
  scannerReply = () => ({ status: 200, body: liveSnapshot() });
});

afterEach(async () => {
  await Promise.all(servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  rmSync(scratch, { recursive: true, force: true });
});

test('real-demo composition rejects an absent adapter without reaching the fixture factory', async () => {
  const config = await liveConfig();
  const h = harness();
  const factories: RuntimeFactories = {
    ...h.factories,
    createLiveAdapters: async (cfg, options) => {
      const adapters = await h.factories.createLiveAdapters!(cfg, options);
      return { scanner: adapters.scanner, waku: adapters.waku } as unknown as LiveAdapters;
    },
  };
  await expect(startRuntime(config, factories)).rejects.toThrow(/storage adapter/i);
  expect(h.fixtureCalls()).toBe(0);
});

test('runtime wires Waku handler errors to the allow-listed waku.handler_error event only', async () => {
  const config = await liveConfig();
  const h = harness();
  let onError: (() => void) | undefined;
  const factories: RuntimeFactories = {
    ...h.factories,
    createLiveAdapters: async (cfg, options) => {
      onError = options.onWakuHandlerError;
      const adapters = await h.factories.createLiveAdapters!(cfg, options);
      return { scanner: adapters.scanner, waku: adapters.waku } as unknown as LiveAdapters;
    },
  };
  await expect(startRuntime(config, factories)).rejects.toThrow(/storage adapter/i);
  expect(onError).toBeTypeOf('function');
  onError!();
  const events = h.logger.lines().map((line) => JSON.parse(line) as Record<string, unknown>)
    .filter((entry) => entry.event === 'waku.handler_error');
  expect(events).toHaveLength(1);
  expect(Object.keys(events[0]!).filter((k) => !['event', 'ts', 'time', 'level'].includes(k))).toEqual([]);
});

test('real-demo composition rejects a mismatched adapter implementation despite SSF_ADAPTER_*=real', async () => {
  const config = await liveConfig();
  expect(config.adapters).toEqual({ messaging: 'real', storage: 'real', scanner: 'real' });
  const h = harness();
  const factories: RuntimeFactories = {
    ...h.factories,
    createLiveAdapters: async (cfg, options) => {
      const adapters = await h.factories.createLiveAdapters!(cfg, options);
      return { ...adapters, scanner: new MemoryScanner() } as unknown as LiveAdapters;
    },
  };
  await expect(startRuntime(config, factories)).rejects.toThrow(/scanner adapter.*live implementation/i);
  const storageSwap: RuntimeFactories = {
    ...h.factories,
    createLiveAdapters: async (cfg, options) => {
      const adapters = await h.factories.createLiveAdapters!(cfg, options);
      return { ...adapters, storage: createMemoryStorageAdapter() } as unknown as LiveAdapters;
    },
  };
  await expect(startRuntime(config, storageSwap)).rejects.toThrow(/storage adapter.*live implementation/i);
  const wakuSwap: RuntimeFactories = {
    ...h.factories,
    createLiveAdapters: async (cfg, options) => {
      const adapters = await h.factories.createLiveAdapters!(cfg, options);
      const impostor = createWakuSession({ contentTopic: TOPIC, bootstrapPeers: [], peerTimeoutMs: 1000 }, generatePrivateKey(), {
        createNode: async () => h.fake.node,
      });
      return { ...adapters, waku: impostor } as unknown as LiveAdapters;
    },
  };
  await expect(startRuntime(config, wakuSwap)).rejects.toThrow(/waku adapter.*live implementation/i);
  expect(h.fixtureCalls()).toBe(0);
});

test('startup failure unwinds already-started components in reverse order', async () => {
  // Invalid live config: both Logos nodes resolve to the same peer, so the
  // storage component fails after scanner and waku have already started.
  const invalidLiveConfig = await liveConfig();
  const h = harness({ peers: { a: 'same-peer', b: 'same-peer' } });
  await expect(startRuntime(invalidLiveConfig, h.factories)).rejects.toThrow();
  // Storage was created before the failing replica check, so the unwind
  // closes it too (last) and its private Logos workDir is removed.
  expect(stoppedFrom(h.logger.lines())).toEqual(['waku', 'scanner', 'storage']);
  expect(h.stopped).toEqual(['waku-node']);
  expect(logosWorkDirs()).toEqual([]);
  expect(h.fixtureCalls()).toBe(0);
});

test('scanner chain mismatch at startup is fatal and unwinds the scanner', async () => {
  const config = await liveConfig();
  scannerReply = () => ({ status: 200, body: liveSnapshot({ chain: { ...CHAIN, genesisHash: 'cd'.repeat(32) } }) });
  const h = harness();
  await expect(startRuntime(config, h.factories)).rejects.toThrow(/chain mismatch/i);
  expect(stoppedFrom(h.logger.lines())).toEqual(['scanner', 'storage']);
  expect(logosWorkDirs()).toEqual([]);
});

test('seller identity pin mismatch is fatal before any component starts', async () => {
  const other = generatePrivateKey();
  const config = await liveConfig({ SSF_SELLER_PUBLIC_KEY: bytesToHex(getPublicKey(other)) });
  const h = harness();
  await expect(startRuntime(config, h.factories)).rejects.toThrow(/pin mismatch/i);
  expect(stoppedFrom(h.logger.lines())).toEqual([]);
  expect(h.stopped).toEqual([]);
});

test('live runtime uses the persisted identity, attaches the Waku handler, seeds nothing, and probes real readiness', async () => {
  const sellerKey = generatePrivateKey();
  const sellerKeyId = bytesToHex(getPublicKey(sellerKey));
  const config = await liveConfig({ SSF_SELLER_PUBLIC_KEY: sellerKeyId });
  writeSellerIdentity(config.dbPath, { privateKeyHex: bytesToHex(sellerKey), publicKeyHex: sellerKeyId });
  const h = harness();
  const runtime = await startRuntime(config, h.factories);
  try {
    expect(runtime.sellerKeyId).toBe(sellerKeyId);
    expect(h.fixtureCalls()).toBe(0);

    // No seeded fixture product in live mode.
    const product = await fetch(`${runtime.server!.publicUrl}/api/product`);
    expect(product.status).toBe(404);

    // Readiness is probed, not read from config booleans. checkedAt is in
    // Unix seconds and counts as fresh.
    let readiness = await runtime.refreshReadiness();
    expect(readiness.scanner).toBe(true);
    expect(readiness.messaging).toBe(true);
    expect(readiness.products).toEqual({});
    expect(readiness.checkout).toBe(false);

    // The actual seller application is subscribed on Waku: a buyer create
    // for an unpublished product gets a signed 'unavailable' response.
    const buyerKey = generatePrivateKey();
    const buyerKeyId = bytesToHex(getPublicKey(buyerKey));
    const buyer = createWakuSession({ contentTopic: TOPIC, bootstrapPeers: [], peerTimeoutMs: 1000 }, buyerKey, {
      createNode: async () => h.fake.node,
    });
    const responses: DecodedWakuMessage[] = [];
    await buyer.subscribe(async (message) => { responses.push(message); });
    const now = Date.now();
    const request: BuyerRequest = {
      version: 1, messageId: 'msg-comp-1', sellerKeyId, network: 'regtest', issuedAt: now - 1, expiresAt: now + 60_000,
      type: 'create', requestId: 'req-1', productVersion: 'book-v1', expectedAmountZat: '100000000',
    };
    await buyer.send(sellerKeyId, request);
    const reply = responses.find((message) => message.signerKeyId === sellerKeyId);
    expect(reply?.body).toMatchObject({ type: 'error', code: 'unavailable', inReplyTo: 'msg-comp-1', buyerKeyId });

    // Stale scanner snapshot (seconds) is not ready.
    scannerReply = () => ({ status: 200, body: liveSnapshot({ checkedAt: Math.floor(Date.now() / 1000) - 3600 }) });
    readiness = await runtime.refreshReadiness();
    expect(readiness.scanner).toBe(false);

    // Outage: readiness goes false and a sanitized error is logged, not swallowed.
    scannerReply = () => ({ status: 503, body: { error: 'unavailable' } });
    readiness = await runtime.refreshReadiness();
    expect(readiness.scanner).toBe(false);
    await runtime.runLoopsOnce();
    const errors = h.logger.lines().map((line) => JSON.parse(line) as Record<string, unknown>)
      .filter((record) => record.event === 'runtime.loop' && record.ok === false);
    expect(errors.length).toBeGreaterThan(0);
    for (const line of h.logger.lines()) expect(line).not.toMatch(/admin-secret|not-a-real-ufvk|s\.sock/);
  } finally {
    await runtime.stop();
  }
  // Storage closes last, after the core/server and the Waku handler stop.
  expect(stoppedFrom(h.logger.lines()).slice(-4)).toEqual(['core', 'waku', 'scanner', 'storage']);
  expect(logosWorkDirs()).toEqual([]);
});

// --- Task 10 final review I1: stop() releases the Logos storage adapter.
test('stop() closes the live storage adapter and removes its workDir and download files', async () => {
  const state = { downloads: [] as string[], missing: new Set<string>(), hang: false };
  const config = await liveConfig();
  const h = replicaHarness(state);
  const runtime = await startRuntime(config, h.factories);
  try {
    expect(logosWorkDirs()).toHaveLength(1);
    publish(runtime, 'book-v1', 'cid-v1');
    await runtime.refreshReadiness();
    await runtime.refreshReadiness();
    expect(state.downloads.length).toBe(2);
    // Readiness probes leave no download-*.ssf1 behind while running.
    const [dir] = logosWorkDirs();
    expect(readdirSync(join(scratch, 'logos-work', dir!))).toEqual([]);
  } finally {
    await runtime.stop();
  }
  expect(stoppedFrom(h.logger.lines())).toContain('storage');
  expect(logosWorkDirs()).toEqual([]);
});

test('a partial-start failure after the storage adapter was created still closes it', async () => {
  const config = await liveConfig();
  const h = harness();
  const factories: RuntimeFactories = {
    ...h.factories,
    createLiveAdapters: async (cfg, options) => {
      const adapters = await h.factories.createLiveAdapters!(cfg, options);
      // Waku startup fails after scanner (and storage) exist.
      adapters.waku.ready = async () => { throw new Error('waku bootstrap failed'); };
      return adapters;
    },
  };
  expect(logosWorkDirs()).toEqual([]);
  await expect(startRuntime(config, factories)).rejects.toThrow(/waku bootstrap failed/);
  expect(stoppedFrom(h.logger.lines())).toEqual(['waku', 'scanner', 'storage']);
  expect(logosWorkDirs()).toEqual([]);
});

// --- Fix round 1 (Critical #1): scanner 503 over the real Waku path.
test('scanner outage: Waku status replies verification unavailable, recover replies unavailable, nothing escapes', async () => {
  const sellerKey = generatePrivateKey();
  const sellerKeyId = bytesToHex(getPublicKey(sellerKey));
  const config = await liveConfig({ SSF_SELLER_PUBLIC_KEY: sellerKeyId });
  writeSellerIdentity(config.dbPath, { privateKeyHex: bytesToHex(sellerKey), publicKeyHex: sellerKeyId });
  const h = harness();
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => { unhandled.push(reason); };
  process.on('unhandledRejection', onUnhandled);
  const runtime = await startRuntime(config, h.factories);
  try {
    const buyerKey = generatePrivateKey();
    const buyerKeyId = bytesToHex(getPublicKey(buyerKey));
    // An order this buyer owns, committed directly (no product replica needed).
    const core = runtime.server!.core;
    core.catalogue.beginPublication({ version: 'book-v1', description: 'fixture', amountZat: '100000000', network: 'regtest' });
    core.catalogue.completePublication({
      version: 'book-v1', ciphertextCid: 'fixture-cid', ciphertextDigest: 'a'.repeat(64), fileSize: 1,
      sellerKeyRef: 'fixture-key', wrappedKey: new Uint8Array([1]),
    });
    const order = await core.store.createOrder({ requestId: 'req-outage', buyerKeyId, productVersion: 'book-v1' });
    const draft = await core.store.reserveInvoice({
      orderId: order.id, buyerKeyId, productVersion: 'book-v1', now: Date.now(), ttlMs: 60_000, chain: CHAIN, accountId: ACCOUNT,
    });
    await core.store.commitInvoice(draft.id, fixtureAllocation({
      allocationId: draft.id, chain: CHAIN, accountId: ACCOUNT, amountZat: draft.amountZat, expiresAt: draft.expiresAt,
      receiver: { ...fixtureAllocation().receiver, accountId: ACCOUNT },
    }));

    const buyer = createWakuSession({ contentTopic: TOPIC, bootstrapPeers: [], peerTimeoutMs: 1000 }, buyerKey, {
      createNode: async () => h.fake.node,
    });
    const responses: DecodedWakuMessage[] = [];
    await buyer.subscribe(async (message) => { responses.push(message); });

    scannerReply = () => ({ status: 503, body: { error: 'unavailable' } });
    const now = Date.now();
    const base = { version: 1 as const, sellerKeyId, network: 'regtest' as const, issuedAt: now - 1, expiresAt: now + 60_000 };
    await buyer.send(sellerKeyId, { ...base, messageId: 'msg-outage-status', type: 'status', orderId: order.id });
    await buyer.send(sellerKeyId, { ...base, messageId: 'msg-outage-recover', type: 'recover', orderId: order.id });
    await new Promise((resolve) => setTimeout(resolve, 50));

    const statusReply = responses.find((message) => message.signerKeyId === sellerKeyId && (message.body as { inReplyTo?: string }).inReplyTo === 'msg-outage-status');
    expect(statusReply?.body).toMatchObject({ type: 'status', orderId: order.id, buyerKeyId, status: { verification: 'unavailable' } });
    const recoverReply = responses.find((message) => message.signerKeyId === sellerKeyId && (message.body as { inReplyTo?: string }).inReplyTo === 'msg-outage-recover');
    expect(recoverReply?.body).toMatchObject({ type: 'error', code: 'unavailable', buyerKeyId });
    expect(unhandled).toEqual([]);
    for (const line of h.logger.lines()) expect(line).not.toMatch(/admin-secret|not-a-real-ufvk|s\.sock/);
  } finally {
    process.off('unhandledRejection', onUnhandled);
    await runtime.stop();
  }
});

// --- Fix round 1 (Important #1): replica readiness is a per-product cache
// populated only by the bounded readiness loop; request paths never download.
function countingLogosRunner(state: { downloads: string[]; missing: Set<string>; hang: boolean; started?: () => void }) {
  let resolveEvent: ((event: Record<string, unknown>) => void) | undefined;
  return {
    async call(configDir: string, method: string, args: string[] = []) {
      if (method === 'peerId') return configDir.endsWith('node-a') ? 'peer-a' : 'peer-b';
      if (method === 'manifests') return [];
      if (method === 'downloadManifest') {
        state.downloads.push(args[0]!);
        state.started?.();
        if (state.hang) return new Promise(() => undefined);
        if (state.missing.has(args[0]!)) throw new Error('manifest not found');
        return null;
      }
      if (method === 'downloadToUrl') {
        writeFileSync(args[1]!, new Uint8Array(10));
        resolveEvent?.({ sessionId: 'sess-1', success: true });
        return 'sess-1';
      }
      return null;
    },
    subscribe() {
      const event = new Promise<Record<string, unknown> | null>((resolve) => { resolveEvent = resolve; });
      return { ready: Promise.resolve(), event, cancel() { return; } };
    },
  };
}

function publish(runtime: Awaited<ReturnType<typeof startRuntime>>, version: string, cid: string): void {
  const catalogue = runtime.server!.core.catalogue;
  catalogue.beginPublication({ version, description: 'fixture', amountZat: '100000000', network: 'regtest' });
  catalogue.completePublication({
    version, ciphertextCid: cid, ciphertextDigest: 'a'.repeat(64), fileSize: 10, sellerKeyRef: `key-${version}`, wrappedKey: new Uint8Array([1]),
  });
}

function replicaHarness(state: Parameters<typeof countingLogosRunner>[0], extra: Partial<RuntimeFactories> = {}) {
  const h = harness();
  const factories: RuntimeFactories = {
    ...h.factories,
    createLiveAdapters: (config, options) => createLiveAdapters(config, {
      ...options,
      wakuCreateNode: async () => h.fake.node,
      logosRunner: countingLogosRunner(state),
      logosWorkRoot: logosWorkRoot(),
    }),
    ...extra,
  };
  return { ...h, factories };
}

async function availabilityFor(runtime: Awaited<ReturnType<typeof startRuntime>>, version?: string) {
  const query = version === undefined ? '' : `?productVersion=${encodeURIComponent(version)}`;
  const res = await fetch(`${runtime.server!.publicUrl}/api/availability${query}`);
  expect(res.status).toBe(200);
  return await res.json() as { productPublished: boolean; storageReplica: boolean; scanner: boolean; messaging: boolean };
}

test('replica readiness is cached per product by the loop; request paths never download', async () => {
  const state = { downloads: [] as string[], missing: new Set(['cid-v2']), hang: false };
  const config = await liveConfig();
  const h = replicaHarness(state);
  const runtime = await startRuntime(config, h.factories);
  try {
    publish(runtime, 'book-v1', 'cid-v1');
    publish(runtime, 'book-v2', 'cid-v2');
    // Before the loop has probed anything: unavailable, and no download.
    expect((await availabilityFor(runtime, 'book-v1')).storageReplica).toBe(false);
    expect(state.downloads).toEqual([]);

    const readiness = await runtime.refreshReadiness();
    expect(readiness.products).toEqual({ 'book-v1': true, 'book-v2': false });
    const probed = state.downloads.length;
    expect(probed).toBe(2);

    const v1 = await availabilityFor(runtime, 'book-v1');
    expect(v1).toEqual({ productPublished: true, messaging: true, storageReplica: true, scanner: true });
    const v2 = await availabilityFor(runtime, 'book-v2');
    expect(v2.productPublished).toBe(true);
    expect(v2.storageReplica).toBe(false);
    expect((await availabilityFor(runtime, 'book-v9')).productPublished).toBe(false);
    await availabilityFor(runtime);
    expect((await runtime.server!.core.catalogue.productAvailability('book-v1')).storageReplica).toBe(true);

    // Waku create reads the same cache (v2 replica missing => unavailable) without downloading.
    const buyerKey = generatePrivateKey();
    const buyer = createWakuSession({ contentTopic: TOPIC, bootstrapPeers: [], peerTimeoutMs: 1000 }, buyerKey, { createNode: async () => h.fake.node });
    const responses: DecodedWakuMessage[] = [];
    await buyer.subscribe(async (message) => { responses.push(message); });
    const now = Date.now();
    await buyer.send(runtime.sellerKeyId, {
      version: 1, messageId: 'msg-v2', sellerKeyId: runtime.sellerKeyId, network: 'regtest', issuedAt: now - 1, expiresAt: now + 60_000,
      type: 'create', requestId: 'req-v2', productVersion: 'book-v2', expectedAmountZat: '100000000',
    });
    expect(responses.find((message) => message.signerKeyId === runtime.sellerKeyId)?.body).toMatchObject({ type: 'error', code: 'unavailable' });

    expect(state.downloads.length).toBe(probed);
  } finally {
    await runtime.stop();
  }
});

test('a stale readiness cache (past TTL) reports unavailable without re-probing', async () => {
  const state = { downloads: [] as string[], missing: new Set<string>(), hang: false };
  let clock = Date.now();
  const config = await liveConfig();
  const h = replicaHarness(state, { now: () => clock, readinessTtlMs: 1_000 });
  const runtime = await startRuntime(config, h.factories);
  try {
    publish(runtime, 'book-v1', 'cid-v1');
    await runtime.refreshReadiness();
    expect((await availabilityFor(runtime, 'book-v1')).storageReplica).toBe(true);
    const probed = state.downloads.length;
    clock += 1_001;
    const stale = await availabilityFor(runtime, 'book-v1');
    expect(stale.storageReplica).toBe(false);
    expect(stale.scanner).toBe(false);
    expect(state.downloads.length).toBe(probed);
  } finally {
    await runtime.stop();
  }
});

test('a hung replica probe is bounded and never blocks stop()', async () => {
  const state = { downloads: [] as string[], missing: new Set<string>(), hang: true };
  const config = await liveConfig();
  const h = replicaHarness(state, { replicaProbeTimeoutMs: 50 });
  const runtime = await startRuntime(config, h.factories);
  try {
    publish(runtime, 'book-v1', 'cid-v1');
    // Bounded: the probe times out and the product is not ready.
    const readiness = await runtime.refreshReadiness();
    expect(readiness.products).toEqual({ 'book-v1': false });

    // stop() while a probe is in flight (and hangs forever) resolves promptly.
    let started!: () => void;
    const probeStarted = new Promise<void>((resolve) => { started = resolve; });
    const slow = replicaHarness({ ...state, downloads: [], started }, { replicaProbeTimeoutMs: 60_000 });
    const second = await liveConfig({ SSF_DB_PATH: join(scratch, 'data2', 'seller.sqlite') });
    const runtime2 = await startRuntime(second, slow.factories);
    publish(runtime2, 'book-v1', 'cid-v1');
    void runtime2.refreshReadiness();
    await probeStarted;
    const t0 = Date.now();
    const outcome = await Promise.race([
      runtime2.stop().then(() => 'stopped'),
      new Promise((resolve) => setTimeout(() => resolve('timeout'), 2_000)),
    ]);
    expect(outcome).toBe('stopped');
    expect(Date.now() - t0).toBeLessThan(1_000);
  } finally {
    await runtime.stop();
  }
});

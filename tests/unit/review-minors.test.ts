// Subtask 10.6: deferred slice-A review minors 1, 5 and 6 (config minors 2, 4
// and 7 live in config.test.ts). Deterministic unit tests only: nothing here is
// live evidence.
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generatePrivateKey } from '@waku/message-encryption';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import {
  createLiveAdapters,
  createWakuFulfillmentMessaging,
  LIVE_MESSENGER_HISTORY_CAP,
  type LiveAdapters,
} from '../../src/adapters/live.ts';
import { createMemoryStorageAdapter } from '../../src/adapters/storage.ts';
import { createWakuSession, type WakuNode } from '../../src/adapters/waku.ts';
import { ConfigError, loadConfig, type RuntimeConfig } from '../../src/config.ts';
import { consensusFingerprint } from '../../src/contracts/consensus.ts';
import type { WakuSession } from '../../src/contracts/messages.ts';
import { startRuntime } from '../../src/runtime.ts';

const ACTIVATIONS = {
  overwinter: 1, sapling: 1, blossom: 1, heartwood: 1, canopy: 1, nu5: 1, nu6: 1,
  'nu6-1': null, 'nu6-2': null, 'nu6-3': null,
};
const GENESIS = 'ab'.repeat(32);
const CHAIN = { network: 'regtest' as const, genesisHash: GENESIS, consensusFingerprint: consensusFingerprint('regtest', ACTIVATIONS) };
const TOPIC = '/ssf/1/review-minors/proto';

let scratch = '';

beforeEach(() => {
  scratch = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), 'ssf-minors-'));
});

afterEach(() => {
  rmSync(scratch, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Minor 1: waku.ready() must reflect current connectivity, not latch true.

type ControlledNode = {
  node: WakuNode;
  setConnected(up: boolean): void;
  setSubscribeOk(ok: boolean): void;
  emitConnection(up: boolean): void;
  subscribeCalls(): number;
};

function controlledNode(opts: { withIsConnected?: boolean } = {}): ControlledNode {
  let connected = true;
  let subscribeOk = true;
  let subscribes = 0;
  const listeners = new Set<(event: { detail: unknown }) => void>();
  const node: WakuNode = {
    async waitForPeers() { return; },
    lightPush: { async send() { return { successes: ['peer'], failures: [] }; } },
    filter: {
      async subscribe() { subscribes += 1; return subscribeOk; },
      async unsubscribe() { return true; },
    },
    events: {
      addEventListener(type, listener) { if (type === 'waku:connection') listeners.add(listener); },
      removeEventListener(type, listener) { if (type === 'waku:connection') listeners.delete(listener); },
    },
    async stop() { return; },
    ...(opts.withIsConnected === false ? {} : { isConnected: () => connected }),
  };
  return {
    node,
    setConnected(up) { connected = up; },
    setSubscribeOk(ok) { subscribeOk = ok; },
    emitConnection(up) { for (const listener of listeners) listener({ detail: up }); },
    subscribeCalls: () => subscribes,
  };
}

const wakuConfig = { contentTopic: TOPIC, bootstrapPeers: [], peerTimeoutMs: 1000 };
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

test('minor 1: ready() turns false when the node loses its peers and true again after they return', async () => {
  const fake = controlledNode();
  const session = createWakuSession(wakuConfig, generatePrivateKey(), { createNode: async () => fake.node });
  expect(await session.ready()).toBe(true);
  fake.setConnected(false);
  expect(await session.ready()).toBe(false);
  fake.setConnected(true);
  expect(await session.ready()).toBe(true);
  await session.close();
});

test('minor 1: a disconnect event drops readiness even without node.isConnected()', async () => {
  const fake = controlledNode({ withIsConnected: false });
  const session = createWakuSession(wakuConfig, generatePrivateKey(), { createNode: async () => fake.node });
  expect(await session.ready()).toBe(true);
  fake.emitConnection(false);
  expect(await session.ready()).toBe(false);
  fake.emitConnection(true);
  await flush();
  expect(fake.subscribeCalls()).toBe(2);
  expect(await session.ready()).toBe(true);
  await session.close();
});

test('minor 1: a failed filter resubscribe after reconnect keeps ready() false (no unhandled rejection)', async () => {
  const fake = controlledNode();
  const session = createWakuSession(wakuConfig, generatePrivateKey(), { createNode: async () => fake.node });
  expect(await session.ready()).toBe(true);
  fake.emitConnection(false);
  fake.setSubscribeOk(false);
  fake.emitConnection(true);
  await flush();
  expect(await session.ready()).toBe(false);
  fake.setSubscribeOk(true);
  fake.emitConnection(true);
  await flush();
  expect(await session.ready()).toBe(true);
  await session.close();
});

// ---------------------------------------------------------------------------
// Minor 5: the live messenger's history arrays are bounded.

test('minor 5: live messenger history is capped and keeps the newest entries', async () => {
  const session: WakuSession = {
    async ready() { return true; },
    async send() { return; },
    async subscribe() { return async () => undefined; },
    async decodeStored() { throw new Error('unused'); },
    async close() { return; },
  };
  const messenger = createWakuFulfillmentMessaging(session, 'ab'.repeat(65), 'regtest', () => 1_000);
  const total = LIVE_MESSENGER_HISTORY_CAP + 44;
  for (let i = 0; i < total; i += 1) {
    await messenger.send({ orderId: `order-${i}`, productVersion: 'v1', buyerKeyId: 'cd'.repeat(65), encryptedEnvelope: new Uint8Array([1]), packageId: `pkg-${i}` });
  }
  expect(LIVE_MESSENGER_HISTORY_CAP).toBe(256);
  expect(messenger.sendInitiatedFor.length).toBe(LIVE_MESSENGER_HISTORY_CAP);
  expect(messenger.sendInitiatedFor.at(-1)).toBe(`order-${total - 1}`);
  expect(messenger.sendInitiatedFor[0]).toBe(`order-${total - LIVE_MESSENGER_HISTORY_CAP}`);
  expect(messenger.sent.length).toBeLessThanOrEqual(LIVE_MESSENGER_HISTORY_CAP);
});

// ---------------------------------------------------------------------------
// Minor 6: adapters are closed (and the Logos workDir removed) when the
// runtime rejects a mismatched adapter set.

function fakeLogosRunner() {
  return {
    async call(configDir: string, method: string) {
      if (method === 'peerId') return configDir.endsWith('node-a') ? 'peer-a' : 'peer-b';
      return null;
    },
    subscribe() {
      return { ready: Promise.resolve(), event: Promise.resolve(null), cancel() { return; } };
    },
  };
}

function realDemoConfig(): RuntimeConfig {
  const scannerConfig = join(scratch, 'scanner.json');
  writeFileSync(scannerConfig, JSON.stringify({ runtime: { chain: CHAIN, activations: ACTIVATIONS } }), { mode: 0o600 });
  chmodSync(scannerConfig, 0o600);
  const tokenFile = join(scratch, 'admin.token');
  writeFileSync(tokenFile, 'token-from-file\n', { mode: 0o600 });
  chmodSync(tokenFile, 0o600);
  return loadConfig({
    SSF_MODE: 'real-demo',
    SSF_NETWORK: 'regtest',
    SSF_MAX_HEALTH_AGE_MS: '120000',
    SSF_MAX_CIPHERTEXT_BYTES: '73',
    SSF_MAX_PLAINTEXT_BYTES: '41',
    SSF_INVOICE_TTL_MS: '86400000',
    SSF_PUBLIC_PORT: '0',
    SSF_ADMIN_PORT: '0',
    SSF_DB_PATH: join(scratch, 'data', 'seller.sqlite'),
    SSF_ADMIN_TOKEN_FILE: tokenFile,
    SSF_ADAPTER_MESSAGING: 'real',
    SSF_ADAPTER_STORAGE: 'real',
    SSF_ADAPTER_SCANNER: 'real',
    SSF_SCANNER_SOCKET: join(scratch, 'never.sock'),
    SSF_SCANNER_ACCOUNT_ID: 'seller-account-0',
    SSF_SCANNER_CONFIG: scannerConfig,
    SSF_WAKU_CONTENT_TOPIC: TOPIC,
    WAKU_BOOTSTRAP_PEERS: '/dns4/peer.example/tcp/8000/wss/p2p/16Uiu2HAmFixturePeer',
    LOGOSCTL: '/opt/logos/logosctl',
    LOGOS_NODE_A: join(scratch, 'node-a'),
    LOGOS_NODE_B: join(scratch, 'node-b'),
  });
}

async function realAdapters(config: RuntimeConfig, sellerPrivateKey: Uint8Array, workRoot: string): Promise<LiveAdapters> {
  return createLiveAdapters(config, {
    sellerPrivateKey,
    wakuCreateNode: async () => controlledNode().node,
    logosRunner: fakeLogosRunner(),
    logosWorkRoot: workRoot,
  });
}

test('minor 6: live storage close() removes its private Logos workDir', async () => {
  const config = realDemoConfig();
  const workRoot = join(scratch, 'work');
  mkdirSync(workRoot);
  const adapters = await realAdapters(config, generatePrivateKey(), workRoot);
  expect(readdirSync(workRoot).length).toBe(1);
  await adapters.storage.close();
  expect(readdirSync(workRoot)).toEqual([]);
  await adapters.scanner.close();
  await adapters.waku.close();
});

test('minor 6: a mismatched scanner is closed along with the real adapters, then the error is rethrown', async () => {
  const config = realDemoConfig();
  const workRoot = join(scratch, 'work');
  mkdirSync(workRoot);
  const imposterClose = vi.fn(async () => undefined);
  let wakuClose: ReturnType<typeof vi.spyOn> | undefined;
  const run = startRuntime(config, {
    createLiveAdapters: async (cfg, options) => {
      const real = await realAdapters(cfg, options.sellerPrivateKey, workRoot);
      wakuClose = vi.spyOn(real.waku, 'close');
      return { ...real, scanner: { snapshot: async () => { throw new Error('unused'); }, allocateReceiver: async () => { throw new Error('unused'); }, close: imposterClose } };
    },
  });
  await expect(run).rejects.toBeInstanceOf(ConfigError);
  await expect(run).rejects.toThrow(/scanner adapter is not the live implementation/);
  expect(imposterClose).toHaveBeenCalledTimes(1);
  expect(wakuClose).toHaveBeenCalledTimes(1);
  expect(readdirSync(workRoot)).toEqual([]);
});

test('minor 6: a mismatched storage exposing only stop() is stopped, and a failing close does not mask the error', async () => {
  const config = realDemoConfig();
  const workRoot = join(scratch, 'work');
  mkdirSync(workRoot);
  const imposterStop = vi.fn(async () => undefined);
  let scannerClose: ReturnType<typeof vi.spyOn> | undefined;
  const run = startRuntime(config, {
    createLiveAdapters: async (cfg, options) => {
      const real = await realAdapters(cfg, options.sellerPrivateKey, workRoot);
      scannerClose = vi.spyOn(real.scanner, 'close').mockRejectedValue(new Error('close exploded'));
      // The real storage is dropped here, so remove its workDir ourselves.
      await real.storage.close();
      const imposter = { ...createMemoryStorageAdapter(), assertIndependentReplicas: async () => undefined, stop: imposterStop };
      return { ...real, storage: imposter as unknown as LiveAdapters['storage'] };
    },
  });
  await expect(run).rejects.toThrow(/storage adapter is not the live implementation/);
  expect(imposterStop).toHaveBeenCalledTimes(1);
  expect(scannerClose).toHaveBeenCalledTimes(1);
  expect(existsSync(workRoot)).toBe(true);
});

// Server-only live adapter composition for SSF_MODE=real-demo. Never import
// from browser code. Fixture/memory adapters are deliberately not imported
// here, so they are unreachable from real-demo composition.
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RuntimeConfig } from '../config.ts';
import type { ReceiptSource, ScanSnapshot } from '../contracts/live.ts';
import type { SellerResponse, WakuConfig, WakuSession } from '../contracts/messages.ts';
import type { DeliveryPackage, StorageAdapter } from '../contracts/types.ts';
import type { FulfillmentMessaging } from './messaging.ts';
import { createLogosStorageAdapter, defaultLogosRunner, type LogosRunner } from './storage.ts';
import { sha256Hex } from './crypto.ts';
import { confirmRemoteReplica, createRemoteReplica } from './remote-replica.ts';
import { createWakuSession, type WakuNode } from './waku.ts';
import { createWalletScanner } from './wallet-scanner.ts';

export type LiveAdapterKind = 'scanner' | 'storage' | 'waku';

/**
 * Storage with the independent-replica startup check the runtime gates on, and
 * a close() that removes its private Logos work directory.
 */
export type LiveStorage = StorageAdapter & {
  assertIndependentReplicas(): Promise<void>;
  verifyPublished(cid: string, digest: string, sizeBytes: number): Promise<boolean>;
  close(): Promise<void>;
};

export type LiveAdapters = {
  scanner: ReceiptSource;
  storage: LiveStorage;
  waku: WakuSession;
};

export type LiveAdapterOptions = {
  /** Validated persisted seller identity; the Waku session signs with it. */
  sellerPrivateKey: Uint8Array;
  /** Test seams only: substitute transports, never the adapter implementations. */
  wakuCreateNode?: (config: WakuConfig) => Promise<WakuNode>;
  logosRunner?: LogosRunner;
  /** Parent of the private Logos work directory (default: TMPDIR or the OS tmpdir). */
  logosWorkRoot?: string;
  /** Called (no arguments) when the seller's Waku handler rejects; log an allow-listed event only. */
  onWakuHandlerError?: () => void;
};

// Module-private registry of objects produced by createLiveAdapters. The
// runtime checks actual implementation identity against it, so a config that
// says SSF_ADAPTER_*=real cannot be satisfied by a memory/fixture object.
const liveImplementations = new WeakMap<object, LiveAdapterKind>();

function brand<T extends object>(kind: LiveAdapterKind, value: T): T {
  liveImplementations.set(value, kind);
  return value;
}

export function isLiveImplementation(kind: LiveAdapterKind, value: unknown): boolean {
  return typeof value === 'object' && value !== null && liveImplementations.get(value) === kind;
}

const MS_PER_SECOND = 1000;

/**
 * The live scanner reports `checkedAt` and receipt `firstSeenAt` in Unix
 * SECONDS. Seller payment/readiness policy works in milliseconds
 * (`Date.now()`, `maxHealthAgeMs`, invoice `expiresAt`), so normalise at this
 * boundary exactly once.
 */
function snapshotToMillis(snapshot: ScanSnapshot): ScanSnapshot {
  return {
    ...snapshot,
    checkedAt: snapshot.checkedAt * MS_PER_SECOND,
    receipts: snapshot.receipts.map((receipt) => ({ ...receipt, firstSeenAt: receipt.firstSeenAt * MS_PER_SECOND })),
  };
}

/** Below this, an `expiresAt` is not a plausible Unix-milliseconds timestamp (it would be before 2001). */
const MIN_EXPIRES_AT_MS = 1e12;
/** At or above this it is microseconds (or later than year 5138), not milliseconds. */
const MAX_EXPIRES_AT_MS = 1e14;

/**
 * Invoice `expiresAt` is milliseconds; the scanner's allocation `expiresAt` is
 * Unix SECONDS. Convert once here (rounding up so the scanner never expires an
 * allocation early). wallet-scanner then requires the echo to equal the
 * seconds sent, and callers get their milliseconds back.
 */
function expiresAtToSeconds(expiresAt: number): number {
  if (!Number.isSafeInteger(expiresAt) || expiresAt < MIN_EXPIRES_AT_MS || expiresAt >= MAX_EXPIRES_AT_MS) {
    throw new TypeError('expiresAt must be a Unix-milliseconds safe integer');
  }
  return Math.ceil(expiresAt / MS_PER_SECOND);
}

export function createLiveReceiptSource(config: Pick<NonNullable<RuntimeConfig['live']>, 'scannerSocket' | 'chain' | 'scannerAccountId'>): ReceiptSource {
  const inner = createWalletScanner({
    socketPath: config.scannerSocket,
    expectedChain: config.chain,
    accountId: config.scannerAccountId,
  });
  return {
    async snapshot() { return snapshotToMillis(await inner.snapshot()); },
    async allocateReceiver(input) {
      const seconds = expiresAtToSeconds(input.expiresAt);
      const allocation = await inner.allocateReceiver({ ...input, expiresAt: seconds });
      return { ...allocation, expiresAt: input.expiresAt };
    },
    close: () => inner.close(),
  };
}

/**
 * The origin's fixed loopback `listen-port`, from the `storage-init.json`
 * that `scripts/live-infra/logos-up.ts` writes into the node directory.
 * Undefined when absent or malformed (replication then keeps the empty hint).
 */
export function readOriginListenPort(originConfigDir: string): number | undefined {
  try {
    const init = JSON.parse(readFileSync(join(originConfigDir, 'storage-init.json'), 'utf8')) as Record<string, unknown>;
    const port = init['listen-port'];
    return typeof port === 'number' && Number.isInteger(port) && port > 0 && port <= 65535 ? port : undefined;
  } catch {
    return undefined;
  }
}

const REMOTE_REPLICA_TIMEOUT_MS = 90_000;

function liveStorage(
  config: NonNullable<RuntimeConfig['live']>,
  runner: LogosRunner,
  workRoot: string,
  maxBytes: number,
): LiveStorage {
  // Owned here (not inside the Logos adapter) so close() can remove it.
  const workDir = mkdtempSync(join(workRoot, 'ssf-logos-'));
  const originListenPort = readOriginListenPort(config.logos.originConfigDir);
  const remote = config.replicaAgent === undefined
    ? undefined
    : createRemoteReplica({
        url: config.replicaAgent.url,
        tokenFile: config.replicaAgent.tokenFile,
        timeoutMs: REMOTE_REPLICA_TIMEOUT_MS,
        maxBytes,
      });
  const adapter = createLogosStorageAdapter(
    originListenPort === undefined ? config.logos : { ...config.logos, originListenPort },
    { runner, workDir },
    { maxBytes, ...(remote ? { connectReplica: false } : {}) },
  );
  const known = new Map<string, { digest: string; sizeBytes: number }>();
  return {
    async publish(ciphertext) {
      const cid = await adapter.publish(ciphertext);
      if (!remote || config.replicaAgent === undefined) return cid;
      const originPeerId = await runner.call(config.logos.originConfigDir, 'peerId');
      if (typeof originPeerId !== 'string' || originPeerId.length === 0) {
        throw new Error('replica verification failed');
      }
      const digest = sha256Hex(ciphertext);
      const sizeBytes = ciphertext.byteLength;
      known.set(cid, { digest, sizeBytes });
      const port = originListenPort ?? 8091;
      const ok = await confirmRemoteReplica(remote, {
        cid,
        originMultiaddr: `/ip4/${config.replicaAgent.advertiseHost}/tcp/${port}/p2p/${originPeerId}`,
        digest,
        sizeBytes,
      });
      if (!ok) throw new Error('replica verification failed');
      return cid;
    },
    fetch: (cid) => (remote ? remote.fetch(cid) : adapter.fetch(cid)),
    async verifyReplica(cid, replicaId) {
      if (!remote) return adapter.verifyReplica(cid, replicaId);
      const noted = known.get(cid);
      if (noted) remote.noteExpected(cid, noted.digest, noted.sizeBytes);
      return remote.verifyReplica(cid, replicaId);
    },
    async verifyPublished(cid, digest, sizeBytes) {
      if (remote) {
        known.set(cid, { digest, sizeBytes });
        remote.noteExpected(cid, digest, sizeBytes);
        return remote.verifyReplica(cid, 'replica');
      }
      return adapter.verifyReplica(cid, 'replica');
    },
    async assertIndependentReplicas() {
      if (remote) {
        const origin = await runner.call(config.logos.originConfigDir, 'peerId');
        if (typeof origin !== 'string' || origin.length === 0) {
          throw new Error('logos storage peer identity unavailable');
        }
        await remote.assertIndependentReplicas(origin);
        return;
      }
      const [a, b] = await Promise.all([
        runner.call(config.logos.originConfigDir, 'peerId'),
        runner.call(config.logos.replicaConfigDir, 'peerId'),
      ]);
      if (typeof a !== 'string' || typeof b !== 'string' || a.length === 0 || b.length === 0) {
        throw new Error('logos storage peer identity unavailable');
      }
      if (a === b) throw new Error('logos origin and replica are not independent peers');
    },
    async close() {
      remote?.close();
      rmSync(workDir, { recursive: true, force: true });
    },
  };
}

/**
 * Pushes an authorised delivery to the buyer over the authenticated Waku
 * session. The pull path (`recover`) remains the durable fallback.
 */
export const LIVE_MESSENGER_HISTORY_CAP = 256;

/** Appends and drops the oldest entries beyond the cap, in place. */
function pushCapped<T>(ring: T[], value: T): void {
  ring.push(value);
  if (ring.length > LIVE_MESSENGER_HISTORY_CAP) ring.splice(0, ring.length - LIVE_MESSENGER_HISTORY_CAP);
}

export function createWakuFulfillmentMessaging(session: WakuSession, sellerKeyId: string, network: 'test' | 'regtest', now: () => number = Date.now): FulfillmentMessaging {
  if (sellerKeyId.length === 0) throw new Error('live messenger requires a seller key id');
  // The live messenger never records delivered packages (`sent` stays empty);
  // `sendInitiatedFor` is diagnostic only and bounded.
  const sent: DeliveryPackage[] = [];
  const sendInitiatedFor: string[] = [];
  return {
    sent,
    sendInitiatedFor,
    async send(pkg) {
      if (!pkg.packageId) throw new Error('prepared package missing identity');
      pushCapped(sendInitiatedFor, pkg.orderId);
      const at = now();
      const messageId = `push-${pkg.packageId}`;
      const body: SellerResponse = {
        version: 1, messageId, inReplyTo: messageId, sellerKeyId, buyerKeyId: pkg.buyerKeyId, network,
        issuedAt: at, expiresAt: at + 15 * 60 * 1000, type: 'delivery', packageId: pkg.packageId,
        package: { orderId: pkg.orderId, productVersion: pkg.productVersion, buyerKeyId: pkg.buyerKeyId, encryptedEnvelope: pkg.encryptedEnvelope },
      };
      await session.send(pkg.buyerKeyId, body);
    },
  };
}

export async function createLiveAdapters(config: RuntimeConfig, options: LiveAdapterOptions): Promise<LiveAdapters> {
  const live = config.live;
  if ((config.mode !== 'real-demo' && config.mode !== 'public-testnet') || !live) {
    throw new Error('live adapters require real-demo configuration');
  }
  const runner = options.logosRunner ?? defaultLogosRunner(live.logos.logosctlPath);
  return {
    scanner: brand('scanner', createLiveReceiptSource(live)),
    storage: brand('storage', liveStorage(live, runner, options.logosWorkRoot ?? process.env.TMPDIR ?? tmpdir(), config.maxCiphertextBytes)),
    waku: brand('waku', createWakuSession(live.waku, options.sellerPrivateKey, {
      ...(options.wakuCreateNode ? { createNode: options.wakuCreateNode } : {}),
      ...(options.onWakuHandlerError ? { onHandlerError: options.onWakuHandlerError } : {}),
    })),
  };
}

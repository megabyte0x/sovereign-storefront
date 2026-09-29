// Server-only runtime composition and lifecycle. Real-demo composition only
// ever goes through `createLiveAdapters`; fixture adapters are reachable only
// through an explicitly injected fixture factory in fixture mode.
import { hexToBytes } from '@waku/utils/bytes';
import {
  createLiveAdapters as defaultCreateLiveAdapters,
  createWakuFulfillmentMessaging,
  isLiveImplementation,
  type LiveAdapterKind,
  type LiveAdapterOptions,
  type LiveAdapters,
} from './adapters/live.ts';
import { ConfigError, type RuntimeConfig } from './config.ts';
import { eligibleSnapshot } from './contracts/live-validation.ts';
import type { ReceiptSource } from './contracts/live.ts';
import { allowNewCheckout, type StorageAdapter } from './contracts/types.ts';
import { silentLogger, type OperationalLogger } from './ops/log.ts';
import { loadOrCreateSellerIdentity } from './seller/identity.ts';
import { attachSellerApplication, createSellerApplication } from './seller/messages.ts';
import { startSeller, type SellerServer } from './seller/server.ts';

export type FixtureAdapters = { scanner: ReceiptSource; storage: StorageAdapter };

export type RuntimeFactories = {
  createLiveAdapters?: (config: RuntimeConfig, options: LiveAdapterOptions) => Promise<LiveAdapters>;
  /** Fixture mode only; never invoked for real-demo. */
  createFixtureAdapters?: () => FixtureAdapters;
  logger?: OperationalLogger;
  loopIntervalMs?: number;
  maxBackoffMs?: number;
  now?: () => number;
  /** Max age of a cached readiness entry before request paths treat it as not ready. Default 3x the readiness interval. */
  readinessTtlMs?: number;
  /** Upper bound on one replica probe; a timeout counts as not ready. Default 30 s. */
  replicaProbeTimeoutMs?: number;
  /** Built browser UI directory (must contain index.html); required by real-demo startSeller. */
  publicDir?: string;
};

export type RuntimeReadiness = {
  scanner: boolean;
  messaging: boolean;
  /** New-checkout readiness per published product version. */
  products: Record<string, boolean>;
  checkout: boolean;
  checkedAt: number;
};

export type Runtime = {
  sellerKeyId: string;
  server?: SellerServer;
  readiness(): RuntimeReadiness;
  refreshReadiness(): Promise<RuntimeReadiness>;
  /** Runs one reconcile then one dispatch cycle, sharing the loops' in-flight guards. */
  runLoopsOnce(): Promise<void>;
  stop(): Promise<void>;
};

const DEFAULT_LOOP_INTERVAL_MS = 2_000;
const DEFAULT_MAX_BACKOFF_MS = 60_000;
const READINESS_INTERVAL_FACTOR = 5;
const DEFAULT_REPLICA_PROBE_TIMEOUT_MS = 30_000;

type CacheEntry = { ok: boolean; checkedAt: number };

/** Resolves `fallback` if `work` does not settle within `ms`; never rejects. */
function bounded<T>(work: Promise<T>, ms: number, fallback: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(fallback), ms);
    timer.unref();
  });
  return Promise.race([work.catch(() => fallback), timeout]).finally(() => clearTimeout(timer));
}

function errorCode(error: unknown): string {
  return error instanceof Error ? error.name : 'Error';
}

type Loop = { runOnce(): Promise<void>; stop(options?: { drain?: boolean }): Promise<void> };

/**
 * A bounded, non-overlapping loop: the next tick is scheduled only after the
 * current run settles, failures back off exponentially up to a cap, and
 * errors are logged as sanitized codes rather than swallowed.
 */
function startLoop(name: string, intervalMs: number, maxBackoffMs: number, logger: OperationalLogger, fn: () => Promise<void>): Loop {
  let stopped = false;
  let failures = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let inFlight: Promise<void> | null = null;

  const runOnce = (): Promise<void> => {
    if (inFlight) return inFlight;
    const started = Date.now();
    inFlight = (async () => {
      try {
        await fn();
        if (failures > 0) logger.log({ event: 'runtime.loop', loop: name, ok: true, count: failures });
        failures = 0;
      } catch (error) {
        failures += 1;
        logger.log({ event: 'runtime.loop', loop: name, ok: false, code: errorCode(error), count: failures, durationMs: Date.now() - started });
      } finally {
        inFlight = null;
      }
    })();
    return inFlight;
  };

  const schedule = (): void => {
    if (stopped) return;
    const delay = Math.min(intervalMs * 2 ** Math.min(failures, 16), maxBackoffMs);
    timer = setTimeout(() => {
      void runOnce().then(schedule);
    }, delay);
    timer.unref();
  };
  schedule();

  return {
    runOnce,
    async stop({ drain = true } = {}) {
      stopped = true;
      if (timer) clearTimeout(timer);
      if (drain && inFlight) await inFlight;
    },
  };
}

function assertLiveAdapters(adapters: Partial<LiveAdapters> | undefined): LiveAdapters {
  const kinds: LiveAdapterKind[] = ['scanner', 'storage', 'waku'];
  for (const kind of kinds) {
    const value = adapters?.[kind];
    if (value === undefined || value === null) {
      throw new ConfigError(`real-demo requires the live ${kind} adapter; it is missing`);
    }
    if (!isLiveImplementation(kind, value)) {
      throw new ConfigError(`${kind} adapter is not the live implementation (SSF_ADAPTER_* says real)`);
    }
  }
  return adapters as LiveAdapters;
}

/** Best-effort close()/stop() of whatever a live-adapter factory returned. */
async function closeCreatedAdapters(created: Partial<LiveAdapters> | undefined): Promise<void> {
  const values = Object.values(created ?? {}) as unknown[];
  await Promise.allSettled(values.map(async (value) => {
    if (typeof value !== 'object' || value === null) return;
    const closable = value as { close?: unknown; stop?: unknown };
    if (typeof closable.close === 'function') await (closable.close as () => unknown).call(value);
    else if (typeof closable.stop === 'function') await (closable.stop as () => unknown).call(value);
  }));
}

async function startFixtureRuntime(config: RuntimeConfig, factories: RuntimeFactories): Promise<Runtime> {
  if (!factories.createFixtureAdapters) throw new ConfigError('fixture mode requires an explicit fixture adapter factory');
  const fixture = factories.createFixtureAdapters();
  const server = await startSeller({ config, seedProduct: true, scanner: fixture.scanner, storage: fixture.storage, logger: factories.logger });
  const readiness: RuntimeReadiness = { scanner: true, messaging: true, products: {}, checkout: true, checkedAt: Date.now() };
  return {
    sellerKeyId: server.core.sellerKeyId,
    server,
    readiness: () => readiness,
    refreshReadiness: async () => readiness,
    runLoopsOnce: async () => undefined,
    stop: () => server.close(),
  };
}

export async function startRuntime(config: RuntimeConfig, factories: RuntimeFactories = {}): Promise<Runtime> {
  if (config.mode !== 'real-demo' && config.mode !== 'public-testnet') return startFixtureRuntime(config, factories);
  const live = config.live;
  if (!live) {
    throw new ConfigError(config.mode === 'real-demo'
      ? 'real-demo requires live configuration'
      : 'public-testnet requires live configuration');
  }
  const logger = factories.logger ?? silentLogger;
  const now = factories.now ?? Date.now;
  const intervalMs = factories.loopIntervalMs ?? DEFAULT_LOOP_INTERVAL_MS;
  const maxBackoffMs = factories.maxBackoffMs ?? DEFAULT_MAX_BACKOFF_MS;
  const readinessIntervalMs = intervalMs * READINESS_INTERVAL_FACTOR;
  const readinessTtlMs = factories.readinessTtlMs ?? readinessIntervalMs * 3;
  const replicaProbeTimeoutMs = factories.replicaProbeTimeoutMs ?? DEFAULT_REPLICA_PROBE_TIMEOUT_MS;

  // Persisted seller identity is authoritative; a configured pin that does not
  // match it is fatal before anything starts.
  const identity = loadOrCreateSellerIdentity(config.dbPath, live.sellerPublicKeyPin === undefined
    ? {}
    : { expectedPublicKeyHex: live.sellerPublicKeyPin });
  const sellerKeyId = identity.publicKeyHex;

  const create = factories.createLiveAdapters ?? defaultCreateLiveAdapters;
  const created = await create(config, {
    sellerPrivateKey: hexToBytes(identity.privateKeyHex),
    onWakuHandlerError: () => logger.log({ event: 'waku.handler_error' }),
  });
  let adapters: LiveAdapters;
  try {
    adapters = assertLiveAdapters(created);
  } catch (error) {
    // Nothing has started yet, but the adapters own resources (sockets, the
    // Waku node, the Logos workDir). Release them best-effort, then rethrow.
    await closeCreatedAdapters(created);
    throw error;
  }

  const started: Array<{ name: string; stop: () => Promise<void> }> = [];
  const unwind = async (): Promise<void> => {
    while (started.length > 0) {
      const component = started.pop()!;
      try {
        await component.stop();
        logger.log({ event: 'runtime.component', component: component.name, status: 'stopped', ok: true });
      } catch (error) {
        logger.log({ event: 'runtime.component', component: component.name, status: 'stopped', ok: false, code: errorCode(error) });
      }
    }
  };
  const markStarted = (name: string, stop: () => Promise<void>): void => {
    started.push({ name, stop });
    logger.log({ event: 'runtime.component', component: name, status: 'started', ok: true });
  };

  // Set by stop(): afterwards no in-flight probe result may reach the cache or the log.
  let stopped = false;
  const scannerProbe = async (): Promise<boolean> => {
    try {
      const snapshot = await adapters.scanner.snapshot();
      return eligibleSnapshot(snapshot, now(), config.maxHealthAgeMs);
    } catch (error) {
      if (!stopped) logger.log({ event: 'runtime.readiness', component: 'scanner', ok: false, code: errorCode(error) });
      return false;
    }
  };
  const messagingProbe = async (): Promise<boolean> => {
    try {
      return await adapters.waku.ready();
    } catch (error) {
      if (!stopped) logger.log({ event: 'runtime.readiness', component: 'waku', ok: false, code: errorCode(error) });
      return false;
    }
  };

  // Readiness cache. Only `refreshReadiness` (the bounded readiness loop)
  // probes storage; request paths read these entries and never download.
  const replicaCache = new Map<string, CacheEntry>();
  let scannerEntry: CacheEntry | undefined;
  const fresh = (entry: CacheEntry | undefined): boolean =>
    entry !== undefined && entry.ok && now() - entry.checkedAt <= readinessTtlMs;
  const replicaReady = (productVersion: string): boolean => fresh(replicaCache.get(productVersion));
  const cachedScannerProbe = async (): Promise<boolean> => fresh(scannerEntry);

  let server: SellerServer;
  let detach: (() => Promise<void>) | undefined;
  try {
    // 0. Storage owns a private Logos workDir from the moment it is created.
    // Registered first so it is released last (after core, the Waku handler
    // and scanner stop) and on every partial-start unwind, including a
    // failed independent-replica check.
    markStarted('storage', () => adapters.storage.close());

    // 1. Scanner: first snapshot pins chain/account/source against config.
    markStarted('scanner', () => adapters.scanner.close());
    await adapters.scanner.snapshot();

    // 2. Waku: start the node and wait for peers.
    markStarted('waku', () => adapters.waku.close());
    await adapters.waku.ready();

    // 3. Storage: origin and replica must be independent Logos peers.
    await adapters.storage.assertIndependentReplicas();

    // 4. Core: issuer/application/fulfillment, Waku handler attached BEFORE
    // any listener accepts traffic. No fixture product is seeded.
    server = await startSeller({
      config,
      sellerKeyId,
      seedProduct: false,
      scanner: adapters.scanner,
      storage: adapters.storage,
      messaging: createWakuFulfillmentMessaging(adapters.waku, sellerKeyId, config.productNetwork, now),
      logger,
      startLoops: false,
      probes: { scanner: cachedScannerProbe, messaging: messagingProbe },
      replicaReady,
      publicDir: factories.publicDir,
      beforeListen: async (core) => {
        const application = createSellerApplication({
          store: core.store,
          issuer: core.issuer,
          payments: core.payments,
          sellerKeyId,
          network: config.productNetwork,
          now,
        });
        detach = await attachSellerApplication(adapters.waku, application, { logger, now, sellerKeyId, network: config.productNetwork });
      },
    });
    markStarted('core', async () => {
      try {
        if (detach) await detach();
      } finally {
        await server.close();
      }
    });
  } catch (error) {
    if (detach) {
      await detach().catch((detachError: unknown) => {
        logger.log({ event: 'runtime.component', component: 'waku-handler', status: 'stopped', ok: false, code: errorCode(detachError) });
      });
    }
    await unwind();
    throw error;
  }

  let readiness: RuntimeReadiness = { scanner: false, messaging: false, products: {}, checkout: false, checkedAt: 0 };
  const probeReadiness = async (): Promise<RuntimeReadiness> => {
    const [scanner, messaging] = await Promise.all([
      bounded(scannerProbe(), replicaProbeTimeoutMs, false),
      bounded(messagingProbe(), replicaProbeTimeoutMs, false),
    ]);
    if (stopped) return readiness;
    scannerEntry = { ok: scanner, checkedAt: now() };
    const products: Record<string, boolean> = {};
    const published = server.core.catalogue.listPublished();
    for (const product of published) {
      // Each replica probe is bounded; a timeout or error is "not ready". A
      // timed-out download may keep running in the adapter, but its result is
      // never observed.
      const cid = product.ciphertextCid;
      const digest = product.ciphertextDigest;
      const sizeBytes = product.fileSize;
      const ok = cid && digest && sizeBytes != null
        ? await bounded(adapters.storage.verifyPublished(cid, digest, sizeBytes), replicaProbeTimeoutMs, false)
        : cid
          ? await bounded(adapters.storage.verifyReplica(cid, 'replica'), replicaProbeTimeoutMs, false)
          : false;
      if (stopped) return readiness;
      replicaCache.set(product.version, { ok, checkedAt: now() });
      products[product.version] = allowNewCheckout({ productPublished: true, storageReplica: ok, scanner, messaging });
    }
    const live = new Set(published.map((product) => product.version));
    for (const version of replicaCache.keys()) if (!live.has(version)) replicaCache.delete(version);
    readiness = {
      scanner,
      messaging,
      products,
      checkout: Object.values(products).some(Boolean),
      checkedAt: now(),
    };
    logger.log({ event: 'runtime.readiness', ok: readiness.checkout, count: Object.keys(products).length });
    return readiness;
  };
  // Non-overlapping: a manual refresh and a loop tick share one in-flight probe.
  let probing: Promise<RuntimeReadiness> | null = null;
  const refreshReadiness = (): Promise<RuntimeReadiness> => {
    probing ??= probeReadiness().finally(() => { probing = null; });
    return probing;
  };

  const reconcile = startLoop('reconcile', intervalMs, maxBackoffMs, logger, () => server.core.payments.reconcileFromScanner());
  const dispatch = startLoop('dispatch', intervalMs, maxBackoffMs, logger, () => server.core.fulfillment.dispatchPending());
  const readinessLoop = startLoop('readiness', readinessIntervalMs, maxBackoffMs, logger, async () => { await refreshReadiness(); });
  logger.log({ event: 'runtime.component', component: 'loops', status: 'started', ok: true });

  let stopping: Promise<void> | null = null;
  return {
    sellerKeyId,
    server,
    readiness: () => readiness,
    refreshReadiness,
    async runLoopsOnce() {
      await reconcile.runOnce();
      await dispatch.runOnce();
    },
    stop() {
      stopping ??= (async () => {
        // Reconcile/dispatch drain their in-flight run before the core they
        // drive stops. The readiness probe is NOT awaited (a hung replica
        // download must not block shutdown); `stopped` discards its result.
        stopped = true;
        await Promise.all([reconcile.stop(), dispatch.stop(), readinessLoop.stop({ drain: false })]);
        logger.log({ event: 'runtime.component', component: 'loops', status: 'stopped', ok: true });
        await unwind();
      })();
      return stopping;
    },
  };
}

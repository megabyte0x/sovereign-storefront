// Task 5 crash-boundary tests (F1.3).
//
// Every crash is injected into ONE opened store instance (openStore's own
// per-instance `crashAfterObservations` option, or a per-instance Proxy around
// the store returned by openStore). Nothing here is process-global: a crash
// kills that incarnation, the store is closed, and a fresh openStore on the
// same sqlite file plays the restarted seller.
//
// Reorg boundaries are covered by tests/unit/fulfillment.test.ts
// ('prepare, then payment reorg, then recover: disclose is false' and
// 'reorg after release records exception and preserves delivery evidence');
// they are intentionally not duplicated here.
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { createTestCredentialAdapter } from '../../src/adapters/credentials.ts';
import type { FulfillmentMessaging } from '../../src/adapters/messaging.ts';
import { MemoryScanner } from '../../src/adapters/scanner.ts';
import { createMemoryStorageAdapter } from '../../src/adapters/storage.ts';
import type { ChainIdentity } from '../../src/contracts/live.ts';
import type { CredentialAdapter, DeliveryPackage, Invoice, SellerStore, ServiceAvailability } from '../../src/contracts/types.ts';
import { openCatalogue } from '../../src/seller/catalogue.ts';
import { openStore } from '../../src/seller/db.ts';
import { createFulfillment } from '../../src/seller/fulfillment.ts';
import { createInvoiceIssuer } from '../../src/seller/issuance.ts';
import { DEFAULT_POLICY, createPayments } from '../../src/seller/payments.ts';

const scratchRoot = process.env.TMPDIR ?? tmpdir();
const availability: ServiceAvailability = { productPublished: true, messaging: true, storageReplica: true, scanner: true };
const chain: ChainIdentity = { network: 'regtest', genesisHash: 'a'.repeat(64), consensusFingerprint: 'c'.repeat(64) };

class InjectedCrash extends Error {
  constructor(where: string) {
    super(`injected crash: ${where}`);
    this.name = 'InjectedCrash';
  }
}

type StoreMethod = keyof SellerStore;
type CrashPoint =
  | { kind: 'in-snapshot-tx' }
  | { kind: 'method'; method: StoreMethod; when: 'before' | 'after'; match?: (args: unknown[]) => boolean };

let scratchDir = '';
let dbPath = '';
const open: SellerStore[] = [];

beforeEach(() => {
  scratchDir = mkdtempSync(join(scratchRoot, 'ssf-fulfill-crash-'));
  dbPath = join(scratchDir, 'seller.sqlite');
  const catalogue = openCatalogue({ dbPath, storage: createMemoryStorageAdapter() });
  catalogue.beginPublication({ version: 'book-v1', description: 'fixture', amountZat: '100', network: chain.network });
  catalogue.completePublication({
    version: 'book-v1', ciphertextCid: 'fixture-cid', ciphertextDigest: 'a'.repeat(64), fileSize: 1,
    sellerKeyRef: 'fixture-key', wrappedKey: new Uint8Array([1]),
  });
  catalogue.close();
});

afterEach(async () => {
  for (const store of open.splice(0)) await store.close().catch(() => undefined);
  rmSync(scratchDir, { recursive: true, force: true });
});

/** Open one store incarnation; the crash (if any) fires once, only in this instance. */
async function openIncarnation(point: CrashPoint | null): Promise<SellerStore> {
  let armed = point !== null;
  const inner = await openStore(dbPath, point?.kind === 'in-snapshot-tx'
    ? {
      crashAfterObservations: () => {
        if (!armed) return;
        armed = false;
        throw new InjectedCrash('inside commitSnapshot after observations');
      },
    }
    : {});
  open.push(inner);
  if (!point || point.kind !== 'method') return inner;
  return new Proxy(inner, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver) as unknown;
      if (prop !== point.method || typeof value !== 'function') return value;
      return async (...args: unknown[]) => {
        const hit = armed && (point.match ? point.match(args) : true);
        if (hit && point.when === 'before') {
          armed = false;
          throw new InjectedCrash(`before ${String(prop)}`);
        }
        const result = await (value as (...a: unknown[]) => Promise<unknown>).apply(target, args);
        if (hit && point.when === 'after') {
          armed = false;
          throw new InjectedCrash(`after ${String(prop)}`);
        }
        return result;
      };
    },
  });
}

type WireRecord = { orderId: string; packageId: string | undefined; envelope: Uint8Array };

/** The transport outlives seller crashes: one shared wire log across incarnations. */
function wireMessaging(wire: WireRecord[]): FulfillmentMessaging {
  return {
    sent: [],
    sendInitiatedFor: [],
    async send(pkg: DeliveryPackage) {
      wire.push({ orderId: pkg.orderId, packageId: pkg.packageId, envelope: new Uint8Array(pkg.encryptedEnvelope) });
    },
  };
}

type World = {
  scanner: MemoryScanner;
  credentials: CredentialAdapter;
  buyer: string;
  stranger: string;
  invoice: Invoice;
  wire: WireRecord[];
  releases: string[];
};

async function issueAndPay(): Promise<World> {
  const store = await openStore(dbPath);
  open.push(store);
  const credentials = createTestCredentialAdapter();
  const created = await credentials.createPurchaseCredential();
  const other = await credentials.createPurchaseCredential();
  const scanner = new MemoryScanner();
  const issuer = createInvoiceIssuer({
    store, scanner, chain, accountId: 'fixture-account', ttlMs: 60_000, now: () => 1000,
    availability: async () => availability,
  });
  const invoice = await issuer.issue({
    requestId: 'req-crash', buyerKeyId: created.buyerKeyId, productVersion: 'book-v1', expectedAmountZat: '100',
  });
  if (invoice.attribution?.kind !== 'receiver') throw new Error('receiver invoice required');
  // Receipt mined at height 1, tip at minConfirmations -> exactly enough confirmations.
  const tipHeight = DEFAULT_POLICY.minConfirmations;
  scanner.setReceiptReceiver('out-a', invoice.attribution.receiver);
  scanner.replaceSnapshot(
    [{ outputId: 'out-a', invoiceId: null, amountZat: invoice.amountZat, confirmations: 0, canonical: true, receivedAt: 1000, revision: { id: 'rev-1', height: 1 } }],
    { id: `rev-${tipHeight}`, height: tipHeight },
    true,
    1000,
  );
  await store.close();
  open.splice(open.indexOf(store), 1);
  return { scanner, credentials, buyer: created.credentialId, stranger: other.credentialId, invoice, wire: [], releases: [] };
}

function seller(world: World, store: SellerStore) {
  const payments = createPayments({
    store,
    scanner: world.scanner,
    now: () => 1000,
    // Deterministic per order, like a sealed envelope that is persisted once.
    preparePackage: async (inv) => ({
      orderId: inv.orderId, productVersion: inv.productVersion, buyerKeyId: inv.buyerKeyId, encryptedEnvelope: new Uint8Array([7, 7, 7]),
    }),
  });
  const counted = {
    ...payments,
    async authorizeRelease(orderId: string) {
      const decision = await payments.authorizeRelease(orderId);
      if (decision.disclose) world.releases.push(decision.reason);
      return decision;
    },
  };
  const fulfillment = createFulfillment({ store, payments: counted, messaging: wireMessaging(world.wire), credentials: world.credentials });
  return { payments: counted, fulfillment };
}

/** One seller lifetime: reconcile, dispatch, then the buyer acks what it received. */
async function runToAck(world: World, store: SellerStore): Promise<void> {
  const { payments, fulfillment } = seller(world, store);
  await payments.reconcileFromScanner();
  await fulfillment.dispatchPending();
  const received = world.wire.at(-1);
  if (!received?.packageId) throw new Error('buyer received no package');
  await fulfillment.acknowledge(world.invoice.orderId, world.buyer, received.packageId);
}

async function close(store: SellerStore): Promise<void> {
  await store.close();
  const index = open.indexOf(store);
  if (index >= 0) open.splice(index, 1);
}

const casTo = (next: string) => (args: unknown[]) => args[2] === next;

type Boundary = {
  name: string;
  point: CrashPoint;
  afterCrash: { delivery: string; disclosure: string; packaged: boolean; wire: number };
  totalWire: number;
};

const boundaries: Boundary[] = [
  {
    name: 'before snapshot commit (rolled-back commitSnapshot tx)',
    point: { kind: 'in-snapshot-tx' },
    afterCrash: { delivery: 'locked', disclosure: 'none', packaged: false, wire: 0 },
    totalWire: 1,
  },
  {
    name: 'after snapshot commit, before package prepare',
    point: { kind: 'method', method: 'savePreparedPackage', when: 'before' },
    afterCrash: { delivery: 'locked', disclosure: 'none', packaged: false, wire: 0 },
    totalWire: 1,
  },
  {
    name: 'after package saved, before locked->prepared',
    point: { kind: 'method', method: 'compareAndSetDelivery', when: 'before', match: casTo('prepared') },
    afterCrash: { delivery: 'locked', disclosure: 'none', packaged: true, wire: 0 },
    totalWire: 1,
  },
  {
    name: 'after prepare, before release CAS prepared->queued',
    point: { kind: 'method', method: 'compareAndSetDelivery', when: 'before', match: casTo('queued') },
    afterCrash: { delivery: 'prepared', disclosure: 'none', packaged: true, wire: 0 },
    totalWire: 1,
  },
  {
    name: 'after prepare/release, before send intent',
    point: { kind: 'method', method: 'beginDeliveryAttempt', when: 'before' },
    afterCrash: { delivery: 'queued', disclosure: 'none', packaged: true, wire: 0 },
    totalWire: 1,
  },
  {
    name: 'after send intent, before send',
    point: { kind: 'method', method: 'beginDeliveryAttempt', when: 'after' },
    afterCrash: { delivery: 'queued', disclosure: 'attempted', packaged: true, wire: 0 },
    totalWire: 1,
  },
  {
    // At-least-once: the unproven send is retried with the SAME immutable package.
    name: 'after send, before outcome',
    point: { kind: 'method', method: 'finishDeliveryAttempt', when: 'before' },
    afterCrash: { delivery: 'queued', disclosure: 'attempted', packaged: true, wire: 1 },
    totalWire: 2,
  },
  {
    name: 'after transport-accepted outcome, before queued->sent_unacknowledged',
    point: { kind: 'method', method: 'compareAndSetDelivery', when: 'before', match: casTo('sent_unacknowledged') },
    afterCrash: { delivery: 'queued', disclosure: 'transport-accepted', packaged: true, wire: 1 },
    totalWire: 2,
  },
  {
    name: 'after acceptance, before ack',
    point: { kind: 'method', method: 'acknowledgePackage', when: 'before' },
    afterCrash: { delivery: 'sent_unacknowledged', disclosure: 'transport-accepted', packaged: true, wire: 1 },
    totalWire: 1,
  },
  {
    name: 'after package ack persisted, before ack CAS',
    point: { kind: 'method', method: 'acknowledgePackage', when: 'after' },
    afterCrash: { delivery: 'acknowledged', disclosure: 'buyer-acknowledged', packaged: true, wire: 1 },
    totalWire: 1,
  },
];

describe('Task 5 crash boundaries: reopen never double-discloses, keeps packageId, and progresses', () => {
  for (const boundary of boundaries) {
    test(boundary.name, async () => {
      const world = await issueAndPay();
      const orderId = world.invoice.orderId;

      const crashed = await openIncarnation(boundary.point);
      await expect(runToAck(world, crashed)).rejects.toBeInstanceOf(InjectedCrash);
      await close(crashed);

      // Restarted seller, same sqlite file, no injection.
      const store = await openIncarnation(null);
      expect(await store.getDelivery(orderId)).toBe(boundary.afterCrash.delivery);
      expect(await store.getDisclosure(orderId)).toBe(boundary.afterCrash.disclosure);
      expect(world.wire).toHaveLength(boundary.afterCrash.wire);
      const before = await store.getPreparedPackage(orderId);
      expect(before !== null).toBe(boundary.afterCrash.packaged);
      if (boundary.point.kind === 'in-snapshot-tx') {
        // Atomic rollback: neither observations nor the snapshot row survived.
        expect(await store.getScanSnapshot()).toBeNull();
        expect(await store.listObservations()).toEqual([]);
      }

      // A wrong buyer can never recover or ack, at any boundary.
      const { fulfillment } = seller(world, store);
      await expect(fulfillment.recover(orderId, world.stranger)).rejects.toThrow(/buyer/);
      await expect(fulfillment.acknowledge(orderId, world.stranger, before?.packageId ?? 'x')).rejects.toThrow(/buyer/);

      // Progress continues to a buyer-acknowledged delivery.
      await runToAck(world, store);
      expect(await store.getDelivery(orderId)).toBe('acknowledged');
      expect(await store.getDisclosure(orderId)).toBe('buyer-acknowledged');

      // Exactly one first disclosure across both lifetimes; every resend is a replay.
      expect(world.releases.filter((reason) => reason === 'first_release')).toHaveLength(1);
      expect(world.wire).toHaveLength(boundary.totalWire);

      // Same immutable packageId before and after the crash, and on every wire send.
      const after = await store.getPreparedPackage(orderId);
      expect(after?.packageId).toMatch(/^[0-9a-f]{64}$/);
      if (before) expect(before.packageId).toBe(after?.packageId);
      for (const record of world.wire) {
        expect(record.orderId).toBe(orderId);
        expect(record.packageId).toBe(after?.packageId);
        expect(record.envelope).toEqual(after?.encryptedEnvelope);
      }

      // Duplicate ack is idempotent; a further tick re-sends nothing.
      await fulfillment.acknowledge(orderId, world.buyer, after?.packageId ?? '');
      await seller(world, store).fulfillment.dispatchPending();
      expect(world.wire).toHaveLength(boundary.totalWire);
      expect(await store.getDelivery(orderId)).toBe('acknowledged');
      // Wrong buyer still refused after acknowledgement.
      await expect(fulfillment.recover(orderId, world.stranger)).rejects.toThrow(/buyer/);
      await expect(fulfillment.acknowledge(orderId, world.stranger, after?.packageId ?? '')).rejects.toThrow(/buyer/);
    });
  }
});

describe('production assembly exposes no test-only mutation/crash API', () => {
  const productionFiles = ['src/main.ts', 'src/runtime.ts', 'src/seller/server.ts', 'src/seller/messages.ts', 'src/seller/payments.ts', 'src/seller/fulfillment.ts'];
  const forbidden = [
    /commitReconciliation/, // legacy per-observation commit (tests/unit/invoices.test.ts only)
    /\.getCheckpoint\(/, // legacy per-observation checkpoint read
    /crashAfterObservations/, // openStore test-only injection
    /crashBeforeCommit|crashAfterCommit/, // PaymentHooks are only read inside payments.ts
    /crashBeforeSend|crashAfterSend/, // memory messaging hooks
    /recordSendAttempt/, // legacy counter
    /setReceiptReceiver|replaceReceiptSourceSnapshot|setHealth\(/, // MemoryScanner fixture mutators
  ];

  test('no production file wires a forbidden API', () => {
    const hits: string[] = [];
    for (const file of productionFiles) {
      const lines = readFileSync(join(process.cwd(), file), 'utf8').split('\n');
      lines.forEach((line, index) => {
        if (file === 'src/seller/payments.ts' && /crash(Before|After)Commit/.test(line)) return; // declaration + optional call sites
        for (const pattern of forbidden) if (pattern.test(line)) hits.push(`${file}:${index + 1}`);
      });
    }
    expect(hits).toEqual([]);
  });

  test('openStore and createPayments are called without injection options in production', () => {
    const server = readFileSync(join(process.cwd(), 'src/seller/server.ts'), 'utf8');
    expect(server.match(/openStore\([^)]*\)/g)).toEqual(['openStore(config.dbPath)']);
    expect(server).not.toMatch(/hooks\s*:/);
    // The only MemoryScanner mutation is the fixture default, guarded by !options.scanner
    // (real-demo refuses to start without an injected scanner).
    const replace = server.split('\n').filter((line) => line.includes('replaceSnapshot'));
    expect(replace).toHaveLength(1);
    expect(server).toMatch(/if \(scanner instanceof MemoryScanner && !options\.scanner\) \{\n\s*scanner\.replaceSnapshot/);
    expect(server).toMatch(/if \(!options\.storage \|\| !options\.scanner \|\| !options\.messaging\)/);
  });
});

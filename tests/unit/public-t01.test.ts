import { expect, test } from 'vitest';
import type { Receipt, ScanSnapshot } from '../../src/contracts/live.ts';
import {
  finalizeT01,
  runT01,
  type BrowserDriver,
  type RunState,
  type T01Deps,
} from '../../scripts/public-t01.ts';

const A = 'gift-of-the-magi';
const B = 'yellow-wallpaper';
const SHA = { [A]: 'a'.repeat(64), [B]: 'b'.repeat(64) };
// Bech32 has no '1' after the separator: receiver n uses digit n+1 (n <= 8).
const RECEIVER = (n: number) => `utest1${String(n + 1).repeat(100)}`;
const receiverIndex = (uri: string) => Number(/utest1(\d)/.exec(uri)?.[1]) - 1;
const uriFor = (n: number) => `zcash:${RECEIVER(n)}?amount=0.001`;
const TX = (n: number) => String(n).repeat(64);

type World = {
  height: number;
  mempool: Map<string, number | null>; // txid -> mined height
  sends: string[];
  stopped: Set<string>;
  events: string[];
  stages: Record<string, { status: string; evidence: string[] }>;
  inits: number;
  state: RunState | null;
};

function snapshot(world: World): ScanSnapshot {
  const receipts: Receipt[] = [...world.mempool.entries()].map(([txid, mined], index) => ({
    outputId: `${txid}:ironwood:0`, txid, pool: 'ironwood', outputIndex: 0, accountId: 'acct', scope: 'external',
    receiverHex: String(index).repeat(86), amountZat: '100000', firstSeenAt: 1,
    mined: mined === null ? null : { height: mined, hash: 'f'.repeat(64) }, canonical: true,
  }));
  return {
    version: 1, sourceId: 'src', generation: '1', accountId: 'acct',
    chain: { network: 'test', genesisHash: 'e'.repeat(64), consensusFingerprint: 'c'.repeat(64) },
    tip: { height: world.height, hash: 'd'.repeat(64) }, scanned: { height: world.height, hash: 'd'.repeat(64) },
    checkedAt: 1, caughtUp: true, complete: true, health: 'ready', receipts,
  };
}

function makeDeps(overrides: {
  browser?: Partial<BrowserDriver>;
  send?: T01Deps['wallet']['send'];
  preflight?: string[];
  mineAfterSend?: number;
  sellerSnapshot?: (world: World) => ScanSnapshot;
  piStop?: (service: string) => Promise<void>;
} = {}): { deps: T01Deps; world: World } {
  const world: World = {
    height: 100, mempool: new Map(), sends: [], stopped: new Set(), events: [], stages: {}, inits: 0, state: null,
  };
  let invoiceCount = 0;
  const invoices = new Map<string, { profile: string; version: string; n: number }>();
  const imported = new Map<string, string[]>();
  const browser: BrowserDriver = {
    async openInvoice(profile, version) {
      invoiceCount += 1;
      const requestId = `req-${invoiceCount}`;
      invoices.set(requestId, { profile, version, n: invoiceCount });
      return { requestId, orderId: `order-${invoiceCount}`, uri: uriFor(invoiceCount), qr: uriFor(invoiceCount) };
    },
    async relaunch(profile) { world.events.push(`relaunch ${profile}`); },
    async purchase(profile, requestId) {
      const invoice = invoices.get(requestId);
      const visible = invoice && (invoice.profile === profile || imported.get(profile)?.includes(requestId));
      return visible ? { requestId, orderId: `order-${invoice.n}`, uri: uriFor(invoice.n) } : null;
    },
    async exportBackup(_profile, requestId) { return `/private/${requestId}.backup`; },
    async importBackup(profile, file) {
      const requestId = /(req-\d+)/.exec(file)?.[1] ?? '';
      imported.set(profile, [...(imported.get(profile) ?? []), requestId]);
    },
    async paymentState(_profile, requestId) {
      const n = invoices.get(requestId)?.n ?? 0;
      const mined = world.mempool.get(TX(n));
      return mined !== undefined && mined !== null && world.height - mined + 1 >= 3 && !world.stopped.has('seller') ? 'confirmed' : 'awaiting';
    },
    async download(_profile, requestId) {
      const invoice = invoices.get(requestId);
      if (!invoice) return null;
      if (world.stopped.has('logos-a') && world.events.includes('replica-down')) return null;
      return SHA[invoice.version as keyof typeof SHA];
    },
    ...overrides.browser,
  };
  const deps: T01Deps = {
    products: [A, B],
    expectedPlaintextSha256: SHA,
    amountZat: '100000',
    pollMs: 0,
    timeoutMs: 50,
    freshProfile: (label) => `profile-${label}`,
    async sleep() {
      world.height += 1;
      for (const [txid, mined] of world.mempool) if (mined === null) world.mempool.set(txid, world.height);
    },
    loadState: () => (world.state ? structuredClone(world.state) : null),
    saveState: (state) => { world.state = structuredClone(state); },
    async preflight() { return overrides.preflight ?? []; },
    recorder: {
      async init() { world.inits += 1; },
      async stage(id, status, evidence) { world.stages[id] = { status, evidence }; },
    },
    browser,
    wallet: {
      send: overrides.send ?? (async (uri) => {
        world.sends.push(uri);
        const n = receiverIndex(uri);
        world.mempool.set(TX(n), null);
        return { kind: 'sent', txid: TX(n) };
      }),
    },
    sellerSnapshot: async () => (overrides.sellerSnapshot ?? snapshot)(world),
    checkerSnapshot: async () => snapshot(world),
    pi: {
      async stop(service) {
        world.events.push(`stop ${service}`);
        if (overrides.piStop) await overrides.piStop(service);
        world.stopped.add(service);
      },
      async start(service) { world.events.push(`start ${service}`); world.stopped.delete(service); },
      async healthy() { return world.stopped.size === 0; },
    },
  };
  return { deps, world };
}

const ALL = ['embed-invoice', 'receipt-observed', 'three-confirmations', 'bytes-match', 'recover-without-repay', 'restart-between', 'origin-stop', 'funds-received'];

test('a full run records all eight stages PASS with two distinct purchases and one init', async () => {
  const { deps, world } = makeDeps();
  expect(await runT01(deps)).toBe(0);
  expect(Object.fromEntries(Object.entries(world.stages).map(([id, row]) => [id, row.status])))
    .toEqual(Object.fromEntries(ALL.map((id) => [id, 'PASS'])));
  expect(world.inits).toBe(1);
  expect(world.sends).toHaveLength(2);
  expect(new Set(world.sends).size).toBe(2);
  expect(world.stopped.size).toBe(0);
  expect(world.events).toEqual(expect.arrayContaining(['stop seller', 'start seller', 'stop logos-a', 'start logos-a']));
  const evidence = JSON.stringify(world.stages);
  expect(evidence).not.toMatch(/utest1|zcash:/);
  for (const n of [1, 2]) expect(evidence).not.toContain(TX(n));
  // A rerun of a finished run neither pays nor re-inits.
  expect(await runT01(deps)).toBe(0);
  expect(world.sends).toHaveLength(2);
  expect(world.inits).toBe(1);
});

test('preflight failure neither inits nor pays', async () => {
  const { deps, world } = makeDeps({ preflight: ['replica unavailable'] });
  expect(await runT01(deps)).not.toBe(0);
  expect(world.inits).toBe(0);
  expect(world.sends).toHaveLength(0);
});

test('profile loss before payment fails embed-invoice and never pays', async () => {
  const { deps, world } = makeDeps({ browser: { purchase: async () => null } });
  expect(await runT01(deps)).not.toBe(0);
  expect(world.stages['embed-invoice']?.status).toBe('FAIL');
  expect(world.sends).toHaveLength(0);
});

test('a QR that differs from the invoice URI never pays', async () => {
  const { deps, world } = makeDeps({
    browser: { openInvoice: async () => ({ requestId: 'req-1', orderId: 'order-1', uri: uriFor(1), qr: uriFor(7) }) },
  });
  expect(await runT01(deps)).not.toBe(0);
  expect(world.stages['embed-invoice']?.status).toBe('FAIL');
  expect(world.sends).toHaveLength(0);
});

test('an invoice for the wrong amount never pays', async () => {
  const { deps, world } = makeDeps({
    browser: { openInvoice: async () => ({ requestId: 'req-1', orderId: 'order-1', uri: `zcash:${RECEIVER(1)}?amount=0.002`, qr: `zcash:${RECEIVER(1)}?amount=0.002` }) },
  });
  expect(await runT01(deps)).not.toBe(0);
  expect(world.sends).toHaveLength(0);
});

test('a wallet success with no scanner receipt fails receipt-observed', async () => {
  const { deps, world } = makeDeps({ sellerSnapshot: (w) => ({ ...snapshot(w), receipts: [] }) });
  expect(await runT01(deps)).not.toBe(0);
  expect(world.stages['receipt-observed']?.status).toBe('FAIL');
  expect(world.stages['three-confirmations']).toBeUndefined();
});

test('a wallet txid in display byte order matches the scanner receipt in internal byte order', async () => {
  // Wallets print txids byte-reversed (RPC/explorer order); the scanner hex-encodes the raw bytes.
  const internal = (n: number) => `0${String(n)}${'ab'.repeat(31)}`;
  const display = (txid: string) => Buffer.from(txid, 'hex').reverse().toString('hex');
  const requestN = (requestId: string) => Number(/req-(\d+)/.exec(requestId)?.[1] ?? 0);
  const { deps, world } = makeDeps({
    send: async (uri) => {
      world.sends.push(uri);
      const n = receiverIndex(uri);
      world.mempool.set(internal(n), null);
      return { kind: 'sent', txid: display(internal(n)) };
    },
    // The default fixture looks up TX(n); this world keys the mempool by internal(n).
    browser: {
      paymentState: async (_profile, requestId) => {
        const mined = world.mempool.get(internal(requestN(requestId)));
        return mined !== undefined && mined !== null && world.height - mined + 1 >= 3 && !world.stopped.has('seller') ? 'confirmed' : 'awaiting';
      },
    },
  });
  expect(display(internal(1))).not.toBe(internal(1));
  expect(await runT01(deps)).toBe(0);
  expect(world.stages['receipt-observed']?.status).toBe('PASS');
  expect(world.stages['three-confirmations']?.status).toBe('PASS');
  expect(world.sends).toHaveLength(2);
});

test('an ambiguous broadcast stops the run, and resume does not send again', async () => {
  let calls = 0;
  const { deps, world } = makeDeps({ send: async () => { calls += 1; return { kind: 'ambiguous' }; } });
  expect(await runT01(deps)).not.toBe(0);
  expect(world.state?.a?.send).toBe('ambiguous');
  expect(await runT01(deps)).not.toBe(0);
  expect(calls).toBe(1);
});

test('restart-between fails without stopping the seller when the payment already has 3 confirmations', async () => {
  const { deps, world } = makeDeps();
  // Mine instantly and far ahead so the second payment is past the floor when first observed.
  deps.wallet.send = async (uri) => {
    world.sends.push(uri);
    const n = receiverIndex(uri);
    world.mempool.set(TX(n), world.height - 5);
    return { kind: 'sent', txid: TX(n) };
  };
  expect(await runT01(deps)).not.toBe(0);
  expect(world.stages['restart-between']?.status).toBe('FAIL');
  expect(world.events).not.toContain('stop seller');
});

test('the seller is restarted even when the stop path throws', async () => {
  const { deps, world } = makeDeps({ piStop: async (service) => { if (service === 'seller') throw new Error('compose timeout'); } });
  expect(await runT01(deps)).not.toBe(0);
  expect(world.stages['restart-between']?.status).toBe('FAIL');
  expect(world.events).toContain('start seller');
});

test('logos-a is restored after a failed origin-stop download', async () => {
  const { deps, world } = makeDeps({ piStop: async (service) => { if (service === 'logos-a') world.events.push('replica-down'); } });
  expect(await runT01(deps)).not.toBe(0);
  expect(world.stages['origin-stop']?.status).toBe('FAIL');
  expect(world.events.at(-1)).toBe('start logos-a');
  expect(world.stopped.has('logos-a')).toBe(false);
});

test('a plaintext mismatch fails bytes-match', async () => {
  const { deps, world } = makeDeps({ browser: { download: async () => 'c'.repeat(64) } });
  expect(await runT01(deps)).not.toBe(0);
  expect(world.stages['bytes-match']?.status).toBe('FAIL');
});

test('finalize refuses an incomplete run and passes the first purchase txid for a complete one', async () => {
  const calls: string[][] = [];
  const recorderFinalize = async (args: string[]) => { calls.push(args); return 0; };
  const incomplete = makeDeps({ sellerSnapshot: (w) => ({ ...snapshot(w), receipts: [] }) });
  await runT01(incomplete.deps);
  expect(await finalizeT01(incomplete.deps, recorderFinalize)).not.toBe(0);
  expect(calls).toHaveLength(0);

  const complete = makeDeps();
  await runT01(complete.deps);
  expect(await finalizeT01(complete.deps, recorderFinalize)).toBe(0);
  expect(calls).toHaveLength(1);
  const args = calls[0]!;
  expect(args[args.indexOf('--txid') + 1]).toBe(TX(1));
  expect(Number(args[args.indexOf('--confirmations') + 1])).toBeGreaterThanOrEqual(3);
  expect(args).toEqual(expect.arrayContaining(['--wallet', 'ssf-buyer-sender', '--lightwalletd', 'https://testnet.zec.rocks:443/']));
});

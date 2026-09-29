// Public T01 runner: two real public-testnet purchases through the deployed
// storefront, recorded stage by stage through the existing live-observe recorder.
// The orchestration core takes every side effect as a dependency so it can be
// tested fail-closed without paying; the live adapters live in public-t01-live.ts.
import { parseTestnetZip321 } from './public-t01-wallet.ts';
import { PUBLIC_MIN_CONFIRMATIONS, PUBLIC_STAGE_IDS } from './live-report.ts';
import type { Receipt, ScanSnapshot } from '../src/contracts/live.ts';

export const WALLET_NAME = 'ssf-buyer-sender';
export const WALLET_VERSION = 'ssf-buyer-sender 0.1.0 (zakura-client-backend 0.1.0-rc5)';
export const LIGHTWALLETD_URL = 'https://testnet.zec.rocks:443/';

type StageId = (typeof PUBLIC_STAGE_IDS)[number];
type StageStatus = 'PASS' | 'FAIL' | 'NOT_RUN';

export type InvoiceView = { requestId: string; orderId: string; uri: string; qr: string };
export type PurchaseView = { requestId: string; orderId: string; uri: string };

export type BrowserDriver = {
  /** Embed Buy -> popup checkout; returns the persisted invoice and the decoded QR text. */
  openInvoice(profile: string, productVersion: string): Promise<InvoiceView>;
  /** Close the whole browser process for this profile and reopen it. */
  relaunch(profile: string): Promise<void>;
  /** The purchase as listed in My purchases for this profile, or null when absent. */
  purchase(profile: string, requestId: string): Promise<PurchaseView | null>;
  exportBackup(profile: string, requestId: string): Promise<string>;
  importBackup(profile: string, file: string): Promise<void>;
  paymentState(profile: string, requestId: string): Promise<string>;
  /** Recover, decrypt and return the plaintext SHA-256, or null when no verified plaintext. */
  download(profile: string, requestId: string): Promise<string | null>;
};

export type SendResult = { kind: 'sent'; txid: string } | { kind: 'ambiguous' } | { kind: 'refused'; reason: string };

export type PurchaseState = {
  product: string;
  profile: string;
  requestId: string;
  orderId: string;
  backup?: string;
  send: 'none' | 'pending' | 'sent' | 'ambiguous';
  txid?: string;
};

export type RunState = {
  version: 1;
  initDone: boolean;
  done: boolean;
  stages: Partial<Record<StageId, StageStatus>>;
  a?: PurchaseState;
  b?: PurchaseState;
};

export type T01Deps = {
  products: readonly [string, string] | string[];
  expectedPlaintextSha256: Record<string, string>;
  amountZat: string;
  pollMs: number;
  timeoutMs: number;
  freshProfile(label: string): string;
  sleep(ms: number): Promise<void>;
  loadState(): RunState | null;
  saveState(state: RunState): void;
  preflight(): Promise<string[]>;
  recorder: {
    init(): Promise<void>;
    stage(id: StageId, status: StageStatus, evidence: string[]): Promise<void>;
  };
  browser: BrowserDriver;
  wallet: { send(uri: string): Promise<SendResult> };
  sellerSnapshot(): Promise<ScanSnapshot>;
  checkerSnapshot(): Promise<ScanSnapshot>;
  pi: {
    stop(service: 'seller' | 'logos-a'): Promise<void>;
    start(service: 'seller' | 'logos-a'): Promise<void>;
    healthy(): Promise<boolean>;
  };
  log?(line: string): void;
};

class StageFailure extends Error {
  readonly stage: StageId;
  readonly reasons: string[];
  readonly code: number;

  // Plain fields, not parameter properties: node --experimental-strip-types rejects those.
  constructor(stage: StageId, reasons: string[], code = 1) {
    super(`${stage} FAIL: ${reasons.join('; ')}`);
    this.stage = stage;
    this.reasons = reasons;
    this.code = code;
  }
}

function fail(stage: StageId, ...reasons: string[]): never {
  throw new StageFailure(stage, reasons);
}

export function confirmationsOf(receipt: Receipt, snapshot: ScanSnapshot): number {
  if (!receipt.mined || !receipt.canonical) return 0;
  return Math.max(0, snapshot.tip.height - receipt.mined.height + 1);
}

/**
 * Wallets print txids in display (RPC/explorer) byte order; the scanner hex-encodes
 * the raw internal bytes. Accept either order so the same transaction always matches.
 */
function sameTxid(receiptTxid: string, walletTxid: string): boolean {
  const wallet = walletTxid.toLowerCase();
  if (receiptTxid === wallet) return true;
  if (!/^[0-9a-f]{64}$/.test(wallet)) return false;
  return receiptTxid === (wallet.match(/../g) ?? []).reverse().join('');
}

function matchingReceipt(snapshot: ScanSnapshot, txid: string, amountZat: string): Receipt | undefined {
  return snapshot.receipts.find((receipt) => sameTxid(receipt.txid, txid) && receipt.canonical
    && receipt.scope === 'external' && receipt.amountZat === amountZat);
}

function usableSnapshot(snapshot: ScanSnapshot): boolean {
  return snapshot.chain.network === 'test' && snapshot.health === 'ready' && snapshot.caughtUp && snapshot.complete;
}

async function poll<T>(deps: T01Deps, probe: () => Promise<T | null | undefined>): Promise<T | null> {
  const deadline = Date.now() + deps.timeoutMs;
  for (;;) {
    const value = await probe().catch(() => null);
    if (value !== null && value !== undefined) return value;
    if (Date.now() >= deadline) return null;
    await deps.sleep(deps.pollMs);
  }
}

export async function runT01(deps: T01Deps): Promise<number> {
  const log = deps.log ?? (() => undefined);
  const state: RunState = deps.loadState() ?? { version: 1, initDone: false, done: false, stages: {} };
  const save = (): void => deps.saveState(state);
  if (state.done) {
    log('run already complete; nothing sent');
    return 0;
  }
  const blockers = await deps.preflight();
  if (blockers.length > 0) {
    for (const blocker of blockers) log(`preflight BLOCKED: ${blocker}`);
    return 2;
  }
  if (!state.initDone) {
    await deps.recorder.init();
    state.initDone = true;
    save();
  }
  const record = async (id: StageId, status: StageStatus, evidence: string[]): Promise<void> => {
    state.stages[id] = status;
    save();
    await deps.recorder.stage(id, status, evidence);
  };
  const [productA, productB] = deps.products as [string, string];

  const checkInvoice = (stage: StageId, invoice: InvoiceView): void => {
    if (invoice.qr !== invoice.uri) fail(stage, 'rendered QR does not decode to the invoice URI');
    let amount: bigint;
    try {
      amount = parseTestnetZip321(invoice.uri).amountZat;
    } catch (error) {
      fail(stage, `invoice URI refused: ${(error as Error).message}`);
    }
    if (amount.toString() !== deps.amountZat) fail(stage, 'invoice amount differs from the product price');
  };

  const pay = async (purchase: PurchaseState, uri: string, stage: StageId): Promise<string> => {
    if (purchase.send === 'sent' && purchase.txid) return purchase.txid;
    if (purchase.send !== 'none') {
      throw new StageFailure(stage, ['an earlier send is unresolved; resolve it from wallet history before resuming'], 3);
    }
    purchase.send = 'pending';
    save();
    const result = await deps.wallet.send(uri);
    if (result.kind === 'refused') {
      purchase.send = 'none';
      save();
      fail(stage, `wallet refused: ${result.reason}`);
    }
    if (result.kind === 'ambiguous') {
      purchase.send = 'ambiguous';
      save();
      throw new StageFailure(stage, ['wallet outcome is ambiguous; not retrying'], 3);
    }
    purchase.send = 'sent';
    purchase.txid = result.txid;
    save();
    return result.txid;
  };

  const confirmed = async (purchase: PurchaseState, txid: string): Promise<number | null> => poll(deps, async () => {
    const snapshot = await deps.sellerSnapshot();
    const receipt = usableSnapshot(snapshot) ? matchingReceipt(snapshot, txid, deps.amountZat) : undefined;
    const confirmations = receipt ? confirmationsOf(receipt, snapshot) : 0;
    if (confirmations < PUBLIC_MIN_CONFIRMATIONS) return null;
    return (await deps.browser.paymentState(purchase.profile, purchase.requestId)) === 'confirmed' ? confirmations : null;
  });

  try {
    // Purchase A: embed invoice, recovery gates, payment, confirmations, bytes, recovery.
    if (!state.a) {
      const profile = deps.freshProfile('a');
      const invoice = await deps.browser.openInvoice(profile, productA);
      checkInvoice('embed-invoice', invoice);
      await deps.browser.relaunch(profile);
      const reopened = await deps.browser.purchase(profile, invoice.requestId);
      if (!reopened || reopened.orderId !== invoice.orderId || reopened.uri !== invoice.uri) {
        fail('embed-invoice', 'invoice not recovered unchanged after a browser relaunch');
      }
      const backup = await deps.browser.exportBackup(profile, invoice.requestId);
      const importProfile = deps.freshProfile('a-import');
      await deps.browser.importBackup(importProfile, backup);
      const imported = await deps.browser.purchase(importProfile, invoice.requestId);
      if (!imported || imported.orderId !== invoice.orderId || imported.uri !== invoice.uri) {
        fail('embed-invoice', 'backup import did not restore the same order');
      }
      state.a = { product: productA, profile, requestId: invoice.requestId, orderId: invoice.orderId, backup, send: 'none' };
      save();
      await record('embed-invoice', 'PASS', [
        'embed popup invoice persisted; QR equals URI; testnet receiver',
        `amount ${deps.amountZat} zat`,
        'same order after browser relaunch and after backup import into a fresh profile',
      ]);
    }
    const a = state.a;
    const aUri = (await deps.browser.purchase(a.profile, a.requestId))?.uri;
    if (a.send === 'none' && !aUri) fail('receipt-observed', 'invoice no longer available before payment');
    const txidA = await pay(a, aUri ?? '', 'receipt-observed');

    if (state.stages['receipt-observed'] !== 'PASS') {
      const observed = await poll(deps, async () => {
        const snapshot = await deps.sellerSnapshot();
        return usableSnapshot(snapshot) ? matchingReceipt(snapshot, txidA, deps.amountZat) : undefined;
      });
      if (!observed) fail('receipt-observed', 'wallet reported a txid but no matching scanner receipt appeared');
      await record('receipt-observed', 'PASS', [`scanner receipt pool ${observed.pool} amount ${deps.amountZat} zat bound to the wallet txid`]);
    }
    if (state.stages['three-confirmations'] !== 'PASS') {
      const confirmations = await confirmed(a, txidA);
      if (confirmations === null) fail('three-confirmations', 'payment did not reach 3 confirmations with the seller confirming it');
      await record('three-confirmations', 'PASS', [`confirmations ${confirmations}; seller reports paid`]);
    }
    const expectedA = deps.expectedPlaintextSha256[a.product];
    if (state.stages['bytes-match'] !== 'PASS') {
      const digest = await poll(deps, () => deps.browser.download(a.profile, a.requestId));
      if (digest !== expectedA) fail('bytes-match', 'decrypted plaintext digest differs from the published fixture');
      await record('bytes-match', 'PASS', [`plaintext sha256 ${digest.slice(0, 12)} equals the fixture`]);
    }
    if (state.stages['recover-without-repay'] !== 'PASS') {
      await deps.browser.relaunch(a.profile);
      const digest = await poll(deps, () => deps.browser.download(a.profile, a.requestId));
      if (digest !== expectedA) fail('recover-without-repay', 'relaunched profile did not recover the same plaintext');
      await record('recover-without-repay', 'PASS', ['relaunched profile recovered the same plaintext; no second send']);
    }

    // Purchase B: stop the seller after the receipt is seen and before 3 confirmations.
    if (state.stages['restart-between'] !== 'PASS') {
      if (!state.b) {
        const profile = deps.freshProfile('b');
        const invoice = await deps.browser.openInvoice(profile, productB);
        checkInvoice('restart-between', invoice);
        state.b = { product: productB, profile, requestId: invoice.requestId, orderId: invoice.orderId, send: 'none' };
        save();
      }
      const b = state.b;
      const bUri = (await deps.browser.purchase(b.profile, b.requestId))?.uri;
      if (b.send === 'none' && !bUri) fail('restart-between', 'second invoice no longer available before payment');
      const txidB = await pay(b, bUri ?? '', 'restart-between');
      const seen = await poll(deps, async () => {
        const snapshot = await deps.sellerSnapshot();
        const receipt = usableSnapshot(snapshot) ? matchingReceipt(snapshot, txidB, deps.amountZat) : undefined;
        return receipt ? { confirmations: confirmationsOf(receipt, snapshot), height: snapshot.tip.height } : undefined;
      });
      if (!seen) fail('restart-between', 'no scanner receipt for the second payment');
      if (seen.confirmations >= PUBLIC_MIN_CONFIRMATIONS) {
        fail('restart-between', `already at ${seen.confirmations} confirmations before the seller stop; needs a fresh payment`);
      }
      let stopError: string | null = null;
      try {
        await deps.pi.stop('seller');
        const reached = await poll(deps, async () => {
          const snapshot = await deps.checkerSnapshot();
          const receipt = usableSnapshot(snapshot) ? matchingReceipt(snapshot, txidB, deps.amountZat) : undefined;
          return receipt && confirmationsOf(receipt, snapshot) >= PUBLIC_MIN_CONFIRMATIONS ? true : undefined;
        });
        if (!reached) stopError = 'chain did not reach 3 confirmations while the seller was stopped';
      } catch (error) {
        stopError = `seller stop failed: ${(error as Error).message}`;
      } finally {
        await deps.pi.start('seller');
      }
      if (stopError) fail('restart-between', stopError);
      const confirmations = await confirmed(b, txidB);
      if (confirmations === null) fail('restart-between', 'seller did not confirm the payment after restart');
      const digest = await poll(deps, () => deps.browser.download(b.profile, b.requestId));
      if (digest !== deps.expectedPlaintextSha256[b.product]) fail('restart-between', 'delivery after restart did not match the fixture');
      await record('restart-between', 'PASS', [
        `seller stopped at ${seen.confirmations} confirmations and restarted`,
        `confirmed at ${confirmations}; one entitlement; plaintext matches`,
      ]);
    }

    // Origin stop: purchase A's backup in a fresh profile, served by replica B.
    if (state.stages['origin-stop'] !== 'PASS') {
      if (!a.backup) fail('origin-stop', 'no verified backup from the first purchase');
      const profile = deps.freshProfile('origin');
      await deps.browser.importBackup(profile, a.backup);
      let digest: string | null = null;
      let stopError: string | null = null;
      try {
        await deps.pi.stop('logos-a');
        digest = await poll(deps, () => deps.browser.download(profile, a.requestId));
      } catch (error) {
        stopError = `origin stop failed: ${(error as Error).message}`;
      } finally {
        await deps.pi.start('logos-a');
      }
      if (stopError) fail('origin-stop', stopError);
      if (digest !== expectedA) fail('origin-stop', 'download through replica B did not match the fixture');
      if (!(await poll(deps, async () => ((await deps.pi.healthy()) ? true : undefined)))) {
        fail('origin-stop', 'Pi services unhealthy after restoring logos-a');
      }
      await record('origin-stop', 'PASS', ['logos-a stopped; restored backup downloaded via replica B; plaintext matches; logos-a restored']);
    }

    if (state.stages['funds-received'] !== 'PASS') {
      const txids = [state.a?.txid, state.b?.txid].filter((txid): txid is string => typeof txid === 'string');
      const seen = await poll(deps, async () => {
        const snapshot = await deps.checkerSnapshot();
        if (!usableSnapshot(snapshot)) return undefined;
        const receipts = txids.map((txid) => matchingReceipt(snapshot, txid, deps.amountZat));
        return receipts.every((receipt) => receipt && receipt.mined) ? receipts.length : undefined;
      });
      if (seen !== 2) fail('funds-received', 'independent view-only checker did not find both payments');
      await record('funds-received', 'PASS', [`independent view-only checker sees ${seen} mined payments of ${deps.amountZat} zat`]);
    }
    state.done = true;
    save();
    log('T01 run complete: 8 stages PASS');
    return 0;
  } catch (error) {
    if (!(error instanceof StageFailure)) throw error;
    log(error.message);
    if (state.stages[error.stage] !== 'FAIL') await record(error.stage, 'FAIL', error.reasons);
    return error.code;
  }
}

export async function finalizeT01(
  deps: Pick<T01Deps, 'loadState' | 'sellerSnapshot' | 'amountZat'> & { log?: (line: string) => void },
  recorderFinalize: (args: string[]) => Promise<number>,
): Promise<number> {
  const log = deps.log ?? (() => undefined);
  const state = deps.loadState();
  const missing = PUBLIC_STAGE_IDS.filter((id) => state?.stages[id] !== 'PASS');
  if (!state?.done || missing.length > 0 || !state.a?.txid) {
    log(`finalize refused: stages not PASS: ${missing.join(', ') || 'run incomplete'}`);
    return 1;
  }
  const snapshot = await deps.sellerSnapshot();
  const receipt = matchingReceipt(snapshot, state.a.txid, deps.amountZat);
  const confirmations = receipt ? confirmationsOf(receipt, snapshot) : 0;
  if (confirmations < PUBLIC_MIN_CONFIRMATIONS) {
    log('finalize refused: first purchase no longer has 3 confirmations in the scanner');
    return 1;
  }
  return recorderFinalize([
    '--profile', 'public', 'finalize',
    '--wallet', WALLET_NAME,
    '--wallet-version', WALLET_VERSION,
    '--lightwalletd', LIGHTWALLETD_URL,
    '--txid', state.a.txid,
    '--confirmations', String(confirmations),
  ]);
}

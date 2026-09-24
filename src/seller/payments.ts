import { parseAmountZat } from '../contracts/validation.ts';
import { sameReceiver } from '../contracts/live-validation.ts';
import type {
  ChainRevision,
  DeliveryPackage,
  DeliveryState,
  ExceptionRecord,
  Invoice,
  InvoiceSettlement,
  Observation,
  OrderStatus,
  PaymentState,
  Policy,
  ReleaseDecision,
  ScanHealth,
  SellerStore,
  Verification,
} from '../contracts/types.ts';
import type { ReceiptSource, Receipt, ScanSnapshot } from '../contracts/live.ts';

export const DEFAULT_MIN_CONFIRMATIONS = 10;
export const DEFAULT_MAX_HEALTH_AGE_MS = 120_000;

export const DEFAULT_POLICY: Policy = {
  minConfirmations: DEFAULT_MIN_CONFIRMATIONS,
  maxHealthAgeMs: DEFAULT_MAX_HEALTH_AGE_MS,
};

function latestByOutputId(receipts: Observation[]): Observation[] {
  const byId = new Map<string, Observation>();
  for (const receipt of receipts) {
    const previous = byId.get(receipt.outputId);
    if (!previous || receipt.revision.height >= previous.revision.height) {
      byId.set(receipt.outputId, receipt);
    }
  }
  return [...byId.values()];
}

function exception(
  invoice: Invoice,
  code: ExceptionRecord['code'],
  now: number,
  detail: string,
): ExceptionRecord {
  return {
    id: `${invoice.orderId}:${code}:${detail}`,
    orderId: invoice.orderId,
    code,
    createdAt: now,
    detail,
  };
}

function healthAllowsRelease(
  health: ScanHealth,
  policy: Policy,
  now: number,
  receipt: Observation,
): boolean {
  if (!health.healthy || !health.caughtUp) return false;
  if (now - health.checkedAt > policy.maxHealthAgeMs) return false;
  if (health.revision.height < receipt.revision.height) return false;
  return true;
}

/**
 * Pure settlement reducer. Unchanged in shape from the pre-Task-5 version:
 * it still takes an already invoiceId-attributed Observation[] plus a health
 * snapshot and folds them into one settlement. What changed in Task 5 is
 * WHERE these Observation[] come from (see fetchAndCommitSnapshot below):
 * they are now derived wholesale, every reconciliation cycle, from one
 * complete authoritative ReceiptSource snapshot and receiver-identity
 * matching, never from an incrementally merged per-output height cache.
 */
export function reduceInvoice(
  invoice: Invoice,
  receipts: Observation[],
  health: ScanHealth,
  policy: Policy,
  now: number,
): InvoiceSettlement {
  const exceptions: ExceptionRecord[] = [];
  const unique = latestByOutputId(receipts);
  const matched = unique.filter((receipt) => receipt.invoiceId === invoice.id);
  const unmatched = unique.filter((receipt) => receipt.invoiceId === null);

  for (const receipt of unmatched) {
    exceptions.push(exception(invoice, 'unmatched', now, receipt.outputId));
  }

  const expected = parseAmountZat(invoice.amountZat);
  const sufficient: Observation[] = [];
  for (const receipt of matched) {
    if (receipt.receivedAt > invoice.expiresAt) {
      exceptions.push(exception(invoice, 'late', now, receipt.outputId));
      continue;
    }
    const amount = parseAmountZat(receipt.amountZat);
    if (amount < expected) {
      exceptions.push(exception(invoice, 'underpayment', now, receipt.outputId));
      continue;
    }
    if (amount > expected) {
      exceptions.push(exception(invoice, 'overpayment', now, receipt.outputId));
    }
    sufficient.push(receipt);
  }

  const canonicalSufficient = sufficient.filter((receipt) => receipt.canonical);
  const confirmedReceipts = canonicalSufficient
    .filter((receipt) => receipt.confirmations >= policy.minConfirmations)
    .slice()
    .sort((a, b) => a.outputId.localeCompare(b.outputId));

  if (confirmedReceipts.length > 1) {
    for (const extra of confirmedReceipts.slice(1)) {
      exceptions.push(exception(invoice, 'duplicate', now, extra.outputId));
    }
  }

  const backing = confirmedReceipts[0] ?? null;
  let payment: PaymentState = 'awaiting';
  let releaseEligible = false;
  const backingOutputIds: string[] = [];

  if (backing) {
    payment = 'confirmed';
    backingOutputIds.push(backing.outputId);
    releaseEligible = healthAllowsRelease(health, policy, now, backing);
  } else {
    const reorged = sufficient.some((receipt) => !receipt.canonical)
      && canonicalSufficient.length === 0;
    const reviewed = matched.some((receipt) =>
      receipt.canonical && receipt.confirmations >= policy.minConfirmations,
    );
    if (reorged) {
      payment = 'reorged';
    } else if (reviewed && exceptions.length > 0) {
      payment = 'review_required';
    } else if (matched.some((receipt) => receipt.canonical && receipt.confirmations > 0)) {
      payment = 'confirming';
    } else if (matched.length > 0) {
      payment = 'detected';
    } else if (exceptions.length > 0) {
      payment = 'review_required';
    }
  }

  return { payment, releaseEligible, backingOutputIds, exceptions };
}

function createLock() {
  let tail = Promise.resolve();
  return function lock<T>(fn: () => Promise<T>): Promise<T> {
    const run = tail.then(fn, fn);
    tail = run.then(() => undefined, () => undefined);
    return run;
  };
}

function classifyVerification(snapshot: ScanSnapshot | null, policy: Policy, now: number): Verification {
  if (!snapshot) return 'unavailable';
  if (snapshot.health !== 'ready') return 'unavailable';
  if (snapshot.checkedAt > now || now - snapshot.checkedAt > policy.maxHealthAgeMs) return 'stale';
  if (!snapshot.caughtUp) return 'stale';
  return 'available';
}

function isAuthorized(delivery: DeliveryState): boolean {
  return delivery === 'queued'
    || delivery === 'sent_unacknowledged'
    || delivery === 'acknowledged'
    || delivery === 'retry_required';
}

function receiptMatchesInvoice(invoice: Invoice, snapshot: ScanSnapshot, receipt: Receipt): boolean {
  if (invoice.attribution?.kind !== 'receiver') return false;
  if (!invoice.chain || !invoice.accountId) return false;
  if (invoice.accountId !== snapshot.accountId) return false;
  if (invoice.chain.network !== snapshot.chain.network) return false;
  if (invoice.chain.genesisHash !== snapshot.chain.genesisHash) return false;
  if (invoice.chain.consensusFingerprint !== snapshot.chain.consensusFingerprint) return false;
  return sameReceiver(invoice.attribution.receiver, {
    accountId: receipt.accountId,
    scope: receipt.scope === 'external' ? 'external' : invoice.attribution.receiver.scope,
    pool: 'orchard',
    diversifierIndex: invoice.attribution.receiver.diversifierIndex,
    receiverHex: receipt.receiverHex,
  }) && receipt.scope === 'external' && receipt.pool === 'orchard';
}

export type PaymentHooks = {
  crashBeforeCommit?: () => void;
  crashAfterCommit?: () => void;
};

export type PaymentDeps = {
  store: SellerStore;
  scanner: ReceiptSource;
  policy?: Policy;
  now?: () => number;
  preparePackage?: (invoice: Invoice) => Promise<DeliveryPackage>;
  hooks?: PaymentHooks;
};

export type Payments = {
  cacheInvoice(invoice: Invoice): void;
  knownOrderIds(): Promise<string[]>;
  reconcileFromScanner(): Promise<void>;
  authorizeRelease(orderId: string): Promise<ReleaseDecision>;
  orderStatus(orderId: string): Promise<OrderStatus>;
};

async function persistPreparedPackage(
  store: SellerStore,
  invoice: Invoice,
  revision: ChainRevision,
  preparePackage: (invoice: Invoice) => Promise<DeliveryPackage>,
): Promise<void> {
  const existing = await store.getPreparedPackage(invoice.orderId);
  if (!existing) {
    const pkg = await preparePackage(invoice);
    try {
      await store.savePreparedPackage(pkg);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!message.includes('already exists')) throw error;
    }
  }
  await store.compareAndSetDelivery(invoice.orderId, 'locked', 'prepared', revision);
}

export function createPayments(deps: PaymentDeps): Payments {
  const store = deps.store;
  const scanner = deps.scanner;
  const policy = deps.policy ?? DEFAULT_POLICY;
  const now = deps.now ?? Date.now;
  const preparePackage = deps.preparePackage ?? (async (invoice: Invoice): Promise<DeliveryPackage> => ({
    orderId: invoice.orderId,
    productVersion: invoice.productVersion,
    buyerKeyId: invoice.buyerKeyId,
    encryptedEnvelope: new Uint8Array([1]),
  }));
  const lock = createLock();
  const invoicesById = new Map<string, Invoice>();
  const invoicesByOrder = new Map<string, Invoice>();

  function cacheInvoice(invoice: Invoice): void {
    invoicesById.set(invoice.id, invoice);
    invoicesByOrder.set(invoice.orderId, invoice);
  }

  async function hydrateFromStore(): Promise<void> {
    // Always re-fetch: invoices are issued continuously by a separate issuer
    // process/path, so a payments instance must see newly issued invoices on
    // every reconciliation cycle, not just the first.
    for (const invoice of await store.listInvoices()) {
      cacheInvoice(invoice);
    }
  }

  async function loadInvoiceForOrder(orderId: string): Promise<Invoice | null> {
    await hydrateFromStore();
    const cached = invoicesByOrder.get(orderId);
    if (cached) return cached;
    const invoice = await store.getInvoice(orderId);
    if (invoice) cacheInvoice(invoice);
    return invoice;
  }

  async function recordVerification(orderId: string, verification: Verification, at: number): Promise<void> {
    if (verification === 'available') return;
    await store.recordException({
      id: `${orderId}:verification_unavailable:scanner`,
      orderId,
      code: 'verification_unavailable',
      createdAt: at,
      detail: verification,
    });
  }

  async function settleInvoice(
    invoice: Invoice,
    observations: Observation[],
    health: ScanHealth,
    at: number,
  ): Promise<InvoiceSettlement> {
    const settlement = reduceInvoice(
      invoice,
      observations.filter((item) => item.invoiceId === invoice.id),
      health,
      policy,
      at,
    );
    const delivery = await store.getDelivery(invoice.orderId);
    if (settlement.payment === 'reorged' && isAuthorized(delivery)) {
      settlement.exceptions.push({
        id: `${invoice.orderId}:reorg_after_release:chain`,
        orderId: invoice.orderId,
        code: 'reorg_after_release',
        createdAt: at,
        detail: settlement.backingOutputIds.join(',') || 'reorg',
      });
    }
    return settlement;
  }

  /**
   * The single production reconciliation entrypoint. Fetches ONE complete
   * ReceiptSource snapshot, wholesale-replaces the reducer's view of the
   * world from it (never merges with a stale incremental cache), matches
   * receipts to known invoices by receiver identity (not an injected
   * invoiceId), refuses to commit an incomplete/future-dated snapshot, and
   * atomically persists observations+settlements+snapshot together via
   * store.commitSnapshot. Returns false when nothing was committed (stale,
   * incomplete, or future-dated snapshot) so callers such as
   * authorizeRelease can refuse first disclosure on that cycle.
   */
  async function fetchAndCommitSnapshot(): Promise<boolean> {
    const raw = await scanner.snapshot();
    const at = now();
    if (raw.checkedAt > at) return false;
    if (!raw.complete) return false;

    await hydrateFromStore();
    const knownInvoices = [...invoicesByOrder.values()];

    const observations: Observation[] = [];
    for (const receipt of raw.receipts) {
      if (receipt.pool !== 'orchard' || receipt.scope !== 'external') continue;
      const matched = knownInvoices.find((invoice) => receiptMatchesInvoice(invoice, raw, receipt));
      observations.push({
        outputId: receipt.outputId,
        invoiceId: matched ? matched.id : null,
        amountZat: receipt.amountZat,
        confirmations: receipt.canonical && receipt.mined
          ? Math.max(0, raw.tip.height - receipt.mined.height + 1)
          : 0,
        canonical: receipt.canonical,
        receivedAt: receipt.firstSeenAt,
        revision: { id: raw.tip.hash, height: raw.tip.height },
        sourceId: raw.sourceId,
        generation: raw.generation,
        chainNetwork: raw.chain.network,
        txid: receipt.txid,
        pool: receipt.pool,
        outputIndex: receipt.outputIndex,
      });
    }

    const health: ScanHealth = {
      healthy: raw.health === 'ready',
      checkedAt: raw.checkedAt,
      revision: { id: raw.tip.hash, height: raw.tip.height },
      caughtUp: raw.caughtUp,
    };

    const settlements: InvoiceSettlement[] = [];
    for (const invoice of knownInvoices) {
      if (invoice.attribution?.kind !== 'receiver') continue;
      settlements.push(await settleInvoice(invoice, observations, health, at));
    }

    deps.hooks?.crashBeforeCommit?.();
    await store.commitSnapshot({ snapshot: raw, observations, settlements });
    deps.hooks?.crashAfterCommit?.();

    const verification = classifyVerification(raw, policy, at);
    for (const invoice of knownInvoices) {
      await recordVerification(invoice.orderId, verification, at);
    }

    let settlementIndex = 0;
    for (const invoice of knownInvoices) {
      if (invoice.attribution?.kind !== 'receiver') continue;
      const settlement = settlements[settlementIndex];
      settlementIndex += 1;
      if (settlement?.releaseEligible) {
        await persistPreparedPackage(store, invoice, health.revision, preparePackage);
      }
    }

    return true;
  }

  async function currentSnapshotAndObservations(): Promise<{ snapshot: ScanSnapshot | null; observations: Observation[] }> {
    const snapshot = await store.getScanSnapshot();
    const observations = await store.listObservations();
    return { snapshot, observations };
  }

  async function authorizeReleaseLocked(orderId: string): Promise<ReleaseDecision> {
    const invoice = await loadInvoiceForOrder(orderId);
    let delivery = await store.getDelivery(orderId);
    let pkg = await store.getPreparedPackage(orderId);
    if (isAuthorized(delivery)) {
      return { disclose: true, reason: 'replay', delivery, package: pkg };
    }
    if (!invoice || invoice.attribution?.kind !== 'receiver') {
      return { disclose: false, reason: 'not_eligible', delivery, package: null };
    }

    const committed = await fetchAndCommitSnapshot();
    if (!committed) {
      return { disclose: false, reason: 'not_eligible', delivery, package: null };
    }

    delivery = await store.getDelivery(orderId);
    pkg = await store.getPreparedPackage(orderId);
    if (delivery !== 'prepared') {
      return { disclose: false, reason: 'not_eligible', delivery, package: null };
    }

    const { snapshot, observations } = await currentSnapshotAndObservations();
    if (!snapshot) {
      return { disclose: false, reason: 'not_eligible', delivery, package: null };
    }
    const health: ScanHealth = {
      healthy: snapshot.health === 'ready',
      checkedAt: snapshot.checkedAt,
      revision: { id: snapshot.tip.hash, height: snapshot.tip.height },
      caughtUp: snapshot.caughtUp,
    };
    const fresh = reduceInvoice(
      invoice,
      observations.filter((item) => item.invoiceId === invoice.id),
      health,
      policy,
      now(),
    );
    if (!fresh.releaseEligible) {
      return { disclose: false, reason: 'not_eligible', delivery, package: null };
    }

    const revision = { id: snapshot.tip.hash, height: snapshot.tip.height };
    const ok = await store.compareAndSetDelivery(orderId, 'prepared', 'queued', revision);
    if (!ok) {
      return {
        disclose: false,
        reason: 'not_eligible',
        delivery: await store.getDelivery(orderId),
        package: null,
      };
    }
    return {
      disclose: true,
      reason: 'first_release',
      delivery: 'queued',
      package: pkg,
    };
  }

  return {
    cacheInvoice,
    async knownOrderIds() {
      await hydrateFromStore();
      return [...invoicesByOrder.keys()];
    },
    reconcileFromScanner() {
      return lock(async () => {
        await fetchAndCommitSnapshot();
      });
    },
    authorizeRelease(orderId) {
      return lock(() => authorizeReleaseLocked(orderId));
    },
    async orderStatus(orderId) {
      return lock(async () => {
        const invoice = await loadInvoiceForOrder(orderId);
        const delivery = await store.getDelivery(orderId);
        const at = now();
        const live = await scanner.snapshot().catch(() => null);
        const verification = classifyVerification(live, policy, at);
        await recordVerification(orderId, verification, at);
        if (!invoice || invoice.attribution?.kind !== 'receiver') {
          const exceptions = await store.listExceptions(orderId);
          return {
            payment: 'awaiting',
            delivery,
            verification,
            exceptions: exceptions.map((record) => ({ code: record.code })),
          };
        }
        const { snapshot, observations } = await currentSnapshotAndObservations();
        const health: ScanHealth = snapshot
          ? {
            healthy: snapshot.health === 'ready',
            checkedAt: snapshot.checkedAt,
            revision: { id: snapshot.tip.hash, height: snapshot.tip.height },
            caughtUp: snapshot.caughtUp,
          }
          : { healthy: false, checkedAt: 0, revision: { id: 'none', height: 0 }, caughtUp: false };
        const settlement = reduceInvoice(
          invoice,
          observations.filter((item) => item.invoiceId === invoice.id),
          health,
          policy,
          at,
        );
        const exceptions = await store.listExceptions(orderId);
        return {
          payment: settlement.payment,
          delivery,
          verification,
          exceptions: exceptions.map((record) => ({ code: record.code })),
        };
      });
    },
  };
}

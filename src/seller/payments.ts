import { parseAmountZat } from '../contracts/validation.ts';
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
  Scanner,
  SellerStore,
  Verification,
} from '../contracts/types.ts';

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

function applyReceipt(into: Map<string, Observation>, observation: Observation): void {
  const previous = into.get(observation.outputId);
  if (!previous || observation.revision.height >= previous.revision.height) {
    into.set(observation.outputId, { ...observation, revision: { ...observation.revision } });
  }
}

function classifyVerification(health: ScanHealth, policy: Policy, now: number): Verification {
  if (!health.healthy) return 'unavailable';
  if (now - health.checkedAt > policy.maxHealthAgeMs) return 'stale';
  if (!health.caughtUp) return 'stale';
  return 'available';
}

function isAuthorized(delivery: DeliveryState): boolean {
  return delivery === 'queued'
    || delivery === 'sent_unacknowledged'
    || delivery === 'acknowledged'
    || delivery === 'retry_required';
}

function receiptsForInvoice(receipts: Map<string, Observation>, invoiceId: string): Observation[] {
  return [...receipts.values()].filter((item) => item.invoiceId === invoiceId);
}

export type PaymentHooks = {
  crashBeforeCommit?: () => void;
  crashAfterCommit?: () => void;
};

export type PaymentDeps = {
  store: SellerStore;
  scanner: Scanner;
  policy?: Policy;
  now?: () => number;
  preparePackage?: (invoice: Invoice) => Promise<DeliveryPackage>;
  hooks?: PaymentHooks;
};

export type Payments = {
  cacheInvoice(invoice: Invoice): void;
  knownOrderIds(): Promise<string[]>;
  reconcileObservation(observation: Observation): Promise<void>;
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
  const receipts = new Map<string, Observation>();
  let hydratePromise: Promise<void> | null = null;

  function cacheInvoice(invoice: Invoice): void {
    invoicesById.set(invoice.id, invoice);
    invoicesByOrder.set(invoice.orderId, invoice);
  }

  async function hydrateFromStore(): Promise<void> {
    if (!hydratePromise) {
      hydratePromise = (async () => {
        for (const invoice of await store.listInvoices()) {
          cacheInvoice(invoice);
        }
        for (const observation of await store.listObservations()) {
          applyReceipt(receipts, observation);
        }
      })();
    }
    await hydratePromise;
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
    source: Map<string, Observation>,
    health: ScanHealth,
    at: number,
  ): Promise<InvoiceSettlement> {
    const settlement = reduceInvoice(invoice, receiptsForInvoice(source, invoice.id), health, policy, at);
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

  async function reconcileObservationLocked(observation: Observation): Promise<boolean> {
    await hydrateFromStore();
    let invoice = observation.invoiceId ? invoicesById.get(observation.invoiceId) ?? null : null;
    if (observation.invoiceId && !invoice) {
      for (const cached of invoicesByOrder.values()) {
        if (cached.id === observation.invoiceId) {
          invoice = cached;
          cacheInvoice(cached);
          break;
        }
      }
    }

    const at = now();
    const health = await scanner.health();
    const verification = classifyVerification(health, policy, at);
    const pending = new Map(receipts);
    applyReceipt(pending, observation);

    const settlements: InvoiceSettlement[] = [];
    if (invoice) {
      settlements.push(await settleInvoice(invoice, pending, health, at));
    }

    deps.hooks?.crashBeforeCommit?.();
    await store.commitReconciliation({
      checkpoint: { revision: observation.revision },
      observations: invoice || observation.invoiceId === null ? [observation] : [],
      settlements,
    });
    applyReceipt(receipts, observation);
    deps.hooks?.crashAfterCommit?.();

    for (const cached of invoicesByOrder.values()) {
      await recordVerification(cached.orderId, verification, at);
    }

    if (invoice) {
      const settlement = settlements[0];
      if (settlement?.releaseEligible) {
        await persistPreparedPackage(store, invoice, health.revision, preparePackage);
      }
    }
    return true;
  }

  async function authorizeReleaseLocked(orderId: string): Promise<ReleaseDecision> {
    const invoice = await loadInvoiceForOrder(orderId);
    let delivery = await store.getDelivery(orderId);
    let pkg = await store.getPreparedPackage(orderId);
    if (isAuthorized(delivery)) {
      return { disclose: true, reason: 'replay', delivery, package: pkg };
    }
    if (!invoice) {
      return { disclose: false, reason: 'not_eligible', delivery, package: null };
    }

    const at = now();
    const health = await scanner.health();
    const settlement = reduceInvoice(invoice, receiptsForInvoice(receipts, invoice.id), health, policy, at);
    if (!settlement.releaseEligible) {
      return { disclose: false, reason: 'not_eligible', delivery, package: null };
    }
    if (delivery === 'locked') {
      await persistPreparedPackage(store, invoice, health.revision, preparePackage);
      delivery = await store.getDelivery(orderId);
      pkg = await store.getPreparedPackage(orderId);
    }
    if (delivery !== 'prepared') {
      return { disclose: false, reason: 'not_eligible', delivery, package: null };
    }

    const ok = await store.compareAndSetDelivery(orderId, 'prepared', 'queued', health.revision);
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
    reconcileObservation(observation) {
      return lock(async () => {
        await reconcileObservationLocked(observation);
      });
    },
    reconcileFromScanner() {
      return lock(async () => {
        await hydrateFromStore();
        const checkpoint = await store.getCheckpoint();
        const items: Observation[] = [];
        for await (const item of scanner.observations(checkpoint)) {
          items.push(item);
        }
        for (const item of items) {
          await reconcileObservationLocked(item);
        }
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
        const health = await scanner.health();
        const verification = classifyVerification(health, policy, at);
        await recordVerification(orderId, verification, at);
        const settlement = invoice
          ? reduceInvoice(invoice, receiptsForInvoice(receipts, invoice.id), health, policy, at)
          : null;
        const exceptions = await store.listExceptions(orderId);
        return {
          payment: settlement?.payment ?? 'awaiting',
          delivery,
          verification,
          exceptions: exceptions.map((record) => ({ code: record.code })),
        };
      });
    },
  };
}

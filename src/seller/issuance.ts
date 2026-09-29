import type { Invoice, SellerStore, ServiceAvailability } from '../contracts/types.ts';
import type { ChainIdentity, ReceiptSource } from '../contracts/live.ts';
import { assertCanonicalAmountZat, assertRequiredString } from '../contracts/validation.ts';
import type { IssuanceLimiter } from './orders.ts';

/**
 * Issues immutable unique-receiver invoices (Task 4, Section 3.2).
 *
 * Replay lookup runs first: an already-committed invoice for the request's
 * order always wins, even if dependencies are currently unavailable or the
 * catalogue/config has since changed. New issuance never bypasses a known
 * unavailable dependency. No seller SQL transaction is held across scanner
 * network I/O: `reserveInvoice` and `commitInvoice` are separate durable
 * steps, with the scanner allocation call sitting between them.
 *
 * Concurrent handlers share one issuer. `issue` is queued in-process from
 * its first line until a draft or invoice is committed, or the call fails,
 * so a later call sees the reserved slot. The queue is released before
 * `allocateReceiver`.
 */
export function createInvoiceIssuer(deps: {
  store: SellerStore;
  scanner: ReceiptSource;
  chain: ChainIdentity;
  accountId: string;
  ttlMs: number;
  now: () => number;
  availability: (productVersion: string) => Promise<ServiceAvailability>;
  /** When set, new issuance (not replay) is refused with RateLimitedError past config.limits. */
  limiter?: IssuanceLimiter;
}): {
  issue(input: {
    requestId: string;
    buyerKeyId: string;
    productVersion: string;
    expectedAmountZat: string;
  }): Promise<Invoice>;
} {
  let queued: Promise<void> = Promise.resolve();
  const untilReserved = <T>(work: () => Promise<T>): Promise<T> => {
    const previous = queued;
    let release: () => void = () => undefined;
    queued = new Promise<void>((resolve) => { release = resolve; });
    return previous.then(work, work).finally(release);
  };

  return {
    async issue(input): Promise<Invoice> {
      const prepared = await untilReserved(async () => {
        assertRequiredString(input.requestId, 'requestId');
        assertRequiredString(input.buyerKeyId, 'buyerKeyId');
        assertRequiredString(input.productVersion, 'productVersion');
        assertCanonicalAmountZat(input.expectedAmountZat);

        // Replay of an existing invoice/draft is not new issuance. A refused
        // create must not insert an order row or allocate a scanner receiver.
        deps.limiter?.assertCanIssue({ requestId: input.requestId, buyerKeyId: input.buyerKeyId });
        const order = await deps.store.createOrder({
          requestId: input.requestId,
          buyerKeyId: input.buyerKeyId,
          productVersion: input.productVersion,
        });

        // A committed invoice for this order still wins, including a replay the
        // limiter already classified as not-new, even if availability has drifted.
        const existingInvoice = await deps.store.getInvoice(order.id);
        if (existingInvoice) {
          if (existingInvoice.amountZat !== input.expectedAmountZat) {
            throw new Error('request terms changed');
          }
          return { invoice: existingInvoice };
        }

        const now = deps.now();
        const draft = await deps.store.getInvoiceDraft(order.id);
        if (!draft) {
          const availability = await deps.availability(input.productVersion);
          if (!availability.productPublished || !availability.messaging || !availability.storageReplica || !availability.scanner) {
            throw new Error('checkout unavailable');
          }
        }

        const reservedDraft = await deps.store.reserveInvoice({
          orderId: order.id,
          buyerKeyId: input.buyerKeyId,
          productVersion: input.productVersion,
          chain: deps.chain,
          accountId: deps.accountId,
          now,
          ttlMs: deps.ttlMs,
        });

        if (reservedDraft.amountZat !== input.expectedAmountZat) {
          throw new Error('request terms changed');
        }
        return { draft: reservedDraft };
      });

      if ('invoice' in prepared) {
        if (!prepared.invoice) throw new Error('invoice result missing');
        return prepared.invoice;
      }

      // Allocator/network I/O happens outside the seller SQL transaction and
      // outside the in-process issuance queue. `allocateReceiver` is itself
      // idempotent per allocationId on the scanner side, so a crash between
      // reservation and this call, or between this call and `commitInvoice`,
      // is safe to retry.
      const allocation = await deps.scanner.allocateReceiver({
        allocationId: prepared.draft.id,
        chain: prepared.draft.chain,
        accountId: prepared.draft.accountId,
        amountZat: prepared.draft.amountZat,
        expiresAt: prepared.draft.expiresAt,
      });

      return deps.store.commitInvoice(prepared.draft.id, allocation);
    },
  };
}

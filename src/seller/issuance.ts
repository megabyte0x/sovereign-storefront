import type { Invoice, SellerStore, ServiceAvailability } from '../contracts/types.ts';
import type { ChainIdentity, ReceiptSource } from '../contracts/live.ts';
import { assertCanonicalAmountZat, assertRequiredString } from '../contracts/validation.ts';

/**
 * Issues immutable unique-receiver invoices (Task 4, Section 3.2).
 *
 * Replay lookup runs first: an already-committed invoice for the request's
 * order always wins, even if dependencies are currently unavailable or the
 * catalogue/config has since changed. New issuance never bypasses a known
 * unavailable dependency. No seller SQL transaction is held across scanner
 * network I/O: `reserveInvoice` and `commitInvoice` are separate durable
 * steps, with the scanner allocation call sitting between them.
 */
export function createInvoiceIssuer(deps: {
  store: SellerStore;
  scanner: ReceiptSource;
  chain: ChainIdentity;
  accountId: string;
  ttlMs: number;
  now: () => number;
  availability: (productVersion: string) => Promise<ServiceAvailability>;
}): {
  issue(input: {
    requestId: string;
    buyerKeyId: string;
    productVersion: string;
    expectedAmountZat: string;
  }): Promise<Invoice>;
} {
  return {
    async issue(input): Promise<Invoice> {
      assertRequiredString(input.requestId, 'requestId');
      assertRequiredString(input.buyerKeyId, 'buyerKeyId');
      assertRequiredString(input.productVersion, 'productVersion');
      assertCanonicalAmountZat(input.expectedAmountZat);

      const order = await deps.store.createOrder({
        requestId: input.requestId,
        buyerKeyId: input.buyerKeyId,
        productVersion: input.productVersion,
      });

      // Replay lookup first: an existing, already-committed invoice for this
      // order always wins, regardless of current availability/terms drift.
      const existingInvoice = await deps.store.getInvoice(order.id);
      if (existingInvoice) {
        if (existingInvoice.amountZat !== input.expectedAmountZat) {
          throw new Error('request terms changed');
        }
        return existingInvoice;
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

      // Allocator/network I/O happens outside the seller SQL transaction.
      // `allocateReceiver` is itself idempotent per allocationId on the
      // scanner side, so a crash between reservation and this call, or
      // between this call and `commitInvoice`, is safe to retry.
      const allocation = await deps.scanner.allocateReceiver({
        allocationId: reservedDraft.id,
        chain: reservedDraft.chain,
        accountId: reservedDraft.accountId,
        amountZat: reservedDraft.amountZat,
        expiresAt: reservedDraft.expiresAt,
      });

      return deps.store.commitInvoice(reservedDraft.id, allocation);
    },
  };
}

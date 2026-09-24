import type { FulfillmentMessaging } from '../adapters/messaging.ts';
import type {
  CredentialAdapter,
  DeliveryPackage,
  OrderStatus,
  ReleaseDecision,
  SellerStore,
} from '../contracts/types.ts';
import type { Payments } from './payments.ts';

export type FulfillmentDeps = {
  store: SellerStore;
  payments: Payments;
  messaging: FulfillmentMessaging;
  credentials?: CredentialAdapter;
};

async function persistSentUnacknowledged(store: SellerStore, orderId: string): Promise<void> {
  await store.compareAndSetDelivery(orderId, 'queued', 'sent_unacknowledged', {
    id: 'send',
    height: 0,
  });
}

export function createFulfillment(deps: FulfillmentDeps) {
  let inFlight: Promise<void> | null = null;

  async function assertBuyer(orderId: string, credentialId: string): Promise<void> {
    if (!credentialId) {
      throw new Error('credential required');
    }
    if (!deps.credentials) {
      throw new Error('credential required');
    }
    const invoice = await deps.store.getInvoice(orderId);
    if (!invoice) {
      throw new Error('order not found');
    }
    const proof = await deps.credentials.provePossession(credentialId, { orderId });
    const ok = await deps.credentials.verifyPossession(invoice.buyerKeyId, proof, { orderId });
    if (!ok) {
      throw new Error('buyer does not own order');
    }
  }

  return {
    async recover(orderId: string, credentialId: string): Promise<ReleaseDecision> {
      await assertBuyer(orderId, credentialId);
      return deps.payments.authorizeRelease(orderId);
    },

    async status(orderId: string, credentialId: string): Promise<OrderStatus> {
      await assertBuyer(orderId, credentialId);
      return deps.payments.orderStatus(orderId);
    },

    async acknowledge(orderId: string, credentialId: string, packageId: string): Promise<void> {
      await assertBuyer(orderId, credentialId);
      await deps.store.acknowledgePackage(orderId, packageId);
      const ok = await deps.store.compareAndSetDelivery(
        orderId,
        'sent_unacknowledged',
        'acknowledged',
        { id: 'ack', height: 0 },
      );
      if (!ok) {
        const current = await deps.store.getDelivery(orderId);
        if (current !== 'acknowledged') {
          throw new Error('acknowledgement not accepted');
        }
        // Idempotent replay of the same authenticated ack for the same
        // immutable package.
      }
    },

    async dispatchPending(): Promise<void> {
      if (inFlight) return inFlight;
      inFlight = (async () => {
        try {
          for (const orderId of await deps.payments.knownOrderIds()) {
            const decision = await deps.payments.authorizeRelease(orderId);
            if (!decision.disclose || !decision.package) continue;
            if (decision.delivery === 'acknowledged') continue;
            if (decision.delivery === 'sent_unacknowledged') continue;
            const pkg: DeliveryPackage = decision.package;
            const packageId = pkg.packageId;
            if (!packageId) throw new Error('prepared package missing identity');
            // Persist intent before any network I/O: a crash after this
            // point but before send is a durably visible 'attempted'
            // disclosure, not silently lost.
            const attempt = await deps.store.beginDeliveryAttempt({
              orderId,
              packageId,
              reason: 'initial',
              checkpoint: null,
            });
            try {
              await deps.messaging.send(pkg);
            } catch (error) {
              // Send outcome is unproven either way (our own process may
              // crash before or after the transport actually accepted it);
              // leave the attempt unresolved rather than guessing, and do
              // not upgrade delivery state on an unconfirmed send.
              throw error;
            }
            await deps.store.finishDeliveryAttempt(attempt.attemptId, 'transport-accepted');
            await persistSentUnacknowledged(deps.store, orderId);
          }
        } finally {
          inFlight = null;
        }
      })();
      return inFlight;
    },
  };
}

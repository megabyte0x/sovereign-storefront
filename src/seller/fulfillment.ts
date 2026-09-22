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
  const sentThisProcess = new Set<string>();
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

    async acknowledge(orderId: string, credentialId: string): Promise<void> {
      await assertBuyer(orderId, credentialId);
      const ok = await deps.store.compareAndSetDelivery(
        orderId,
        'sent_unacknowledged',
        'acknowledged',
        { id: 'ack', height: 0 },
      );
      if (!ok) {
        throw new Error('acknowledgement not accepted');
      }
    },

    async dispatchPending(): Promise<void> {
      if (inFlight) return inFlight;
      inFlight = (async () => {
        try {
          for (const orderId of await deps.payments.knownOrderIds()) {
            if (sentThisProcess.has(orderId)) continue;
            const decision = await deps.payments.authorizeRelease(orderId);
            if (!decision.disclose || !decision.package) continue;
            if (decision.delivery === 'acknowledged') continue;
            const pkg: DeliveryPackage = decision.package;
            try {
              await deps.messaging.send(pkg);
              sentThisProcess.add(orderId);
              await deps.store.recordSendAttempt(orderId);
              await persistSentUnacknowledged(deps.store, orderId);
            } catch (error) {
              if (deps.messaging.sendInitiatedFor.includes(orderId)) {
                await persistSentUnacknowledged(deps.store, orderId);
              }
              throw error;
            }
          }
        } finally {
          inFlight = null;
        }
      })();
      return inFlight;
    },
  };
}

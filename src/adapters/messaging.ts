import type { DeliveryPackage } from '../contracts/types.ts';

/**
 * Messaging in this task is a test double over Gate A encrypted envelopes.
 * Do not treat Light Push ack as an application response. logos-chat is not used.
 */
export const MESSAGING_MAPPING = {
  kind: 'test-double',
  gate: 'A',
  library: '@waku/message-encryption',
  logosChat: false,
  lightPushAckIsApplicationResponse: false,
} as const;

export type MessagingHooks = {
  crashBeforeSend?: () => void;
  crashAfterSend?: () => void;
};

export type FulfillmentMessaging = {
  sent: DeliveryPackage[];
  sendInitiatedFor: string[];
  send(pkg: DeliveryPackage): Promise<void>;
};

export function createMemoryMessaging(hooks: MessagingHooks = {}): FulfillmentMessaging {
  const sent: DeliveryPackage[] = [];
  const sendInitiatedFor: string[] = [];
  return {
    sent,
    sendInitiatedFor,
    async send(pkg) {
      hooks.crashBeforeSend?.();
      sendInitiatedFor.push(pkg.orderId);
      sent.push({
        orderId: pkg.orderId,
        productVersion: pkg.productVersion,
        buyerKeyId: pkg.buyerKeyId,
        encryptedEnvelope: new Uint8Array(pkg.encryptedEnvelope),
      });
      hooks.crashAfterSend?.();
    },
  };
}

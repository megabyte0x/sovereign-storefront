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

export const ROUTING_MARKERS = ['ORDER_MARK', 'BUYER_MARK', 'PRODUCT_MARK'] as const;

export type PublicEnvelope = {
  contentTopic: string;
  pubsubTopic?: string;
  version?: number;
  timestamp?: number;
  ephemeral?: boolean;
  meta?: Uint8Array | null;
  rateLimitProof?: Uint8Array | null;
  payload?: Uint8Array;
};

export function applicationContentTopic(runId: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(runId)) {
    throw new Error('invalid run id');
  }
  return `/ssf/1/${runId}/proto`;
}

export function encodeApplicationPayload(input: Record<string, unknown>): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(input));
}

export function buildPublicEnvelope(runId: string, encryptedPayload: Uint8Array): PublicEnvelope {
  return {
    contentTopic: applicationContentTopic(runId),
    pubsubTopic: '/waku/2/rs/1/0',
    version: 1,
    timestamp: Date.now(),
    ephemeral: false,
    meta: null,
    rateLimitProof: null,
    payload: encryptedPayload,
  };
}

function stringifyPublic(value: unknown): string[] {
  if (value == null) return [];
  if (value instanceof Uint8Array) {
    return [new TextDecoder('utf-8', { fatal: false }).decode(value)];
  }
  if (typeof value === 'object') return [JSON.stringify(value)];
  return [String(value)];
}

export function inspectPublicRouting(envelope: PublicEnvelope): { ok: boolean; found: string[] } {
  const haystack = [
    envelope.contentTopic,
    envelope.pubsubTopic,
    envelope.version,
    envelope.timestamp,
    envelope.ephemeral,
    envelope.meta,
    envelope.rateLimitProof,
  ].flatMap((value) => stringifyPublic(value)).join('\n');
  const found = ROUTING_MARKERS.filter((marker) => haystack.includes(marker));
  return { ok: found.length === 0, found };
}

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

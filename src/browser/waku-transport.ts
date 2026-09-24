import type {
  BrowserPurchase, CredentialAdapter, DeliveryPackage, OrderStatus, OrderTransport, PurchaseStore,
} from '../contracts/types.ts';
import type { BuyerRequest, DecodedWakuMessage, SellerResponse, WakuSession } from '../contracts/messages.ts';
import type { Network } from '../contracts/live.ts';

/**
 * Fixed single-product terms this storefront buys: the seller's own public
 * key (`send`'s ECIES recipient), the invoice network, and the price/version
 * the buyer expects to be charged (`create`'s `expectedAmountZat` terms
 * commitment — `BrowserPurchase` carries `productVersion` per record but not
 * price, and the seller-side issuer rejects a mismatched `expectedAmountZat`
 * as "request terms changed").
 */
export type WakuSellerConfig = {
  sellerKeyId: string;
  network: Network;
  amountZat: string;
  productVersion: string;
};

const REQUEST_TTL_MS = 5 * 60 * 1000;
const RESPONSE_TIMEOUT_MS = 10_000;
const MAX_ATTEMPTS = 3;

function newMessageId(): string {
  const id = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto?.randomUUID?.();
  return id ? `req-${id}` : `req-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

/**
 * Builds an `OrderTransport` over one already-open `WakuSession`. The
 * session is expected to be scoped to exactly one purchase credential (its
 * signing key is that credential's key) — this transport does not itself
 * open/close/cache sessions per credential; the caller creates a fresh
 * session (via `credentials.createWakuSession`) for the credential it is
 * about to act with, builds a transport over it, uses it, and closes it.
 * That keeps "reopening My purchases restores the matching credential's own
 * session" true by construction rather than by an internal cache the caller
 * has to trust.
 */
export function createWakuOrderTransport(
  credentials: CredentialAdapter,
  session: WakuSession,
  sellerConfig: WakuSellerConfig,
  purchases: PurchaseStore,
): OrderTransport {
  let subscribed: Promise<() => Promise<void>> | null = null;
  const pending = new Map<string, {
    resolve: (message: DecodedWakuMessage) => void;
    reject: (error: Error) => void;
  }>();

  async function ensureSubscribed(): Promise<void> {
    if (!subscribed) {
      subscribed = session.subscribe(async (message) => {
        if (!('inReplyTo' in message.body)) return; // ignore any non-response body
        const waiter = pending.get(message.body.inReplyTo);
        if (!waiter) return;
        pending.delete(message.body.inReplyTo);
        waiter.resolve(message);
      });
    }
    await subscribed;
  }

  async function sendAndWait(
    buildBody: (messageId: string, issuedAt: number, expiresAt: number) => BuyerRequest,
  ): Promise<DecodedWakuMessage> {
    // Subscribe before the first send so a fast reply is never missed.
    await ensureSubscribed();
    let lastError = new Error('waku request timed out with no response');
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      const messageId = newMessageId();
      const issuedAt = Date.now();
      const expiresAt = issuedAt + REQUEST_TTL_MS;
      const body = buildBody(messageId, issuedAt, expiresAt);
      const message = await new Promise<DecodedWakuMessage | null>((resolve) => {
        const timer = setTimeout(() => {
          pending.delete(messageId);
          resolve(null);
        }, RESPONSE_TIMEOUT_MS);
        pending.set(messageId, {
          resolve: (m) => {
            clearTimeout(timer);
            resolve(m);
          },
          reject: (error) => {
            clearTimeout(timer);
            pending.delete(messageId);
            lastError = error;
            resolve(null);
          },
        });
        session.send(sellerConfig.sellerKeyId, body).catch((error: unknown) => {
          const waiter = pending.get(messageId);
          if (waiter) waiter.reject(error instanceof Error ? error : new Error(String(error)));
        });
      });
      if (message) return message;
      // On response loss, retry with a fresh messageId and the same
      // underlying order/credential/terms — never replay the exact same
      // envelope (a resend that reuses `messageId` would just dedup at the
      // seller's inbox as a no-op if it actually arrived and got lost only
      // on the return trip).
    }
    throw lastError;
  }

  async function requireCorrelatedResponse(
    message: DecodedWakuMessage,
    expectBuyerKeyId: string,
  ): Promise<SellerResponse> {
    const response = message.body as SellerResponse;
    if (message.signerKeyId !== sellerConfig.sellerKeyId) {
      throw new Error('response was not signed by the configured seller');
    }
    if (response.buyerKeyId !== expectBuyerKeyId) {
      throw new Error('response buyer identity does not match this credential');
    }
    if (response.type === 'error') {
      throw new Error(`seller rejected request: ${response.code}`);
    }
    return response;
  }

  return {
    async create(record: BrowserPurchase) {
      const buyerKeyId = await credentials.publicKey(record.credentialId);
      const message = await sendAndWait((messageId, issuedAt, expiresAt) => ({
        version: 1, messageId, sellerKeyId: sellerConfig.sellerKeyId,
        network: sellerConfig.network, issuedAt, expiresAt,
        type: 'create', requestId: record.requestId,
        productVersion: record.productVersion, expectedAmountZat: sellerConfig.amountZat,
      }));
      const response = await requireCorrelatedResponse(message, buyerKeyId);
      if (response.type !== 'invoice') {
        throw new Error(`unexpected response type for create: ${response.type}`);
      }
      return response.invoice;
    },
    async status(orderId: string, credentialId: string): Promise<OrderStatus> {
      const buyerKeyId = await credentials.publicKey(credentialId);
      const message = await sendAndWait((messageId, issuedAt, expiresAt) => ({
        version: 1, messageId, sellerKeyId: sellerConfig.sellerKeyId,
        network: sellerConfig.network, issuedAt, expiresAt,
        type: 'status', orderId,
      }));
      const response = await requireCorrelatedResponse(message, buyerKeyId);
      if (response.type !== 'status') {
        throw new Error(`unexpected response type for status: ${response.type}`);
      }
      return response.status;
    },
    async recover(orderId: string, credentialId: string): Promise<DeliveryPackage> {
      const buyerKeyId = await credentials.publicKey(credentialId);
      const message = await sendAndWait((messageId, issuedAt, expiresAt) => ({
        version: 1, messageId, sellerKeyId: sellerConfig.sellerKeyId,
        network: sellerConfig.network, issuedAt, expiresAt,
        type: 'recover', orderId,
      }));
      const response = await requireCorrelatedResponse(message, buyerKeyId);
      if (response.type !== 'delivery') {
        throw new Error(`unexpected response type for recover: ${response.type}`);
      }
      // Persist the original authenticated wire envelope alongside the
      // package before the caller acknowledges it, so a later reload can
      // re-verify the retained signature/bindings instead of trusting a
      // decrypted-only cache.
      await purchases.saveDelivery(orderId, {
        packageId: response.packageId,
        wireEnvelope: message.wireEnvelope,
      });
      return response.package;
    },
    async acknowledge(orderId: string, credentialId: string, packageId: string): Promise<void> {
      const buyerKeyId = await credentials.publicKey(credentialId);
      const message = await sendAndWait((messageId, issuedAt, expiresAt) => ({
        version: 1, messageId, sellerKeyId: sellerConfig.sellerKeyId,
        network: sellerConfig.network, issuedAt, expiresAt,
        type: 'acknowledge', orderId, packageId,
      }));
      const response = await requireCorrelatedResponse(message, buyerKeyId);
      if (response.type !== 'acknowledged') {
        throw new Error(`unexpected response type for acknowledge: ${response.type}`);
      }
    },
  };
}

import type {
  BrowserPurchase, CredentialAdapter, DeliveryPackage, OrderStatus, OrderTransport, PurchaseStore,
} from '../contracts/types.ts';
import type { BuyerRequest, DecodedWakuMessage, SellerResponse, StoredDelivery, WakuSession } from '../contracts/messages.ts';
import type { Network } from '../contracts/live.ts';
import { createWakuSession, routingInfoFor, wakuNetworkSettings, type WakuNetworkInput, type WakuNetworkSettings } from '../adapters/waku.ts';

export function browserWakuNetworkSettings(input: WakuNetworkInput): WakuNetworkSettings {
  return wakuNetworkSettings(input);
}

export function browserRoutingInfo(settings: WakuNetworkSettings, contentTopic: string) {
  return routingInfoFor(settings, contentTopic);
}

/** Buyer-facing text for a signed seller error. `rate_limited` is an abuse cap, not a transport failure. */
export function mapWakuSellerError(code: string): string {
  if (code === 'rate_limited') return 'Too many open checkouts';
  return `seller rejected request: ${code}`;
}

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

/**
 * The Waku order transport. `listen()` subscribes without sending anything so
 * an unsolicited `delivery` pushed by the seller's dispatch loop is accepted
 * (after full validation) and persisted even when no request is in flight.
 */
export type WakuOrderTransport = OrderTransport & { listen(): Promise<void> };

const REQUEST_TTL_MS = 5 * 60 * 1000;
const RESPONSE_TIMEOUT_MS = 10_000;
const MAX_ATTEMPTS = 3;

function hex(bytes: Uint8Array): string {
  let out = '';
  for (const b of bytes) out += b.toString(16).padStart(2, '0');
  return out;
}

/**
 * Recomputes the seller's immutable package identity (src/seller/db.ts
 * `immutablePackageId`): sha256(orderId \0 productVersion \0 buyerKeyId \0
 * encryptedEnvelope), hex. Uses WebCrypto so it runs in the browser.
 */
async function derivePackageId(pkg: DeliveryPackage): Promise<string> {
  const enc = new TextEncoder();
  const parts = [enc.encode(pkg.orderId), new Uint8Array([0]), enc.encode(pkg.productVersion), new Uint8Array([0]),
    enc.encode(pkg.buyerKeyId), new Uint8Array([0]), pkg.encryptedEnvelope];
  const total = parts.reduce((n, p) => n + p.byteLength, 0);
  const buf = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) { buf.set(p, offset); offset += p.byteLength; }
  return hex(new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', buf)));
}

/**
 * Re-verifies a retained delivery before it is trusted again (v2 backup
 * import). `decodeStored` checks the seller's signature and that the envelope
 * still decrypts to this buyer; the advertised packageId must be the one
 * derived from the sealed envelope, and the bindings must match this store.
 * A failure rejects the whole import — a crafted backup must not plant a
 * delivery that later blocks a real push. The error text is generic: the UI
 * shows it as "Backup could not be imported".
 */
export async function verifyImportedDelivery(
  session: WakuSession,
  delivery: StoredDelivery,
  expect: { sellerKeyId: string; buyerKeyId: string; orderId: string; productVersion: string; network: Network },
): Promise<void> {
  let decoded: DecodedWakuMessage;
  try {
    decoded = await session.decodeStored(delivery.wireEnvelope);
  } catch {
    throw new Error('backup could not be imported');
  }
  if (decoded.signerKeyId !== expect.sellerKeyId) throw new Error('backup could not be imported');
  const body = decoded.body;
  if (!('type' in body) || body.type !== 'delivery') throw new Error('backup could not be imported');
  if (body.sellerKeyId !== expect.sellerKeyId) throw new Error('backup could not be imported');
  if (body.buyerKeyId !== expect.buyerKeyId) throw new Error('backup could not be imported');
  if (body.network !== expect.network) throw new Error('backup could not be imported');
  if (body.packageId !== delivery.packageId) throw new Error('backup could not be imported');
  const pkg = body.package;
  if (pkg.orderId !== expect.orderId || pkg.productVersion !== expect.productVersion) {
    throw new Error('backup could not be imported');
  }
  if (pkg.buyerKeyId !== expect.buyerKeyId) throw new Error('backup could not be imported');
  if (await derivePackageId(pkg) !== delivery.packageId) throw new Error('backup could not be imported');
}

/**
 * A session that can only `decodeStored`. Import re-verifies a retained
 * delivery before the credential exists in the adapter, and must not dial
 * Waku to do it — `decodeStored` needs the private key and the topic, nothing
 * else. `createNode` throws so a send/subscribe here fails closed.
 */
export function importVerifySession(contentTopic: string, buyerPrivateKey: Uint8Array): WakuSession {
  return createWakuSession(
    { contentTopic, bootstrapPeers: [], peerTimeoutMs: 1 },
    buyerPrivateKey,
    { createNode: async () => { throw new Error('import verification does not open a node'); } },
  );
}

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
): WakuOrderTransport {
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
        if (waiter) {
          pending.delete(message.body.inReplyTo);
          waiter.resolve(message);
          return;
        }
        // Not a reply we are waiting for: the only other thing we accept is
        // a seller-initiated delivery push. Anything invalid is dropped
        // silently — never thrown into the session, never logged.
        await acceptUnsolicitedDelivery(message).catch(() => undefined);
      });
    }
    await subscribed;
  }

  /**
   * Accepts a seller-pushed `delivery` (fulfillment dispatch loop, see
   * `createWakuFulfillmentMessaging`: `inReplyTo === messageId === push-<packageId>`)
   * only if every binding holds; otherwise returns without side effects.
   */
  async function acceptUnsolicitedDelivery(message: DecodedWakuMessage): Promise<void> {
    const body = message.body as SellerResponse;
    if (body.type !== 'delivery') return;
    // Signed by, and claiming to be from, the configured seller.
    if (message.signerKeyId !== sellerConfig.sellerKeyId) return;
    if (body.sellerKeyId !== sellerConfig.sellerKeyId) return;
    // A push is self-referential; anything else claims to answer a request
    // we never made (or one that already completed/timed out).
    if (body.inReplyTo !== body.messageId || body.messageId !== `push-${body.packageId}`) return;
    if (body.network !== sellerConfig.network) return;
    const pkg = body.package;
    if (pkg.buyerKeyId !== body.buyerKeyId) return;
    if (pkg.productVersion !== sellerConfig.productVersion) return;
    // A known order, bought for these exact terms, with this credential.
    const record = (await purchases.list()).find((candidate) => candidate.orderId === pkg.orderId);
    if (!record || !record.invoice) return;
    if (record.sellerKeyId !== sellerConfig.sellerKeyId) return;
    if (record.productVersion !== pkg.productVersion) return;
    const invoice = record.invoice;
    if (invoice.orderId !== pkg.orderId || invoice.productVersion !== pkg.productVersion) return;
    if (invoice.amountZat !== sellerConfig.amountZat) return;
    if (invoice.network !== sellerConfig.network) return;
    const buyerKeyId = await credentials.publicKey(record.credentialId);
    if (body.buyerKeyId !== buyerKeyId || invoice.buyerKeyId !== buyerKeyId) return;
    // The package id must be the one derived from the sealed envelope.
    if (await derivePackageId(pkg) !== body.packageId) return;
    // Never overwrite a retained delivery; an identical replay is a no-op.
    const existing = await purchases.getDelivery(pkg.orderId);
    if (existing) return;
    await purchases.saveDelivery(pkg.orderId, { packageId: body.packageId, wireEnvelope: message.wireEnvelope });
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
      throw new Error(mapWakuSellerError(response.code));
    }
    return response;
  }

  return {
    async listen(): Promise<void> {
      await ensureSubscribed();
    },
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
      // Bind the advertised id to the sealed envelope (same rule as pushes),
      // then carry it on the package so the caller acknowledges exactly it.
      if (await derivePackageId(response.package) !== response.packageId) {
        throw new Error('delivery package id does not match its envelope');
      }
      // Persist the original authenticated wire envelope alongside the
      // package before the caller acknowledges it, so a later reload can
      // re-verify the retained signature/bindings instead of trusting a
      // decrypted-only cache.
      await purchases.saveDelivery(orderId, {
        packageId: response.packageId,
        wireEnvelope: message.wireEnvelope,
      });
      return { ...response.package, packageId: response.packageId };
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

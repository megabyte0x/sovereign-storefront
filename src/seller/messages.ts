import type { SellerApplication, BuyerRequest, SellerResponse, WakuSession } from '../contracts/messages.ts';
import type { DeliveryPackage, Invoice, SellerStore } from '../contracts/types.ts';
import type { Network } from '../contracts/live.ts';
import { silentLogger, type OperationalLogger } from '../ops/log.ts';
import type { Payments } from './payments.ts';
import type { createInvoiceIssuer } from './issuance.ts';
import { RateLimitedError } from './orders.ts';

type InvoiceIssuer = ReturnType<typeof createInvoiceIssuer>;

const MESSAGE_TTL_MS = 15 * 60 * 1000;

/**
 * True when the scanner (not the request) is at fault: the live wallet
 * scanner is down/non-200. Matched by name so this layer does not depend on
 * the adapter module.
 */
export function isScannerUnavailable(error: unknown): boolean {
  return error instanceof Error && error.name === 'WalletScannerUnavailableError';
}

export type SellerApplicationDeps = {
  store: SellerStore;
  issuer: InvoiceIssuer;
  payments: Payments;
  sellerKeyId: string;
  network: Network;
  now: () => number;
};

function digestOf(body: BuyerRequest): string {
  // Digest over everything except the header fields that legitimately vary
  // per delivery (issuedAt/expiresAt/messageId itself), so a resend of the
  // exact same logical request within its own message envelope still
  // dedups, while a tampered payload under a replayed messageId is caught.
  const { messageId: _messageId, issuedAt: _issuedAt, expiresAt: _expiresAt, ...rest } = body;
  return JSON.stringify(rest, Object.keys(rest).sort());
}

function invoiceToWire(invoice: Invoice): Invoice & { chain: NonNullable<Invoice['chain']>; accountId: string; paymentUri: string; attribution: NonNullable<Invoice['attribution']> } {
  if (!invoice.chain || !invoice.accountId || !invoice.paymentUri || !invoice.attribution) {
    throw new Error('invoice missing live issuance fields');
  }
  return invoice as ReturnType<typeof invoiceToWire>;
}

type ResponseBody =
  | { type: 'invoice'; invoice: SellerResponse & { type: 'invoice' } extends never ? never : Invoice }
  | { type: 'status'; orderId: string; status: (SellerResponse & { type: 'status' })['status'] }
  | { type: 'delivery'; packageId: string; package: DeliveryPackage }
  | { type: 'acknowledged'; orderId: string; packageId: string }
  | { type: 'error'; code: 'unavailable' | 'invalid' | 'forbidden' | 'not_eligible' | 'rate_limited' };

/**
 * Owns seller business rules (checkout/status/recover/acknowledge) behind a
 * single signed, replay-safe entry point. HTTP or Waku transports both call
 * `handle`; neither can reach `payments`/`issuer`/the store directly, so
 * there is exactly one place these rules can be bypassed from — nowhere.
 *
 * Ownership here is the cryptographically verified Waku `signerKeyId`
 * (== buyerKeyId), not a re-derived possession proof: the transport layer
 * (Task 6's `WakuSession`) already rejects unsigned/unverifiable senders
 * before `handle` ever sees a message, so an `invoice.buyerKeyId === signerKeyId`
 * comparison is the correct and sufficient ownership check at this layer.
 */
export function createSellerApplication(deps: SellerApplicationDeps): SellerApplication {
  function header(request: BuyerRequest, buyerKeyId: string) {
    const now = deps.now();
    return {
      version: 1 as const,
      messageId: `resp-${request.messageId}`,
      inReplyTo: request.messageId,
      sellerKeyId: deps.sellerKeyId,
      buyerKeyId,
      network: deps.network,
      issuedAt: now,
      expiresAt: now + MESSAGE_TTL_MS,
    };
  }
  function respond(request: BuyerRequest, buyerKeyId: string, body: ResponseBody): SellerResponse {
    return { ...header(request, buyerKeyId), ...body } as SellerResponse;
  }
  function errorResponse(request: BuyerRequest, buyerKeyId: string, code: 'unavailable' | 'invalid' | 'forbidden' | 'not_eligible' | 'rate_limited'): SellerResponse {
    return respond(request, buyerKeyId, { type: 'error', code });
  }

  async function assertOwner(orderId: string, buyerKeyId: string): Promise<Invoice | null> {
    const invoice = await deps.store.getInvoice(orderId);
    if (!invoice) return null;
    if (invoice.buyerKeyId !== buyerKeyId) return null;
    return invoice;
  }

  return {
    async handle({ signerKeyId, body }) {
      const now = deps.now();
      // Envelope checks first: expiry, seller/network binding. These reject
      // before anything reaches the durable inbox, so a malformed/foreign
      // envelope never consumes messageId dedup state.
      if (body.expiresAt <= body.issuedAt || body.issuedAt > now || body.expiresAt <= now) {
        return errorResponse(body, signerKeyId, 'invalid');
      }
      if (body.sellerKeyId !== deps.sellerKeyId) {
        return errorResponse(body, signerKeyId, 'invalid');
      }
      if (body.network !== deps.network) {
        return errorResponse(body, signerKeyId, 'invalid');
      }

      const inboxResult = await deps.store.recordMessage({
        signer: signerKeyId,
        messageId: body.messageId,
        operation: body.type,
        payloadDigest: digestOf(body),
        expiresAt: body.expiresAt,
      }).catch((error: unknown) => {
        if (error instanceof Error && /replay payload changed/.test(error.message)) return 'tampered' as const;
        throw error;
      });
      if (inboxResult === 'tampered') {
        return errorResponse(body, signerKeyId, 'invalid');
      }

      switch (body.type) {
        case 'create': {
          try {
            const invoice = await deps.issuer.issue({
              requestId: body.requestId,
              buyerKeyId: signerKeyId,
              productVersion: body.productVersion,
              expectedAmountZat: body.expectedAmountZat,
            });
            return respond(body, signerKeyId, { type: 'invoice', invoice: invoiceToWire(invoice) });
          } catch (error) {
            if (error instanceof RateLimitedError) return errorResponse(body, signerKeyId, 'rate_limited');
            return errorResponse(body, signerKeyId, 'unavailable');
          }
        }
        case 'status': {
          const invoice = await assertOwner(body.orderId, signerKeyId);
          if (!invoice) return errorResponse(body, signerKeyId, 'forbidden');
          // A scanner outage must not suppress the reply: orderStatus maps a
          // failed live snapshot to verification 'unavailable' itself.
          await deps.payments.reconcileFromScanner().catch(() => undefined);
          const status = await deps.payments.orderStatus(body.orderId);
          return respond(body, signerKeyId, { type: 'status', orderId: body.orderId, status });
        }
        case 'recover': {
          const invoice = await assertOwner(body.orderId, signerKeyId);
          if (!invoice) return errorResponse(body, signerKeyId, 'forbidden');
          let decision: Awaited<ReturnType<Payments['authorizeRelease']>>;
          try {
            decision = await deps.payments.authorizeRelease(body.orderId);
          } catch (error) {
            if (isScannerUnavailable(error)) return errorResponse(body, signerKeyId, 'unavailable');
            throw error;
          }
          if (!decision.disclose || !decision.package) {
            return errorResponse(body, signerKeyId, 'not_eligible');
          }
          const pkg: DeliveryPackage = decision.package;
          if (!pkg.packageId) return errorResponse(body, signerKeyId, 'not_eligible');
          return respond(body, signerKeyId, { type: 'delivery', packageId: pkg.packageId, package: pkg });
        }
        case 'acknowledge': {
          const invoice = await assertOwner(body.orderId, signerKeyId);
          if (!invoice) return errorResponse(body, signerKeyId, 'forbidden');
          try {
            await deps.store.acknowledgePackage(body.orderId, body.packageId);
          } catch {
            return errorResponse(body, signerKeyId, 'invalid');
          }
          const ok = await deps.store.compareAndSetDelivery(body.orderId, 'sent_unacknowledged', 'acknowledged', { id: 'ack', height: 0 });
          if (!ok) {
            const current = await deps.store.getDelivery(body.orderId);
            if (current !== 'acknowledged') {
              return errorResponse(body, signerKeyId, 'invalid');
            }
          }
          return respond(body, signerKeyId, { type: 'acknowledged', orderId: body.orderId, packageId: body.packageId });
        }
        default: {
          const exhaustive: never = body;
          throw new Error(`unhandled request type: ${JSON.stringify(exhaustive)}`);
        }
      }
    },
  };
}

export type AttachOptions = {
  logger?: OperationalLogger;
  now?: () => number;
  /** Seller identity/network for the catch-all reply; defaults to the request's own header. */
  sellerKeyId?: string;
  network?: Network;
};

/**
 * Subscribes a `SellerApplication` to a `WakuSession`: decoded requests are
 * dispatched through `application.handle`, and the response is sent back to
 * the verified signer over the same session. Response-side send failures are
 * swallowed (a buyer who never received a response can always retry/recover
 * the same request), matching the recover/status idempotency already built
 * into `handle` itself. Non-request bodies (a `SellerResponse` looping back
 * to the seller's own decoder) are ignored.
 *
 * The Waku SDK invokes this callback as `void callback(message)`, so any
 * rejection here would be unhandled and crash the seller. A catch-all logs a
 * sanitized code (never the message) and replies `unavailable` instead.
 */
export function attachSellerApplication(
  session: WakuSession,
  application: SellerApplication,
  options: AttachOptions = {},
): Promise<() => Promise<void>> {
  const logger = options.logger ?? silentLogger;
  const now = options.now ?? Date.now;
  return session.subscribe(async (message) => {
    try {
      if ('inReplyTo' in message.body || 'buyerKeyId' in message.body) return;
      const request = message.body;
      let response: SellerResponse;
      try {
        response = await application.handle({ signerKeyId: message.signerKeyId, body: request });
      } catch (error) {
        logger.log({ event: 'error', component: 'waku.handler', code: error instanceof Error ? error.name : 'Error', ok: false });
        const at = now();
        response = {
          version: 1,
          messageId: `resp-${request.messageId}`,
          inReplyTo: request.messageId,
          sellerKeyId: options.sellerKeyId ?? request.sellerKeyId,
          buyerKeyId: message.signerKeyId,
          network: options.network ?? request.network,
          issuedAt: at,
          expiresAt: at + MESSAGE_TTL_MS,
          type: 'error',
          code: 'unavailable',
        } as SellerResponse;
      }
      await session.send(message.signerKeyId, response).catch(() => undefined);
    } catch (error) {
      logger.log({ event: 'error', component: 'waku.handler', code: error instanceof Error ? error.name : 'Error', ok: false });
    }
  });
}

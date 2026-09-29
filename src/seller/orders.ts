import { randomBytes } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { assertRequiredString } from '../contracts/validation.ts';

type OrderRow = {
  id: string;
  request_id: string;
  buyer_key_id: string;
  product_version: string;
};

export function createOrder(
  db: DatabaseSync,
  input: { requestId: string; buyerKeyId: string; productVersion: string },
): { id: string } {
  assertRequiredString(input.requestId, 'requestId');
  assertRequiredString(input.buyerKeyId, 'buyerKeyId');
  assertRequiredString(input.productVersion, 'productVersion');

  const existing = db.prepare(
    `SELECT id, request_id, buyer_key_id, product_version
     FROM orders WHERE request_id = ? AND buyer_key_id = ?`,
  ).get(input.requestId, input.buyerKeyId) as OrderRow | undefined;

  if (existing) {
    if (existing.product_version !== input.productVersion) {
      throw new Error('request terms changed');
    }
    return { id: existing.id };
  }

  const id = randomBytes(16).toString('hex');
  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare(
      `INSERT INTO orders (id, request_id, buyer_key_id, product_version, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(id, input.requestId, input.buyerKeyId, input.productVersion, Date.now());
    db.prepare(
      `INSERT INTO delivery_state (order_id, state, send_attempts) VALUES (?, 'locked', 0)`,
    ).run(id);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    const raced = db.prepare(
      `SELECT id, product_version FROM orders WHERE request_id = ? AND buyer_key_id = ?`,
    ).get(input.requestId, input.buyerKeyId) as OrderRow | undefined;
    if (raced) {
      if (raced.product_version !== input.productVersion) {
        throw new Error('request terms changed');
      }
      return { id: raced.id };
    }
    throw error;
  }
  return { id };
}

export function getOrder(db: DatabaseSync, orderId: string): OrderRow {
  assertRequiredString(orderId, 'orderId');
  const row = db.prepare(
    `SELECT id, request_id, buyer_key_id, product_version FROM orders WHERE id = ?`,
  ).get(orderId) as OrderRow | undefined;
  if (!row) {
    throw new Error('order not found');
  }
  return row;
}

const ISSUANCE_WINDOW_MS = 60_000;

/** Thrown when a new invoice would exceed `config.limits`. Replay is not issuance. */
export class RateLimitedError extends Error {
  readonly code = 'rate_limited' as const;
  constructor() {
    super('rate_limited');
    this.name = 'RateLimitedError';
  }
}

/**
 * Caps scanner-receiver issuance. Reads `config.limits.openInvoicesPerBuyer`
 * and `config.limits.invoicesPerMinute` (defaults 3 and 30, parsed by loadConfig).
 * An existing invoice or in-progress draft for the same requestId is a replay,
 * not a new slot. A reserved draft occupies both caps; the per-buyer slot
 * frees when that draft or invoice expires.
 */
export class IssuanceLimiter {
  private readonly deps: {
    db: DatabaseSync;
    config: { limits: { openInvoicesPerBuyer: number; invoicesPerMinute: number } };
    now: () => number;
  };

  constructor(deps: {
    db: DatabaseSync;
    config: { limits: { openInvoicesPerBuyer: number; invoicesPerMinute: number } };
    now: () => number;
  }) {
    this.deps = deps;
    const { openInvoicesPerBuyer, invoicesPerMinute } = deps.config.limits;
    if (!Number.isInteger(openInvoicesPerBuyer) || openInvoicesPerBuyer <= 0
      || !Number.isInteger(invoicesPerMinute) || invoicesPerMinute <= 0) {
      throw new Error('invalid issuance limits');
    }
  }

  assertCanIssue(input: { requestId: string; buyerKeyId: string }): void {
    const replay = this.deps.db.prepare(
      `SELECT 1 AS ok FROM orders o
       WHERE o.request_id = ? AND o.buyer_key_id = ?
         AND (
           EXISTS (SELECT 1 FROM invoices i WHERE i.order_id = o.id)
           OR EXISTS (SELECT 1 FROM invoice_drafts d WHERE d.order_id = o.id)
         )`,
    ).get(input.requestId, input.buyerKeyId);
    if (replay) return;

    const now = this.deps.now();
    const { openInvoicesPerBuyer, invoicesPerMinute } = this.deps.config.limits;
    const open = this.deps.db.prepare(
      `SELECT
         (SELECT COUNT(*) FROM invoices WHERE buyer_key_id = ? AND expires_at > ?)
         + (SELECT COUNT(*) FROM invoice_drafts d
            WHERE d.buyer_key_id = ? AND d.expires_at > ?
              AND NOT EXISTS (SELECT 1 FROM invoices i WHERE i.order_id = d.order_id))
         AS n`,
    ).get(input.buyerKeyId, now, input.buyerKeyId, now) as { n: number };
    if (Number(open.n) >= openInvoicesPerBuyer) throw new RateLimitedError();

    const windowStart = now - ISSUANCE_WINDOW_MS;
    const recent = this.deps.db.prepare(
      `SELECT
         (SELECT COUNT(*) FROM invoices WHERE created_at > ?)
         + (SELECT COUNT(*) FROM invoice_drafts d
            WHERE d.created_at > ?
              AND NOT EXISTS (SELECT 1 FROM invoices i WHERE i.order_id = d.order_id))
         AS n`,
    ).get(windowStart, windowStart) as { n: number };
    if (Number(recent.n) >= invoicesPerMinute) throw new RateLimitedError();
  }
}

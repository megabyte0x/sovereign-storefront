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

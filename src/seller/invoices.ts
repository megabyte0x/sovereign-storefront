import { randomBytes } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import {
  allowNewCheckout,
  type Invoice,
  type InvoiceAttribution,
  type ServiceAvailability,
} from '../contracts/types.ts';
import {
  INVOICE_TTL_MS,
  assertCanonicalAmountZat,
  assertNetwork,
  assertRequiredString,
  assertTestnetShieldedAddress,
} from '../contracts/validation.ts';
import { getOrder } from './orders.ts';

type InvoiceRow = {
  id: string;
  order_id: string;
  product_version: string;
  buyer_key_id: string;
  network: 'test' | 'regtest';
  amount_zat: string;
  destination: string;
  attribution_ref: string;
  expires_at: number;
  attribution_kind: string;
  attribution_data: string;
  payment_uri: string;
  chain_genesis_hash: string;
  consensus_fingerprint: string;
  account_id: string;
};

const INVOICE_COLUMNS = `id, order_id, product_version, buyer_key_id, network, amount_zat,
            destination, attribution_ref, expires_at, attribution_kind, attribution_data,
            payment_uri, chain_genesis_hash, consensus_fingerprint, account_id`;

export const DEFAULT_AMOUNT_ZAT = '100000000';
export const DEFAULT_DESTINATION =
  'uregtest1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq';
const LEGACY_CHAIN_HASH = '0'.repeat(64);

function setting(db: DatabaseSync, key: string, fallback: string): string {
  const row = db.prepare(`SELECT value FROM store_settings WHERE key = ?`).get(key) as
    | { value: string }
    | undefined;
  return row?.value ?? fallback;
}

function rowToInvoice(row: InvoiceRow): Invoice {
  // Rows written before receiver attribution (attribution_kind default 'legacy-memo'
  // with no chain/account/paymentUri recorded) keep the legacy shape; rows committed
  // through commitInvoice() carry the real receiver attribution and live chain/account.
  if (row.attribution_kind === 'receiver' && row.account_id !== '') {
    const attribution = JSON.parse(row.attribution_data) as InvoiceAttribution;
    return {
      id: row.id,
      orderId: row.order_id,
      productVersion: row.product_version,
      buyerKeyId: row.buyer_key_id,
      network: row.network,
      chain: { network: row.network, genesisHash: row.chain_genesis_hash, consensusFingerprint: row.consensus_fingerprint },
      accountId: row.account_id,
      amountZat: row.amount_zat,
      destination: row.destination,
      paymentUri: row.payment_uri,
      attribution,
      expiresAt: Number(row.expires_at),
    };
  }
  return {
    id: row.id,
    orderId: row.order_id,
    productVersion: row.product_version,
    buyerKeyId: row.buyer_key_id,
    network: row.network,
    chain: { network: row.network, genesisHash: LEGACY_CHAIN_HASH, consensusFingerprint: LEGACY_CHAIN_HASH },
    accountId: 'legacy',
    amountZat: row.amount_zat,
    destination: row.destination,
    paymentUri: '',
    attribution: { kind: 'legacy-memo', reference: row.attribution_ref },
    attributionRef: row.attribution_ref,
    expiresAt: Number(row.expires_at),
  };
}

export function readInvoiceByOrder(db: DatabaseSync, orderId: string): Invoice | null {
  const row = db.prepare(
    `SELECT ${INVOICE_COLUMNS} FROM invoices WHERE order_id = ?`,
  ).get(orderId) as InvoiceRow | undefined;
  return row ? rowToInvoice(row) : null;
}

export function listInvoices(db: DatabaseSync): Invoice[] {
  const rows = db.prepare(
    `SELECT ${INVOICE_COLUMNS} FROM invoices ORDER BY created_at ASC`,
  ).all() as InvoiceRow[];
  return rows.map(rowToInvoice);
}

export function getOrCreateInvoice(
  db: DatabaseSync,
  input: {
    orderId: string;
    buyerKeyId: string;
    productVersion: string;
    now: number;
    availability: ServiceAvailability;
  },
): Invoice {
  assertRequiredString(input.orderId, 'orderId');
  assertRequiredString(input.buyerKeyId, 'buyerKeyId');
  assertRequiredString(input.productVersion, 'productVersion');
  if (!Number.isInteger(input.now) || input.now < 0) {
    throw new Error('malformed payload: now');
  }

  const order = getOrder(db, input.orderId);
  if (order.buyer_key_id !== input.buyerKeyId) {
    throw new Error('buyer does not own order');
  }
  if (order.product_version !== input.productVersion) {
    throw new Error('request terms changed');
  }

  const existing = readInvoiceByOrder(db, order.id);
  if (existing) {
    return existing;
  }
  if (!allowNewCheckout(input.availability)) {
    throw new Error('checkout unavailable');
  }

  const product = db.prepare(
    `SELECT amount_zat, network FROM products WHERE version = ?`,
  ).get(input.productVersion) as { amount_zat: string; network: string } | undefined;
  const amountZat = product?.amount_zat ?? setting(db, 'default_amount_zat', DEFAULT_AMOUNT_ZAT);
  assertCanonicalAmountZat(amountZat);
  const network = setting(db, 'network', 'test');
  assertNetwork(network);
  const destination = setting(db, 'destination', DEFAULT_DESTINATION);
  assertTestnetShieldedAddress(destination);
  const ttl = Number(setting(db, 'invoice_ttl_ms', String(INVOICE_TTL_MS)));
  if (!Number.isInteger(ttl) || ttl <= 0) {
    throw new Error('invalid invoice ttl');
  }

  const attributionRef = `attr-${randomBytes(16).toString('hex')}`;
  const invoice: Invoice = {
    id: randomBytes(16).toString('hex'),
    orderId: order.id,
    productVersion: order.product_version,
    buyerKeyId: order.buyer_key_id,
    network,
    chain: { network, genesisHash: LEGACY_CHAIN_HASH, consensusFingerprint: LEGACY_CHAIN_HASH },
    accountId: 'legacy',
    amountZat,
    destination,
    paymentUri: '',
    attribution: { kind: 'legacy-memo', reference: attributionRef },
    attributionRef,
    expiresAt: input.now + ttl,
  };

  db.exec('BEGIN IMMEDIATE');
  try {
    const raced = readInvoiceByOrder(db, order.id);
    if (raced) {
      db.exec('ROLLBACK');
      return raced;
    }
    db.prepare(
      `INSERT INTO invoices (
         id, order_id, product_version, buyer_key_id, network, amount_zat,
         destination, attribution_ref, expires_at, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      invoice.id,
      invoice.orderId,
      invoice.productVersion,
      invoice.buyerKeyId,
      invoice.network,
      invoice.amountZat,
      invoice.destination,
      invoice.attribution?.kind === 'legacy-memo' ? invoice.attribution.reference : invoice.attributionRef ?? 'legacy',
      invoice.expiresAt,
      input.now,
    );
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    const raced = readInvoiceByOrder(db, order.id);
    if (raced) return raced;
    throw error;
  }
  return invoice;
}

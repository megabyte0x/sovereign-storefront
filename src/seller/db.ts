import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import type {
  ChainRevision,
  DeliveryPackage,
  DeliveryState,
  ExceptionRecord,
  InvoiceSettlement,
  Observation,
  ScanCheckpoint,
  SellerStore,
  ServiceAvailability,
} from '../contracts/types.ts';
import {
  INVOICE_TTL_MS,
  assertCanonicalAmountZat,
  assertDeliveryState,
  assertExceptionCode,
  assertPaymentState,
  assertRequiredString,
} from '../contracts/validation.ts';
import { DEFAULT_AMOUNT_ZAT, DEFAULT_DESTINATION, getOrCreateInvoice, readInvoiceByOrder } from './invoices.ts';
import { createOrder, getOrder } from './orders.ts';

const SCHEMA = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'schema.sql'), 'utf8');

type ObservationRow = {
  output_id: string;
  invoice_id: string | null;
  amount_zat: string;
  confirmations: number;
  canonical: number;
  received_at: number;
  revision_id: string;
  revision_height: number;
};

function withTx<T>(db: DatabaseSync, fn: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // already rolled back
    }
    throw error;
  }
}

function seed(db: DatabaseSync): void {
  const insert = db.prepare(`INSERT OR IGNORE INTO store_settings (key, value) VALUES (?, ?)`);
  insert.run('network', 'test');
  insert.run('default_amount_zat', DEFAULT_AMOUNT_ZAT);
  insert.run('destination', DEFAULT_DESTINATION);
  insert.run('invoice_ttl_ms', String(INVOICE_TTL_MS));
}

function persistObservation(db: DatabaseSync, observation: Observation): void {
  assertRequiredString(observation.outputId, 'outputId');
  assertCanonicalAmountZat(observation.amountZat);
  if (!Number.isInteger(observation.confirmations) || observation.confirmations < 0) {
    throw new Error('malformed payload: confirmations');
  }
  if (!Number.isInteger(observation.receivedAt) || observation.receivedAt < 0) {
    throw new Error('malformed payload: receivedAt');
  }
  assertRequiredString(observation.revision.id, 'revision.id');
  if (!Number.isInteger(observation.revision.height) || observation.revision.height < 0) {
    throw new Error('malformed payload: revision.height');
  }

  const existing = db.prepare(
    `SELECT output_id, invoice_id, revision_height FROM observations WHERE output_id = ?`,
  ).get(observation.outputId) as Pick<ObservationRow, 'output_id' | 'invoice_id' | 'revision_height'> | undefined;

  if (
    existing?.invoice_id &&
    observation.invoiceId &&
    existing.invoice_id !== observation.invoiceId
  ) {
    throw new Error('output already claimed');
  }

  if (existing && observation.revision.height < existing.revision_height) {
    return;
  }

  db.prepare(
    `INSERT INTO observations (
       output_id, invoice_id, amount_zat, confirmations, canonical,
       received_at, revision_id, revision_height
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(output_id) DO UPDATE SET
       invoice_id = COALESCE(observations.invoice_id, excluded.invoice_id),
       amount_zat = excluded.amount_zat,
       confirmations = excluded.confirmations,
       canonical = excluded.canonical,
       received_at = excluded.received_at,
       revision_id = excluded.revision_id,
       revision_height = excluded.revision_height`,
  ).run(
    observation.outputId,
    observation.invoiceId,
    observation.amountZat,
    observation.confirmations,
    observation.canonical ? 1 : 0,
    observation.receivedAt,
    observation.revision.id,
    observation.revision.height,
  );
}

function persistSettlement(db: DatabaseSync, settlement: InvoiceSettlement, observations: Observation[]): void {
  assertPaymentState(settlement.payment);
  if (!Array.isArray(settlement.backingOutputIds) || !Array.isArray(settlement.exceptions)) {
    throw new Error('malformed payload: settlement');
  }
  const invoiceIds = new Set<string>();
  for (const outputId of settlement.backingOutputIds) {
    const matched = observations.find((item) => item.outputId === outputId)?.invoiceId;
    if (matched) invoiceIds.add(matched);
  }
  const invoiceId = invoiceIds.size === 1 ? [...invoiceIds][0] : null;
  db.prepare(
    `INSERT INTO invoice_settlements (
       invoice_id, payment_state, release_eligible, backing_output_ids, created_at
     ) VALUES (?, ?, ?, ?, ?)`,
  ).run(
    invoiceId,
    settlement.payment,
    settlement.releaseEligible ? 1 : 0,
    JSON.stringify(settlement.backingOutputIds),
    Date.now(),
  );
  for (const record of settlement.exceptions) {
    persistException(db, record);
  }
}

function persistException(db: DatabaseSync, record: ExceptionRecord): void {
  assertRequiredString(record.id, 'exception.id');
  assertRequiredString(record.orderId, 'exception.orderId');
  assertExceptionCode(record.code);
  getOrder(db, record.orderId);
  db.prepare(
    `INSERT INTO exceptions (id, order_id, code, created_at, detail)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(id) DO NOTHING`,
  ).run(record.id, record.orderId, record.code, record.createdAt, record.detail);
}

function persistCheckpoint(db: DatabaseSync, checkpoint: ScanCheckpoint): void {
  assertRequiredString(checkpoint.revision.id, 'checkpoint.revision.id');
  if (!Number.isInteger(checkpoint.revision.height) || checkpoint.revision.height < 0) {
    throw new Error('malformed payload: checkpoint.revision.height');
  }
  db.prepare(
    `INSERT INTO scan_checkpoints (id, revision_id, revision_height)
     VALUES (1, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       revision_id = excluded.revision_id,
       revision_height = excluded.revision_height`,
  ).run(checkpoint.revision.id, checkpoint.revision.height);
}

export async function openStore(
  path: string,
  options: { crashAfterObservations?: () => void } = {},
): Promise<SellerStore> {
  assertRequiredString(path, 'path');
  mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA journal_mode = WAL');
  db.exec(SCHEMA);
  seed(db);

  const store: SellerStore = {
    async createOrder(input) {
      return createOrder(db, input);
    },
    async getOrCreateInvoice(input: {
      orderId: string;
      buyerKeyId: string;
      productVersion: string;
      now: number;
      availability: ServiceAvailability;
    }) {
      return getOrCreateInvoice(db, input);
    },
    async getInvoice(orderId) {
      return readInvoiceByOrder(db, orderId);
    },
    async getCheckpoint() {
      const row = db.prepare(
        `SELECT revision_id, revision_height FROM scan_checkpoints WHERE id = 1`,
      ).get() as { revision_id: string; revision_height: number } | undefined;
      if (!row) return null;
      return { revision: { id: row.revision_id, height: Number(row.revision_height) } };
    },
    async commitReconciliation(input) {
      withTx(db, () => {
        for (const observation of input.observations) {
          persistObservation(db, observation);
        }
        options.crashAfterObservations?.();
        for (const settlement of input.settlements) {
          persistSettlement(db, settlement, input.observations);
        }
        persistCheckpoint(db, input.checkpoint);
      });
    },
    async savePreparedPackage(pkg: DeliveryPackage) {
      assertRequiredString(pkg.orderId, 'orderId');
      assertRequiredString(pkg.productVersion, 'productVersion');
      assertRequiredString(pkg.buyerKeyId, 'buyerKeyId');
      if (!(pkg.encryptedEnvelope instanceof Uint8Array) || pkg.encryptedEnvelope.byteLength === 0) {
        throw new Error('malformed payload: encryptedEnvelope');
      }
      const order = getOrder(db, pkg.orderId);
      if (order.buyer_key_id !== pkg.buyerKeyId || order.product_version !== pkg.productVersion) {
        throw new Error('request terms changed');
      }
      try {
        db.prepare(
          `INSERT INTO delivery_packages (order_id, product_version, buyer_key_id, encrypted_envelope)
           VALUES (?, ?, ?, ?)`,
        ).run(pkg.orderId, pkg.productVersion, pkg.buyerKeyId, pkg.encryptedEnvelope);
      } catch (error) {
        const exists = db.prepare(`SELECT order_id FROM delivery_packages WHERE order_id = ?`).get(pkg.orderId);
        if (exists) {
          throw new Error('prepared package already exists');
        }
        throw error;
      }
    },
    async getPreparedPackage(orderId) {
      const row = db.prepare(
        `SELECT order_id, product_version, buyer_key_id, encrypted_envelope
         FROM delivery_packages WHERE order_id = ?`,
      ).get(orderId) as {
        order_id: string;
        product_version: string;
        buyer_key_id: string;
        encrypted_envelope: Uint8Array;
      } | undefined;
      if (!row) return null;
      return {
        orderId: row.order_id,
        productVersion: row.product_version,
        buyerKeyId: row.buyer_key_id,
        encryptedEnvelope: row.encrypted_envelope,
      };
    },
    async getDelivery(orderId) {
      const row = db.prepare(`SELECT state FROM delivery_state WHERE order_id = ?`).get(orderId) as
        | { state: DeliveryState }
        | undefined;
      if (!row) {
        throw new Error('delivery state not found');
      }
      return row.state;
    },
    async compareAndSetDelivery(orderId, expected, next, revision: ChainRevision) {
      assertDeliveryState(expected);
      assertDeliveryState(next);
      assertRequiredString(revision.id, 'revision.id');
      const result = db.prepare(
        `UPDATE delivery_state
         SET state = ?, revision_id = ?, revision_height = ?
         WHERE order_id = ? AND state = ?`,
      ).run(next, revision.id, revision.height, orderId, expected);
      return result.changes === 1;
    },
    async recordSendAttempt(orderId) {
      const result = db.prepare(
        `UPDATE delivery_state SET send_attempts = send_attempts + 1 WHERE order_id = ?`,
      ).run(orderId);
      if (result.changes !== 1) {
        throw new Error('delivery state not found');
      }
    },
    async recordException(record) {
      withTx(db, () => persistException(db, record));
    },
    async listExceptions(orderId) {
      const rows = db.prepare(
        `SELECT id, order_id, code, created_at, detail FROM exceptions WHERE order_id = ? ORDER BY created_at ASC`,
      ).all(orderId) as Array<{
        id: string;
        order_id: string;
        code: ExceptionRecord['code'];
        created_at: number;
        detail: string;
      }>;
      return rows.map((row) => ({
        id: row.id,
        orderId: row.order_id,
        code: row.code,
        createdAt: Number(row.created_at),
        detail: row.detail,
      }));
    },
    async close() {
      db.close();
    },
  };
  return store;
}

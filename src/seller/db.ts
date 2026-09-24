import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import type {
  ChainRevision,
  DeliveryAttempt,
  Disclosure,
  DeliveryPackage,
  DeliveryState,
  ExceptionRecord,
  Invoice,
  InvoiceDraft,
  InvoiceSettlement,
  Observation,
  ReconciledCheckpoint,
  ScanCheckpoint,
  SellerStore,
  ServiceAvailability,
} from '../contracts/types.ts';
import type { ReceiverAllocation, ScanSnapshot } from '../contracts/live.ts';
import { validateAllocation, validateSnapshot } from '../contracts/live-validation.ts';
import {
  INVOICE_TTL_MS,
  assertCanonicalAmountZat,
  assertDeliveryState,
  assertExceptionCode,
  assertPaymentState,
  assertRequiredString,
} from '../contracts/validation.ts';
import { DEFAULT_AMOUNT_ZAT, DEFAULT_DESTINATION, getOrCreateInvoice, listInvoices, readInvoiceByOrder } from './invoices.ts';
import { createOrder, getOrder } from './orders.ts';
import { migrateStore } from './migrations.ts';

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
  source_id: string;
  generation: string;
  chain_network: string;
  txid: string;
  pool: string;
  output_index: number;
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

function immutablePackageId(pkg: DeliveryPackage): string {
  const derived = createHash('sha256')
    .update(pkg.orderId).update('\0').update(pkg.productVersion).update('\0').update(pkg.buyerKeyId).update('\0')
    .update(pkg.encryptedEnvelope).digest('hex');
  if (pkg.packageId !== undefined && pkg.packageId !== derived) throw new Error('package identity does not match envelope');
  return derived;
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

  db.prepare(
    `INSERT INTO observations (
       output_id, invoice_id, amount_zat, confirmations, canonical,
       received_at, revision_id, revision_height, source_id, generation,
       chain_network, txid, pool, output_index
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(output_id) DO UPDATE SET
       invoice_id = COALESCE(observations.invoice_id, excluded.invoice_id),
       amount_zat = excluded.amount_zat,
       confirmations = excluded.confirmations,
       canonical = excluded.canonical,
       received_at = excluded.received_at,
       revision_id = excluded.revision_id,
       revision_height = excluded.revision_height,
       source_id = excluded.source_id,
       generation = excluded.generation,
       chain_network = excluded.chain_network,
       txid = excluded.txid,
       pool = excluded.pool,
       output_index = excluded.output_index`,
  ).run(
    observation.outputId,
    observation.invoiceId,
    observation.amountZat,
    observation.confirmations,
    observation.canonical ? 1 : 0,
    observation.receivedAt,
    observation.revision.id,
    observation.revision.height,
    observation.sourceId ?? 'legacy',
    observation.generation ?? '0',
    observation.chainNetwork ?? '',
    observation.txid ?? '',
    observation.pool ?? '',
    observation.outputIndex ?? -1,
  );
}

function hydrateSnapshotObservations(snapshot: ScanSnapshot, supplied: Observation[]): Observation[] {
  const suppliedByOutput = new Map(supplied.map((observation) => [observation.outputId, observation]));
  for (const observation of supplied) {
    if (!snapshot.receipts.some((receipt) => receipt.outputId === observation.outputId)) {
      throw new Error('observation is not in authoritative snapshot');
    }
  }
  return snapshot.receipts.map((receipt) => {
    const prior = suppliedByOutput.get(receipt.outputId);
    if (prior?.sourceId !== undefined && prior.sourceId !== snapshot.sourceId) throw new Error('observation source mismatch');
    if (prior?.generation !== undefined && prior.generation !== snapshot.generation) throw new Error('observation generation mismatch');
    return {
      outputId: receipt.outputId,
      invoiceId: prior?.invoiceId ?? null,
      amountZat: receipt.amountZat,
      confirmations: receipt.canonical && receipt.mined ? Math.max(0, snapshot.tip.height - receipt.mined.height + 1) : 0,
      canonical: receipt.canonical,
      receivedAt: receipt.firstSeenAt,
      revision: { id: snapshot.tip.hash, height: snapshot.tip.height },
      sourceId: snapshot.sourceId,
      generation: snapshot.generation,
      chainNetwork: snapshot.chain.network,
      txid: receipt.txid,
      pool: receipt.pool,
      outputIndex: receipt.outputIndex,
    };
  });
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
  const inferredInvoiceId = invoiceIds.size === 1 ? [...invoiceIds][0] : null;
  const invoiceId = settlement.invoiceId ?? inferredInvoiceId;
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
       revision_height = excluded.revision_height
     WHERE excluded.revision_height >= scan_checkpoints.revision_height`,
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
  migrateStore(db);
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
    async listInvoices() {
      return listInvoices(db);
    },
    async listObservations() {
      const rows = db.prepare(
        `SELECT output_id, invoice_id, amount_zat, confirmations, canonical,
                received_at, revision_id, revision_height, source_id, generation,
                chain_network, txid, pool, output_index
         FROM observations`,
      ).all() as ObservationRow[];
      return rows.map((row) => ({
        outputId: row.output_id,
        invoiceId: row.invoice_id,
        amountZat: row.amount_zat,
        confirmations: Number(row.confirmations),
        canonical: row.canonical === 1,
        receivedAt: Number(row.received_at),
        revision: { id: row.revision_id, height: Number(row.revision_height) },
        sourceId: row.source_id,
        generation: row.generation,
        chainNetwork: row.chain_network === 'test' || row.chain_network === 'regtest' ? row.chain_network : undefined,
        txid: row.txid || undefined,
        pool: row.pool || undefined,
        outputIndex: row.output_index >= 0 ? Number(row.output_index) : undefined,
      }));
    },
    async getCheckpoint() {
      const row = db.prepare(
        `SELECT revision_id, revision_height FROM scan_checkpoints WHERE id = 1`,
      ).get() as { revision_id: string; revision_height: number } | undefined;
      if (!row) return null;
      return { revision: { id: row.revision_id, height: Number(row.revision_height) } };
    },
    async getReconciledCheckpoint(): Promise<ReconciledCheckpoint | null> {
      const row = db.prepare(
        `SELECT source_id, generation, tip_height, tip_hash, checked_at FROM scan_snapshots WHERE id = 1`,
      ).get() as { source_id: string; generation: string; tip_height: number; tip_hash: string; checked_at: number } | undefined;
      if (!row) return null;
      return {
        sourceId: row.source_id,
        generation: row.generation,
        tip: { height: Number(row.tip_height), hash: row.tip_hash },
        checkedAt: Number(row.checked_at),
      };
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
    async reserveInvoice(input): Promise<InvoiceDraft> {
      assertRequiredString(input.orderId, 'orderId');
      assertRequiredString(input.buyerKeyId, 'buyerKeyId');
      assertRequiredString(input.productVersion, 'productVersion');
      assertRequiredString(input.accountId, 'accountId');
      if (!Number.isInteger(input.now) || !Number.isInteger(input.ttlMs) || input.now < 0 || input.ttlMs <= 0) {
        throw new Error('malformed payload: invoice draft clock');
      }
      const chain = input.chain;
      if ((chain.network !== 'test' && chain.network !== 'regtest') || !/^[0-9a-f]{64}$/i.test(chain.genesisHash) || !/^[0-9a-f]{64}$/i.test(chain.consensusFingerprint)) {
        throw new Error('malformed payload: invoice draft chain');
      }
      const existing = db.prepare(`SELECT * FROM invoice_drafts WHERE order_id = ?`).get(input.orderId) as Record<string, unknown> | undefined;
      const rowToDraft = (row: Record<string, unknown>): InvoiceDraft => ({
        id: String(row.id), orderId: String(row.order_id), productVersion: String(row.product_version), buyerKeyId: String(row.buyer_key_id),
        chain: { network: String(row.network) as InvoiceDraft['chain']['network'], genesisHash: String(row.genesis_hash), consensusFingerprint: String(row.consensus_fingerprint) },
        accountId: String(row.account_id), amountZat: String(row.amount_zat), createdAt: Number(row.created_at), expiresAt: Number(row.expires_at),
      });
      if (existing) {
        const draft = rowToDraft(existing);
        if (draft.buyerKeyId !== input.buyerKeyId || draft.productVersion !== input.productVersion || draft.accountId !== input.accountId
          || draft.chain.network !== chain.network || draft.chain.genesisHash !== chain.genesisHash || draft.chain.consensusFingerprint !== chain.consensusFingerprint) {
          throw new Error('request terms changed');
        }
        return draft;
      }
      const order = getOrder(db, input.orderId);
      if (order.buyer_key_id !== input.buyerKeyId || order.product_version !== input.productVersion) throw new Error('request terms changed');
      const product = db.prepare(`SELECT amount_zat, network, published FROM products WHERE version = ?`).get(input.productVersion) as
        | { amount_zat: string; network: 'test' | 'regtest'; published: number } | undefined;
      if (!product || product.published !== 1 || product.network !== chain.network) throw new Error('checkout unavailable');
      assertCanonicalAmountZat(product.amount_zat);
      const draft: InvoiceDraft = {
        id: `${input.orderId}:draft`, orderId: input.orderId, productVersion: input.productVersion, buyerKeyId: input.buyerKeyId,
        chain: { ...chain }, accountId: input.accountId, amountZat: product.amount_zat, createdAt: input.now, expiresAt: input.now + input.ttlMs,
      };
      withTx(db, () => db.prepare(`INSERT INTO invoice_drafts (
        id, order_id, product_version, buyer_key_id, network, genesis_hash, consensus_fingerprint, account_id, amount_zat, created_at, expires_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(draft.id, draft.orderId, draft.productVersion, draft.buyerKeyId, draft.chain.network, draft.chain.genesisHash,
          draft.chain.consensusFingerprint, draft.accountId, draft.amountZat, draft.createdAt, draft.expiresAt));
      return draft;
    },
    async getInvoiceDraft(orderId): Promise<InvoiceDraft | null> {
      const row = db.prepare(`SELECT * FROM invoice_drafts WHERE order_id = ?`).get(orderId) as Record<string, unknown> | undefined;
      if (!row) return null;
      return {
        id: String(row.id), orderId: String(row.order_id), productVersion: String(row.product_version), buyerKeyId: String(row.buyer_key_id),
        chain: { network: String(row.network) as InvoiceDraft['chain']['network'], genesisHash: String(row.genesis_hash), consensusFingerprint: String(row.consensus_fingerprint) },
        accountId: String(row.account_id), amountZat: String(row.amount_zat), createdAt: Number(row.created_at), expiresAt: Number(row.expires_at),
      };
    },
    async commitInvoice(draftId, rawAllocation): Promise<Invoice> {
      const allocation = validateAllocation(rawAllocation);
      const draft = db.prepare(`SELECT * FROM invoice_drafts WHERE id = ?`).get(draftId) as Record<string, unknown> | undefined;
      if (!draft) throw new Error('invoice draft not found');
      const chain = { network: String(draft.network), genesisHash: String(draft.genesis_hash), consensusFingerprint: String(draft.consensus_fingerprint) };
      if (allocation.allocationId !== draftId || allocation.accountId !== draft.account_id || allocation.amountZat !== draft.amount_zat
        || allocation.expiresAt !== Number(draft.expires_at) || allocation.chain.network !== chain.network
        || allocation.chain.genesisHash !== chain.genesisHash || allocation.chain.consensusFingerprint !== chain.consensusFingerprint) {
        throw new Error('allocation does not match immutable draft');
      }
      const existing = readInvoiceByOrder(db, String(draft.order_id));
      if (existing) return existing;
      const invoice: Invoice = {
        id: draftId, orderId: String(draft.order_id), productVersion: String(draft.product_version), buyerKeyId: String(draft.buyer_key_id),
        network: allocation.chain.network, chain: allocation.chain, accountId: allocation.accountId, amountZat: allocation.amountZat,
        destination: allocation.destination, paymentUri: allocation.paymentUri,
        attribution: { kind: 'receiver', allocationId: allocation.allocationId, receiver: allocation.receiver }, expiresAt: allocation.expiresAt,
      };
      withTx(db, () => {
        db.prepare(`INSERT INTO receiver_allocations (
          allocation_id, draft_id, network, genesis_hash, consensus_fingerprint, account_id, pool, scope, diversifier_index, receiver_hex,
          destination, payment_uri, amount_zat, expires_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
          .run(allocation.allocationId, draftId, allocation.chain.network, allocation.chain.genesisHash, allocation.chain.consensusFingerprint,
            allocation.accountId, allocation.receiver.pool, allocation.receiver.scope, allocation.receiver.diversifierIndex,
            allocation.receiver.receiverHex, allocation.destination, allocation.paymentUri, allocation.amountZat, allocation.expiresAt);
        db.prepare(`INSERT INTO invoices (
          id, order_id, product_version, buyer_key_id, network, amount_zat, destination, attribution_ref, expires_at, created_at,
          attribution_kind, attribution_data, payment_uri, chain_genesis_hash, consensus_fingerprint, account_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'receiver', ?, ?, ?, ?, ?)`)
          .run(invoice.id, invoice.orderId, invoice.productVersion, invoice.buyerKeyId, invoice.network, invoice.amountZat, invoice.destination,
            allocation.allocationId, invoice.expiresAt, Date.now(), JSON.stringify(invoice.attribution), allocation.paymentUri,
            allocation.chain.genesisHash, allocation.chain.consensusFingerprint, allocation.accountId);
      });
      return invoice;
    },
    async getScanSnapshot(): Promise<ScanSnapshot | null> {
      const row = db.prepare(`SELECT snapshot_json FROM scan_snapshots WHERE id = 1`).get() as { snapshot_json: string } | undefined;
      if (!row) return null;
      return validateSnapshot(JSON.parse(row.snapshot_json));
    },
    async commitSnapshot(input): Promise<void> {
      const snapshot = validateSnapshot(input.snapshot);
      withTx(db, () => {
        const prior = db.prepare(`SELECT source_id, generation, snapshot_json FROM scan_snapshots WHERE id = 1`).get() as
          | { source_id: string; generation: string; snapshot_json: string } | undefined;
        const encoded = JSON.stringify(snapshot);
        if (prior) {
          if (prior.source_id !== snapshot.sourceId) throw new Error('snapshot source changed');
          const previous = validateSnapshot(JSON.parse(prior.snapshot_json));
          if (previous.accountId !== snapshot.accountId || previous.chain.network !== snapshot.chain.network
            || previous.chain.genesisHash !== snapshot.chain.genesisHash
            || previous.chain.consensusFingerprint !== snapshot.chain.consensusFingerprint) {
            throw new Error('snapshot chain/account changed');
          }
          const priorGeneration = BigInt(prior.generation);
          const nextGeneration = BigInt(snapshot.generation);
          if (nextGeneration < priorGeneration) throw new Error('snapshot generation moved backwards');
          if (nextGeneration === priorGeneration && prior.snapshot_json !== encoded) throw new Error('snapshot generation evidence changed');
          if (nextGeneration === priorGeneration) return;
        }
        const observations = hydrateSnapshotObservations(snapshot, input.observations);
        db.prepare(`DELETE FROM observations WHERE source_id = ?`).run(snapshot.sourceId);
        for (const observation of observations) persistObservation(db, observation);
        options.crashAfterObservations?.();
        for (const settlement of input.settlements) persistSettlement(db, settlement, observations);
        db.prepare(`INSERT INTO scan_snapshots (
          id, source_id, generation, network, genesis_hash, consensus_fingerprint, account_id, snapshot_json, tip_height, tip_hash, checked_at
        ) VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET source_id=excluded.source_id, generation=excluded.generation, network=excluded.network,
          genesis_hash=excluded.genesis_hash, consensus_fingerprint=excluded.consensus_fingerprint, account_id=excluded.account_id,
          snapshot_json=excluded.snapshot_json, tip_height=excluded.tip_height, tip_hash=excluded.tip_hash, checked_at=excluded.checked_at`)
          .run(snapshot.sourceId, snapshot.generation, snapshot.chain.network, snapshot.chain.genesisHash, snapshot.chain.consensusFingerprint,
            snapshot.accountId, encoded, snapshot.tip.height, snapshot.tip.hash, snapshot.checkedAt);
      });
    },
    async beginDeliveryAttempt(input): Promise<DeliveryAttempt> {
      const attempt: DeliveryAttempt = { ...input, attemptId: `${input.orderId}:${input.packageId}:${randomUUID()}` };
      db.prepare(`INSERT INTO delivery_attempts(attempt_id, order_id, package_id, reason, checkpoint_json, created_at)
        VALUES (?, ?, ?, ?, ?, ?)`).run(attempt.attemptId, attempt.orderId, attempt.packageId, attempt.reason,
          attempt.checkpoint ? JSON.stringify(attempt.checkpoint) : null, Date.now());
      return attempt;
    },
    async finishDeliveryAttempt(attemptId, outcome): Promise<void> {
      const result = db.prepare(`UPDATE delivery_attempts SET outcome = ?, finished_at = ? WHERE attempt_id = ? AND outcome IS NULL`)
        .run(outcome, Date.now(), attemptId);
      if (result.changes !== 1) throw new Error('delivery attempt not found or already finished');
    },
    async getDisclosure(orderId): Promise<Disclosure> {
      const acknowledged = db.prepare(`SELECT 1 FROM delivery_state WHERE order_id = ? AND state = 'acknowledged'`).get(orderId);
      if (acknowledged) return 'buyer-acknowledged';
      const accepted = db.prepare(`SELECT 1 FROM delivery_attempts WHERE order_id = ? AND outcome = 'transport-accepted' LIMIT 1`).get(orderId);
      if (accepted) return 'transport-accepted';
      const attempted = db.prepare(`SELECT 1 FROM delivery_attempts WHERE order_id = ? LIMIT 1`).get(orderId);
      return attempted ? 'attempted' : 'none';
    },
    async acknowledgePackage(orderId, packageId): Promise<void> {
      assertRequiredString(packageId, 'packageId');
      const prepared = db.prepare(`SELECT package_id FROM delivery_packages WHERE order_id = ?`).get(orderId) as { package_id: string } | undefined;
      if (!prepared) throw new Error('prepared package not found');
      if (prepared.package_id !== packageId) throw new Error('package identity does not match order');
      const result = db.prepare(`UPDATE delivery_state SET state = 'acknowledged' WHERE order_id = ? AND state <> 'acknowledged'`).run(orderId);
      if (result.changes === 0) {
        const state = db.prepare(`SELECT state FROM delivery_state WHERE order_id = ?`).get(orderId) as { state: DeliveryState } | undefined;
        if (!state || state.state !== 'acknowledged') throw new Error('delivery state not found');
      }
    },
    async recordMessage(input): Promise<'new' | 'duplicate'> {
      const existing = db.prepare(`SELECT payload_digest, operation FROM message_inbox WHERE signer = ? AND message_id = ?`)
        .get(input.signer, input.messageId) as { payload_digest: string; operation: string } | undefined;
      if (existing) {
        if (existing.payload_digest !== input.payloadDigest || existing.operation !== input.operation) throw new Error('message replay payload changed');
        return 'duplicate';
      }
      db.prepare(`INSERT INTO message_inbox(signer, message_id, operation, payload_digest, expires_at, created_at)
        VALUES (?, ?, ?, ?, ?, ?)`).run(input.signer, input.messageId, input.operation, input.payloadDigest, input.expiresAt, Date.now());
      return 'new';
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
      const packageId = immutablePackageId(pkg);
      try {
        db.prepare(
          `INSERT INTO delivery_packages (order_id, product_version, buyer_key_id, encrypted_envelope, package_id)
           VALUES (?, ?, ?, ?, ?)`,
        ).run(pkg.orderId, pkg.productVersion, pkg.buyerKeyId, pkg.encryptedEnvelope, packageId);
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
        `SELECT order_id, product_version, buyer_key_id, encrypted_envelope, package_id
         FROM delivery_packages WHERE order_id = ?`,
      ).get(orderId) as {
        order_id: string;
        product_version: string;
        buyer_key_id: string;
        encrypted_envelope: Uint8Array;
        package_id: string;
      } | undefined;
      if (!row) return null;
      const packageId = row.package_id || immutablePackageId({
        orderId: row.order_id, productVersion: row.product_version, buyerKeyId: row.buyer_key_id, encryptedEnvelope: row.encrypted_envelope,
      });
      if (!row.package_id) db.prepare(`UPDATE delivery_packages SET package_id = ? WHERE order_id = ?`).run(packageId, row.order_id);
      const result: DeliveryPackage = {
        orderId: row.order_id,
        productVersion: row.product_version,
        buyerKeyId: row.buyer_key_id,
        encryptedEnvelope: row.encrypted_envelope,
      };
      // Preserve the legacy package object shape while exposing the persisted
      // identity to acknowledgement callers without copying envelope bytes.
      Object.defineProperty(result, 'packageId', { value: packageId, enumerable: false });
      return result;
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

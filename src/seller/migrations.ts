import type { DatabaseSync } from 'node:sqlite';

const LIVE_SCHEMA_VERSION = 2;

function tableColumns(db: DatabaseSync, table: string): Set<string> {
  return new Set((db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((row) => row.name));
}

function addColumn(db: DatabaseSync, table: string, column: string, definition: string): void {
  if (!tableColumns(db, table).has(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

function hasTable(db: DatabaseSync, table: string): boolean {
  return Boolean(db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`).get(table));
}

/**
 * Applies only additive v1→v2 changes. Existing invoice terms remain immutable;
 * old memo attribution is explicitly labelled and no network is inferred.
 */
export function migrateStore(db: DatabaseSync): void {
  db.exec('BEGIN IMMEDIATE');
  try {
    db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL
    )`);
    // Migration markers alone are not authoritative: a prior fresh-store path
    // recorded v2 before adding its invoice fields. Repair the final shape on
    // every open, then retain the version marker for historical compatibility.
    const invoiceColumns = hasTable(db, 'invoices') ? tableColumns(db, 'invoices') : new Set<string>();
    const invoiceNeedsV2 = hasTable(db, 'invoices') && !invoiceColumns.has('attribution_kind');
    const hasLegacyRows = invoiceNeedsV2 && Boolean(db.prepare('SELECT 1 FROM invoices LIMIT 1').get());
    if (hasLegacyRows) {
      const settings = hasTable(db, 'store_settings')
        ? db.prepare(`SELECT value FROM store_settings WHERE key = 'network'`).get() as { value: string } | undefined
        : undefined;
      if (!settings || (settings.value !== 'test' && settings.value !== 'regtest')) {
        throw new Error('ambiguous v1 invoice network; live startup refused');
      }
    }
    if (hasTable(db, 'invoices')) {
      addColumn(db, 'invoices', 'attribution_kind', "TEXT NOT NULL DEFAULT 'legacy-memo'");
      addColumn(db, 'invoices', 'attribution_data', "TEXT NOT NULL DEFAULT '{}'");
      addColumn(db, 'invoices', 'payment_uri', "TEXT NOT NULL DEFAULT ''");
      addColumn(db, 'invoices', 'chain_genesis_hash', "TEXT NOT NULL DEFAULT ''");
      addColumn(db, 'invoices', 'consensus_fingerprint', "TEXT NOT NULL DEFAULT ''");
      addColumn(db, 'invoices', 'account_id', "TEXT NOT NULL DEFAULT ''");
      if (hasLegacyRows) {
        db.prepare(`UPDATE invoices
          SET attribution_kind = 'legacy-memo', attribution_data = json_object('reference', attribution_ref)
          WHERE attribution_kind IS NULL OR attribution_kind = ''`).run();
      }
    }

    if (hasTable(db, 'observations')) {
      addColumn(db, 'observations', 'source_id', "TEXT NOT NULL DEFAULT 'legacy'");
      addColumn(db, 'observations', 'generation', "TEXT NOT NULL DEFAULT '0'");
      addColumn(db, 'observations', 'chain_network', "TEXT NOT NULL DEFAULT ''");
      addColumn(db, 'observations', 'txid', "TEXT NOT NULL DEFAULT ''");
      addColumn(db, 'observations', 'pool', "TEXT NOT NULL DEFAULT ''");
      addColumn(db, 'observations', 'output_index', 'INTEGER NOT NULL DEFAULT -1');
      db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS observations_receipt_identity
        ON observations(chain_network, txid, pool, output_index) WHERE txid <> ''`);
    }
    if (hasTable(db, 'invoice_settlements')) addColumn(db, 'invoice_settlements', 'snapshot_generation', "TEXT");
    if (hasTable(db, 'delivery_packages')) addColumn(db, 'delivery_packages', 'package_id', "TEXT");

    db.exec(`CREATE TABLE IF NOT EXISTS invoice_drafts (
      id TEXT PRIMARY KEY, order_id TEXT NOT NULL UNIQUE REFERENCES orders(id),
      product_version TEXT NOT NULL, buyer_key_id TEXT NOT NULL,
      network TEXT NOT NULL CHECK(network IN ('test', 'regtest')),
      genesis_hash TEXT NOT NULL, consensus_fingerprint TEXT NOT NULL, account_id TEXT NOT NULL,
      amount_zat TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS receiver_allocations (
      allocation_id TEXT PRIMARY KEY, draft_id TEXT NOT NULL UNIQUE REFERENCES invoice_drafts(id),
      network TEXT NOT NULL, genesis_hash TEXT NOT NULL, consensus_fingerprint TEXT NOT NULL,
      account_id TEXT NOT NULL, pool TEXT NOT NULL, scope TEXT NOT NULL,
      diversifier_index TEXT NOT NULL, receiver_hex TEXT NOT NULL, destination TEXT NOT NULL,
      payment_uri TEXT NOT NULL, amount_zat TEXT NOT NULL, expires_at INTEGER NOT NULL,
      UNIQUE(network, genesis_hash, consensus_fingerprint, account_id, pool, receiver_hex)
    );
    CREATE TABLE IF NOT EXISTS scan_snapshots (
      id INTEGER PRIMARY KEY CHECK(id = 1), source_id TEXT NOT NULL, generation TEXT NOT NULL,
      network TEXT NOT NULL, genesis_hash TEXT NOT NULL, consensus_fingerprint TEXT NOT NULL,
      account_id TEXT NOT NULL, snapshot_json TEXT NOT NULL, tip_height INTEGER NOT NULL,
      tip_hash TEXT NOT NULL, checked_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS delivery_attempts (
      attempt_id TEXT PRIMARY KEY, order_id TEXT NOT NULL REFERENCES orders(id), package_id TEXT NOT NULL,
      reason TEXT NOT NULL, checkpoint_json TEXT, outcome TEXT, created_at INTEGER NOT NULL, finished_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS message_inbox (
      signer TEXT NOT NULL, message_id TEXT NOT NULL, operation TEXT NOT NULL,
      payload_digest TEXT NOT NULL, expires_at INTEGER NOT NULL, created_at INTEGER NOT NULL,
      PRIMARY KEY(signer, message_id)
    );`);
    db.prepare('INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (?, ?)').run(LIVE_SCHEMA_VERSION, Date.now());
    db.exec('COMMIT');
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch { /* transaction already closed */ }
    throw error;
  }
}

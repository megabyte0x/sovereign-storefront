-- Seller store schema v1. Later tasks must not add conflicting migrations.

CREATE TABLE IF NOT EXISTS store_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS seller_identity (
  id TEXT PRIMARY KEY,
  public_key_hex TEXT NOT NULL UNIQUE,
  destination TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS products (
  version TEXT PRIMARY KEY,
  description TEXT NOT NULL,
  amount_zat TEXT NOT NULL,
  network TEXT NOT NULL CHECK (network IN ('test', 'regtest')),
  ciphertext_cid TEXT,
  ciphertext_digest TEXT,
  file_format_version TEXT,
  file_size INTEGER,
  seller_key_ref TEXT,
  published INTEGER NOT NULL DEFAULT 0 CHECK (published IN (0, 1)),
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS product_keys (
  key_ref TEXT PRIMARY KEY,
  product_version TEXT NOT NULL REFERENCES products(version),
  wrapped_key BLOB NOT NULL
);

CREATE TABLE IF NOT EXISTS orders (
  id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL,
  buyer_key_id TEXT NOT NULL,
  product_version TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE (request_id, buyer_key_id)
);

CREATE TABLE IF NOT EXISTS invoices (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL UNIQUE REFERENCES orders(id),
  product_version TEXT NOT NULL,
  buyer_key_id TEXT NOT NULL,
  network TEXT NOT NULL CHECK (network = 'test'),
  amount_zat TEXT NOT NULL,
  destination TEXT NOT NULL,
  attribution_ref TEXT NOT NULL UNIQUE,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS observations (
  output_id TEXT PRIMARY KEY,
  invoice_id TEXT REFERENCES invoices(id),
  amount_zat TEXT NOT NULL,
  confirmations INTEGER NOT NULL,
  canonical INTEGER NOT NULL CHECK (canonical IN (0, 1)),
  received_at INTEGER NOT NULL,
  revision_id TEXT NOT NULL,
  revision_height INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS scan_checkpoints (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  revision_id TEXT NOT NULL,
  revision_height INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS invoice_settlements (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  invoice_id TEXT REFERENCES invoices(id),
  payment_state TEXT NOT NULL,
  release_eligible INTEGER NOT NULL CHECK (release_eligible IN (0, 1)),
  backing_output_ids TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS delivery_packages (
  order_id TEXT PRIMARY KEY REFERENCES orders(id),
  product_version TEXT NOT NULL,
  buyer_key_id TEXT NOT NULL,
  encrypted_envelope BLOB NOT NULL
);

CREATE TABLE IF NOT EXISTS delivery_state (
  order_id TEXT PRIMARY KEY REFERENCES orders(id),
  state TEXT NOT NULL CHECK (state IN (
    'locked', 'prepared', 'queued',
    'sent_unacknowledged', 'acknowledged', 'retry_required'
  )),
  revision_id TEXT,
  revision_height INTEGER,
  send_attempts INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS exceptions (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL REFERENCES orders(id),
  code TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  detail TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS outbox (
  id TEXT PRIMARY KEY,
  order_id TEXT REFERENCES orders(id),
  operation TEXT NOT NULL,
  payload_ref TEXT,
  retry_at INTEGER,
  completed_at INTEGER,
  created_at INTEGER NOT NULL
);

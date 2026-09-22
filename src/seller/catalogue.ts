import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import type { ServiceAvailability, StorageAdapter } from '../contracts/types.ts';
import {
  assertCanonicalAmountZat,
  assertProductNetwork,
  assertRequiredString,
} from '../contracts/validation.ts';
import {
  FILE_FORMAT_VERSION,
  FIRST_RELEASE_MAX_CIPHERTEXT_BYTES,
  PayloadTooLarge,
  sha256Hex,
} from '../adapters/crypto.ts';

const SCHEMA = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'schema.sql'), 'utf8');
export const PRODUCT_VERSION_RE = /^[A-Za-z0-9_-]{1,128}$/;

export type ProductManifest = {
  version: string;
  description: string;
  amountZat: string;
  network: 'test' | 'regtest';
  ciphertextCid: string | null;
  ciphertextDigest: string | null;
  fileFormatVersion: string | null;
  fileSize: number | null;
  sellerKeyRef: string | null;
  published: boolean;
};

export type AvailabilityProbes = {
  messaging: () => Promise<boolean>;
  storageReplica: () => Promise<boolean>;
  scanner: () => Promise<boolean>;
};

type ProductRow = {
  version: string;
  description: string;
  amount_zat: string;
  network: 'test' | 'regtest';
  ciphertext_cid: string | null;
  ciphertext_digest: string | null;
  file_format_version: string | null;
  file_size: number | null;
  seller_key_ref: string | null;
  published: number;
};

function assertProductVersion(value: string): void {
  assertRequiredString(value, 'productVersion');
  if (!PRODUCT_VERSION_RE.test(value)) {
    throw new Error('invalid identifier');
  }
}

function rowToManifest(row: ProductRow): ProductManifest {
  return {
    version: row.version,
    description: row.description,
    amountZat: row.amount_zat,
    network: row.network,
    ciphertextCid: row.ciphertext_cid,
    ciphertextDigest: row.ciphertext_digest,
    fileFormatVersion: row.file_format_version,
    fileSize: row.file_size === null || row.file_size === undefined ? null : Number(row.file_size),
    sellerKeyRef: row.seller_key_ref,
    published: row.published === 1,
  };
}

export function openCatalogue(options: {
  dbPath: string;
  storage: StorageAdapter;
  probes?: Partial<AvailabilityProbes>;
}): {
  getPublishedCiphertext(productVersion: string): Promise<Uint8Array>;
  getManifest(productVersion: string): ProductManifest | null;
  listPublished(): ProductManifest[];
  listProductKeys(): Array<{
    keyRef: string;
    productVersion: string;
    rawKey: Uint8Array;
    digestHex: string;
  }>;
  currentAvailability(): Promise<ServiceAvailability>;
  beginPublication(input: {
    version: string;
    description: string;
    amountZat: string;
    network: string;
  }): void;
  completePublication(input: {
    version: string;
    ciphertextCid: string;
    ciphertextDigest: string;
    fileSize: number;
    sellerKeyRef: string;
    wrappedKey: Uint8Array;
  }): ProductManifest;
  deleteProduct(version: string): void;
  close(): void;
} {
  assertRequiredString(options.dbPath, 'dbPath');
  mkdirSync(dirname(options.dbPath), { recursive: true });
  const db = new DatabaseSync(options.dbPath);
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA journal_mode = WAL');
  db.exec(SCHEMA);

  const read = (version: string): ProductRow | undefined =>
    db.prepare(
      `SELECT version, description, amount_zat, network, ciphertext_cid, ciphertext_digest,
              file_format_version, file_size, seller_key_ref, published
       FROM products WHERE version = ?`,
    ).get(version) as ProductRow | undefined;

  const probes: AvailabilityProbes = {
    messaging: options.probes?.messaging ?? (async () => false),
    scanner: options.probes?.scanner ?? (async () => false),
    storageReplica: options.probes?.storageReplica ?? (async () => {
      const row = db.prepare(
        `SELECT ciphertext_cid FROM products WHERE published = 1 AND ciphertext_cid IS NOT NULL LIMIT 1`,
      ).get() as { ciphertext_cid: string } | undefined;
      if (!row?.ciphertext_cid) return false;
      return options.storage.verifyReplica(row.ciphertext_cid, 'replica');
    }),
  };

  return {
    async getPublishedCiphertext(productVersion) {
      assertProductVersion(productVersion);
      const row = read(productVersion);
      if (!row || row.published !== 1 || !row.ciphertext_cid) {
        throw new Error('unpublished product');
      }
      const body = await options.storage.fetch(row.ciphertext_cid);
      if (body.byteLength > FIRST_RELEASE_MAX_CIPHERTEXT_BYTES) {
        throw new PayloadTooLarge(body.byteLength, FIRST_RELEASE_MAX_CIPHERTEXT_BYTES);
      }
      if (row.ciphertext_digest && sha256Hex(body) !== row.ciphertext_digest) {
        throw new Error('ciphertext digest mismatch');
      }
      return body;
    },
    getManifest(productVersion) {
      assertProductVersion(productVersion);
      const row = read(productVersion);
      return row ? rowToManifest(row) : null;
    },
    listPublished() {
      const rows = db.prepare(
        `SELECT version, description, amount_zat, network, ciphertext_cid, ciphertext_digest,
                file_format_version, file_size, seller_key_ref, published
         FROM products WHERE published = 1 ORDER BY created_at ASC`,
      ).all() as ProductRow[];
      return rows.map(rowToManifest);
    },
    listProductKeys() {
      const rows = db.prepare(
        `SELECT pk.key_ref AS key_ref, pk.product_version AS product_version,
                pk.wrapped_key AS wrapped_key, p.ciphertext_digest AS digest_hex
         FROM product_keys pk
         JOIN products p ON p.version = pk.product_version`,
      ).all() as Array<{
        key_ref: string;
        product_version: string;
        wrapped_key: Uint8Array;
        digest_hex: string | null;
      }>;
      return rows.map((row) => ({
        keyRef: row.key_ref,
        productVersion: row.product_version,
        rawKey: row.wrapped_key,
        digestHex: row.digest_hex ?? '',
      }));
    },
    async currentAvailability() {
      const published = db.prepare(`SELECT 1 AS ok FROM products WHERE published = 1 LIMIT 1`).get() as
        | { ok: number }
        | undefined;
      return {
        productPublished: Boolean(published),
        messaging: await probes.messaging(),
        storageReplica: await probes.storageReplica(),
        scanner: await probes.scanner(),
      };
    },
    beginPublication(input) {
      assertProductVersion(input.version);
      assertRequiredString(input.description, 'description');
      assertCanonicalAmountZat(input.amountZat);
      assertProductNetwork(input.network);
      const existing = read(input.version);
      if (existing?.published === 1) {
        throw new Error('product version is immutable');
      }
      if (existing) {
        db.prepare(
          `UPDATE products SET description = ?, amount_zat = ?, network = ?, published = 0
           WHERE version = ? AND published = 0`,
        ).run(input.description, input.amountZat, input.network, input.version);
        return;
      }
      db.prepare(
        `INSERT INTO products (
           version, description, amount_zat, network, published, created_at
         ) VALUES (?, ?, ?, ?, 0, ?)`,
      ).run(input.version, input.description, input.amountZat, input.network, Date.now());
    },
    completePublication(input) {
      assertProductVersion(input.version);
      if (input.fileSize > FIRST_RELEASE_MAX_CIPHERTEXT_BYTES) {
        throw new PayloadTooLarge(input.fileSize, FIRST_RELEASE_MAX_CIPHERTEXT_BYTES);
      }
      db.exec('BEGIN IMMEDIATE');
      try {
        const existing = read(input.version);
        if (!existing || existing.published === 1) {
          throw new Error(existing?.published === 1 ? 'product version is immutable' : 'unpublished product');
        }
        db.prepare(
          `UPDATE products
           SET ciphertext_cid = ?, ciphertext_digest = ?, file_format_version = ?,
               file_size = ?, seller_key_ref = ?, published = 1
           WHERE version = ? AND published = 0`,
        ).run(
          input.ciphertextCid,
          input.ciphertextDigest,
          FILE_FORMAT_VERSION,
          input.fileSize,
          input.sellerKeyRef,
          input.version,
        );
        db.prepare(
          `INSERT INTO product_keys (key_ref, product_version, wrapped_key) VALUES (?, ?, ?)
           ON CONFLICT(key_ref) DO NOTHING`,
        ).run(input.sellerKeyRef, input.version, input.wrappedKey);
        db.exec('COMMIT');
      } catch (error) {
        try {
          db.exec('ROLLBACK');
        } catch {
          // already rolled back
        }
        throw error;
      }
      const published = read(input.version);
      if (!published || published.published !== 1) {
        throw new Error('publication did not commit');
      }
      return rowToManifest(published);
    },
    deleteProduct(version) {
      assertProductVersion(version);
      const order = db.prepare(`SELECT 1 AS ok FROM orders WHERE product_version = ? LIMIT 1`).get(version);
      const invoice = db.prepare(`SELECT 1 AS ok FROM invoices WHERE product_version = ? LIMIT 1`).get(version);
      const delivery = db.prepare(`SELECT 1 AS ok FROM delivery_packages WHERE product_version = ? LIMIT 1`).get(version);
      if (order || invoice || delivery) {
        throw new Error('required references exist');
      }
      db.exec('BEGIN IMMEDIATE');
      try {
        db.prepare(`DELETE FROM product_keys WHERE product_version = ?`).run(version);
        db.prepare(`DELETE FROM products WHERE version = ?`).run(version);
        db.exec('COMMIT');
      } catch (error) {
        try {
          db.exec('ROLLBACK');
        } catch {
          // already rolled back
        }
        throw error;
      }
    },
    close() {
      db.close();
    },
  };
}

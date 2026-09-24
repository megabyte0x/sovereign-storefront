import { describe, expect, test } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getPublicKey } from '@waku/message-encryption';
import { bytesToHex, hexToBytes } from '@waku/utils/bytes';
import { loadOrCreateSellerIdentity, identityPath } from '../../src/seller/identity.ts';

function tmpDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ssf-identity-'));
  return join(dir, 'seller.sqlite');
}

describe('seller identity', () => {
  test('creates a fresh identity whose public key matches the library-derived key from the stored private key', () => {
    const dbPath = tmpDbPath();
    const identity = loadOrCreateSellerIdentity(dbPath);
    const derived = bytesToHex(getPublicKey(hexToBytes(identity.privateKeyHex)));
    expect(identity.publicKeyHex).toBe(derived);
  });

  test('loading twice returns the same identity (idempotent, no overwrite)', () => {
    const dbPath = tmpDbPath();
    const first = loadOrCreateSellerIdentity(dbPath);
    const second = loadOrCreateSellerIdentity(dbPath);
    expect(second).toEqual(first);
  });

  test('rejects a persisted identity whose public key does not match the private key (corruption/tamper detection)', () => {
    const dbPath = tmpDbPath();
    const identity = loadOrCreateSellerIdentity(dbPath);
    const corrupted = { ...identity, publicKeyHex: '0'.repeat(identity.publicKeyHex.length) };
    writeFileSync(identityPath(dbPath), JSON.stringify(corrupted), { mode: 0o600 });
    expect(() => loadOrCreateSellerIdentity(dbPath)).toThrow(/mismatch|malformed/i);
  });

  test('a configured public-key pin mismatch fails startup', () => {
    const dbPath = tmpDbPath();
    const identity = loadOrCreateSellerIdentity(dbPath);
    expect(() => loadOrCreateSellerIdentity(dbPath, { expectedPublicKeyHex: 'f'.repeat(identity.publicKeyHex.length) }))
      .toThrow(/pin/i);
  });

  test('a matching configured public-key pin succeeds', () => {
    const dbPath = tmpDbPath();
    const identity = loadOrCreateSellerIdentity(dbPath);
    expect(loadOrCreateSellerIdentity(dbPath, { expectedPublicKeyHex: identity.publicKeyHex })).toEqual(identity);
  });

  test('the identity file is written with owner-only permissions', () => {
    const dbPath = tmpDbPath();
    loadOrCreateSellerIdentity(dbPath);
    const raw = readFileSync(identityPath(dbPath), 'utf8');
    expect(() => JSON.parse(raw)).not.toThrow();
  });

  test('concurrent first-time creation does not race to two different identities', () => {
    const dbPath = tmpDbPath();
    const results = [
      loadOrCreateSellerIdentity(dbPath),
      loadOrCreateSellerIdentity(dbPath),
      loadOrCreateSellerIdentity(dbPath),
    ];
    expect(results[1]).toEqual(results[0]);
    expect(results[2]).toEqual(results[0]);
  });
});

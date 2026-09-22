import { expect, test } from 'vitest';
import {
  createCredentialAdapter,
  createTestCredentialAdapter,
} from '../../src/adapters/credentials.ts';

const challenge = { orderId: 'ord-1' };

test('two createPurchaseCredential calls yield different credential and buyer keys', async () => {
  const adapter = createCredentialAdapter();
  const first = await adapter.createPurchaseCredential();
  const second = await adapter.createPurchaseCredential();
  expect(first.credentialId).not.toBe(second.credentialId);
  expect(first.buyerKeyId).not.toBe(second.buyerKeyId);
  expect(first.exportable).toBe(true);
});

test('prove/verify fails for a different key', async () => {
  const adapter = createCredentialAdapter();
  const first = await adapter.createPurchaseCredential();
  const second = await adapter.createPurchaseCredential();
  const proof = await adapter.provePossession(first.credentialId, challenge);
  expect(await adapter.verifyPossession(first.buyerKeyId, proof, challenge)).toBe(true);
  expect(await adapter.verifyPossession(second.buyerKeyId, proof, challenge)).toBe(false);
  expect(await adapter.verifyPossession(first.buyerKeyId, proof, { orderId: 'other' })).toBe(false);
});

test('test double isolates keys the same way', async () => {
  const adapter = createTestCredentialAdapter();
  const first = await adapter.createPurchaseCredential();
  const second = await adapter.createPurchaseCredential();
  expect(first.credentialId).not.toBe(second.credentialId);
  const proof = await adapter.provePossession(first.credentialId, challenge);
  expect(await adapter.verifyPossession(first.buyerKeyId, proof, challenge)).toBe(true);
  expect(await adapter.verifyPossession(second.buyerKeyId, proof, challenge)).toBe(false);
});

test('raw 32-byte private key is not a valid possession proof', async () => {
  const adapter = createCredentialAdapter();
  const created = await adapter.createPurchaseCredential();
  const backup = JSON.parse(new TextDecoder().decode(await adapter.exportBackupMaterial(created.credentialId))) as {
    privateKeyHex: string;
  };
  const rawKey = Uint8Array.from(Buffer.from(backup.privateKeyHex, 'hex'));
  expect(rawKey.byteLength).toBe(32);
  expect(await adapter.verifyPossession(created.buyerKeyId, rawKey, challenge)).toBe(false);
  const proof = await adapter.provePossession(created.credentialId, challenge);
  expect(proof.byteLength).not.toBe(32);
  expect(await adapter.verifyPossession(created.buyerKeyId, proof, challenge)).toBe(true);
});

test('hex export/import restores possession', async () => {
  const adapter = createCredentialAdapter();
  const created = await adapter.createPurchaseCredential();
  const backup = await adapter.exportBackupMaterial(created.credentialId);
  const restored = JSON.parse(new TextDecoder().decode(backup)) as {
    privateKeyHex: string;
    publicKeyHex: string;
  };
  expect(restored.privateKeyHex).toMatch(/^[0-9a-f]+$/i);
  expect(restored.publicKeyHex).toBe(created.buyerKeyId);
  const other = createCredentialAdapter();
  const imported = await other.importBackupMaterial(backup);
  expect(imported.buyerKeyId).toBe(created.buyerKeyId);
  const proof = await other.provePossession(imported.credentialId, challenge);
  expect(await other.verifyPossession(created.buyerKeyId, proof, challenge)).toBe(true);
});

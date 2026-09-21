import { expect, test } from 'vitest';
import {
  createCredentialAdapter,
  createTestCredentialAdapter,
} from '../../src/adapters/credentials.ts';

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
  const proof = await adapter.provePossession(first.credentialId);
  expect(await adapter.verifyPossession(first.buyerKeyId, proof)).toBe(true);
  expect(await adapter.verifyPossession(second.buyerKeyId, proof)).toBe(false);
});

test('test double isolates keys the same way', async () => {
  const adapter = createTestCredentialAdapter();
  const first = await adapter.createPurchaseCredential();
  const second = await adapter.createPurchaseCredential();
  expect(first.credentialId).not.toBe(second.credentialId);
  const proof = await adapter.provePossession(first.credentialId);
  expect(await adapter.verifyPossession(first.buyerKeyId, proof)).toBe(true);
  expect(await adapter.verifyPossession(second.buyerKeyId, proof)).toBe(false);
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
  const proof = await other.provePossession(imported.credentialId);
  expect(await other.verifyPossession(created.buyerKeyId, proof)).toBe(true);
});

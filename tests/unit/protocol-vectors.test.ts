import { readFileSync } from 'node:fs';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { expect, test } from 'vitest';
import {
  validateAllocation,
  validateNegativeProtocolVectors,
  validateProtocolVector,
  validateSnapshot,
} from '../../src/contracts/live-validation.ts';

type VectorDocument = Record<string, unknown> & { allocation: Record<string, unknown> };

function fixture(): VectorDocument {
  return JSON.parse(readFileSync(new URL('../../services/scanner/protocol/fixtures/v1.json', import.meta.url), 'utf8')) as VectorDocument;
}

function schemaValidator(schema: object) {
  return new Ajv2020({ strict: false, validateFormats: false }).compile(schema);
}

function allocationWith(vector: VectorDocument, field: string, value: string): VectorDocument {
  const candidate = structuredClone(vector);
  candidate.allocation[field] = value;
  return candidate;
}

test('v1 schema closes every declared shape and both languages reject executable negative vectors', () => {
  const schema = JSON.parse(readFileSync(new URL('../../services/scanner/protocol/schema.json', import.meta.url), 'utf8')) as Record<string, unknown>;
  const vector: unknown = JSON.parse(readFileSync(new URL('../../services/scanner/protocol/fixtures/v1.json', import.meta.url), 'utf8'));

  expect(schema.additionalProperties).toBe(false);
  expect(schema.required).toEqual([
    'version', 'fixturePurpose', 'identity', 'product', 'snapshot', 'allocation', 'observation', 'preparedPackage', 'negative',
  ]);
  expect(schema.$defs).toMatchObject({
    amount: { maxLength: 16 },
    snapshot: { additionalProperties: false, 'x-maxUtf8Bytes': 16 * 1024 * 1024 },
    negative: { additionalProperties: false, required: ['snapshots', 'allocations', 'vectors'] },
  });

  const valid = validateProtocolVector(vector);
  expect(valid.identity.network).toBe('regtest');
  expect(valid.snapshot.receipts).toHaveLength(1);
  expect(validateSnapshot(valid.snapshot)).toEqual(valid.snapshot);
  expect(validateAllocation(valid.allocation)).toEqual(valid.allocation);
  expect(validateNegativeProtocolVectors(vector)).toEqual([
    'snapshot-bad-generation',
    'snapshot-extra-property',
    'snapshot-non-boolean-canonical',
    'snapshot-duplicate-output-id',
    'allocation-over-money-bound',
    'allocation-noncanonical-receiver-hex',
    'allocation-account-binding',
    'vector-product-network-binding',
    'vector-observation-identity-binding',
    'vector-package-body-bound',
  ]);
});

test('v1 validators reject declared max bounds and exact canonical primitive forms', () => {
  const vector = validateProtocolVector(JSON.parse(readFileSync(new URL('../../services/scanner/protocol/fixtures/v1.json', import.meta.url), 'utf8')));
  expect(() => validateSnapshot({ ...vector.snapshot, receipts: new Array(10_001).fill(vector.snapshot.receipts[0]) })).toThrow(/receipt limit/);
  expect(() => validateSnapshot({ ...vector.snapshot, sourceId: 'x'.repeat(16 * 1024 * 1024) })).toThrow(/byte limit/);
  expect(() => validateSnapshot({ ...vector.snapshot, receipts: [{ ...vector.snapshot.receipts[0], amountZat: '0' }] })).toThrow(/amount/);
  expect(() => validateAllocation({ ...vector.allocation, expiresAt: -1 })).toThrow(/expiresAt/);
  expect(() => validateAllocation({ ...vector.allocation, paymentUri: 'http://not-zcash' })).toThrow(/paymentUri/);
});

test('Draft 2020-12 schema itself enforces the canonical positive zatoshi range', () => {
  const schema = JSON.parse(readFileSync(new URL('../../services/scanner/protocol/schema.json', import.meta.url), 'utf8')) as object;
  const amount = (schema as { $defs: { amount: Record<string, unknown> } }).$defs.amount;
  const validate = schemaValidator(schema);
  const vector = fixture();

  expect(amount).not.toHaveProperty('format');
  for (const candidate of [
    '1',
    '999999999999999',
    '1000000000000000',
    '1999999999999999',
    '2000000000000000',
    '2099999999999999',
    '2100000000000000',
  ]) {
    expect(validate(allocationWith(vector, 'amountZat', candidate))).toBe(true);
  }
  for (const candidate of ['0', '01', '1.0', '2100000000000001']) {
    expect(validate(allocationWith(vector, 'amountZat', candidate))).toBe(false);
  }
});

test('schema and TypeScript validators count id256 and text4096 in Unicode code points', () => {
  const schema = JSON.parse(readFileSync(new URL('../../services/scanner/protocol/schema.json', import.meta.url), 'utf8')) as object;
  const validate = schemaValidator(schema);
  const vector = fixture();
  const cases = [
    { field: 'allocationId', unit: 'é', limit: 256 },
    { field: 'allocationId', unit: '😀', limit: 256 },
    { field: 'destination', unit: 'é', limit: 4096 },
    { field: 'destination', unit: '😀', limit: 4096 },
  ];

  for (const { field, unit, limit } of cases) {
    const valid = allocationWith(vector, field, unit.repeat(limit));
    const invalid = allocationWith(vector, field, unit.repeat(limit + 1));
    expect(validate(valid)).toBe(true);
    expect(() => validateAllocation(valid.allocation)).not.toThrow();
    expect(validate(invalid)).toBe(false);
    expect(() => validateAllocation(invalid.allocation)).toThrow();
  }
});

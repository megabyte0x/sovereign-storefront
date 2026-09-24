import { readFileSync } from 'node:fs';
import { expect, test } from 'vitest';
import {
  ACTIVATION_ORDER,
  CONSENSUS_FINGERPRINT_DOMAIN,
  consensusFingerprint,
  consensusFingerprintPreimage,
} from '../../src/contracts/consensus.ts';

type Case = { name: string; network: string; activations: Record<string, unknown>; preimage?: string; consensusFingerprint?: string };
type Vectors = { domain: string; order: string[]; valid: Case[]; invalid: Case[] };

function vectors(): Vectors {
  return JSON.parse(readFileSync(new URL('../../services/scanner/protocol/fixtures/consensus-fingerprint-v1.json', import.meta.url), 'utf8')) as Vectors;
}

test('shared vector domain and order match the TypeScript derivation', () => {
  expect(vectors().domain).toBe(CONSENSUS_FINGERPRINT_DOMAIN);
  expect(vectors().order).toEqual([...ACTIVATION_ORDER]);
});

test('valid shared vectors produce the exact Rust preimage and digest', () => {
  for (const vector of vectors().valid) {
    expect(consensusFingerprintPreimage(vector.network, vector.activations), vector.name).toBe(vector.preimage);
    expect(consensusFingerprint(vector.network, vector.activations), vector.name).toBe(vector.consensusFingerprint);
  }
});

test('invalid shared vectors are rejected instead of fingerprinted', () => {
  for (const vector of vectors().invalid) {
    expect(() => consensusFingerprint(vector.network, vector.activations), vector.name).toThrow();
  }
});

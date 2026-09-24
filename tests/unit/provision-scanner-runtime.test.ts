import { describe, expect, test } from 'vitest';
import {
  buildRuntimeConfig,
  normalizeRegtestBirthdayTree,
  parseBranchBoundActivations,
  validateProvisioningInput,
} from '../../scripts/provision-scanner-runtime.ts';

const upgrades = {
  '5ba81b19': { name: 'Overwinter', activationheight: 1 },
  '76b809bb': { name: 'Sapling', activationheight: 1 },
  '2bb40e60': { name: 'Blossom', activationheight: 1 },
  f5b9230b: { name: 'Heartwood', activationheight: 1 },
  e9ff75a6: { name: 'Canopy', activationheight: 1 },
  c2d6d0b4: { name: 'NU5', activationheight: 1 },
  c8e71055: { name: 'NU6', activationheight: 1 },
};

describe('parseBranchBoundActivations', () => {
  test('maps exact pinned RPC branch IDs to the canonical fingerprint schedule', () => {
    expect(parseBranchBoundActivations(upgrades)).toEqual({
      overwinter: 1,
      sapling: 1,
      blossom: 1,
      heartwood: 1,
      canopy: 1,
      nu5: 1,
      nu6: 1,
      'nu6-1': null,
      'nu6-2': null,
      'nu6-3': null,
    });
  });

  test('rejects an unmapped upgrade and branch-ID/name mismatch', () => {
    expect(() => parseBranchBoundActivations({ ...upgrades, deadbeef: { name: 'NU7', activationheight: 1 } })).toThrow();
    expect(() => parseBranchBoundActivations({ ...upgrades, c8e71055: { name: 'NU5', activationheight: 1 } })).toThrow();
  });
});

describe('validateProvisioningInput', () => {
  test('rejects an existing runtime section and missing required activation', () => {
    expect(() => validateProvisioningInput({ ufvk: 'opaque', birthday: 42, runtime: {} }, 42)).toThrow();
    expect(() => validateProvisioningInput({ ufvk: 'opaque', birthday: 41 }, 42)).toThrow();
  });
});

test('buildRuntimeConfig derives the shared v1 fingerprint instead of accepting one', () => {
  const activations = parseBranchBoundActivations(upgrades);
  const config = buildRuntimeConfig(
    { ufvk: 'opaque', birthday: 42 },
    {
      sourceId: 'owned-regtest',
      network: 'regtest',
      genesisHash: 'a'.repeat(64),
      lightwalletd: 'http://127.0.0.1:9067',
      activations,
      birthdayTree: {
        network: 'regtest', height: 41, hash: 'b'.repeat(64), time: 0,
        saplingTree: '', orchardTree: '', ironwoodTree: '',
      },
    },
  );
  expect(config.runtime.chain.consensusFingerprint).toHaveLength(64);
  expect(config.runtime.chain.consensusFingerprint).not.toBe('c'.repeat(64));
});

test('normalizes the known lightwalletd test label only after regtest selection', () => {
  expect(normalizeRegtestBirthdayTree({
    network: 'test', height: 41, hash: 'b'.repeat(64), time: 0,
    saplingTree: '', orchardTree: '', ironwoodTree: '',
  })).toMatchObject({ network: 'regtest', height: 41 });
  expect(() => normalizeRegtestBirthdayTree({
    network: 'main', height: 41, hash: 'b'.repeat(64), time: 0,
    saplingTree: '', orchardTree: '', ironwoodTree: '',
  })).toThrow();
});

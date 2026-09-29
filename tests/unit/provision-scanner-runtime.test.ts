import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import {
  buildRuntimeConfig,
  normalizeRegtestBirthdayTree,
  parseBranchBoundActivations,
  parseProvisionerArgs,
  validateProvisioningInput,
  writeTestnetScannerConfig,
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

test('parseProvisionerArgs accepts public testnet without a node RPC', () => {
  expect(parseProvisionerArgs([
    '--network', 'test',
    '--config', 'scanner.json',
    '--lightwalletd', 'https://testnet.zec.rocks:443',
    '--source-id', 'public-testnet',
    '--genesis-hash', 'ab'.repeat(32),
  ])).toEqual({
    network: 'test',
    config: 'scanner.json',
    lightwalletd: 'https://testnet.zec.rocks:443',
    sourceId: 'public-testnet',
    genesisHash: 'ab'.repeat(32),
  });
  expect(() => parseProvisionerArgs(['--network', 'main', '--config', 'scanner.json'])).toThrow(/not permitted/);
  expect(() => parseProvisionerArgs([
    '--network', 'test',
    '--config', 'scanner.json',
    '--lightwalletd', 'http://example.com',
    '--source-id', 'public-testnet',
    '--genesis-hash', 'ab'.repeat(32),
  ])).toThrow(/plaintext/);
});

test('writeTestnetScannerConfig writes network test at mode 0600 and omits birthdayTree', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ssf-provision-testnet-'));
  chmodSync(root, 0o700);
  const config = join(root, 'scanner.json');
  writeFileSync(config, `${JSON.stringify({ ufvk: 'opaque', birthday: 4134001 })}\n`);
  chmodSync(config, 0o600);
  await writeTestnetScannerConfig(config, {
    sourceId: 'public-testnet',
    genesisHash: 'ab'.repeat(32),
    lightwalletd: 'https://testnet.zec.rocks:443',
  });
  expect(statSync(config).mode & 0o777).toBe(0o600);
  const written = JSON.parse(readFileSync(config, 'utf8')) as {
    birthday: number;
    birthdayTree?: unknown;
    runtime: { chain: { network: string; consensusFingerprint: string }; lightwalletd: string; activations: { nu6: number } };
  };
  expect(written.runtime.chain.network).toBe('test');
  expect(written.runtime.lightwalletd).toBe('https://testnet.zec.rocks:443');
  expect(written.runtime.activations.nu6).toBe(2_976_000);
  expect(written.runtime.chain.consensusFingerprint).toHaveLength(64);
  expect(written.birthdayTree).toBeUndefined();
  expect(written.birthday).toBe(4134001);
  rmSync(root, { recursive: true, force: true });
});

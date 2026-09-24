import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import {
  fetchWithDeadline,
  successfulQualificationStatus,
  localRegtestParametersFromRpc,
  preparePrivateConfigPath,
  readPrivateScannerResult,
  run,
  scannerArguments,
} from '../../scripts/qualify-payments.ts';

const chainInfo = {
  chain: 'regtest',
  blocks: 42,
  upgrades: {
    overwinter: { name: 'Overwinter', activationheight: 1 },
    sapling: { name: 'Sapling', activationheight: 1 },
    blossom: { name: 'Blossom', activationheight: 1 },
    heartwood: { name: 'Heartwood', activationheight: 1 },
    canopy: { name: 'Canopy', activationheight: 1 },
    nu5: { name: 'NU5', activationheight: 1 },
    nu6: { name: 'NU6', activationheight: 1 },
    nu61: { name: 'NU6.1', activationheight: 1 },
    nu62: { name: 'NU6.2', activationheight: 1 },
    nu63: { name: 'NU6.3', activationheight: 1 },
  },
};

describe('scannerArguments', () => {
  test('passes the config and dynamically supplied lightwalletd endpoint without logging either', () => {
    expect(scannerArguments('.runtime/task1/scanner.json', 'dynamically-supplied-endpoint', 'prepare', {
      birthday: 42,
      activationHeights: {
        overwinter: 1,
        sapling: 1,
        blossom: 1,
        heartwood: 1,
        canopy: 1,
        nu5: 1,
        nu6: 1,
        nu6_1: null,
        nu6_2: null,
        nu6_3: null,
      },
    })).toEqual([
      'run',
      '--locked',
      '--quiet',
      '--manifest-path',
      'services/scanner/Cargo.toml',
      '--',
      'qualify',
      '--stage',
      'prepare',
      '--config',
      '.runtime/task1/scanner.json',
      '--lightwalletd',
      'dynamically-supplied-endpoint',
      '--overwinter',
      '1',
      '--sapling',
      '1',
      '--blossom',
      '1',
      '--heartwood',
      '1',
      '--canopy',
      '1',
      '--nu5',
      '1',
      '--nu6',
      '1',
      '--nu6-1',
      'none',
      '--nu6-2',
      'none',
      '--nu6-3',
      'none',
    ]);
  });
});

describe('localRegtestParametersFromRpc', () => {
  test('records absent future upgrades as unactivated instead of inventing an activation height', () => {
    const { nu61: _nu61, nu62: _nu62, nu63: _nu63, ...legacyUpgrades } = chainInfo.upgrades;
    const legacyRegtest = { ...chainInfo, upgrades: legacyUpgrades };

    expect(localRegtestParametersFromRpc(legacyRegtest)).toEqual({
      birthday: 42,
      activationHeights: {
        overwinter: 1,
        sapling: 1,
        blossom: 1,
        heartwood: 1,
        canopy: 1,
        nu5: 1,
        nu6: 1,
        nu6_1: null,
        nu6_2: null,
        nu6_3: null,
      },
    });
  });

  test('accepts the node test label only with independent Regtest runtime evidence', () => {
    expect(localRegtestParametersFromRpc({ ...chainInfo, chain: 'test' }, 'Regtest')).toEqual({
      birthday: 42,
      activationHeights: {
        overwinter: 1,
        sapling: 1,
        blossom: 1,
        heartwood: 1,
        canopy: 1,
        nu5: 1,
        nu6: 1,
        nu6_1: 1,
        nu6_2: 1,
        nu6_3: 1,
      },
    });
  });

  test('accepts observed local-regtest upgrades and tip as helper inputs', () => {
    expect(localRegtestParametersFromRpc(chainInfo)).toEqual({
      birthday: 42,
      activationHeights: {
        overwinter: 1,
        sapling: 1,
        blossom: 1,
        heartwood: 1,
        canopy: 1,
        nu5: 1,
        nu6: 1,
        nu6_1: 1,
        nu6_2: 1,
        nu6_3: 1,
      },
    });
  });
});

describe('bounded qualification operations', () => {
  test('terminates a hanging child and returns a fail-closed timeout status', async () => {
    const result = await run(process.execPath, ['-e', 'setInterval(() => {}, 1_000)'], 20);
    expect(result.code).toBe(124);
  });

  test('aborts an unresolved fetch at its explicit deadline', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = ((_input: string, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
    })) as typeof fetch;
    try {
      await expect(fetchWithDeadline('http://invalid.test', {}, 20)).rejects.toThrow('network request timed out');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test('successful qualification output is a fixed sanitized status line', () => {
  expect(successfulQualificationStatus()).toBe('status=RECEIPT_QUALIFIED\n');
  expect(successfulQualificationStatus()).not.toContain('configFile');
  expect(successfulQualificationStatus()).not.toContain('.runtime');
});

describe('private scanner boundary', () => {
  test('reads the private Unified Address handoff without exposing receiver identity', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ssf-qualify-private-'));
    const runtime = join(root, 'runtime');
    const config = join(runtime, 'scanner.json');
    const state = join(runtime, '.scanner.json.live-state');
    await mkdir(state, { recursive: true, mode: 0o700 });
    await chmod(runtime, 0o700);
    await chmod(state, 0o700);
    await writeFile(
      join(state, 'result.json'),
      '{"allocation_a":{"unified_address":"opaque-address","orchard_receiver_hex":"private-hex"},"before_ten":null}',
      { mode: 0o600 },
    );
    await chmod(join(state, 'result.json'), 0o600);
    try {
      await expect(readPrivateScannerResult(config)).resolves.toEqual({
        allocation_a: 'opaque-address',
        before_ten: null,
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('refuses a shared runtime directory rather than chmodding it into trust', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ssf-qualify-private-'));
    const runtime = join(root, 'runtime');
    await mkdir(runtime, { mode: 0o755 });
    await chmod(runtime, 0o755);
    try {
      await expect(preparePrivateConfigPath(join(runtime, 'scanner.json'))).rejects.toThrow('private directory is unsafe');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('rejects a state-root symlink before reading a private scanner result', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ssf-qualify-private-'));
    const runtime = join(root, 'runtime');
    const target = join(root, 'target');
    const config = join(runtime, 'scanner.json');
    const stateLink = join(runtime, '.scanner.json.live-state');
    await mkdir(runtime, { mode: 0o700 });
    await mkdir(target, { mode: 0o700 });
    await chmod(runtime, 0o700);
    await chmod(target, 0o700);
    await writeFile(
      join(target, 'result.json'),
      '{"allocation_a":{"unified_address":"opaque","orchard_receiver_hex":"opaque"},"before_ten":{"confirmations":1}}',
      { mode: 0o600 },
    );
    await chmod(join(target, 'result.json'), 0o600);
    await symlink(target, stateLink);
    try {
      await expect(readPrivateScannerResult(config)).rejects.toThrow('private directory is unsafe');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

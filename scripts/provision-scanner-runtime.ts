import { constants } from 'node:fs';
import { lstat, open, rename, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { consensusFingerprint, type ActivationSchedule } from '../src/contracts/consensus.ts';
import { fetchWithDeadline, localRegtestParametersFromRpc, run } from './qualify-payments.ts';

const BRANCH_IDS: Readonly<Record<string, string>> = {
  overwinter: '5ba81b19',
  sapling: '76b809bb',
  blossom: '2bb40e60',
  heartwood: 'f5b9230b',
  canopy: 'e9ff75a6',
  nu5: 'c2d6d0b4',
  nu6: 'c8e71055',
  'nu6-1': '4dec4df0',
  'nu6-2': '5437f330',
  'nu6-3': '37a5165b',
};

const DISPLAY_NAMES: Readonly<Record<string, string>> = {
  overwinter: 'overwinter', sapling: 'sapling', blossom: 'blossom', heartwood: 'heartwood', canopy: 'canopy',
  nu5: 'nu5', nu6: 'nu6', nu61: 'nu6-1', nu62: 'nu6-2', nu63: 'nu6-3',
};

export type BirthdayTree = {
  network: 'regtest'; height: number; hash: string; time: number;
  saplingTree: string; orchardTree: string; ironwoodTree: string;
};

type BaseConfig = { ufvk: string; birthday: number; runtime?: unknown; birthdayTree?: unknown };

function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid provisioning object');
  return value as Record<string, unknown>;
}

function exactActivationName(value: unknown): string {
  if (typeof value !== 'string') throw new Error('upgrade name is invalid');
  const name = DISPLAY_NAMES[value.toLowerCase().replaceAll(/[^a-z0-9]/g, '')];
  if (!name) throw new Error('upgrade name is unmapped');
  return name;
}

function height(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > 0xffff_ffff) {
    throw new Error('upgrade height is invalid');
  }
  return value;
}

/** Maps RPC branch-ID keyed upgrades to the frozen canonical schedule. */
export function parseBranchBoundActivations(value: unknown): Required<ActivationSchedule> {
  const result: Record<string, number | null> = {
    overwinter: null, sapling: null, blossom: null, heartwood: null, canopy: null,
    nu5: null, nu6: null, 'nu6-1': null, 'nu6-2': null, 'nu6-3': null,
  };
  const seen = new Set<string>();
  for (const [branchId, rawUpgrade] of Object.entries(object(value))) {
    const upgrade = object(rawUpgrade);
    const name = exactActivationName(upgrade.name);
    if (branchId !== BRANCH_IDS[name] || seen.has(name)) throw new Error('upgrade branch identity mismatches name');
    seen.add(name);
    result[name] = height(upgrade.activationheight);
  }
  for (const name of ['overwinter', 'sapling', 'blossom', 'heartwood', 'canopy', 'nu5', 'nu6']) {
    if (result[name] === null) throw new Error('required upgrade is missing');
  }
  return result as Required<ActivationSchedule>;
}

export function validateProvisioningInput(value: unknown, observedBirthday: number): BaseConfig {
  const base = object(value);
  if (typeof base.ufvk !== 'string' || base.ufvk.length === 0 || base.birthday !== observedBirthday) {
    throw new Error('private base scanner config does not match current node evidence');
  }
  if ('runtime' in base || 'birthdayTree' in base || Object.keys(base).some((key) => key !== 'ufvk' && key !== 'birthday')) {
    throw new Error('scanner config is not a fresh helper configuration');
  }
  return { ufvk: base.ufvk, birthday: base.birthday };
}

export function buildRuntimeConfig(
  base: BaseConfig,
  input: {
    sourceId: string; network: 'regtest'; genesisHash: string; lightwalletd: string;
    activations: Required<ActivationSchedule>; birthdayTree: BirthdayTree;
  },
) {
  if (!/^[0-9a-f]{64}$/.test(input.genesisHash) || input.sourceId.length === 0) throw new Error('runtime chain identity is invalid');
  if (input.birthdayTree.network !== input.network || input.birthdayTree.height !== base.birthday - 1) {
    throw new Error('birthday tree does not match the helper config');
  }
  return {
    ufvk: base.ufvk,
    birthday: base.birthday,
    birthdayTree: input.birthdayTree,
    runtime: {
      sourceId: input.sourceId,
      chain: {
        network: input.network,
        genesisHash: input.genesisHash,
        consensusFingerprint: consensusFingerprint(input.network, input.activations),
      },
      lightwalletd: input.lightwalletd,
      activations: input.activations,
    },
  };
}

async function assertPrivateDirectory(path: string): Promise<void> {
  const stat = await lstat(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o777) !== 0o700) throw new Error('private directory is unsafe');
}

async function readPrivateBaseConfig(path: string): Promise<BaseConfig> {
  await assertPrivateDirectory(dirname(path));
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o777) !== 0o600) throw new Error('private config is unsafe');
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { return JSON.parse(await file.readFile({ encoding: 'utf8' })) as BaseConfig; } finally { await file.close(); }
}

async function writePrivateConfig(path: string, config: unknown): Promise<void> {
  const parent = dirname(path);
  await assertPrivateDirectory(parent);
  const temporary = join(parent, `.${basename(path)}.${process.pid}.new`);
  const file = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    await file.writeFile(`${JSON.stringify(config)}\n`, { encoding: 'utf8' });
    await file.sync();
  } finally { await file.close(); }
  await rename(temporary, path);
}

export async function replacePrivateBaseConfig(path: string, observedBirthday: number, input: Parameters<typeof buildRuntimeConfig>[1]): Promise<void> {
  const base = validateProvisioningInput(await readPrivateBaseConfig(path), observedBirthday);
  await writePrivateConfig(path, buildRuntimeConfig(base, input));
}

export const __private = { BRANCH_IDS };

function argument(name: string): string {
  const values = process.argv.slice(2);
  const index = values.indexOf(name);
  const value = index < 0 ? undefined : values[index + 1];
  if (!value || value.startsWith('--')) throw new Error('invalid provisioner arguments');
  return value;
}

async function rpc(endpoint: string, method: string, params: unknown[]): Promise<unknown> {
  const response = await fetchWithDeadline(endpoint, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '1.0', id: 'scanner-provisioner', method, params }),
  });
  if (!response.ok) throw new Error('node RPC failed');
  const envelope = object(JSON.parse(await response.text()));
  if (envelope.error !== null || !('result' in envelope)) throw new Error('node RPC returned an error');
  return envelope.result;
}

async function dashboardNetwork(endpoint: string): Promise<string> {
  const response = await fetchWithDeadline(`${endpoint.replace(/\/$/, '')}/api/v1/status`);
  if (!response.ok) throw new Error('dashboard status failed');
  const status = object(JSON.parse(await response.text()));
  if (typeof status.network !== 'string') throw new Error('dashboard network evidence is missing');
  return status.network;
}

function inspectionArguments(config: string, endpoint: string, birthday: number, activations: Required<ActivationSchedule>): string[] {
  const values = [
    'run', '--locked', '--quiet', '--manifest-path', 'services/scanner/Cargo.toml', '--',
    'inspect-lightwalletd', '--lightwalletd', endpoint, '--birthday', String(birthday),
  ];
  for (const name of Object.keys(BRANCH_IDS)) {
    values.push(`--${name}`, activations[name as keyof ActivationSchedule] === null ? 'none' : String(activations[name as keyof ActivationSchedule]));
  }
  return values;
}

export function normalizeRegtestBirthdayTree(value: unknown): BirthdayTree {
  const tree = object(value);
  if (
    (tree.network !== 'regtest' && tree.network !== 'test')
    || typeof tree.height !== 'number' || !Number.isSafeInteger(tree.height) || tree.height < 0
    || typeof tree.hash !== 'string' || !/^[0-9a-f]{64}$/.test(tree.hash)
    || typeof tree.time !== 'number' || !Number.isSafeInteger(tree.time) || tree.time < 0
    || typeof tree.saplingTree !== 'string' || typeof tree.orchardTree !== 'string' || typeof tree.ironwoodTree !== 'string'
  ) throw new Error('lightwalletd birthday tree is invalid');
  return { ...tree, network: 'regtest' } as BirthdayTree;
}

/** `zcash_protocol` 0.10.6 `TestNetwork` activation heights. Not copied from a node. */
export const TESTNET_ACTIVATIONS: Required<ActivationSchedule> = {
  overwinter: 207_500,
  sapling: 280_000,
  blossom: 584_000,
  heartwood: 903_800,
  canopy: 1_028_500,
  nu5: 1_842_420,
  nu6: 2_976_000,
  'nu6-1': 3_536_500,
  'nu6-2': 4_052_000,
  'nu6-3': 4_134_000,
};

export type ProvisionerArgs =
  | { network: 'regtest'; config: string; rpc: string; dashboard: string; lightwalletd: string; sourceId: string }
  | { network: 'test'; config: string; lightwalletd: string; sourceId: string; genesisHash: string };

function flagValues(argv: readonly string[]): Map<string, string> {
  const flags = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!flag?.startsWith('--') || !value || value.startsWith('--') || flags.has(flag)) {
      throw new Error('invalid provisioner arguments');
    }
    flags.set(flag, value);
    index += 1;
  }
  return flags;
}

function requiredFlag(flags: Map<string, string>, name: string): string {
  const value = flags.get(name);
  if (!value) throw new Error('invalid provisioner arguments');
  return value;
}

/** Parses the provisioner CLI. `test` does not require an owned node RPC. */
export function parseProvisionerArgs(argv: readonly string[]): ProvisionerArgs {
  const flags = flagValues(argv);
  const network = flags.get('--network') ?? 'regtest';
  if (network !== 'regtest' && network !== 'test') throw new Error('scanner network is not permitted');
  const config = requiredFlag(flags, '--config');
  const lightwalletd = requiredFlag(flags, '--lightwalletd');
  const sourceId = requiredFlag(flags, '--source-id');
  if (network === 'test') {
    const genesisHash = requiredFlag(flags, '--genesis-hash');
    if (!/^[0-9a-f]{64}$/.test(genesisHash)) throw new Error('runtime chain identity is invalid');
    if (!lightwalletd.startsWith('https://')) throw new Error('plaintext lightwalletd endpoint is not allowed');
    for (const name of flags.keys()) {
      if (!['--network', '--config', '--lightwalletd', '--source-id', '--genesis-hash'].includes(name)) {
        throw new Error('invalid provisioner arguments');
      }
    }
    return { network, config, lightwalletd, sourceId, genesisHash };
  }
  return {
    network,
    config,
    rpc: requiredFlag(flags, '--rpc'),
    dashboard: requiredFlag(flags, '--dashboard'),
    lightwalletd,
    sourceId,
  };
}

export function buildTestnetRuntimeConfig(
  base: BaseConfig,
  input: { sourceId: string; genesisHash: string; lightwalletd: string },
) {
  if (!/^[0-9a-f]{64}$/.test(input.genesisHash) || input.sourceId.length === 0) {
    throw new Error('runtime chain identity is invalid');
  }
  if (!input.lightwalletd.startsWith('https://')) throw new Error('plaintext lightwalletd endpoint is not allowed');
  return {
    ufvk: base.ufvk,
    birthday: base.birthday,
    runtime: {
      sourceId: input.sourceId,
      chain: {
        network: 'test' as const,
        genesisHash: input.genesisHash,
        consensusFingerprint: consensusFingerprint('test', TESTNET_ACTIVATIONS),
      },
      lightwalletd: input.lightwalletd,
      activations: TESTNET_ACTIVATIONS,
    },
  };
}

/** Writes a testnet `scanner.json` at mode 0600. Birthday tree is fetched by `init-view`. */
export async function writeTestnetScannerConfig(
  path: string,
  input: { sourceId: string; genesisHash: string; lightwalletd: string },
): Promise<void> {
  const raw = await readPrivateBaseConfig(path);
  const base = validateProvisioningInput(raw, raw.birthday);
  await writePrivateConfig(path, buildTestnetRuntimeConfig(base, input));
}


async function main(): Promise<void> {
  if (process.argv.includes('--network') && argument('--network') === 'test') {
    const parsed = parseProvisionerArgs(process.argv.slice(2));
    if (parsed.network !== 'test') throw new Error('scanner network is not permitted');
    await writeTestnetScannerConfig(parsed.config, parsed);
    process.stdout.write('status=SCANNER_RUNTIME_PROVISIONED fields=runtime network=test\n');
    return;
  }
  const config = argument('--config');
  const rpcEndpoint = argument('--rpc');
  const dashboard = argument('--dashboard');
  const lightwalletd = argument('--lightwalletd');
  const sourceId = argument('--source-id');
  const chainInfo = await rpc(rpcEndpoint, 'getblockchaininfo', []);
  const network = await dashboardNetwork(dashboard);
  const parameters = localRegtestParametersFromRpc(chainInfo, network);
  const chain = object(chainInfo);
  const activations = parseBranchBoundActivations(chain.upgrades);
  const expectedFromSharedParser = Object.fromEntries(Object.entries(parameters.activationHeights).map(([name, value]) => [name.replaceAll('_', '-'), value]));
  if (JSON.stringify(activations) !== JSON.stringify(expectedFromSharedParser)) throw new Error('activation evidence disagrees');
  const genesisHash = await rpc(rpcEndpoint, 'getblockhash', [0]);
  if (typeof genesisHash !== 'string') throw new Error('genesis hash is invalid');
  const result = await run('cargo', inspectionArguments(config, lightwalletd, parameters.birthday, activations));
  if (result.code !== 0 || result.stderr.length !== 0) throw new Error('lightwalletd inspection failed');
  const tree = normalizeRegtestBirthdayTree(JSON.parse(result.stdout));
  await replacePrivateBaseConfig(config, parameters.birthday, {
    sourceId, network: 'regtest', genesisHash, lightwalletd, activations, birthdayTree: tree,
  });
  process.stdout.write('status=SCANNER_RUNTIME_PROVISIONED fields=birthdayTree,runtime\n');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(() => {
    process.stderr.write('scanner runtime provisioning failed\n');
    process.exitCode = 1;
  });
}

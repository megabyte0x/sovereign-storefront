import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { lstat, mkdir, open } from 'node:fs/promises';
import { basename, dirname } from 'node:path';

export type CommandResult = {
  code: number;
  stdout: string;
  stderr: string;
};

type ActivationName =
  | 'overwinter'
  | 'sapling'
  | 'blossom'
  | 'heartwood'
  | 'canopy'
  | 'nu5'
  | 'nu6'
  | 'nu6_1'
  | 'nu6_2'
  | 'nu6_3';

export type LocalRegtestParameters = {
  birthday: number;
  activationHeights: Record<ActivationName, number | null>;
};

export type QualificationPreflight = {
  status: 'BLOCKED_DEPENDENCY_GRAPH' | 'READY_FOR_SCANNER_CONFIG' | 'PROVISIONED_FOR_SCANNER' | 'RPC_MATRIX_PASS' | 'RECEIPT_QUALIFIED';
  cargo: {
    check: 'PASS' | 'FAIL';
    failure: string | null;
  };
  runtime: LocalRegtestParameters | null;
};

type PreflightInternals = {
  doctorOk: boolean;
  endpointKinds: string[];
  dashboardEndpoint: string | null;
  lightwalletdEndpoint: string | null;
  rpcEndpoint: string | null;
};

type PreflightResult = {
  publicResult: QualificationPreflight;
  internals: PreflightInternals;
};

const ACTIVATION_NAMES: readonly ActivationName[] = [
  'overwinter',
  'sapling',
  'blossom',
  'heartwood',
  'canopy',
  'nu5',
  'nu6',
  'nu6_1',
  'nu6_2',
  'nu6_3',
];

/** Bounded fail-closed deadlines; status output never includes child output. */
export const CHILD_PROCESS_DEADLINE_MS = 120_000;
export const CHILD_ABORT_GRACE_MS = 1_000;
export const FETCH_DEADLINE_MS = 15_000;

/** The only public success output; qualification internals remain private. */
export function successfulQualificationStatus(): string {
  return 'status=RECEIPT_QUALIFIED\n';
}

export function run(
  command: string,
  args: string[],
  timeoutMs = CHILD_PROCESS_DEADLINE_MS,
): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let timedOut = false;
    let settled = false;
    const settle = (result: CommandResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      clearTimeout(forceKill);
      resolve(result);
    };
    const deadline = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      forceKill = setTimeout(() => child.kill('SIGKILL'), CHILD_ABORT_GRACE_MS);
    }, timeoutMs);
    let forceKill: NodeJS.Timeout | undefined;
    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      clearTimeout(forceKill);
      reject(error);
    });
    child.on('close', (code) => settle({
      code: timedOut ? 124 : (code ?? 1),
      stdout: Buffer.concat(stdout).toString('utf8'),
      stderr: Buffer.concat(stderr).toString('utf8'),
    }));
  });
}

function asObject(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function jsonOrNull(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function endpointKinds(endpoints: unknown): string[] {
  const record = asObject(endpoints);
  if (!record) return [];
  return Object.entries(record)
    .filter(([, value]) => typeof value === 'string' && value.length > 0)
    .map(([key]) => key)
    .sort();
}

function endpointFrom(endpoints: unknown, name: string): string | null {
  const record = asObject(endpoints);
  const endpoint = record?.[name];
  return typeof endpoint === 'string' && endpoint.length > 0 ? endpoint : null;
}

function cargoFailure(result: CommandResult): string | null {
  const text = `${result.stdout}\n${result.stderr}`;
  const compiler = text.match(/error\[E\d+\]:[^\n]*/)?.[0];
  if (compiler) return compiler;
  const line = text.split('\n').find((item) => item.startsWith('error:'));
  return line ?? null;
}

function configArgument(args: string[]): string {
  const index = args.indexOf('--config');
  const value = index >= 0 ? args[index + 1] : undefined;
  if (!value || value.startsWith('--') || args.length !== 2) {
    throw new Error('invalid qualification arguments');
  }
  return value;
}

function nonNegativeInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function activationName(name: string): ActivationName | null {
  const normalized = name.toLowerCase().replaceAll(/[^a-z0-9]/g, '');
  switch (normalized) {
    case 'overwinter': return 'overwinter';
    case 'sapling': return 'sapling';
    case 'blossom': return 'blossom';
    case 'heartwood': return 'heartwood';
    case 'canopy': return 'canopy';
    case 'nu5': return 'nu5';
    case 'nu6': return 'nu6';
    case 'nu61': return 'nu6_1';
    case 'nu62': return 'nu6_2';
    case 'nu63': return 'nu6_3';
    default: return null;
  }
}

/**
 * Builds the helper parameters only from the active node's non-secret RPC evidence.
 * It intentionally rejects incomplete or non-regtest evidence rather than supplying
 * a default activation schedule.
 */
export function localRegtestParametersFromRpc(
  value: unknown,
  independentNetworkEvidence?: unknown,
): LocalRegtestParameters {
  const chain = asObject(value);
  const nodeChain = chain?.chain;
  const independentlyVerifiedRegtest = independentNetworkEvidence === 'Regtest';
  if (
    chain === null
    || (nodeChain !== 'regtest' && !(nodeChain === 'test' && independentlyVerifiedRegtest))
  ) {
    throw new Error('runtime is not regtest');
  }
  const birthday = nonNegativeInteger(chain.blocks);
  const upgrades = asObject(chain.upgrades);
  if (birthday === null || upgrades === null) throw new Error('runtime activation evidence is incomplete');

  const activationHeights = new Map<ActivationName, number>();
  for (const candidate of Object.values(upgrades)) {
    const upgrade = asObject(candidate);
    const name = typeof upgrade?.name === 'string' ? activationName(upgrade.name) : null;
    const height = nonNegativeInteger(upgrade?.activationheight);
    if (name === null || height === null) continue;
    const prior = activationHeights.get(name);
    if (prior !== undefined && prior !== height) throw new Error('runtime activation evidence conflicts');
    activationHeights.set(name, height);
  }

  const requiredActivations: readonly ActivationName[] = ACTIVATION_NAMES.slice(0, 7);
  if (requiredActivations.some((name) => !activationHeights.has(name))) {
    throw new Error('runtime activation evidence is incomplete');
  }
  return {
    birthday,
    activationHeights: Object.fromEntries(
      ACTIVATION_NAMES.map((name) => [name, activationHeights.get(name) ?? null]),
    ) as Record<ActivationName, number | null>,
  };
}

export async function fetchWithDeadline(
  input: string,
  init: RequestInit = {},
  timeoutMs = FETCH_DEADLINE_MS,
): Promise<Response> {
  const controller = new AbortController();
  let timedOut = false;
  const deadline = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } catch (error) {
    if (timedOut) throw new Error('network request timed out');
    throw error;
  } finally {
    clearTimeout(deadline);
  }
}

async function rpc(endpoint: string, method: string): Promise<unknown> {
  const response = await fetchWithDeadline(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '1.0', id: 'ssf-task1', method, params: [] }),
  });
  if (!response.ok) throw new Error('node RPC request failed');
  const envelope = asObject(jsonOrNull(await response.text()));
  if (envelope === null || envelope.error !== null || !('result' in envelope)) {
    throw new Error('node RPC did not return a result');
  }
  return envelope.result;
}

export async function dashboardNetwork(endpoint: string): Promise<string> {
  const response = await fetchWithDeadline(`${endpoint.replace(/\/$/, '')}/api/v1/status`);
  if (!response.ok) throw new Error('dashboard status request failed');
  const status = asObject(jsonOrNull(await response.text()));
  if (typeof status?.network !== 'string') throw new Error('dashboard network evidence is missing');
  return status.network;
}

export function helperArguments(configFile: string, parameters: LocalRegtestParameters): string[] {
  const args = [
    'run',
    '--locked',
    '--quiet',
    '--manifest-path',
    'tools/payment-test-wallet/Cargo.toml',
    '--',
    '--config',
    configFile,
    '--birthday',
    String(parameters.birthday),
  ];
  for (const name of ACTIVATION_NAMES) {
    const height = parameters.activationHeights[name];
    args.push(`--${name.replace('_', '-')}`, height === null ? 'none' : String(height));
  }
  return args;
}

export function scannerArguments(
  configFile: string,
  lightwalletd: string,
  stage: 'prepare' | 'before-ten' | 'at-ten' | 'verify-restart',
  parameters: LocalRegtestParameters,
): string[] {
  const args = [
    'run',
    '--locked',
    '--quiet',
    '--manifest-path',
    'services/scanner/Cargo.toml',
    '--',
    'qualify',
    '--stage',
    stage,
    '--config',
    configFile,
    '--lightwalletd',
    lightwalletd,
  ];
  for (const name of ACTIVATION_NAMES) {
    const height = parameters.activationHeights[name];
    args.push(`--${name.replace('_', '-')}`, height === null ? 'none' : String(height));
  }
  return args;
}

function scannerFailure(result: CommandResult): string {
  const diagnostic = `${result.stdout}\n${result.stderr}`.match(
    /rpc_probe_failed call=[a-z_]+ kind=[a-z_]+/,
  )?.[0];
  return diagnostic ?? 'scanner RPC qualification failed';
}

type ScannerStage = 'prepare' | 'before-ten' | 'at-ten' | 'verify-restart';

type PrivateScannerResult = {
  allocation_a: string;
  before_ten: { confirmations: number } | null;
};

async function runScannerStage(
  configFile: string,
  lightwalletd: string,
  parameters: LocalRegtestParameters,
  stage: ScannerStage,
): Promise<void> {
  const result = await run('cargo', scannerArguments(configFile, lightwalletd, stage, parameters));
  if (result.code !== 0 || result.stdout !== `scanner_stage=${stage}\n` || result.stderr.length !== 0) {
    throw new Error('scanner receiver qualification failed');
  }
}

function expectedUid(): number | null {
  return typeof process.getuid === 'function' ? process.getuid() : null;
}

async function assertPrivateDirectory(path: string): Promise<void> {
  const link = await lstat(path);
  if (!link.isDirectory() || link.isSymbolicLink()) throw new Error('private directory is unsafe');
  const directory = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    const metadata = await directory.stat();
    const uid = expectedUid();
    if (
      !metadata.isDirectory()
      || (metadata.mode & 0o777) !== 0o700
      || (uid !== null && metadata.uid !== uid)
    ) {
      throw new Error('private directory is unsafe');
    }
  } finally {
    await directory.close();
  }
}

async function readPrivateFile(path: string): Promise<string> {
  const link = await lstat(path);
  if (!link.isFile() || link.isSymbolicLink()) throw new Error('private file is unsafe');
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const metadata = await file.stat();
    const uid = expectedUid();
    if (
      !metadata.isFile()
      || (metadata.mode & 0o777) !== 0o600
      || (uid !== null && metadata.uid !== uid)
    ) {
      throw new Error('private file is unsafe');
    }
    return await file.readFile({ encoding: 'utf8' });
  } finally {
    await file.close();
  }
}

export async function readPrivateScannerResult(configFile: string): Promise<PrivateScannerResult> {
  const runtimeDirectory = dirname(configFile);
  await assertPrivateDirectory(runtimeDirectory);
  const stateRoot = `${runtimeDirectory}/.${basename(configFile)}.live-state`;
  await assertPrivateDirectory(stateRoot);
  const parsed = asObject(jsonOrNull(await readPrivateFile(`${stateRoot}/result.json`)));
  const allocation = asObject(parsed?.allocation_a);
  const unifiedAddress = allocation?.unified_address;
  const receiverHex = allocation?.orchard_receiver_hex;
  const before = asObject(parsed?.before_ten);
  const confirmations = before?.confirmations;
  if (
    typeof unifiedAddress !== 'string'
    || unifiedAddress.length === 0
    || typeof receiverHex !== 'string'
    || receiverHex.length === 0
  ) {
    throw new Error('scanner allocation handoff is invalid');
  }
  if (before !== null && before !== undefined && !Number.isSafeInteger(confirmations)) {
    throw new Error('scanner confirmation handoff is invalid');
  }
  return {
    allocation_a: unifiedAddress,
    before_ten: before === null || before === undefined ? null : { confirmations: confirmations as number },
  };
}

async function fundOnlyAllocationA(configFile: string): Promise<void> {
  const handoff = await readPrivateScannerResult(configFile);
  const faucet = await run('ths', ['faucet', '--name', 'ssf-task1', '--amount', '1', handoff.allocation_a]);
  if (faucet.code !== 0) throw new Error('disposable payer funding failed');
  const mine = await run('ths', ['mine', '--name', 'ssf-task1', '1']);
  if (mine.code !== 0) throw new Error('post-funding mining failed');
}

async function mineToTenConfirmations(configFile: string): Promise<void> {
  const handoff = await readPrivateScannerResult(configFile);
  const confirmations = handoff.before_ten?.confirmations;
  if (
    typeof confirmations !== 'number'
    || !Number.isSafeInteger(confirmations)
    || confirmations < 1
    || confirmations >= 10
  ) {
    throw new Error('scanner before-ten confirmation evidence is invalid');
  }
  const mine = await run('ths', ['mine', '--name', 'ssf-task1', String(10 - confirmations)]);
  if (mine.code !== 0) throw new Error('ten-confirmation mining failed');
}

export async function preparePrivateConfigPath(configFile: string): Promise<void> {
  const runtimeDirectory = dirname(configFile);
  try {
    await mkdir(runtimeDirectory, { mode: 0o700 });
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error;
  }
  await assertPrivateDirectory(runtimeDirectory);
  try {
    await lstat(configFile);
    throw new Error('refusing to overwrite scanner configuration');
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return;
    throw error;
  }
}

async function provisionPrivateConfig(
  configFile: string,
  parameters: LocalRegtestParameters,
): Promise<void> {
  await preparePrivateConfigPath(configFile);
  const result = await run('cargo', helperArguments(configFile, parameters));
  if (result.code !== 0 || result.stdout !== 'provisioned\n' || result.stderr.length !== 0) {
    throw new Error('disposable wallet provisioning failed');
  }
  await assertPrivateDirectory(dirname(configFile));
  await readPrivateFile(configFile);
}

export async function preflight(): Promise<PreflightResult> {
  // All ths interaction is intentionally confined to this harness.
  const doctor = await run('ths', ['doctor', '--json']);
  const endpoints = await run('ths', ['endpoints', '--name', 'ssf-task1', '--json']);
  const cargo = await run('cargo', ['check', '--locked', '--manifest-path', 'services/scanner/Cargo.toml']);

  const doctorJson = jsonOrNull(doctor.stdout);
  const endpointsJson = jsonOrNull(endpoints.stdout);
  const internals = {
    doctorOk: doctor.code === 0 && asObject(doctorJson) !== null,
    endpointKinds: endpoints.code === 0 ? endpointKinds(endpointsJson) : [],
    dashboardEndpoint: endpoints.code === 0 ? endpointFrom(endpointsJson, 'dashboard') : null,
    lightwalletdEndpoint: endpoints.code === 0 ? endpointFrom(endpointsJson, 'lightwalletd') : null,
    rpcEndpoint: endpoints.code === 0 ? endpointFrom(endpointsJson, 'rpc') : null,
  };
  if (
    !internals.doctorOk
    || endpoints.code !== 0
    || internals.dashboardEndpoint === null
    || internals.lightwalletdEndpoint === null
    || internals.rpcEndpoint === null
  ) {
    throw new Error('ths preflight failed');
  }

  return {
    publicResult: {
      status: cargo.code === 0 ? 'READY_FOR_SCANNER_CONFIG' : 'BLOCKED_DEPENDENCY_GRAPH',
      cargo: {
        check: cargo.code === 0 ? 'PASS' : 'FAIL',
        failure: cargo.code === 0 ? null : cargoFailure(cargo),
      },
      runtime: null,
    },
    internals,
  };
}

function reportThsObservation(internals: PreflightInternals): void {
  process.stdout.write(
    `THS_OBSERVATION: command=ths doctor --json; result=${internals.doctorOk ? 'parsed_json' : 'failed'}; sensitive_output=omitted\n`,
  );
  process.stdout.write(
    `THS_OBSERVATION: command=ths endpoints --name ssf-task1 --json; endpoint_kinds=${internals.endpointKinds.join(',')}; endpoint_values=omitted\n`,
  );
}

async function main(): Promise<void> {
  const configFile = configArgument(process.argv.slice(2));
  const { publicResult, internals } = await preflight();
  if (publicResult.status !== 'READY_FOR_SCANNER_CONFIG') {
    process.stderr.write('qualification blocked before scanner configuration\n');
    process.exitCode = 1;
    return;
  }

  const nodeChain = await rpc(internals.rpcEndpoint!, 'getblockchaininfo');
  const networkEvidence = await dashboardNetwork(internals.dashboardEndpoint!);
  const runtime = localRegtestParametersFromRpc(nodeChain, networkEvidence);
  await provisionPrivateConfig(configFile, runtime);
  const endpoint = internals.lightwalletdEndpoint!;
  await runScannerStage(configFile, endpoint, runtime, 'prepare');
  await fundOnlyAllocationA(configFile);
  await runScannerStage(configFile, endpoint, runtime, 'before-ten');
  await mineToTenConfirmations(configFile);
  await runScannerStage(configFile, endpoint, runtime, 'at-ten');
  await runScannerStage(configFile, endpoint, runtime, 'verify-restart');
  process.stdout.write(successfulQualificationStatus());
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    await main();
  } catch (error) {
    const reason = error instanceof Error ? error.message : 'unknown qualification failure';
    process.stderr.write(`qualification failed: ${reason}\n`);
    process.exitCode = 1;
  }
}

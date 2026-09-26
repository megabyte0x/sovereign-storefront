// `npm run backup:live -- export|restore|verify`: coordinated (v2) seller +
// scanner backup for the live stack.
//
// - export refuses while the seller or the scanner is running, asks the
//   scanner binary for `backup-info` (non-secret JSON) and seals the archive.
// - restore writes into fresh directories only and PRINTS the next commands
//   (retire the original, restore-ack --reserve-gap, start, rescan); it never
//   runs them.
// - verify decrypts and classifies an archive (v1 seller-only is incomplete).
//
// Output is limited to paths, the manifest version, the entry count and short
// non-secret facts. The backup key, UFVK, scanner.json contents and the seller
// private key are never printed. This script never starts or stops a service.
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, readlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  describeBackup,
  exportCoordinatedBackup,
  readBackupKeyFile,
  restoreCoordinatedBackup,
  type CoordinatedBackupManifest,
} from '../src/seller/backup.ts';
import { LIVE_ROOT, MAX_SOCKET_PATH_BYTES, SCANNER_JSON } from './live-infra/paths.ts';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SELLER_DIR = path.join(LIVE_ROOT, 'seller');
const SCANNER_BIN_REL = 'services/scanner/target/release/sovereign-storefront-scanner';
const SCANNER_PID_FILE = 'serve.pid';
const SELLER_PID_FILE = 'seller.pid';
/**
 * Suggested `restore-ack --reserve-gap`: diversifier indices burned past the
 * restored high-water mark, covering receivers the original scanner may have
 * issued after the backup. Must exceed the allocations made since the backup.
 */
export const SUGGESTED_RESERVE_GAP = 1000;

export type Proc = { pid: number; cmdline: string; cwd?: string };

export type BackupLiveDeps = {
  /** Running processes (pid, NUL-joined argv as spaces, optional cwd). */
  processes: () => Proc[];
  /** Runs the scanner binary; stderr is discarded (never echoed). */
  runScanner: (bin: string, args: string[]) => Promise<{ code: number; stdout: string }>;
  out: (line: string) => void;
  err: (line: string) => void;
  now: () => Date;
};

function listProcesses(): Proc[] {
  const procs: Proc[] = [];
  for (const name of readdirSync('/proc')) {
    if (!/^\d+$/.test(name)) continue;
    try {
      const cmdline = readFileSync(`/proc/${name}/cmdline`, 'utf8').split('\0').filter(Boolean).join(' ');
      let cwd: string | undefined;
      try { cwd = readlinkSync(`/proc/${name}/cwd`); } catch { cwd = undefined; }
      procs.push({ pid: Number(name), cmdline, cwd });
    } catch {
      // Process exited or is not ours to read.
    }
  }
  return procs;
}

function runScannerBinary(bin: string, args: string[]): Promise<{ code: number; stdout: string }> {
  return new Promise(resolve => {
    execFile(bin, args, { timeout: 60_000, maxBuffer: 1 << 20 }, (error, stdout) => {
      const code = error ? (typeof (error as { code?: unknown }).code === 'number' ? (error as { code: number }).code : 1) : 0;
      resolve({ code, stdout: String(stdout) });
    });
  });
}

export const DEFAULT_DEPS: BackupLiveDeps = {
  processes: listProcesses,
  runScanner: runScannerBinary,
  out: line => process.stdout.write(`${line}\n`),
  err: line => process.stderr.write(`${line}\n`),
  now: () => new Date(),
};

type Args = Record<string, string>;

const FLAGS: Record<string, readonly string[]> = {
  export: ['--repo-root', '--seller-db', '--scanner-config', '--key-file', '--scanner-bin', '--out'],
  restore: ['--repo-root', '--archive', '--key-file', '--seller-dir', '--scanner-dir', '--scanner-bin'],
  verify: ['--archive', '--key-file'],
};

function parseArgs(command: string, argv: readonly string[]): Args {
  const allowed = FLAGS[command];
  if (allowed === undefined) throw new Error('usage: backup:live export|restore|verify [--flag value ...]');
  const args: Args = {};
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i]!;
    const value = argv[i + 1];
    if (!allowed.includes(flag)) throw new Error(`unknown flag for ${command}: ${flag}`);
    if (value === undefined || value.startsWith('--')) throw new Error(`missing value for ${flag}`);
    if (flag in args) throw new Error(`duplicate flag ${flag}`);
    args[flag] = value;
  }
  return args;
}

function scannerStateDir(configPath: string): string {
  return path.join(path.dirname(configPath), `.${path.basename(configPath)}.live-state`);
}

function readPid(file: string): number | undefined {
  try {
    const pid = Number(readFileSync(file, 'utf8').trim());
    return Number.isInteger(pid) && pid > 0 ? pid : undefined;
  } catch {
    return undefined;
  }
}

function isScanner(proc: Proc, configPath: string): boolean {
  const c = proc.cmdline;
  return (c.includes('sovereign-storefront-scanner') || c.includes('services/scanner/Cargo.toml'))
    && /(^|\s)serve(\s|$)/.test(c)
    && c.includes(configPath);
}

function isSeller(proc: Proc, repoRoot: string): boolean {
  const c = proc.cmdline;
  if (c.includes(path.join(repoRoot, 'dist', 'service', 'main.js'))) return true;
  return c.includes('scripts/start-live.ts') && (proc.cwd === repoRoot || c.includes(path.join(repoRoot, 'scripts', 'start-live.ts')));
}

/** Throws if the seller or scanner for these paths is running (PID file first, then a /proc scan). */
export function assertServicesStopped(
  procs: Proc[],
  paths: { repoRoot: string; sellerDb: string; scannerConfig: string },
): void {
  const byPid = new Map(procs.map(p => [p.pid, p]));
  const checks: Array<{ name: string; pidFile: string; match: (p: Proc) => boolean }> = [
    { name: 'scanner', pidFile: path.join(path.dirname(paths.scannerConfig), SCANNER_PID_FILE), match: p => isScanner(p, paths.scannerConfig) },
    { name: 'seller', pidFile: path.join(path.dirname(paths.sellerDb), SELLER_PID_FILE), match: p => isSeller(p, paths.repoRoot) },
  ];
  for (const check of checks) {
    const pid = readPid(check.pidFile);
    const fromFile = pid === undefined ? undefined : byPid.get(pid);
    const live = fromFile !== undefined && check.match(fromFile) ? fromFile : procs.find(check.match);
    if (live !== undefined) {
      throw new Error(`${check.name} is running (pid ${live.pid}); stop it before exporting`);
    }
  }
}

type ScannerInfo = { accountId: string; sourceId: string; network: 'regtest' | 'test'; reservedHighWater: string };

function parseScannerInfo(stdout: string): ScannerInfo {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(stdout.trim()) as Record<string, unknown>;
  } catch {
    throw new Error('scanner backup-info returned malformed output');
  }
  const { accountId, sourceId, network, reservedHighWater } = parsed ?? {};
  if (typeof accountId !== 'string' || typeof sourceId !== 'string' || typeof reservedHighWater !== 'string'
    || !/^\d+$/.test(reservedHighWater) || (network !== 'regtest' && network !== 'test')) {
    throw new Error('scanner backup-info returned malformed output');
  }
  return { accountId, sourceId, network, reservedHighWater };
}

/** Creates a 0600 key file (umask 077) if missing. The key is never printed. */
function ensureKeyFile(file: string): boolean {
  if (existsSync(file)) return false;
  const previous = process.umask(0o077);
  try {
    mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    writeFileSync(file, `${randomBytes(32).toString('hex')}\n`, { mode: 0o600, flag: 'wx' });
  } finally {
    process.umask(previous);
  }
  return true;
}

function identityPrefix(manifest: CoordinatedBackupManifest): string {
  return `${manifest.sellerIdentityPublicKeyHex.slice(0, 16)}…`;
}

function summary(out: (line: string) => void, manifest: CoordinatedBackupManifest): void {
  out(`version: ${manifest.version}`);
  out(`entries: ${manifest.entries.length}`);
  out(`sellerIdentity: ${identityPrefix(manifest)}`);
  out(`scanner: accountId=${manifest.scanner.accountId} sourceId=${manifest.scanner.sourceId} network=${manifest.scanner.network}`);
  out(`reservedHighWater: ${manifest.reservedHighWater}`);
}

async function runExport(args: Args, deps: BackupLiveDeps): Promise<number> {
  const repoRoot = path.resolve(args['--repo-root'] ?? REPO_ROOT);
  const sellerDb = path.resolve(args['--seller-db'] ?? path.join(SELLER_DIR, 'seller.sqlite'));
  const scannerConfig = path.resolve(args['--scanner-config'] ?? SCANNER_JSON);
  const keyFile = path.resolve(args['--key-file'] ?? path.join(SELLER_DIR, 'backup.key'));
  const scannerBin = path.resolve(args['--scanner-bin'] ?? path.join(repoRoot, SCANNER_BIN_REL));
  const stamp = deps.now().toISOString().replace(/[:.]/g, '-');
  const outPath = path.resolve(args['--out'] ?? path.join(LIVE_ROOT, 'backups', `coordinated-${stamp}.ssbk`));
  const paths = { repoRoot, sellerDb, scannerConfig };

  // Nothing is read, created or run before both services are proven stopped.
  assertServicesStopped(deps.processes(), paths);
  const info = await deps.runScanner(scannerBin, ['backup-info', '--config', scannerConfig]);
  if (info.code !== 0) throw new Error(`scanner backup-info failed (exit ${info.code})`);
  const scannerInfo = parseScannerInfo(info.stdout);
  if (ensureKeyFile(keyFile)) deps.out(`created backup key file (0600): ${keyFile}`);

  const manifest = await exportCoordinatedBackup({
    sellerDbPath: sellerDb,
    scannerConfigPath: scannerConfig,
    scannerStateDir: scannerStateDir(scannerConfig),
    backupKeyFile: keyFile,
    outPath,
    scannerInfo,
    assertStopped: async () => assertServicesStopped(deps.processes(), paths),
  });
  deps.out(`archive: ${outPath}`);
  summary(deps.out, manifest);
  deps.out('Store the key file separately from the archive; the archive is useless without it.');
  return 0;
}

async function runRestore(args: Args, deps: BackupLiveDeps): Promise<number> {
  const archive = args['--archive'];
  const sellerArg = args['--seller-dir'];
  const scannerArg = args['--scanner-dir'];
  if (archive === undefined || sellerArg === undefined || scannerArg === undefined) {
    throw new Error('restore requires --archive FILE --seller-dir DIR --scanner-dir DIR (fresh, empty directories)');
  }
  const repoRoot = path.resolve(args['--repo-root'] ?? REPO_ROOT);
  const keyFile = path.resolve(args['--key-file'] ?? path.join(SELLER_DIR, 'backup.key'));
  const scannerBin = path.resolve(args['--scanner-bin'] ?? path.join(repoRoot, SCANNER_BIN_REL));
  const sellerDir = path.resolve(sellerArg);
  const scannerDir = path.resolve(scannerArg);

  const manifest = await restoreCoordinatedBackup({
    archivePath: path.resolve(archive),
    backupKeyFile: keyFile,
    sellerDir,
    scannerDir,
  });
  const entry = (role: string) => manifest.entries.find(e => e.role === role)!.relPath.split('/').pop()!;
  const sellerDb = path.join(sellerDir, entry('seller-db'));
  const config = path.join(scannerDir, entry('scanner-config'));
  const socket = path.join(scannerStateDir(config), 'scanner.sock');

  deps.out(`restored seller: ${sellerDir}`);
  deps.out(`restored scanner: ${scannerDir}`);
  summary(deps.out, manifest);
  deps.out('');
  const tokenFile = path.join(SELLER_DIR, 'admin.token');
  deps.out('Next commands (NOT run by this tool; run them in order). See docs/runbook.md "Restore (into fresh directories)".');
  deps.out('  0. retire the original stack first: stop the original scanner and seller and never restart them.');
  deps.out('     Two stacks with the same viewing key must never allocate receivers concurrently.');
  deps.out(`  1. acknowledge the restore (new source epoch; restored evidence is revoked). --reserve-gap N burns N`);
  deps.out(`     receiver indices past reservedHighWater, so receivers the original issued after the backup are never`);
  deps.out(`     reissued; N must exceed the allocations made since this backup (suggested ${SUGGESTED_RESERVE_GAP}):`);
  deps.out(`     ${scannerBin} restore-ack --config ${config} --new-epoch --reserve-gap ${SUGGESTED_RESERVE_GAP}`);
  deps.out(`  2. start the restored scanner (detached, as infra:up does) and wait for its socket:`);
  deps.out(`     ${scannerBin} serve --config ${config}`);
  if (Buffer.byteLength(socket) > MAX_SOCKET_PATH_BYTES) {
    deps.out(`     WARNING: socket path ${socket} exceeds ${MAX_SOCKET_PATH_BYTES} bytes; restore into a shorter --scanner-dir`);
  }
  deps.out(`  3. point live.env SSF_SCANNER_SOCKET at ${socket}, then start the seller on the restored data`);
  deps.out(`     (SSF_ADMIN_TOKEN_FILE must name an existing owner-only 0600 token file; its value is never printed):`);
  deps.out('     npm run build');
  deps.out(`     SSF_MODE=real-demo SSF_NETWORK=regtest SSF_ADMIN_TOKEN_FILE=${tokenFile} SSF_SCANNER_CONFIG=${config} SSF_DB_PATH=${sellerDb} npm run start:live`);
  deps.out('  4. rescan before first release: let the restored scanner finish a full scan pass and report');
  deps.out('     caught-up with a fresh checkedAt before any order is released; a fresh epoch starts unpaid-until-rescanned.');
  return 0;
}

async function runVerify(args: Args, deps: BackupLiveDeps): Promise<number> {
  const archive = args['--archive'];
  if (archive === undefined) throw new Error('verify requires --archive FILE');
  const keyFile = path.resolve(args['--key-file'] ?? path.join(SELLER_DIR, 'backup.key'));
  const description = await describeBackup({ encrypted: readFileSync(path.resolve(archive)), key: readBackupKeyFile(keyFile) });
  deps.out(`archive: ${path.resolve(archive)}`);
  deps.out(`complete: ${description.complete}`);
  if (description.version === 2) {
    summary(deps.out, description.manifest);
    return 0;
  }
  deps.out(`version: ${description.version}`);
  for (const limitation of description.limitations) deps.out(`limitation: ${limitation}`);
  return 1;
}

export async function main(argv: readonly string[] = process.argv.slice(2), deps: BackupLiveDeps = DEFAULT_DEPS): Promise<number> {
  const [command, ...rest] = argv;
  try {
    const args = parseArgs(command ?? '', rest);
    if (command === 'export') return await runExport(args, deps);
    if (command === 'restore') return await runRestore(args, deps);
    return await runVerify(args, deps);
  } catch (error) {
    deps.err(`backup:live ${command ?? ''} failed: ${error instanceof Error ? error.message : 'unknown error'}`);
    return 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main();
}

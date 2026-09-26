/**
 * Single-node Logos helper (gate D2 = a): stop / start / status for node A
 * ONLY. There is deliberately no code path that can address any other node.
 *
 *   node --experimental-strip-types scripts/live-infra/logos-node.ts <stop|start|status> --node a
 *
 * Prints only `node-a stopped|started|running` lines on stdout.
 */
import { execFile as nodeExecFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { parseDaemonStatus } from './logos-up.ts';
import { LIVE_ROOT } from './paths.ts';

type NodeSpec = { dir: string; listenPort: number; discPort: number };

export type ExecResult = { code: number; stdout: string; stderr: string };

export type LogosNodeDeps = {
  env: Record<string, string | undefined>;
  /** Never rejects on a non-zero exit; reports it in `code`. */
  execFile: (cmd: string, args: string[], timeoutMs: number) => Promise<ExecResult>;
  readFile: (p: string) => string;
  bringUpNode: (logosctlPath: string, node: NodeSpec) => Promise<{ peerId: string }>;
  sleep: (ms: number) => Promise<void>;
  out: (line: string) => void;
};

const USAGE = 'usage: logos-node.ts <stop|start|status> --node a';
const COMMANDS = new Set(['stop', 'start', 'status']);
const NODE_DIR_BASENAME = 'node-a';
const STORAGE_STOP_SETTLE_MS = 15_000;
const STOP_POLL_ATTEMPTS = 15;
const STOP_POLL_INTERVAL_MS = 1_000;

function parseArgs(argv: string[]): 'stop' | 'start' | 'status' {
  if (argv.length !== 3 || !COMMANDS.has(argv[0]) || argv[1] !== '--node') throw new Error(USAGE);
  if (argv[2] !== 'a') throw new Error(`only node a is supported (${USAGE})`);
  return argv[0] as 'stop' | 'start' | 'status';
}

function resolveNodeA(env: Record<string, string | undefined>): { logosctl: string; dir: string } {
  const dir = env.LOGOS_NODE_A;
  if (!dir || !path.isAbsolute(dir) || path.basename(path.resolve(dir)) !== NODE_DIR_BASENAME) {
    throw new Error(`LOGOS_NODE_A must be set to an absolute ${NODE_DIR_BASENAME} directory`);
  }
  const logosctl = env.LOGOSCTL;
  if (!logosctl || !path.isAbsolute(logosctl)) throw new Error('LOGOSCTL must be set to an absolute path');
  return { logosctl, dir: path.resolve(dir) };
}

function scoped(dir: string, args: string[]): string[] {
  return ['--config-dir', dir, '--json', ...args];
}

/** `daemon status`, tolerating logosctl 0.2.3's exit 1 with valid JSON. */
async function daemonStatus(deps: LogosNodeDeps, logosctl: string, dir: string): Promise<string> {
  const r = await deps.execFile(logosctl, scoped(dir, ['daemon', 'status']), 60_000);
  const status = parseDaemonStatus(r.stdout);
  if (status === undefined) throw new Error(`node-a daemon status unparseable (exit ${r.code})`);
  return status;
}

/**
 * Refuse unless the daemon pid recorded in node A's `daemon/state.json` is a
 * process whose argv[0] is a logos binary and whose argv names node A's dir
 * exactly (as its own argument or `--flag=<dir>`).
 */
function assertOwnedDaemon(deps: LogosNodeDeps, dir: string): number {
  let pid: unknown;
  try {
    pid = JSON.parse(deps.readFile(path.join(dir, 'daemon', 'state.json')))?.pid;
  } catch {
    throw new Error('refusing to stop node-a: cannot read daemon pid from state.json');
  }
  if (!Number.isSafeInteger(pid) || (pid as number) <= 0) {
    throw new Error('refusing to stop node-a: state.json has no valid pid');
  }
  let argv: string[];
  try {
    argv = deps.readFile(`/proc/${pid}/cmdline`).split('\0').filter((a) => a !== '');
  } catch {
    throw new Error(`refusing to stop node-a: /proc/${pid}/cmdline unreadable`);
  }
  const binaryOk = argv.length > 0 && path.basename(argv[0]).includes('logos');
  const dirOk = argv.some((a) => a === dir || a.endsWith(`=${dir}`));
  if (!binaryOk || !dirOk) {
    throw new Error(`refusing to stop node-a: pid ${pid} cmdline is not a logos daemon for the node-a dir`);
  }
  return pid as number;
}

/** Only these daemon states are safe no-ops for `stop`; anything else (e.g. degraded) may still own a live pid. */
const STOPPED_STATUSES = new Set(['stopped', 'not_running', 'not_configured']);

async function stopNodeA(deps: LogosNodeDeps, logosctl: string, dir: string): Promise<void> {
  if (STOPPED_STATUSES.has(await daemonStatus(deps, logosctl, dir))) {
    deps.out('node-a stopped');
    return;
  }
  // Any other status (running, degraded, starting, ...) goes through the owned-pid check; refuses otherwise.
  assertOwnedDaemon(deps, dir);
  // Same sequence as logos-down.ts tearDownNode, for this one dir only.
  await deps.execFile(logosctl, scoped(dir, ['call', 'storage_module', 'stop']), 30_000);
  await deps.sleep(STORAGE_STOP_SETTLE_MS);
  await deps.execFile(logosctl, scoped(dir, ['call', 'storage_module', 'destroy']), 30_000);
  await deps.execFile(logosctl, scoped(dir, ['daemon', 'stop']), 30_000);
  for (let i = 0; i < STOP_POLL_ATTEMPTS; i += 1) {
    const status = await daemonStatus(deps, logosctl, dir).catch(() => undefined);
    if (status !== undefined && STOPPED_STATUSES.has(status)) {
      deps.out('node-a stopped');
      return;
    }
    await deps.sleep(STOP_POLL_INTERVAL_MS);
  }
  throw new Error('node-a daemon still running after daemon stop');
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * try/finally that never loses an error: runs `restore` after `body` always.
 * Body fails only -> rethrow the body error. Restore fails only -> throw it.
 * Both fail -> AggregateError([bodyErr, cleanupErr]) naming both messages.
 */
export async function runWithRestore<T>(body: () => Promise<T>, restore: () => Promise<void>): Promise<T> {
  let value: T;
  try {
    value = await body();
  } catch (bodyErr) {
    try {
      await restore();
    } catch (cleanupErr) {
      throw new AggregateError(
        [bodyErr, cleanupErr],
        `body failed: ${errorMessage(bodyErr)}; restore also failed: ${errorMessage(cleanupErr)}`,
      );
    }
    throw bodyErr;
  }
  await restore();
  return value;
}

function readPorts(deps: LogosNodeDeps, dir: string): { listenPort: number; discPort: number } {
  let init: any;
  try {
    init = JSON.parse(deps.readFile(path.join(dir, 'storage-init.json')));
  } catch {
    throw new Error('node-a storage-init.json unreadable; cannot resolve ports');
  }
  const listenPort = init?.['listen-port'];
  const discPort = init?.['disc-port'];
  const valid = (p: unknown) => Number.isInteger(p) && (p as number) > 0 && (p as number) < 65536;
  if (!valid(listenPort) || !valid(discPort)) throw new Error('node-a storage-init.json has invalid listen/disc port');
  return { listenPort, discPort };
}

export async function runLogosNode(argv: string[], deps: LogosNodeDeps): Promise<void> {
  const command = parseArgs(argv);
  const { logosctl, dir } = resolveNodeA(deps.env);
  if (command === 'status') {
    deps.out((await daemonStatus(deps, logosctl, dir)) === 'running' ? 'node-a running' : 'node-a stopped');
    return;
  }
  if (command === 'stop') {
    await stopNodeA(deps, logosctl, dir);
    return;
  }
  const ports = readPorts(deps, dir);
  await deps.bringUpNode(logosctl, { dir, ...ports });
  deps.out('node-a started');
}

// ---------------------------------------------------------------------------
// CLI wiring (real process / fs)
// ---------------------------------------------------------------------------

function readLiveEnv(): Record<string, string> {
  const envPath = path.join(LIVE_ROOT, 'live.env');
  if (!existsSync(envPath)) return {};
  return Object.fromEntries(
    readFileSync(envPath, 'utf8')
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l !== '' && !l.startsWith('#') && l.includes('='))
      .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)] as const),
  );
}

function defaultDeps(): LogosNodeDeps {
  const env = { ...readLiveEnv(), ...process.env };
  return {
    env,
    execFile: (cmd, args, timeoutMs) => new Promise((resolve) => {
      nodeExecFile(
        cmd,
        args,
        { env: { ...process.env, APPIMAGE_EXTRACT_AND_RUN: '1' }, timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 },
        (err: any, stdout, stderr) => {
          const code = err ? (typeof err.code === 'number' ? err.code : 1) : 0;
          resolve({ code, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') });
        },
      );
    }),
    readFile: (p) => readFileSync(p, 'utf8'),
    // Lazy import: reuses logos-up.ts's single-node bring-up without copying it.
    bringUpNode: async (logosctlPath, node) => {
      const mod: any = await import('./logos-up.ts');
      if (typeof mod.bringUpNode !== 'function') throw new Error('logos-up.ts does not export bringUpNode');
      return mod.bringUpNode(logosctlPath, node);
    },
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    out: (line) => process.stdout.write(`${line}\n`),
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runLogosNode(process.argv.slice(2), defaultDeps()).catch((e) => {
    process.stderr.write(`logos-node failed: ${e?.message ?? e}\n`);
    process.exitCode = 1;
  });
}

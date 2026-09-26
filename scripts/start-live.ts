// `npm run start:live`: run the built seller against the live stack.
// Reads .runtime/live/live.env (never printed), overlays real-demo settings,
// and spawns only its own `node dist/service/main.js` child. It never calls
// infra:*, ths, or signals any process other than that child.
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensurePrivateDir, LIVE_ROOT, SCANNER_JSON } from './live-infra/paths.ts';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const LIVE_ENV_PATH = path.join(LIVE_ROOT, 'live.env');
const SELLER_DIR = path.join(LIVE_ROOT, 'seller');

export type LiveDefaults = { scannerConfig: string; adminTokenFile: string; dbPath: string };

export const DEFAULT_PATHS: LiveDefaults = {
  scannerConfig: SCANNER_JSON,
  adminTokenFile: path.join(SELLER_DIR, 'admin.token'),
  dbPath: path.join(SELLER_DIR, 'seller.sqlite'),
};

/** Keys real-demo rejects inline; they are never forwarded to the child. */
const DROPPED_KEYS = ['SSF_ADMIN_TOKEN', 'SSF_SELLER_KEY_ID'];

const FORCED: Record<string, string> = {
  SSF_MODE: 'real-demo',
  SSF_NETWORK: 'regtest',
  SSF_ADAPTER_MESSAGING: 'real',
  SSF_ADAPTER_STORAGE: 'real',
  SSF_ADAPTER_SCANNER: 'real',
};

/** Global real-demo limits (config.ts REAL_DEMO_* caps; 10 confirmations; 24 h invoice TTL). */
const LIMIT_DEFAULTS: Record<string, string> = {
  SSF_MIN_CONFIRMATIONS: '10',
  SSF_MAX_HEALTH_AGE_MS: '120000',
  SSF_MAX_CIPHERTEXT_BYTES: '73',
  SSF_MAX_PLAINTEXT_BYTES: '41',
  SSF_INVOICE_TTL_MS: '86400000',
};

/** Parse simple `KEY=VALUE` lines (optional `export`, optional surrounding quotes). */
export function parseEnvText(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
    if (!match) continue;
    let value = match[2]!;
    if (value.length >= 2 && (value[0] === '"' || value[0] === "'") && value.at(-1) === value[0]) {
      value = value.slice(1, -1);
    }
    out[match[1]!] = value;
  }
  return out;
}

/**
 * Pure: caller env, then live.env, then the forced real-demo overlay. Default
 * paths fill in only where the caller did not set them. Inline secrets are dropped.
 */
export function buildLiveEnv(
  liveEnvText: string,
  callerEnv: NodeJS.Dict<string>,
  defaults: LiveDefaults = DEFAULT_PATHS,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(callerEnv)) {
    if (value !== undefined) env[key] = value;
  }
  Object.assign(env, parseEnvText(liveEnvText), FORCED);
  const fill = (key: string, value: string): void => {
    if (!callerEnv[key]) env[key] = value;
  };
  fill('SSF_SCANNER_CONFIG', defaults.scannerConfig);
  fill('SSF_ADMIN_TOKEN_FILE', defaults.adminTokenFile);
  fill('SSF_DB_PATH', defaults.dbPath);
  // loadConfig requires these limits; live.env carries none of them. The
  // defaults are the real-demo caps and the 10-confirmation floor; loadConfig
  // rejects anything looser, so a caller may only tighten them.
  for (const [key, value] of Object.entries(LIMIT_DEFAULTS)) {
    if (!callerEnv[key] && !env[key]) env[key] = value;
  }
  for (const key of DROPPED_KEYS) delete env[key];
  return env;
}

export type EnvFileIo = { stat: (p: string) => { mode: number }; read: (p: string) => string };

/** Read live.env, requiring mode 0600. Never logs its contents. */
export function readLiveEnvFile(
  file: string,
  io: EnvFileIo = { stat: (p) => statSync(p), read: (p) => readFileSync(p, 'utf8') },
): string {
  const mode = io.stat(file).mode & 0o777;
  if (mode !== 0o600) {
    throw new Error(`live.env must be mode 0600 (found ${mode.toString(8)}); run npm run infra:up`);
  }
  return io.read(file);
}

/** True when both build outputs the seller needs exist. */
export function checkDist(root: string, exists: (p: string) => boolean = existsSync): boolean {
  return (
    exists(path.join(root, 'dist', 'service', 'main.js')) && exists(path.join(root, 'dist', 'browser', 'index.html'))
  );
}

/** Create the admin token file (0600, 32 random bytes hex) if absent. Never prints it. */
function ensureAdminToken(file: string): void {
  if (existsSync(file)) return;
  ensurePrivateDir(path.dirname(file));
  writeFileSync(file, `${randomBytes(32).toString('hex')}\n`, { mode: 0o600, flag: 'wx' });
}

async function main(): Promise<number> {
  if (!checkDist(REPO_ROOT)) {
    console.error('run npm run build first');
    return 2;
  }
  let env: Record<string, string>;
  try {
    env = buildLiveEnv(readLiveEnvFile(LIVE_ENV_PATH), process.env);
  } catch (error) {
    console.error(error instanceof Error && /0600/.test(error.message) ? error.message : 'cannot read live.env; run npm run infra:up');
    return 1;
  }
  if (!process.env.SSF_ADMIN_TOKEN_FILE) ensureAdminToken(env.SSF_ADMIN_TOKEN_FILE!);
  if (!process.env.SSF_DB_PATH) ensurePrivateDir(path.dirname(env.SSF_DB_PATH!));

  // Own process group: a terminal Ctrl-C reaches only this wrapper, which
  // forwards exactly one signal, so the child does not see a double signal.
  const child = spawn(process.execPath, [path.join(REPO_ROOT, 'dist', 'service', 'main.js')], {
    cwd: REPO_ROOT,
    env,
    stdio: ['ignore', 'inherit', 'inherit'],
    detached: true,
  });
  const forward = (signal: NodeJS.Signals) => () => {
    if (child.exitCode === null && child.signalCode === null) child.kill(signal);
  };
  process.on('SIGINT', forward('SIGINT'));
  process.on('SIGTERM', forward('SIGTERM'));
  // If this wrapper dies unexpectedly, do not leave its own child running.
  process.on('exit', () => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
  });
  return new Promise<number>((resolve) => {
    child.on('error', () => resolve(1));
    child.on('exit', (code, signal) => resolve(code ?? (signal ? 128 + (signalNumber(signal) ?? 0) : 1)));
  });
}

function signalNumber(signal: NodeJS.Signals): number | undefined {
  return ({ SIGINT: 2, SIGTERM: 15, SIGKILL: 9, SIGHUP: 1 } as Record<string, number>)[signal];
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main();
}

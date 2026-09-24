import { existsSync, lstatSync, mkdirSync, chmodSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Absolute path to `.runtime/live`, the private root for all live-infra state. */
export const LIVE_ROOT: string = path.resolve(__dirname, '../../.runtime/live');

/**
 * Resolve the scanner state directory. It lives outside the worktree because
 * the scanner's Unix socket path is derived from it and Linux caps
 * `sockaddr_un.sun_path` at 108 bytes. Pure: takes env and home explicitly.
 */
export function resolveScannerDir(env: Record<string, string | undefined>, home: string): string {
  const override = env.SSF_LIVE_SCANNER_DIR;
  if (override !== undefined && override !== '') {
    if (!path.isAbsolute(override)) {
      throw new Error(`SSF_LIVE_SCANNER_DIR must be absolute, got: ${override}`);
    }
    return override;
  }
  const stateHome = env.XDG_STATE_HOME || path.join(home, '.local/state');
  return path.join(stateHome, 'ssf-live', 'scanner');
}

/** Scanner state dir (short path; see resolveScannerDir). */
export const SCANNER_DIR: string = resolveScannerDir(process.env, os.homedir());
export const SCANNER_JSON: string = path.join(SCANNER_DIR, 'scanner.json');
/** Mirrors services/scanner/src/config.rs: `<dir>/.<basename>.live-state/scanner.sock`. */
export const SCANNER_SOCKET: string = path.join(SCANNER_DIR, '.scanner.json.live-state', 'scanner.sock');

/** Max socket path bytes we accept; leaves margin under the 108-byte sun_path limit. */
export const MAX_SOCKET_PATH_BYTES = 100;

/** Throw unless `p` is an absolute path short enough to connect to as a Unix socket. */
export function assertSocketPathFits(p: string): void {
  if (!path.isAbsolute(p)) {
    throw new Error(`unix socket path must be absolute, got: ${p}`);
  }
  const n = Buffer.byteLength(p);
  if (n > MAX_SOCKET_PATH_BYTES) {
    throw new Error(`unix socket path too long (${n} bytes > ${MAX_SOCKET_PATH_BYTES})`);
  }
}

/**
 * Ensure a private (mode 0700) directory exists at `dirPath`.
 * Creates it (and parents) if absent. If it already exists, it must be a
 * real directory (not a symlink) with mode 0700 exactly, or this throws.
 */
export function ensurePrivateDir(dirPath: string): void {
  if (!existsSync(dirPath)) {
    mkdirSync(dirPath, { recursive: true, mode: 0o700 });
    chmodSync(dirPath, 0o700);
    return;
  }
  const st = lstatSync(dirPath);
  if (st.isSymbolicLink()) {
    throw new Error(`refusing to use symlink as private dir: ${dirPath}`);
  }
  if (!st.isDirectory()) {
    throw new Error(`expected a directory at ${dirPath}`);
  }
  const mode = st.mode & 0o777;
  if (mode !== 0o700) {
    throw new Error(`expected mode 0700 at ${dirPath}, found ${mode.toString(8)}`);
  }
}

/**
 * Merge `patch` keys into `.runtime/live/live.env`, preserving unrelated
 * existing keys. Not concurrency-safe by design: callers (the *-up.ts
 * bring-up scripts) run strictly sequentially, per Task 5's `up.ts`.
 * Rewrites atomically (temp file + fsync + rename), mode 0600.
 */
export function mergeLiveEnv(patch: Record<string, string>): void {
  ensurePrivateDir(LIVE_ROOT);
  const envPath = path.join(LIVE_ROOT, 'live.env');
  const existing: Record<string, string> = existsSync(envPath)
    ? Object.fromEntries(
        readFileSync(envPath, 'utf8')
          .split('\n')
          .map((raw) => raw.trim())
          .filter((line) => line !== '' && !line.startsWith('#'))
          .map((line) => {
            const eq = line.indexOf('=');
            return [line.slice(0, eq), line.slice(eq + 1)] as const;
          }),
      )
    : {};
  const merged = { ...existing, ...patch };
  const body = `${Object.entries(merged)
    .map(([k, v]) => `${k}=${v}`)
    .join('\n')}\n`;
  const tmpPath = `${envPath}.tmp`;
  writeFileSync(tmpPath, body, { mode: 0o600 });
  chmodSync(tmpPath, 0o600);
  renameSync(tmpPath, envPath);
}

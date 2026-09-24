import { existsSync, openSync, closeSync, readFileSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { execFile, spawn } from 'node:child_process';
import http from 'node:http';
import path from 'node:path';
import {
  LIVE_ROOT,
  SCANNER_DIR,
  SCANNER_JSON,
  SCANNER_SOCKET,
  assertSocketPathFits,
  ensurePrivateDir,
  mergeLiveEnv,
} from './paths.ts';
import { localRegtestParametersFromRpc, helperArguments, dashboardNetwork } from '../qualify-payments.ts';

const OWNED_ENV_NAME = 'ssf-live';

/** Refuses to operate on any ths environment except the one this plan owns. */
export function assertOwnedEnvName(name: string): void {
  if (name !== OWNED_ENV_NAME) {
    throw new Error(`not an owned environment: ${JSON.stringify(name)}`);
  }
}

/** The `serve` invocation: a config path only, never a key or seed argument. */
export function serveCommand(configPath: string): string[] {
  return [
    'run',
    '--locked',
    '--release',
    '--quiet',
    '--manifest-path',
    'services/scanner/Cargo.toml',
    '--',
    'serve',
    '--config',
    configPath,
  ];
}

/**
 * Removes a stale scanner config and its wallet state so the helper can
 * re-provision. The helper creates `scanner.json` with O_EXCL and exits 1
 * silently if it already exists; the wallet DB under the live-state dir
 * belongs to the torn-down chain and must not be reused either. Refuses
 * while a serve process still holds that state.
 */
export function clearStaleScannerState(scannerJson: string, options: { serving: boolean }): void {
  if (options.serving) {
    throw new Error('refusing to clear scanner state while scanner serve is running');
  }
  const liveState = path.join(path.dirname(scannerJson), `.${path.basename(scannerJson)}.live-state`);
  rmSync(scannerJson, { force: true });
  rmSync(liveState, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// Live bring-up (not exercised by unit tests)
// ---------------------------------------------------------------------------

function execJson(cmd: string, args: string[], ms = 15_000): Promise<any> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${cmd} ${args.join(' ')} timed out`)), ms);
    execFile(cmd, args, { maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      clearTimeout(timer);
      if (err) { reject(new Error(`${cmd} ${args.join(' ')} failed: ${stderr || err.message}`)); return; }
      try { resolve(JSON.parse(stdout)); } catch (e) { reject(e); }
    });
  });
}

function execPlain(cmd: string, args: string[], ms = 120_000): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${cmd} ${args.join(' ')} timed out`)), ms);
    execFile(cmd, args, { maxBuffer: 32 * 1024 * 1024 }, (err, stdout, stderr) => {
      clearTimeout(timer);
      if (err) { reject(new Error(`${cmd} ${args.join(' ')} failed: ${stderr || err.message}`)); return; }
      resolve({ stdout, stderr });
    });
  });
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

const POLL_ERROR_MAX = 200;

/**
 * A short, body-free description of a poll attempt's failure. JSON parse
 * errors quote the offending response text, so they are replaced wholesale.
 */
function describePollError(e: unknown): string {
  if (e instanceof SyntaxError) return 'invalid JSON response';
  const message = e instanceof Error ? e.message : String(e);
  return message.replace(/\s+/g, ' ').trim().slice(0, POLL_ERROR_MAX);
}

/**
 * Polls `fn` until it yields a value. On timeout the error carries the last
 * attempt's failure (`(last: <message>)`) so a persistent cause such as an
 * ENOENT socket is visible instead of swallowed.
 */
export async function pollUntil<T>(fn: () => Promise<T | undefined>, deadlineMs: number, label: string, intervalMs = 2_000): Promise<T> {
  const deadline = Date.now() + deadlineMs;
  let lastError: string | undefined;
  for (;;) {
    const result = await fn().catch((e: unknown) => {
      lastError = describePollError(e);
      return undefined;
    });
    if (result !== undefined) return result;
    if (Date.now() > deadline) {
      const suffix = lastError === undefined ? '' : ` (last: ${lastError})`;
      throw new Error(`${label} did not become ready within ${deadlineMs}ms${suffix}`);
    }
    await sleep(intervalMs);
  }
}

function httpGetJson(socketPath: string, reqPath: string, timeoutMs = 10_000): Promise<any> {
  return new Promise((resolve, reject) => {
    // The scanner's hand-rolled HTTP parser requires an explicit
    // Content-Length even on a bodyless GET, or it replies 400 request_malformed.
    const req = http.request({ socketPath, path: reqPath, method: 'GET', headers: { 'content-length': '0' } }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => {
        try { resolve(JSON.parse(body)); } catch (e) { reject(e); }
      });
    });
    // http.request has no default timeout: a connection that hangs after
    // connect (no response, no error) would otherwise leave this promise
    // pending forever, which stalls pollUntil's deadline check indefinitely
    // (it's only checked between completed attempts).
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`socket request to ${reqPath} timed out after ${timeoutMs}ms`)));
    req.on('error', reject);
    req.end();
  });
}

function pidRunning(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

/**
 * `fetch` has no built-in timeout. `pollUntil`'s deadline is only checked
 * between attempts, so a single hung request inside it can block the whole
 * loop forever regardless of the deadline — every network call in this
 * script must carry its own hard timeout.
 */
function fetchWithTimeout(url: string, init: RequestInit, ms: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  return fetch(url, { ...init, signal: controller.signal }).finally(() => clearTimeout(timer));
}

function trace(label: string): void {
  if (process.env.ZCASH_UP_TRACE === '1') {
    process.stderr.write(`[trace ${new Date().toISOString()}] ${label}\n`);
  }
}

async function main(): Promise<void> {
  const envName = process.env.THS_ENV_NAME ?? OWNED_ENV_NAME;
  assertOwnedEnvName(envName);
  trace('start');

  const zcashDir = path.join(LIVE_ROOT, 'zcash');
  // Scanner state lives at a short path outside the worktree: its Unix
  // socket path must fit sockaddr_un.sun_path (108 bytes).
  const scannerDir = SCANNER_DIR;
  assertSocketPathFits(SCANNER_SOCKET);
  ensurePrivateDir(LIVE_ROOT);
  ensurePrivateDir(zcashDir);
  ensurePrivateDir(path.dirname(SCANNER_DIR));
  ensurePrivateDir(SCANNER_DIR);

  // Step 2: start ths if not already running.
  trace('step2: checking ths status');
  const initialStatus = await execJson('ths', ['status', '--name', envName, '--json']).catch(() => ({ running: false }));
  trace(`step2: ths running=${initialStatus?.running}`);
  if (initialStatus?.running !== true) {
    const logPath = path.join(zcashDir, 'ths-start.log');
    const logFd = openSync(logPath, 'a', 0o600);
    const child = spawn('ths', ['start', '--name', envName, '--no-open'], {
      detached: true,
      stdio: ['ignore', logFd, logFd],
    });
    closeSync(logFd);
    child.unref();
    writeFileSync(path.join(zcashDir, 'ths.pid'), `${child.pid}\n`, { mode: 0o600 });
    chmodSync(path.join(zcashDir, 'ths.pid'), 0o600);
  }

  // Step 3: poll endpoints + dashboard until wallet sync is ready.
  trace('step3: polling wallet sync');
  const endpoints = await pollUntil(
    async () => {
      const eps = await execJson('ths', ['endpoints', '--name', envName, '--json']);
      const dashboard = eps?.dashboard;
      if (!dashboard) return undefined;
      const statusRes = await fetchWithTimeout(`${String(dashboard).replace(/\/$/, '')}/api/v1/status`, {}, 10_000);
      if (!statusRes.ok) return undefined;
      const status: any = await statusRes.json();
      if (status?.wallet_sync?.state !== 'ready') return undefined;
      return eps;
    },
    180_000,
    'ths wallet sync',
  );
  trace('step3: wallet sync ready');
  writeFileSync(path.join(zcashDir, 'endpoints.json'), `${JSON.stringify(endpoints)}\n`, { mode: 0o600 });
  chmodSync(path.join(zcashDir, 'endpoints.json'), 0o600);

  const rpc: string = endpoints.rpc;
  const dashboard: string = endpoints.dashboard;
  const lightwalletd: string = endpoints.lightwalletd;

  // Step 4: derive helper config + provision runtime.
  // Regenerated whenever missing OR stale: `ths` assigns fresh random ports
  // on every `start`, so a scanner.json left over from an earlier ths
  // session (e.g. a prior failed run) points serve at a dead lightwalletd
  // endpoint. Comparing against the live endpoints keeps this idempotent
  // without needlessly re-provisioning on a normal restart.
  const scannerJson = SCANNER_JSON;
  const cachedLightwalletd = existsSync(scannerJson)
    ? (JSON.parse(readFileSync(scannerJson, 'utf8'))?.runtime?.lightwalletd as string | undefined)
    : undefined;
  trace(`step4: cachedLightwalletd=${cachedLightwalletd} liveLightwalletd=${lightwalletd}`);
  if (!existsSync(scannerJson) || cachedLightwalletd !== lightwalletd) {
    trace('step4: (re)provisioning scanner.json');
    const chainInfoRes = await fetchWithTimeout(rpc, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '1.0', id: 'zcash-up', method: 'getblockchaininfo', params: [] }),
    }, 10_000);
    const chainInfoEnvelope: any = await chainInfoRes.json();
    const chainInfo = chainInfoEnvelope.result;
    // zakurad reports chain:"test" even in regtest mode; the dashboard's
    // independently-sourced network evidence is required to accept it.
    const networkEvidence = await dashboardNetwork(dashboard);
    const parameters = localRegtestParametersFromRpc(chainInfo, networkEvidence);
    const servePidFile = path.join(SCANNER_DIR, 'serve.pid');
    const serving = existsSync(servePidFile) && pidRunning(Number(readFileSync(servePidFile, 'utf8').trim()));
    clearStaleScannerState(scannerJson, { serving });
    await execPlain('cargo', helperArguments(scannerJson, parameters), 300_000);
    await execPlain(
      'node',
      [
        '--experimental-strip-types',
        'scripts/provision-scanner-runtime.ts',
        '--config', scannerJson,
        '--rpc', rpc,
        '--dashboard', dashboard,
        '--lightwalletd', lightwalletd,
        '--source-id', envName,
      ],
      60_000,
    );
  }

  // Step 5: build the scanner and init-view (idempotent), unless a serve
  // process for this exact scanner.json is already running — init-view
  // mutates the wallet DB and conflicts with a live holder of its lock.
  const socketPath = SCANNER_SOCKET;
  const servePidPath = path.join(scannerDir, 'serve.pid');
  const alreadyServing = existsSync(servePidPath) && pidRunning(Number(readFileSync(servePidPath, 'utf8').trim()));
  trace(`step5: alreadyServing=${alreadyServing}; cargo build starting`);

  await execPlain(
    'cargo',
    ['build', '--locked', '--release', '--manifest-path', 'services/scanner/Cargo.toml'],
    600_000,
  );
  trace('step5: cargo build done');
  if (!alreadyServing) {
    trace('step5: init-view starting');
    const initView = await execPlain(
      'cargo',
      ['run', '--locked', '--release', '--quiet', '--manifest-path', 'services/scanner/Cargo.toml', '--', 'init-view', '--config', scannerJson],
      60_000,
    );
    if (!initView.stdout.includes('scanner_view_initialized')) {
      throw new Error('scanner init-view did not report scanner_view_initialized');
    }
  }

  // Step 6: spawn serve, detached; poll the socket until ready.
  trace('step6: starting');
  if (!alreadyServing) {
    const serveLogPath = path.join(scannerDir, 'serve.log');
    const serveLogFd = openSync(serveLogPath, 'a', 0o600);
    const serveArgs = serveCommand(scannerJson);
    const serveChild = spawn('cargo', serveArgs, { detached: true, stdio: ['ignore', serveLogFd, serveLogFd] });
    closeSync(serveLogFd);
    serveChild.unref();
    writeFileSync(servePidPath, `${serveChild.pid}\n`, { mode: 0o600 });
    chmodSync(servePidPath, 0o600);
  }
  const servePid = Number(readFileSync(servePidPath, 'utf8').trim());

  const snapshotBefore = await pollUntil(
    async () => {
      if (!pidRunning(servePid)) throw new Error('scanner serve process exited before becoming ready');
      const snap = await httpGetJson(socketPath, '/v1/snapshot').catch((e) => {
        trace(`step6 attempt: httpGetJson error: ${e?.message ?? e}`);
        throw e;
      });
      trace(`step6 attempt: complete=${snap?.complete} health=${snap?.health}`);
      if (snap?.complete === true && snap?.health === 'ready') return snap;
      return undefined;
    },
    // Measured 2026-09-24 (Subtask 2.3): with `ths` already up, a scanner-only
    // cold start (serve stopped, then zcash-up) went from `step6: starting` to
    // `step6: scanner ready` in 2.018 s and 2.014 s (one ECONNREFUSED poll, then
    // complete/ready on the next 2 s poll). The earlier 300-500 s "cold start"
    // was an artifact: the old scanner socket path exceeded the 108-byte
    // Unix-socket limit, so clients failed with ENOENT until the deadline.
    // Deadline = max(180 s, 3 x worst observed 2.018 s) = 180 s.
    180_000,
    'scanner serve',
  );
  trace(`step6: scanner ready, generation=${snapshotBefore.generation}`);

  // Step 7: mine one block and re-poll to prove the lifecycle worker is live.
  trace('step7: mining');
  await execJson('ths', ['mine', '--name', envName, '--json', '1'], 60_000);
  trace('step7: mine call returned, polling for advance');
  const snapshotAfter = await pollUntil(
    async () => {
      const snap = await httpGetJson(socketPath, '/v1/snapshot');
      const generationAdvanced = snap.generation !== snapshotBefore.generation;
      const heightAdvanced = snap?.tip?.height === snapshotBefore?.tip?.height + 1;
      return generationAdvanced && heightAdvanced ? snap : undefined;
    },
    120_000,
    'scanner generation advance after mining',
  );

  // Step 8: merge non-secret pointers into live.env.
  mergeLiveEnv({
    SSF_SCANNER_SOCKET: socketPath,
    SSF_SCANNER_ACCOUNT_ID: snapshotAfter.accountId,
    SSF_SCANNER_SOURCE_ID: envName,
    THS_ENV_NAME: envName,
  });

  process.stdout.write(`zcash=up scanner=ready generation_advanced=true\n`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    process.stderr.write(`zcash-up failed: ${e?.message ?? e}\n`);
    process.exitCode = 1;
  });
}

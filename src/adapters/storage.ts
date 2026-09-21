import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import type { StorageAdapter } from '../contracts/types.ts';
import { FIRST_RELEASE_MAX_CIPHERTEXT_BYTES, PayloadTooLarge, sha256Hex } from './crypto.ts';

export const LOGOSCTL_VERSION = '0.2.3';
export const STORAGE_MODULE = 'storage_module';
export const STORAGE_MODULE_VERSION = '2.1.2';
export const STORAGE_MODULE_ROOT_HASH =
  '19b11b153748c30665608c5527776ba2be74f7764481a11d33f687098764b740';
export const UPLOAD_DONE_EVENT = 'storageUploadDone';
export const DOWNLOAD_DONE_EVENT = 'storageDownloadDone';
const CHUNK_SIZE = 65_536;

export type MemoryStorageAdapter = StorageAdapter & {
  uploaded: string[];
  setReplica(up: boolean): void;
  disconnect(): void;
};

export function createMemoryStorageAdapter(): MemoryStorageAdapter {
  const objects = new Map<string, Uint8Array>();
  const uploaded: string[] = [];
  let replicaUp = true;
  let next = 0;

  return {
    uploaded,
    setReplica(up) {
      replicaUp = up;
    },
    disconnect() {
      replicaUp = false;
    },
    async publish(ciphertext) {
      if (ciphertext.byteLength > FIRST_RELEASE_MAX_CIPHERTEXT_BYTES) {
        throw new PayloadTooLarge(ciphertext.byteLength, FIRST_RELEASE_MAX_CIPHERTEXT_BYTES);
      }
      const cid = `mem-${++next}-${sha256Hex(ciphertext).slice(0, 12)}`;
      objects.set(cid, new Uint8Array(ciphertext));
      uploaded.push(cid);
      return cid;
    },
    async fetch(cid) {
      if (!replicaUp) {
        throw new Error('replica unavailable');
      }
      const body = objects.get(cid);
      if (!body) {
        throw new Error('unpublished product');
      }
      return new Uint8Array(body);
    },
    async verifyReplica(cid) {
      if (!replicaUp) return false;
      return objects.has(cid);
    },
  };
}

type LogosCall = {
  status: number | null;
  stdout: string;
  stderr: string;
};

function logosEnv(): NodeJS.ProcessEnv {
  return { ...process.env, APPIMAGE_EXTRACT_AND_RUN: '1' };
}

function callRaw(logosctlPath: string, configDir: string, args: string[], timeoutMs = 60_000): LogosCall {
  const result = spawnSync(logosctlPath, ['--config-dir', configDir, '--json', ...args], {
    env: logosEnv(),
    encoding: 'utf8',
    timeout: timeoutMs,
    maxBuffer: 20 * 1024 * 1024,
  });
  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

function parseJson(text: string): unknown {
  const trimmed = text.trim();
  if (!trimmed) return null;
  return JSON.parse(trimmed);
}

function unwrap(parsed: unknown): unknown {
  if (!parsed || typeof parsed !== 'object') {
    throw new Error(`logosctl error: ${JSON.stringify(parsed)}`);
  }
  const record = parsed as { status?: string; result?: unknown };
  if (record.status === 'error') {
    throw new Error(`logosctl error: ${JSON.stringify(parsed)}`);
  }
  return record.result;
}

function resultValue(parsed: unknown): unknown {
  const result = unwrap(parsed);
  if (result && typeof result === 'object' && 'success' in result) {
    const body = result as { success: boolean; value?: unknown };
    if (!body.success) {
      throw new Error(`module call failed: ${JSON.stringify(result)}`);
    }
    return body.value;
  }
  return result;
}

function call(logosctlPath: string, configDir: string, method: string, methodArgs: string[] = []) {
  if (method === 'fetch') {
    throw new Error('storage_module fetch() is acceptance-only and must not be used');
  }
  const raw = callRaw(logosctlPath, configDir, ['call', STORAGE_MODULE, method, ...methodArgs]);
  if (raw.status !== 0 && !raw.stdout) {
    throw new Error(`logosctl call ${method} failed: ${raw.stderr}`);
  }
  return parseJson(raw.stdout);
}

function eventBody(parsed: unknown): { event?: string; success?: boolean; cid?: string } | null {
  if (!parsed || typeof parsed !== 'object') return null;
  const record = parsed as { event?: string; data?: { arg0?: string } };
  const arg0 = record.data?.arg0;
  if (typeof arg0 === 'string') {
    try {
      return { event: record.event, ...(JSON.parse(arg0) as object) };
    } catch {
      return { event: record.event };
    }
  }
  return { event: record.event };
}

function watch(logosctlPath: string, configDir: string, eventName: string) {
  const proc = spawn(
    logosctlPath,
    ['--config-dir', configDir, '--json', 'watch', STORAGE_MODULE, '--event', eventName],
    { env: logosEnv(), stdio: ['ignore', 'pipe', 'pipe'] },
  );
  const lines: string[] = [];
  let buffer = '';
  proc.stdout?.setEncoding('utf8');
  proc.stdout?.on('data', (chunk: string) => {
    buffer += chunk;
    let idx = buffer.indexOf('\n');
    while (idx >= 0) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (line) lines.push(line);
      idx = buffer.indexOf('\n');
    }
  });
  return {
    lines,
    stop() {
      if (!proc.killed) proc.kill('SIGTERM');
    },
  };
}

export type LogosRuntime = {
  logosctlPath: string;
  originConfigDir: string;
  replicaConfigDir: string;
};

export type LogosDetection =
  | { ok: true; runtime: LogosRuntime }
  | { ok: false; reason: string };

export function detectLogosRuntime(): LogosDetection {
  const fromEnv = {
    logosctlPath: process.env.LOGOSCTL ?? '',
    originConfigDir: process.env.LOGOS_NODE_A ?? '',
    replicaConfigDir: process.env.LOGOS_NODE_B ?? '',
  };
  const candidates: LogosRuntime[] = [];
  if (fromEnv.logosctlPath && fromEnv.originConfigDir && fromEnv.replicaConfigDir) {
    candidates.push(fromEnv);
  }
  const t2Root = '/home/megabyte/Work/zcash/eco-research/money-research/sovereign-storefront/.worktrees/feat-mvp-t2/spikes/storage/runtime';
  const extracted = '/home/megabyte/.hermes/cache/scratch/appimage_extracted_7f7be31a2e4756b2b1eb523db686b370/usr/bin/logosctl';
  if (existsSync(extracted) && existsSync(join(t2Root, 'node-a')) && existsSync(join(t2Root, 'node-b'))) {
    candidates.push({
      logosctlPath: extracted,
      originConfigDir: join(t2Root, 'node-a'),
      replicaConfigDir: join(t2Root, 'node-b'),
    });
  }
  const errors: string[] = [];
  for (const runtime of candidates) {
    try {
      const peerA = resultValue(call(runtime.logosctlPath, runtime.originConfigDir, 'peerId'));
      const peerB = resultValue(call(runtime.logosctlPath, runtime.replicaConfigDir, 'peerId'));
      if (typeof peerA === 'string' && typeof peerB === 'string' && peerA !== peerB) {
        return { ok: true, runtime };
      }
      errors.push(`peer ids not independent: ${String(peerA)} vs ${String(peerB)}`);
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }
  return {
    ok: false,
    reason: errors.length
      ? `live two-node Logos not usable: ${errors.join('; ')}`
      : 'live two-node Logos is not running in this worktree',
  };
}

export function createLogosStorageAdapter(runtime: LogosRuntime, workDir?: string): StorageAdapter {
  const scratch = workDir ?? mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), 'ssf-logos-'));

  function listManifests(configDir: string): Array<{ cid?: string; filename?: string; datasetSize?: number }> {
    return (resultValue(call(runtime.logosctlPath, configDir, 'manifests')) as Array<{
      cid?: string;
      filename?: string;
      datasetSize?: number;
    }> | null) ?? [];
  }

  async function uploadAndWait(ciphertext: Uint8Array): Promise<string> {
    const filePath = join(scratch, `upload-${Date.now()}.ssf1`);
    const filename = basename(filePath);
    writeFileSync(filePath, ciphertext, { mode: 0o600 });
    const before = new Set(listManifests(runtime.originConfigDir).map((item) => item.cid).filter(Boolean) as string[]);
    const watcher = watch(runtime.logosctlPath, runtime.originConfigDir, UPLOAD_DONE_EVENT);
    try {
      await new Promise((resolve) => setTimeout(resolve, 400));
      call(runtime.logosctlPath, runtime.originConfigDir, 'uploadUrl', [filePath, String(CHUNK_SIZE)]);
      const deadline = Date.now() + 90_000;
      while (Date.now() < deadline) {
        let eventCid: string | undefined;
        for (const line of watcher.lines) {
          try {
            const body = eventBody(JSON.parse(line));
            if (body?.event === UPLOAD_DONE_EVENT && body.success === true && body.cid) {
              eventCid = body.cid;
            }
          } catch {
            // ignore non-JSON watch lines
          }
        }
        const manifests = listManifests(runtime.originConfigDir);
        const match =
          manifests.find((item) => item.cid === eventCid) ??
          manifests.find((item) => item.filename === filename) ??
          manifests.find((item) => item.cid && !before.has(item.cid) && item.datasetSize === ciphertext.byteLength);
        if (match?.cid) {
          const exists = resultValue(call(runtime.logosctlPath, runtime.originConfigDir, 'exists', [match.cid]));
          if (exists === true) return match.cid;
        }
        await new Promise((resolve) => setTimeout(resolve, 300));
      }
      throw new Error('timed out waiting for storageUploadDone/manifests completion');
    } finally {
      watcher.stop();
    }
  }

  async function downloadAndWait(configDir: string, cid: string): Promise<Uint8Array> {
    const destPath = join(scratch, `download-${Date.now()}.ssf1`);
    if (existsSync(destPath)) rmSync(destPath);
    const manifestWatcher = watch(runtime.logosctlPath, configDir, 'storageDownloadManifestDone');
    try {
      await new Promise((resolve) => setTimeout(resolve, 400));
      const manifestAccepted = call(runtime.logosctlPath, configDir, 'downloadManifest', [cid]);
      if ((unwrap(manifestAccepted) as { success?: boolean } | null)?.success === false) {
        throw new Error(`downloadManifest not accepted: ${JSON.stringify(manifestAccepted)}`);
      }
      const manifestDeadline = Date.now() + 60_000;
      while (Date.now() < manifestDeadline) {
        if (listManifests(configDir).some((item) => item.cid === cid)) break;
        await new Promise((resolve) => setTimeout(resolve, 300));
      }
    } finally {
      manifestWatcher.stop();
    }
    const watcher = watch(runtime.logosctlPath, configDir, DOWNLOAD_DONE_EVENT);
    try {
      await new Promise((resolve) => setTimeout(resolve, 400));
      call(runtime.logosctlPath, configDir, 'downloadToUrl', [cid, destPath, 'false', String(CHUNK_SIZE)]);
      const deadline = Date.now() + 90_000;
      while (Date.now() < deadline) {
        if (existsSync(destPath) && readFileSync(destPath).byteLength > 0) {
          return new Uint8Array(readFileSync(destPath));
        }
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
      throw new Error(`download did not materialize ${destPath}`);
    } finally {
      watcher.stop();
    }
  }

  function connectReplica(): void {
    const peerA = resultValue(call(runtime.logosctlPath, runtime.originConfigDir, 'peerId'));
    if (typeof peerA === 'string') {
      call(runtime.logosctlPath, runtime.replicaConfigDir, 'connect', [peerA, 'json:[]']);
    }
  }

  return {
    async publish(ciphertext) {
      if (ciphertext.byteLength > FIRST_RELEASE_MAX_CIPHERTEXT_BYTES) {
        throw new PayloadTooLarge(ciphertext.byteLength, FIRST_RELEASE_MAX_CIPHERTEXT_BYTES);
      }
      return uploadAndWait(ciphertext);
    },
    async fetch(cid) {
      connectReplica();
      return downloadAndWait(runtime.replicaConfigDir, cid);
    },
    async verifyReplica(cid) {
      try {
        connectReplica();
        const bytes = await downloadAndWait(runtime.replicaConfigDir, cid);
        return bytes.byteLength > 0 && bytes.byteLength <= FIRST_RELEASE_MAX_CIPHERTEXT_BYTES;
      } catch {
        return false;
      }
    },
  };
}

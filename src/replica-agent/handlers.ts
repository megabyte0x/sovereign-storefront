import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { readFileSync, rmSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DOWNLOAD_DONE_EVENT, type LogosRunner } from '../adapters/storage.ts';
import { PUBLIC_MAX_PLAINTEXT_BYTES } from '../contracts/public.ts';

/**
 * Observed Logos storage CIDs are multibase base58btc (`z` + base58).
 * The 1.2 spike sample is 52 characters. `src/adapters/storage.ts` does not
 * export a CID regex; this is stricter than the alphanumeric check in
 * `scripts/live-resources.ts` (`0`, `O`, `I` and `l` are rejected).
 */
export const LOGOS_CID_RE = /^z[1-9A-HJ-NP-Za-km-z]{50,80}$/;

const PEER_ID_RE = /^[1-9A-HJ-NP-Za-km-z]{20,100}$/;
const DIGEST_RE = /^[0-9a-f]{64}$/;
const SIZE_RE = /^(0|[1-9][0-9]*)$/;
const MULTIADDR_RE = /^\/ip4\/(\d{1,3}(?:\.\d{1,3}){3})\/tcp\/(\d{1,5})\/p2p\/([1-9A-HJ-NP-Za-km-z]{20,100})$/;
const TRANSIENT_DOWNLOAD_RE = /Failed to start download/;
const CHUNK = '65536';
const DOWNLOAD_ATTEMPTS = 4;
const MANIFEST_ATTEMPTS = 3;
const DEFAULT_RETRY_MS = 2_000;
const WATCH_MS = 90_000;
const BODY_LIMIT = 4_096;
const PUBLIC_CIPHERTEXT_OVERHEAD = 32;

export type ReplicaLog = { route: string; status: number };

export type ReplicaAgentOptions = {
  runner: LogosRunner;
  configDir: string;
  token: string;
  maxBytes?: number;
  downloadAttempts?: number;
  downloadRetryDelayMs?: number;
  watchTimeoutMs?: number;
  log?: (record: ReplicaLog) => void;
  readFile?: (path: string) => Uint8Array;
};

type ReplicateState = 'done' | 'pending' | 'failed';

type Job = { digest: string; sizeBytes: number; state: ReplicateState };

function ipv4(host: string): [number, number, number, number] | null {
  const parts = host.split('.');
  if (parts.length !== 4) return null;
  const nums: number[] = [];
  for (const part of parts) {
    if (!/^(0|[1-9]\d{0,2})$/.test(part)) return null;
    const n = Number(part);
    if (n > 255) return null;
    nums.push(n);
  }
  return [nums[0] ?? -1, nums[1] ?? -1, nums[2] ?? -1, nums[3] ?? -1];
}

function originAllowed(host: string): boolean {
  const ip = ipv4(host);
  if (!ip) return false;
  if (ip[0] === 127) return true;
  return ip[0] === 100 && ip[1] >= 64 && ip[1] <= 127;
}

function peerFromMultiaddr(value: string): string | null {
  const match = MULTIADDR_RE.exec(value);
  if (!match) return null;
  const host = match[1] ?? '';
  const port = Number(match[2]);
  const peerId = match[3] ?? '';
  if (!originAllowed(host) || port < 1 || port > 65535 || !PEER_ID_RE.test(peerId)) return null;
  return peerId;
}

function authorized(header: string | undefined, token: string): boolean {
  const expected = Buffer.from(`Bearer ${token}`);
  const actual = Buffer.from(header ?? '');
  if (actual.length !== expected.length) return false;
  return timingSafeEqual(actual, expected);
}

function send(res: ServerResponse, status: number, body: string | Uint8Array, type: string): void {
  const payload = typeof body === 'string' ? Buffer.from(body) : Buffer.from(body);
  res.writeHead(status, {
    'content-type': type,
    'content-length': String(payload.byteLength),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  res.end(payload);
}

function sendJson(res: ServerResponse, status: number, value: unknown): void {
  send(res, status, JSON.stringify(value), 'application/json; charset=utf-8');
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buf.byteLength;
    if (total > BODY_LIMIT) throw new Error('body');
    chunks.push(buf);
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function pause(ms: number): Promise<void> {
  if (ms <= 0) return;
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  await promise;
}

export function createReplicaAgentHandler(options: ReplicaAgentOptions): (req: IncomingMessage, res: ServerResponse) => void {
  const maxBytes = options.maxBytes ?? PUBLIC_MAX_PLAINTEXT_BYTES + PUBLIC_CIPHERTEXT_OVERHEAD;
  const attempts = options.downloadAttempts ?? DOWNLOAD_ATTEMPTS;
  const retryDelayMs = options.downloadRetryDelayMs ?? DEFAULT_RETRY_MS;
  const watchTimeoutMs = options.watchTimeoutMs ?? WATCH_MS;
  const readFile = options.readFile ?? ((path: string) => new Uint8Array(readFileSync(path)));
  const finished = new Map<string, Job>();
  const inflight = new Map<string, { digest: string; sizeBytes: number; task: Promise<ReplicateState> }>();
  let chain: Promise<unknown> = Promise.resolve();

  const locked = <T>(fn: () => Promise<T>): Promise<T> => {
    const run = chain.then(fn, fn);
    chain = run.then(() => undefined, () => undefined);
    return run;
  };

  const log = (route: string, status: number): void => {
    options.log?.({ route, status });
  };

  const eventByteCount = (event: Record<string, unknown>): number | undefined => {
    for (const key of ['bytes', 'size', 'datasetSize', 'written', 'totalBytes']) {
      const value = event[key];
      if (typeof value === 'number' && Number.isInteger(value) && value >= 0) return value;
      if (typeof value === 'string' && SIZE_RE.test(value)) return Number(value);
    }
    return undefined;
  };

  const correlated = (event: Record<string, unknown>, cid: string, sessionId: unknown): boolean => {
    if (event.success !== true) return false;
    if (event.cid !== undefined && event.cid !== cid) return false;
    if (event.sessionId !== undefined) {
      return sessionId != null && String(event.sessionId) === String(sessionId);
    }
    return event.cid !== undefined;
  };

  const manifestSize = async (cid: string): Promise<number | undefined> => {
    try {
      const list = await options.runner.call(options.configDir, 'manifests');
      if (!Array.isArray(list)) return undefined;
      for (const item of list) {
        if (!item || typeof item !== 'object' || !('cid' in item) || item.cid !== cid) continue;
        const size = 'datasetSize' in item ? item.datasetSize : undefined;
        if (typeof size === 'number' && Number.isInteger(size) && size >= 0) return size;
      }
    } catch {
      return undefined;
    }
    return undefined;
  };

  const readWhenComplete = async (path: string, expected: number | undefined): Promise<Uint8Array | null> => {
    const deadline = Date.now() + 10_000;
    if (expected !== undefined) {
      let bytes: Uint8Array | null = null;
      try { bytes = readFile(path); } catch { bytes = null; }
      while ((bytes === null || bytes.byteLength !== expected) && Date.now() < deadline) {
        if (bytes && bytes.byteLength > expected) return null;
        await pause(50);
        try { bytes = readFile(path); } catch { bytes = null; }
      }
      return bytes && bytes.byteLength === expected ? bytes : null;
    }
    let previous = -1;
    while (Date.now() < deadline) {
      let bytes: Uint8Array | null = null;
      try { bytes = readFile(path); } catch { bytes = null; }
      if (bytes && bytes.byteLength > 0 && bytes.byteLength === previous) return bytes;
      previous = bytes?.byteLength ?? -1;
      await pause(50);
    }
    return null;
  };

  // Watch must be attached before downloadToUrl. The completion event is not replayed.
  const downloadWatched = async (
    cid: string,
    dest: string,
    local: boolean,
    expectedSize: number | undefined,
  ): Promise<Uint8Array | 'timeout' | 'failed'> => {
    const flag = local ? 'true' : 'false';
    for (let attempt = 1; ; attempt += 1) {
      const sub = options.runner.subscribe(options.configDir, DOWNLOAD_DONE_EVENT, watchTimeoutMs);
      try {
        await sub.ready;
        const sessionId = await options.runner.call(options.configDir, 'downloadToUrl', [cid, dest, flag, CHUNK]);
        const event = await sub.event;
        if (!event) return 'timeout';
        if (!correlated(event, cid, sessionId)) return 'failed';
        const expected = eventByteCount(event) ?? expectedSize ?? await manifestSize(cid);
        const bytes = await readWhenComplete(dest, expected);
        if (!bytes || bytes.byteLength > maxBytes) return 'failed';
        return bytes;
      } catch (error) {
        const transient = error instanceof Error && TRANSIENT_DOWNLOAD_RE.test(error.message);
        if (!transient || attempt >= attempts) throw error;
      } finally {
        sub.cancel();
      }
      await pause(retryDelayMs);
    }
  };

  const readLocal = async (cid: string, expectedSize: number | undefined): Promise<Uint8Array | null> => {
    const dest = join(tmpdir(), `ssf-replica-${randomUUID()}.ssf1`);
    try {
      const downloaded = await downloadWatched(cid, dest, true, expectedSize);
      return downloaded instanceof Uint8Array ? downloaded : null;
    } catch {
      return null;
    } finally {
      rmSync(dest, { force: true });
    }
  };

  const matches = (bytes: Uint8Array | null, digest: string, sizeBytes: number): boolean => {
    if (!bytes || bytes.byteLength !== sizeBytes) return false;
    const actual = createHash('sha256').update(bytes).digest('hex');
    const left = Buffer.from(actual);
    const right = Buffer.from(digest);
    return left.length === right.length && timingSafeEqual(left, right);
  };

  const startDownload = async (cid: string, multiaddr: string, digest: string, sizeBytes: number): Promise<ReplicateState> => {
    const peerId = peerFromMultiaddr(multiaddr);
    if (!peerId) return 'failed';
    const dest = join(tmpdir(), `ssf-replica-${randomUUID()}.ssf1`);
    try {
      await options.runner.call(options.configDir, 'connect', [peerId, `json:[${JSON.stringify(multiaddr)}]`]);
      for (let attempt = 1; ; attempt += 1) {
        try {
          await options.runner.call(options.configDir, 'downloadManifest', [cid]);
          break;
        } catch (error) {
          if (attempt >= MANIFEST_ATTEMPTS) throw error;
          await pause(retryDelayMs);
        }
      }
      const downloaded = await downloadWatched(cid, dest, false, sizeBytes);
      if (downloaded === 'timeout') return 'pending';
      if (!(downloaded instanceof Uint8Array)) return 'failed';
      return matches(downloaded, digest, sizeBytes) ? 'done' : 'failed';
    } catch {
      return 'failed';
    } finally {
      rmSync(dest, { force: true });
    }
  };

  const replicate = (cid: string, multiaddr: string, digest: string, sizeBytes: number): Promise<ReplicateState> => {
    const prior = finished.get(cid);
    if (prior && prior.digest === digest && prior.sizeBytes === sizeBytes && prior.state !== 'failed') {
      return Promise.resolve(prior.state);
    }
    const running = inflight.get(cid);
    if (running && running.digest === digest && running.sizeBytes === sizeBytes) return running.task;
    if ((prior && prior.state !== 'failed') || running) return Promise.resolve('failed');
    const task = startDownload(cid, multiaddr, digest, sizeBytes).then((state) => {
      if (state !== 'pending') finished.set(cid, { digest, sizeBytes, state });
      inflight.delete(cid);
      return state;
    });
    inflight.set(cid, { digest, sizeBytes, task });
    return task;
  };

  return (req, res) => {
    void (async () => {
      const header = req.headers.authorization;
      if (!authorized(typeof header === 'string' ? header : undefined, options.token)) {
        log('reject', 401);
        send(res, 401, 'unauthorized', 'text/plain; charset=utf-8');
        return;
      }
      const raw = req.url ?? '/';
      if (raw.includes('..') || raw.includes('%') || raw.includes('\\')) {
        log('reject', 400);
        send(res, 400, 'bad request', 'text/plain; charset=utf-8');
        return;
      }
      const url = new URL(raw, 'http://replica.invalid');
      const path = url.pathname;
      if (req.method === 'GET' && path === '/v1/peer') {
        const peerId = await locked(() => options.runner.call(options.configDir, 'peerId'));
        if (typeof peerId !== 'string' || !PEER_ID_RE.test(peerId)) {
          log('peer', 503);
          send(res, 503, 'unavailable', 'text/plain; charset=utf-8');
          return;
        }
        log('peer', 200);
        sendJson(res, 200, { peerId });
        return;
      }
      if (req.method === 'POST' && path === '/v1/replicate') {
        let parsed: unknown;
        try {
          parsed = JSON.parse(await readBody(req));
        } catch {
          log('replicate', 400);
          send(res, 400, 'bad request', 'text/plain; charset=utf-8');
          return;
        }
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          log('replicate', 400);
          send(res, 400, 'bad request', 'text/plain; charset=utf-8');
          return;
        }
        const body = parsed as Record<string, unknown>;
        if (Object.keys(body).some((key) => key !== 'cid' && key !== 'originMultiaddr' && key !== 'digest' && key !== 'sizeBytes')) {
          log('replicate', 400);
          send(res, 400, 'bad request', 'text/plain; charset=utf-8');
          return;
        }
        const { cid, originMultiaddr, digest, sizeBytes } = body;
        if (typeof cid !== 'string' || !LOGOS_CID_RE.test(cid)
          || typeof originMultiaddr !== 'string' || peerFromMultiaddr(originMultiaddr) === null
          || typeof digest !== 'string' || !DIGEST_RE.test(digest)
          || typeof sizeBytes !== 'number' || !Number.isInteger(sizeBytes) || sizeBytes < 0 || sizeBytes > maxBytes) {
          log('replicate', 400);
          send(res, 400, 'bad request', 'text/plain; charset=utf-8');
          return;
        }
        const state = await locked(() => replicate(cid, originMultiaddr, digest, sizeBytes));
        log('replicate', 200);
        sendJson(res, 200, { state });
        return;
      }
      const has = /^\/v1\/has\/([^/]+)$/.exec(path);
      if (req.method === 'GET' && has) {
        const cid = has[1] ?? '';
        const digest = url.searchParams.get('digest') ?? '';
        const sizeRaw = url.searchParams.get('size') ?? '';
        if (!LOGOS_CID_RE.test(cid) || !DIGEST_RE.test(digest) || !SIZE_RE.test(sizeRaw) || Number(sizeRaw) > maxBytes) {
          log('has', 400);
          send(res, 400, 'bad request', 'text/plain; charset=utf-8');
          return;
        }
        const bytes = await locked(() => readLocal(cid, Number(sizeRaw)));
        log('has', 200);
        sendJson(res, 200, { present: matches(bytes, digest, Number(sizeRaw)) });
        return;
      }
      const cipher = /^\/v1\/ciphertext\/([^/]+)$/.exec(path);
      if (req.method === 'GET' && cipher) {
        const cid = cipher[1] ?? '';
        if (!LOGOS_CID_RE.test(cid)) {
          log('ciphertext', 400);
          send(res, 400, 'bad request', 'text/plain; charset=utf-8');
          return;
        }
        const bytes = await locked(() => readLocal(cid, undefined));
        if (!bytes) {
          log('ciphertext', 404);
          send(res, 404, 'not found', 'text/plain; charset=utf-8');
          return;
        }
        log('ciphertext', 200);
        send(res, 200, bytes, 'application/octet-stream');
        return;
      }
      log('reject', 404);
      send(res, 404, 'not found', 'text/plain; charset=utf-8');
    })().catch(() => {
      if (!res.headersSent) {
        log('reject', 500);
        send(res, 500, 'error', 'text/plain; charset=utf-8');
      }
    });
  };
}

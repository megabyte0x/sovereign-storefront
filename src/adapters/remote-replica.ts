import { lstatSync, readFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import type { IncomingMessage } from 'node:http';
import { LOGOS_CID_RE } from '../replica-agent/handlers.ts';
import { PUBLIC_MAX_PLAINTEXT_BYTES } from '../contracts/public.ts';

const JSON_CAP = 8_192;
const PUBLIC_CIPHERTEXT_OVERHEAD = 32;
const POLL_MS = 20;

export type ReplicateRequest = {
  cid: string;
  originMultiaddr: string;
  digest: string;
  sizeBytes: number;
};

export type RemoteReplica = {
  peerId(): Promise<string>;
  replicate(input: ReplicateRequest): Promise<{ state: 'done' | 'pending' | 'failed' }>;
  verifyReplica(cid: string, replicaId: string): Promise<boolean>;
  fetch(cid: string): Promise<Uint8Array>;
  assertIndependentReplicas(originPeerId: string): Promise<void>;
  noteExpected(cid: string, digest: string, sizeBytes: number): void;
  close(): void;
};

type Expected = { digest: string; sizeBytes: number };

export function isTailnetIpv4(host: string): boolean {
  const parts = host.split('.');
  if (parts.length !== 4) return false;
  const nums: number[] = [];
  for (const part of parts) {
    if (!/^(0|[1-9]\d{0,2})$/.test(part)) return false;
    const n = Number(part);
    if (n > 255) return false;
    nums.push(n);
  }
  return nums[0] === 100 && (nums[1] ?? -1) >= 64 && (nums[1] ?? -1) <= 127;
}

function isLoopbackHost(host: string): boolean {
  if (host === 'localhost' || host === '::1') return true;
  const parts = host.split('.');
  if (parts.length !== 4 || parts[0] !== '127') return false;
  return parts.every((part) => /^(0|[1-9]\d{0,2})$/.test(part) && Number(part) <= 255);
}

export function assertReplicaAgentUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('invalid replica agent url');
  }
  if (url.username !== '' || url.password !== '' || (url.pathname !== '/' && url.pathname !== '') || url.search !== '' || url.hash !== '') {
    throw new Error('invalid replica agent url');
  }
  if (url.protocol === 'https:') return url;
  if (url.protocol !== 'http:') throw new Error('invalid replica agent url');
  if (isLoopbackHost(url.hostname) || isTailnetIpv4(url.hostname)) return url;
  throw new Error('http replica agent url must use a tailnet or loopback address');
}

/** Reads a bearer token only from a regular 0600 file owned by this uid. */
export function readReplicaToken(path: string): string {
  let stat;
  try {
    stat = lstatSync(path);
  } catch {
    throw new Error('unreadable replica token file');
  }
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error('invalid replica token file');
  if ((stat.mode & 0o077) !== 0) throw new Error('replica token file must be mode 0600');
  const uid = typeof process.getuid === 'function' ? process.getuid() : undefined;
  if (uid !== undefined && stat.uid !== uid) throw new Error('replica token file must be owned by the current uid');
  const token = readFileSync(path, 'utf8').trim();
  if (token.length === 0 || token.length > 256 || /\s/.test(token)) throw new Error('invalid replica token file');
  return token;
}

class ReplicaTimeout extends Error {
  constructor() {
    super('replica agent timed out');
    this.name = 'ReplicaTimeout';
  }
}

function ask(
  target: URL,
  method: string,
  timeoutMs: number,
  maxBytes: number,
  token: string,
  body?: string,
): Promise<{ status: number; body: Buffer }> {
  const { promise, resolve, reject } = Promise.withResolvers<{ status: number; body: Buffer }>();
  let settled = false;
  const fail = (error: Error): void => {
    if (settled) return;
    settled = true;
    reject(error);
  };
  const ok = (value: { status: number; body: Buffer }): void => {
    if (settled) return;
    settled = true;
    resolve(value);
  };
  const headers: Record<string, string> = { authorization: `Bearer ${token}` };
  if (body !== undefined) {
    headers['content-type'] = 'application/json';
    headers['content-length'] = String(Buffer.byteLength(body));
  }
  const lib = target.protocol === 'https:' ? httpsRequest : httpRequest;
  const req = lib(target, { method, headers }, (res: IncomingMessage) => {
    const declared = Number(res.headers['content-length'] ?? '');
    if (Number.isFinite(declared) && declared > maxBytes) {
      fail(new Error('response exceeds size cap'));
      res.destroy();
      req.destroy();
      return;
    }
    const chunks: Buffer[] = [];
    let total = 0;
    res.on('data', (chunk: Buffer) => {
      total += chunk.byteLength;
      if (total > maxBytes) {
        fail(new Error('response exceeds size cap'));
        res.destroy();
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    res.on('end', () => ok({ status: res.statusCode ?? 0, body: Buffer.concat(chunks) }));
    res.on('error', () => fail(new ReplicaTimeout()));
  });
  req.on('error', () => fail(new ReplicaTimeout()));
  req.setTimeout(timeoutMs, () => {
    req.destroy();
    fail(new ReplicaTimeout());
  });
  req.end(body);
  return promise;
}

export function createRemoteReplica(options: {
  url: string;
  tokenFile: string;
  timeoutMs: number;
  maxBytes?: number;
}): RemoteReplica {
  const base = assertReplicaAgentUrl(options.url);
  if (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0) throw new Error('invalid replica timeout');
  const maxBytes = options.maxBytes ?? PUBLIC_MAX_PLAINTEXT_BYTES + PUBLIC_CIPHERTEXT_OVERHEAD;
  if (!Number.isInteger(maxBytes) || maxBytes < 1) throw new Error('invalid replica size cap');
  readReplicaToken(options.tokenFile);
  const expected = new Map<string, Expected>();
  let closed = false;

  const token = (): string => readReplicaToken(options.tokenFile);
  const endpoint = (path: string): URL => new URL(path, base);

  return {
    noteExpected(cid, digest, sizeBytes) {
      expected.set(cid, { digest, sizeBytes });
    },
    async peerId() {
      if (closed) throw new Error('replica client closed');
      const res = await ask(endpoint('/v1/peer'), 'GET', options.timeoutMs, JSON_CAP, token());
      if (res.status !== 200) throw new Error('logos storage peer identity unavailable');
      const parsed = JSON.parse(res.body.toString('utf8')) as { peerId?: unknown };
      if (typeof parsed.peerId !== 'string' || parsed.peerId.length === 0) {
        throw new Error('logos storage peer identity unavailable');
      }
      return parsed.peerId;
    },
    async replicate(input) {
      if (closed) throw new Error('replica client closed');
      if (!LOGOS_CID_RE.test(input.cid)) throw new Error('invalid cid');
      expected.set(input.cid, { digest: input.digest, sizeBytes: input.sizeBytes });
      const res = await ask(
        endpoint('/v1/replicate'),
        'POST',
        options.timeoutMs,
        JSON_CAP,
        token(),
        JSON.stringify(input),
      );
      if (res.status !== 200) return { state: 'failed' as const };
      const parsed = JSON.parse(res.body.toString('utf8')) as { state?: unknown };
      if (parsed.state !== 'done' && parsed.state !== 'pending' && parsed.state !== 'failed') {
        return { state: 'failed' as const };
      }
      return { state: parsed.state };
    },
    async verifyReplica(cid, replicaId) {
      if (closed || replicaId.length === 0 || !LOGOS_CID_RE.test(cid)) return false;
      const noted = expected.get(cid);
      if (!noted) return false;
      const deadline = Date.now() + options.timeoutMs;
      const path = `/v1/has/${encodeURIComponent(cid)}?digest=${noted.digest}&size=${noted.sizeBytes}`;
      while (Date.now() < deadline) {
        const remaining = deadline - Date.now();
        if (remaining <= 0) return false;
        try {
          const res = await ask(endpoint(path), 'GET', remaining, JSON_CAP, token());
          if (res.status === 200) {
            const parsed = JSON.parse(res.body.toString('utf8')) as { present?: unknown };
            if (parsed.present === true) return true;
          }
        } catch {
          return false;
        }
        const left = deadline - Date.now();
        if (left <= 0) return false;
        const { promise, resolve } = Promise.withResolvers<void>();
        setTimeout(resolve, Math.min(POLL_MS, left));
        await promise;
      }
      return false;
    },
    async fetch(cid) {
      if (closed) throw new Error('replica client closed');
      if (!LOGOS_CID_RE.test(cid)) throw new Error('invalid cid');
      const res = await ask(endpoint(`/v1/ciphertext/${encodeURIComponent(cid)}`), 'GET', options.timeoutMs, maxBytes, token());
      if (res.body.byteLength > maxBytes) throw new Error('response exceeds size cap');
      if (res.status !== 200) throw new Error('replica fetch failed');
      return new Uint8Array(res.body);
    },
    async assertIndependentReplicas(originPeerId) {
      if (typeof originPeerId !== 'string' || originPeerId.length === 0) {
        throw new Error('logos storage peer identity unavailable');
      }
      const remote = await this.peerId();
      if (remote === originPeerId) throw new Error('logos origin and replica are not independent peers');
    },
    close() {
      closed = true;
    },
  };
}

/**
 * Seller-side remote confirm: POST /v1/replicate, then has until present or timeout.
 * Upload on A stays with the origin adapter. Publication stays refused until this
 * returns true (`src/seller/admin.ts` already maps a false verifyReplica to 503).
 */
export async function confirmRemoteReplica(remote: RemoteReplica, input: ReplicateRequest): Promise<boolean> {
  const started = await remote.replicate(input);
  if (started.state === 'failed') return false;
  return remote.verifyReplica(input.cid, 'replica');
}

// Public-testnet doctor. Rows are PASS, FAIL, or SKIP. --strict makes any SKIP
// a non-zero exit. delivery-wss is omitted unless SSF_WSS_ORIGIN is set, so an
// unset owned-delivery origin cannot fail --strict (D1=a).
import { connect as tlsConnect } from 'node:tls';
import { connect as http2Connect } from 'node:http2';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { request as httpRequest } from 'node:http';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { readReplicaToken } from '../src/adapters/remote-replica.ts';
import { sanitizeEvidence } from './demo-check.ts';

export type RowStatus = 'PASS' | 'FAIL' | 'SKIP';
export type Row = { id: string; status: RowStatus; reason: string };

export type HttpProbe = {
  status: number;
  body: Uint8Array;
  headers: Record<string, string>;
};

export type DoctorProbes = {
  tls: (origin: string) => Promise<{ ok: boolean; reason: string } | undefined>;
  http: (url: string) => Promise<HttpProbe | undefined>;
  scanner: () => Promise<{ scannerTip?: number; lightwalletdTip?: number; reason?: string } | undefined>;
  logosA: () => Promise<{ ok?: boolean; reason: string } | undefined>;
  replica: () => Promise<{ present?: boolean; digestMatch?: boolean; reason: string } | undefined>;
  wssRoundTrip: (origin: string) => Promise<{ ok?: boolean; reason: string } | undefined>;
  backupAgeMs: () => Promise<number | undefined>;
  readBuildHtml: () => Promise<Uint8Array | undefined>;
  readEmbedSri: () => Promise<string | undefined>;
  embedBody?: () => Promise<Uint8Array | undefined>;
};

const BACKUP_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const SCANNER_TIP_LAG = 3;
const REFUSED = 'evidence refused by sanitizer';

export function safeReason(reason: string): string {
  try {
    return sanitizeEvidence([reason])[0] ?? 'ok';
  } catch {
    return REFUSED;
  }
}

export function formatDoctor(rows: readonly Row[]): string {
  return rows.map((row) => `${row.id} ${row.status} ${safeReason(row.reason)}`).join('\n');
}

function row(id: string, status: RowStatus, reason: string): Row {
  return { id, status, reason: safeReason(reason) };
}

function skipped(id: string, reason: string): Row {
  return row(id, 'SKIP', reason);
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function sha384Sri(bytes: Uint8Array): string {
  return `sha384-${createHash('sha384').update(bytes).digest('base64')}`;
}

function escapeAttr(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[char] ?? char));
}

/** Same `<main id="app">` decoration `src/seller/server.ts` applies before serving. */
export function decoratePublicIndex(html: string, env: Record<string, string>): string {
  const embedOrigins = env.SSF_EMBED_ORIGINS ?? '';
  const attrs = [
    `data-min-confirmations="${env.SSF_MIN_CONFIRMATIONS ?? ''}"`,
    `data-network="${env.SSF_NETWORK ?? ''}"`,
    `data-embed-origins="${escapeAttr(embedOrigins)}"`,
    `data-public-origin="${escapeAttr(env.SSF_PUBLIC_ORIGIN ?? '')}"`,
  ].join(' ');
  if (!html.includes('id="app"')) return html;
  return html.replace(/<main id="app"[^>]*>/, `<main id="app" ${attrs}>`);
}

function indexIntact(served: Uint8Array, built: Uint8Array, env: Record<string, string>): boolean {
  const servedText = new TextDecoder().decode(served);
  const builtText = new TextDecoder().decode(built);
  const servedScripts = servedText.match(/<script/gi)?.length ?? 0;
  const builtScripts = builtText.match(/<script/gi)?.length ?? 0;
  if (servedScripts > builtScripts) return false;
  const decorated = decoratePublicIndex(builtText, env);
  if (sha256(served) === sha256(new TextEncoder().encode(decorated))) return true;
  const normalize = (html: string) => html.replace(/<main id="app"[^>]*>/g, '<main id="app">');
  return normalize(servedText) === normalize(builtText);
}
export function scannerWithinFloor(scannerTip: number, lightwalletdTip: number): boolean {
  return Math.abs(lightwalletdTip - scannerTip) <= SCANNER_TIP_LAG;
}

export async function runPublicDoctor(input: {
  strict: boolean;
  env: Record<string, string>;
  probes: DoctorProbes;
  nowMs?: number;
}): Promise<{ exitCode: 0 | 1; rows: Row[] }> {
  const origin = input.env.SSF_PUBLIC_ORIGIN ?? '';
  const wssOrigin = input.env.SSF_WSS_ORIGIN ?? '';
  const rows: Row[] = [];

  if (origin.length === 0) {
    rows.push(row('tls', 'FAIL', 'store origin unset'));
    rows.push(row('seller-public', 'FAIL', 'store origin unset'));
  } else {
    const storeTls = await input.probes.tls(origin);
    const wssTls = wssOrigin.length > 0 ? await input.probes.tls(wssOrigin) : { ok: true, reason: 'wss not configured' };
    if (storeTls === undefined || wssTls === undefined) {
      rows.push(skipped('tls', 'cert probe unreachable'));
    } else if (storeTls.ok && wssTls.ok) {
      rows.push(row('tls', 'PASS', 'cert ok'));
    } else {
      rows.push(row('tls', 'FAIL', storeTls.ok ? wssTls.reason : storeTls.reason));
    }

    const home = await input.probes.http(`${origin}/`);
    rows.push(home === undefined
      ? skipped('seller-public', 'store unreachable')
      : home.status === 200
        ? row('seller-public', 'PASS', 'store 200')
        : row('seller-public', 'FAIL', `store status ${home.status}`));
  }

  const adminPort = await input.probes.http(`${origin}:8788`);
  const adminPath = await input.probes.http(`${origin}/admin/health`);
  const adminAnswered = (probe: HttpProbe | undefined): boolean => {
    if (probe === undefined || probe.status === 404) return false;
    return probe.status === 200 || probe.status === 401 || probe.status === 403;
  };
  if (adminAnswered(adminPort) || adminAnswered(adminPath)) {
    rows.push(row('admin-not-public', 'FAIL', 'admin endpoint answered'));
  } else {
    rows.push(row('admin-not-public', 'PASS', 'admin unpublished'));
  }

  const served = origin.length === 0 ? undefined : await input.probes.http(`${origin}/index.html`);
  const built = await input.probes.readBuildHtml();
  if (served === undefined || built === undefined) {
    rows.push(skipped('html-integrity', 'html unavailable'));
  } else if (indexIntact(served.body, built, input.env)) {
    rows.push(row('html-integrity', 'PASS', 'index hash matches build'));
  } else {
    rows.push(row('html-integrity', 'FAIL', 'served index.html does not match the build'));
  }

  const scan = await input.probes.scanner();
  if (scan === undefined || scan.scannerTip === undefined || scan.lightwalletdTip === undefined) {
    rows.push(skipped('scanner', scan?.reason ?? 'scanner tip unavailable'));
  } else if (scannerWithinFloor(scan.scannerTip, scan.lightwalletdTip)) {
    rows.push(row('scanner', 'PASS', 'tip within 3 blocks'));
  } else {
    rows.push(row('scanner', 'FAIL', 'scanner tip is more than 3 blocks from lightwalletd'));
  }

  const logos = await input.probes.logosA();
  if (logos === undefined || logos.ok === undefined) {
    rows.push(skipped('logos-a', logos?.reason ?? 'logos-a unreachable'));
  } else {
    rows.push(row('logos-a', logos.ok ? 'PASS' : 'FAIL', logos.reason));
  }

  const replica = await input.probes.replica();
  if (replica === undefined || replica.present === undefined) {
    rows.push(skipped('logos-b-replica', replica?.reason ?? 'replica agent unreachable'));
  } else if (replica.present && replica.digestMatch) {
    rows.push(row('logos-b-replica', 'PASS', 'replica holds published digest'));
  } else {
    rows.push(row('logos-b-replica', 'FAIL', replica.reason));
  }

  if (wssOrigin.length > 0) {
    const trip = await input.probes.wssRoundTrip(wssOrigin);
    if (trip === undefined || trip.ok === undefined) {
      rows.push(skipped('delivery-wss', trip?.reason ?? 'wss unreachable'));
    } else {
      rows.push(row('delivery-wss', trip.ok ? 'PASS' : 'FAIL', trip.reason));
    }
  }

  const embed = origin.length === 0 ? undefined : await input.probes.http(`${origin}/embed.js`);
  const sri = await input.probes.readEmbedSri();
  if (embed === undefined || sri === undefined) {
    rows.push(skipped('embed-js', 'embed.js unavailable'));
  } else if (embed.status === 200 && sha384Sri(embed.body) === sri.trim()) {
    rows.push(row('embed-js', 'PASS', 'embed.js 200 sri match'));
  } else {
    rows.push(row('embed-js', 'FAIL', 'embed.js missing or sri mismatch'));
  }

  const age = await input.probes.backupAgeMs();
  if (age === undefined) {
    rows.push(skipped('backup-age', 'backup age unavailable'));
  } else if (age >= 0 && age < BACKUP_MAX_AGE_MS) {
    rows.push(row('backup-age', 'PASS', 'backup younger than 24h'));
  } else {
    rows.push(row('backup-age', 'FAIL', 'backup older than 24h'));
  }

  const failed = rows.some((item) => item.status === 'FAIL' || (input.strict && item.status === 'SKIP'));
  return { exitCode: failed ? 1 : 0, rows };
}

function hostOf(origin: string): { host: string; port: number } | undefined {
  try {
    const url = new URL(origin);
    return { host: url.hostname, port: url.port.length > 0 ? Number(url.port) : 443 };
  } catch {
    return undefined;
  }
}

function readScannerTip(socketPath: string): Promise<number | undefined> {
  const { promise, resolve } = Promise.withResolvers<number | undefined>();
  const req = httpRequest({ socketPath, path: '/v1/snapshot', method: 'GET', headers: { 'content-length': '0' }, timeout: 10_000 }, (res) => {
    const chunks: Buffer[] = [];
    res.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
    res.on('end', () => {
      try {
        const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (!parsed || typeof parsed !== 'object' || !('tip' in parsed)) {
          resolve(undefined);
          return;
        }
        const tip = parsed.tip;
        if (!tip || typeof tip !== 'object' || !('height' in tip) || typeof tip.height !== 'number') {
          resolve(undefined);
          return;
        }
        resolve(tip.height);
      } catch {
        resolve(undefined);
      }
    });
  });
  req.on('error', () => resolve(undefined));
  req.on('timeout', () => { req.destroy(); resolve(undefined); });
  req.end();
  return promise;
}

function lightwalletdFromConfig(path: string | undefined): string | undefined {
  if (!path) return undefined;
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || !('runtime' in parsed)) return undefined;
    const runtime = parsed.runtime;
    if (!runtime || typeof runtime !== 'object' || !('lightwalletd' in runtime)) return undefined;
    return typeof runtime.lightwalletd === 'string' ? runtime.lightwalletd : undefined;
  } catch {
    return undefined;
  }
}

function readVarintField(message: Buffer, fieldNo: number): number | undefined {
  let i = 0;
  while (i < message.length) {
    const tag = message[i];
    i += 1;
    if (tag === undefined) return undefined;
    const field = tag >> 3;
    const wire = tag & 7;
    if (wire === 0) {
      let value = 0;
      let shift = 0;
      while (i < message.length) {
        const byte = message[i] ?? 0;
        i += 1;
        value += (byte & 0x7f) * (2 ** shift);
        if ((byte & 0x80) === 0) break;
        shift += 7;
      }
      if (field === fieldNo) return value;
    } else if (wire === 2) {
      const len = message[i] ?? 0;
      i += 1 + len;
    } else {
      return undefined;
    }
  }
  return undefined;
}

function latestBlockHeight(endpoint: string): Promise<number | undefined> {
  let url: URL;
  try { url = new URL(endpoint); } catch { return Promise.resolve(undefined); }
  const { promise, resolve } = Promise.withResolvers<number | undefined>();
  const client = http2Connect(`${url.protocol}//${url.host}`);
  let settled = false;
  const done = (value: number | undefined) => {
    if (settled) return;
    settled = true;
    client.close();
    resolve(value);
  };
  client.on('error', () => done(undefined));
  const req = client.request({
    ':method': 'POST',
    ':path': '/cash.z.wallet.sdk.rpc.CompactTxStreamer/GetLatestBlock',
    'content-type': 'application/grpc',
    te: 'trailers',
  });
  const chunks: Buffer[] = [];
  req.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
  req.on('end', () => {
    const body = Buffer.concat(chunks);
    if (body.length < 6) {
      done(undefined);
      return;
    }
    done(readVarintField(body.subarray(5), 1));
  });
  req.on('error', () => done(undefined));
  req.setTimeout(10_000, () => { req.close(); done(undefined); });
  req.end(Buffer.from([0, 0, 0, 0, 0]));
  return promise;
}

function probeLogosA(logosctl: string | undefined, configDir: string | undefined): { ok?: boolean; reason: string } | undefined {
  if (!logosctl || !configDir) return undefined;
  const result = spawnSync(logosctl, ['--config-dir', configDir, '--json', 'daemon', 'status'], {
    encoding: 'utf8',
    timeout: 15_000,
  });
  if (result.error) return undefined;
  const text = result.stdout ?? '';
  const ok = text.includes('"running"');
  return { ok, reason: ok ? 'daemon running' : 'daemon not running' };
}

function latestPublished(dbPath: string): { cid: string; digest: string; size: number } | undefined {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const row: unknown = db.prepare(
      `SELECT ciphertext_cid, ciphertext_digest, file_size
       FROM products WHERE published = 1 AND ciphertext_cid IS NOT NULL
       ORDER BY created_at DESC, rowid DESC LIMIT 1`,
    ).get();
    if (!row || typeof row !== 'object') return undefined;
    if (!('ciphertext_cid' in row) || typeof row.ciphertext_cid !== 'string') return undefined;
    if (!('ciphertext_digest' in row) || typeof row.ciphertext_digest !== 'string') return undefined;
    if (!('file_size' in row) || typeof row.file_size !== 'number') return undefined;
    return { cid: row.ciphertext_cid, digest: row.ciphertext_digest, size: row.file_size };
  } finally {
    db.close();
  }
}

async function probeReplica(env: Record<string, string>): Promise<{ present?: boolean; digestMatch?: boolean; reason: string } | undefined> {
  const url = env.SSF_REPLICA_AGENT_URL;
  const tokenFile = env.SSF_REPLICA_TOKEN_FILE;
  const dbPath = env.SSF_DB_PATH;
  if (!url || !tokenFile || !dbPath) return undefined;
  try {
    const token = readReplicaToken(tokenFile);
    const published = latestPublished(dbPath);
    if (!published) return { present: false, digestMatch: false, reason: 'no published cid' };
    const target = new URL(`/v1/has/${encodeURIComponent(published.cid)}?digest=${published.digest}&size=${published.size}`, url);
    const response = await fetch(target, {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) return { present: false, digestMatch: false, reason: 'replica has failed' };
    const body: unknown = await response.json();
    const present = body !== null && typeof body === 'object' && 'present' in body && body.present === true;
    return { present, digestMatch: present, reason: present ? 'digest match' : 'digest mismatch' };
  } catch {
    return undefined;
  }
}

function backupAgeMs(dir: string): number | undefined {
  try {
    const names = readdirSync(dir).filter((name) => name.endsWith('.ssbk'));
    if (names.length === 0) return undefined;
    let newest = Number.POSITIVE_INFINITY;
    const now = Date.now();
    for (const name of names) {
      const age = now - statSync(join(dir, name)).mtimeMs;
      if (age < newest) newest = age;
    }
    return newest;
  } catch {
    return undefined;
  }
}


export function defaultProbes(env: Record<string, string>): DoctorProbes {
  return {
    tls: (origin) => {
      const { promise, resolve } = Promise.withResolvers<{ ok: boolean; reason: string } | undefined>();
      const target = hostOf(origin);
      if (!target) {
        resolve(undefined);
        return promise;
      }
      const socket = tlsConnect({ host: target.host, port: target.port, servername: target.host, timeout: 10_000 }, () => {
        const ok = socket.authorized;
        socket.end();
        resolve({ ok, reason: ok ? 'cert ok' : 'cert rejected' });
      });
      socket.on('error', () => resolve(undefined));
      socket.on('timeout', () => { socket.destroy(); resolve(undefined); });
      return promise;
    },
    http: (url) => fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(10_000) })
      .then(async (response) => ({
        status: response.status,
        body: new Uint8Array(await response.arrayBuffer()),
        headers: Object.fromEntries(response.headers.entries()),
      }))
      .catch(() => undefined),
    scanner: async () => {
      const socketPath = env.SSF_SCANNER_SOCKET;
      if (!socketPath) return undefined;
      const scannerTip = await readScannerTip(socketPath);
      const endpoint = env.SSF_LIGHTWALLETD ?? lightwalletdFromConfig(env.SSF_SCANNER_CONFIG);
      if (scannerTip === undefined || !endpoint) return undefined;
      const lightwalletdTip = await latestBlockHeight(endpoint);
      if (lightwalletdTip === undefined) return { scannerTip, reason: 'lightwalletd tip unavailable' };
      return { scannerTip, lightwalletdTip };
    },
    logosA: async () => probeLogosA(env.LOGOSCTL, env.LOGOS_NODE_A),
    replica: async () => probeReplica(env),
    wssRoundTrip: async () => undefined,
    backupAgeMs: async () => backupAgeMs(env.SSF_BACKUP_DIR ?? '/var/lib/ssf/backups'),
    readBuildHtml: async () => {
      try { return new Uint8Array(readFileSync('dist/browser/index.html')); } catch { return undefined; }
    },
    readEmbedSri: async () => {
      try { return readFileSync('dist/browser/embed.sri.txt', 'utf8'); } catch { return undefined; }
    },
  };
}

function isMain(): boolean {
  return process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`;
}

async function main(): Promise<number> {
  const strict = process.argv.includes('--strict');
  const result = await runPublicDoctor({ strict, env: process.env as Record<string, string>, probes: defaultProbes(process.env as Record<string, string>) });
  process.stdout.write(`${formatDoctor(result.rows)}\n`);
  return result.exitCode;
}

if (isMain()) {
  process.exitCode = await main();
}

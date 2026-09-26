import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { createMemoryMessaging } from '../../src/adapters/messaging.ts';
import { MemoryScanner } from '../../src/adapters/scanner.ts';
import { createMemoryStorageAdapter } from '../../src/adapters/storage.ts';
import { loadConfig, type RuntimeConfig } from '../../src/config.ts';
import { consensusFingerprint } from '../../src/contracts/consensus.ts';
import { startSeller, type SellerServer } from '../../src/seller/server.ts';

const ACTIVATIONS = {
  overwinter: 1, sapling: 1, blossom: 1, heartwood: 1, canopy: 1, nu5: 1, nu6: 1,
  'nu6-1': null, 'nu6-2': null, 'nu6-3': null,
};
const GENESIS = 'ab'.repeat(32);
const CHAIN = { network: 'regtest' as const, genesisHash: GENESIS, consensusFingerprint: consensusFingerprint('regtest', ACTIVATIONS) };
const TOPIC = '/ssf/1/waku-config-test/proto';
const PEER_A = '/dns4/peer-a.example/tcp/8000/wss/p2p/16Uiu2HAmPeerA';
const PEER_B = '/dns4/peer-b.example/tcp/8443/wss/p2p/16Uiu2HAmPeerB';
const ADMIN_TOKEN = 'admin-token-from-file';

let scratch = '';
let seller: SellerServer | undefined;

beforeEach(() => {
  scratch = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), 'ssf-wakucfg-'));
});

afterEach(async () => {
  await seller?.close().catch(() => undefined);
  seller = undefined;
  if (scratch) rmSync(scratch, { recursive: true, force: true });
  scratch = '';
});

// Copied (not imported) from csp-static.test.ts liveConfig().
function liveConfig(): RuntimeConfig {
  const scannerConfig = join(scratch, 'scanner.json');
  writeFileSync(scannerConfig, JSON.stringify({
    ufvk: 'not-a-real-ufvk',
    runtime: { chain: CHAIN, activations: ACTIVATIONS, sourceId: 'fixture-scanner' },
  }), { mode: 0o600 });
  chmodSync(scannerConfig, 0o600);
  const tokenFile = join(scratch, 'admin.token');
  writeFileSync(tokenFile, `${ADMIN_TOKEN}\n`, { mode: 0o600 });
  chmodSync(tokenFile, 0o600);
  return loadConfig({
    SSF_MODE: 'real-demo',
    SSF_NETWORK: 'regtest',
    SSF_MAX_HEALTH_AGE_MS: '120000',
    SSF_MAX_CIPHERTEXT_BYTES: '73',
    SSF_MAX_PLAINTEXT_BYTES: '41',
    SSF_INVOICE_TTL_MS: '86400000',
    SSF_PUBLIC_HOST: '127.0.0.1',
    SSF_PUBLIC_PORT: '0',
    SSF_ADMIN_HOST: '127.0.0.1',
    SSF_ADMIN_PORT: '0',
    SSF_DB_PATH: join(scratch, 'data', 'seller.sqlite'),
    SSF_ADMIN_TOKEN_FILE: tokenFile,
    SSF_ADAPTER_MESSAGING: 'real',
    SSF_ADAPTER_STORAGE: 'real',
    SSF_ADAPTER_SCANNER: 'real',
    SSF_SCANNER_SOCKET: join(scratch, 's.sock'),
    SSF_SCANNER_ACCOUNT_ID: 'seller-account-0',
    SSF_SCANNER_CONFIG: scannerConfig,
    SSF_WAKU_CONTENT_TOPIC: TOPIC,
    WAKU_BOOTSTRAP_PEERS: `${PEER_A},${PEER_B}`,
    LOGOSCTL: '/opt/logos/logosctl',
    LOGOS_NODE_A: join(scratch, 'node-a'),
    LOGOS_NODE_B: join(scratch, 'node-b'),
  });
}

function fixtureConfig(): RuntimeConfig {
  return loadConfig({
    SSF_MODE: 'fixture',
    SSF_NETWORK: 'test',
    SSF_MIN_CONFIRMATIONS: '10',
    SSF_MAX_HEALTH_AGE_MS: '120000',
    SSF_MAX_CIPHERTEXT_BYTES: '73',
    SSF_MAX_PLAINTEXT_BYTES: '41',
    SSF_INVOICE_TTL_MS: '86400000',
    SSF_PUBLIC_HOST: '127.0.0.1',
    SSF_PUBLIC_PORT: '0',
    SSF_ADMIN_HOST: '127.0.0.1',
    SSF_ADMIN_PORT: '0',
    SSF_DB_PATH: join(scratch, 'fixture.sqlite'),
    SSF_SELLER_KEY_ID: 'seller-key-1',
    SSF_DESTINATION: `uregtest1${'q'.repeat(150)}`,
    SSF_ADAPTER_MESSAGING: 'fixture',
    SSF_ADAPTER_STORAGE: 'fixture',
    SSF_ADAPTER_SCANNER: 'fixture',
    SSF_ADMIN_TOKEN: 'admin-token-not-for-examples',
  });
}

function browserDir(): string {
  const dir = join(scratch, 'browser');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'index.html'), '<!DOCTYPE html><title>built</title>');
  return dir;
}

function liveAdapters() {
  const scanner = new MemoryScanner();
  scanner.replaceSnapshot([], { id: 'rev-10', height: 10 }, true, Date.now());
  return { scanner, storage: createMemoryStorageAdapter(), messaging: createMemoryMessaging() };
}

async function startLive(): Promise<SellerServer> {
  return startSeller({ config: liveConfig(), sellerKeyId: 'seller-key-1', seedProduct: false, publicDir: browserDir(), startLoops: false, ...liveAdapters() });
}

/** Hosts (with port) named by the CSP connect-src, excluding 'self'. */
function connectSrcHosts(csp: string): string[] {
  const directive = csp.split(';').map((part) => part.trim()).find((part) => part.startsWith('connect-src')) ?? '';
  return directive.split(/\s+/).slice(1).filter((token) => token !== "'self'").map((origin) => new URL(origin).host).sort();
}

/** host:port of each peer multiaddr, independent of the server's own parser. */
function peerHosts(peers: string[]): string[] {
  return peers.map((peer) => {
    const [, proto, host, , port] = peer.split('/');
    return `${proto === 'ip6' ? `[${host}]` : host}:${port}`;
  }).sort();
}

test('real-demo GET /api/waku-config returns exactly the frozen PublicWakuConfig fields', async () => {
  seller = await startLive();
  const res = await fetch(`${seller.publicUrl}/api/waku-config`);
  expect(res.status).toBe(200);
  expect(res.headers.get('content-type') ?? '').toMatch(/application\/json/);
  const body = await res.json() as Record<string, unknown>;
  expect(Object.keys(body).sort()).toEqual(['bootstrapPeers', 'contentTopic', 'network', 'sellerKeyId']);
  expect(body).toEqual({
    sellerKeyId: 'seller-key-1',
    network: 'regtest',
    contentTopic: TOPIC,
    bootstrapPeers: [PEER_A, PEER_B],
  });
  const text = JSON.stringify(body);
  for (const leak of [ADMIN_TOKEN, 'not-a-real-ufvk', 's.sock', 'seller-account-0', 'logosctl', 'node-a', 'seller.sqlite']) {
    expect(text).not.toContain(leak);
  }
});

test('real-demo /api/waku-config sellerKeyId matches /api/product identity source', async () => {
  seller = await startLive();
  const cfg = await (await fetch(`${seller.publicUrl}/api/waku-config`)).json() as { sellerKeyId: string };
  expect(cfg.sellerKeyId).toBe('seller-key-1');
});

test('real-demo CSP connect-src hosts equal the hosts derived from /api/waku-config bootstrapPeers', async () => {
  seller = await startLive();
  const res = await fetch(`${seller.publicUrl}/api/waku-config`);
  const cfg = await res.json() as { bootstrapPeers: string[] };
  const csp = res.headers.get('content-security-policy') ?? '';
  expect(connectSrcHosts(csp)).toEqual(peerHosts(cfg.bootstrapPeers));
});

test('real-demo POST /api/acknowledge returns 404 alongside orders/status/recover', async () => {
  seller = await startLive();
  for (const path of ['/api/acknowledge', '/api/orders', '/api/status', '/api/recover']) {
    const res = await fetch(`${seller.publicUrl}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    expect(res.status, path).toBe(404);
  }
});

test('fixture GET /api/waku-config returns 404', async () => {
  seller = await startSeller({ config: fixtureConfig(), seedProduct: false, startLoops: false });
  const res = await fetch(`${seller.publicUrl}/api/waku-config`);
  expect(res.status).toBe(404);
});

test('real-demo /api/waku-config is not served on the admin port as a public route', async () => {
  seller = await startLive();
  const res = await fetch(`${seller.adminUrl}/api/waku-config`);
  expect(res.status).toBe(401);
});

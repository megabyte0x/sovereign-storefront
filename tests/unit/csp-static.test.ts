import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { createMemoryMessaging } from '../../src/adapters/messaging.ts';
import { MemoryScanner } from '../../src/adapters/scanner.ts';
import { createMemoryStorageAdapter } from '../../src/adapters/storage.ts';
import { ConfigError, loadConfig, type RuntimeConfig } from '../../src/config.ts';
import { consensusFingerprint } from '../../src/contracts/consensus.ts';
import { buildCsp, startSeller, type SellerServer } from '../../src/seller/server.ts';

const ACTIVATIONS = {
  overwinter: 1, sapling: 1, blossom: 1, heartwood: 1, canopy: 1, nu5: 1, nu6: 1,
  'nu6-1': null, 'nu6-2': null, 'nu6-3': null,
};
const GENESIS = 'ab'.repeat(32);
const CHAIN = { network: 'regtest' as const, genesisHash: GENESIS, consensusFingerprint: consensusFingerprint('regtest', ACTIVATIONS) };
const PEER_A = '/dns4/peer-a.example/tcp/8000/wss/p2p/16Uiu2HAmPeerA';
const PEER_B = '/dns4/peer-b.example/tcp/8443/wss/p2p/16Uiu2HAmPeerB';

let scratch = '';
let seller: SellerServer | undefined;

beforeEach(() => {
  scratch = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), 'ssf-csp-'));
});

afterEach(async () => {
  await seller?.close().catch(() => undefined);
  seller = undefined;
  if (scratch) rmSync(scratch, { recursive: true, force: true });
  scratch = '';
});

// Copied (not imported) from live-composition.test.ts liveConfig().
function liveConfig(overrides: Record<string, string | undefined> = {}): RuntimeConfig {
  const scannerConfig = join(scratch, 'scanner.json');
  writeFileSync(scannerConfig, JSON.stringify({
    ufvk: 'not-a-real-ufvk',
    runtime: { chain: CHAIN, activations: ACTIVATIONS, sourceId: 'fixture-scanner' },
  }), { mode: 0o600 });
  chmodSync(scannerConfig, 0o600);
  const tokenFile = join(scratch, 'admin.token');
  writeFileSync(tokenFile, 'admin-token-from-file\n', { mode: 0o600 });
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
    SSF_WAKU_CONTENT_TOPIC: '/ssf/1/csp-test/proto',
    WAKU_BOOTSTRAP_PEERS: `${PEER_A},${PEER_B}`,
    LOGOSCTL: '/opt/logos/logosctl',
    LOGOS_NODE_A: join(scratch, 'node-a'),
    LOGOS_NODE_B: join(scratch, 'node-b'),
    ...overrides,
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

function withPeers(config: RuntimeConfig, peers: string[]): RuntimeConfig {
  if (!config.live) throw new Error('liveConfig() must produce a live block');
  return { ...config, live: { ...config.live, waku: { ...config.live.waku, bootstrapPeers: peers } } };
}

function connectSrc(csp: string): string {
  return csp.split(';').map((part) => part.trim()).find((part) => part.startsWith('connect-src')) ?? '';
}

function browserDir(withIndex = true): string {
  const dir = join(scratch, 'browser');
  mkdirSync(dir, { recursive: true });
  if (withIndex) writeFileSync(join(dir, 'index.html'), '<!DOCTYPE html><title>built</title>');
  return dir;
}

function liveAdapters() {
  const scanner = new MemoryScanner();
  scanner.replaceSnapshot([], { id: 'rev-10', height: 10 }, true, Date.now());
  return { scanner, storage: createMemoryStorageAdapter(), messaging: createMemoryMessaging() };
}

function publicTestnetEnv(): NodeJS.Dict<string> {
  const scannerConfig = join(scratch, 'scanner-test.json');
  writeFileSync(scannerConfig, JSON.stringify({
    ufvk: 'not-a-real-ufvk',
    runtime: {
      sourceId: 'fixture-scanner',
      chain: {
        network: 'test',
        genesisHash: GENESIS,
        consensusFingerprint: consensusFingerprint('test', ACTIVATIONS),
      },
      activations: ACTIVATIONS,
    },
  }), { mode: 0o600 });
  chmodSync(scannerConfig, 0o600);
  const tokenFile = join(scratch, 'public-admin.token');
  writeFileSync(tokenFile, 'admin-token-from-file\n', { mode: 0o600 });
  chmodSync(tokenFile, 0o600);
  return {
    SSF_MODE: 'public-testnet',
    SSF_NETWORK: 'test',
    SSF_PUBLIC_ORIGIN: 'https://store.example.org',
    SSF_EMBED_ORIGINS: 'https://books.example.org',
    SSF_MIN_CONFIRMATIONS: '3',
    SSF_MAX_HEALTH_AGE_MS: '120000',
    SSF_MAX_PLAINTEXT_BYTES: '41',
    SSF_INVOICE_TTL_MS: '86400000',
    SSF_PUBLIC_HOST: '127.0.0.1',
    SSF_PUBLIC_PORT: '0',
    SSF_ADMIN_HOST: '127.0.0.1',
    SSF_ADMIN_PORT: '0',
    SSF_DB_PATH: join(scratch, 'public.sqlite'),
    SSF_ADAPTER_MESSAGING: 'real',
    SSF_ADAPTER_STORAGE: 'real',
    SSF_ADAPTER_SCANNER: 'real',
    SSF_ADMIN_TOKEN_FILE: tokenFile,
    SSF_SCANNER_SOCKET: join(scratch, 's.sock'),
    SSF_SCANNER_ACCOUNT_ID: 'seller-account-0',
    SSF_SCANNER_CONFIG: scannerConfig,
    SSF_WAKU_CONTENT_TOPIC: '/ssf/1/csp-test/proto',
    WAKU_BOOTSTRAP_PEERS: `${PEER_A},${PEER_B}`,
    LOGOSCTL: '/opt/logos/logosctl',
    LOGOS_NODE_A: join(scratch, 'node-a'),
    LOGOS_NODE_B: join(scratch, 'node-b'),
  };
}

test('fixture CSP keeps connect-src self only', () => {
  const csp = buildCsp(fixtureConfig());
  expect(connectSrc(csp)).toBe("connect-src 'self'");
  expect(csp).not.toContain('*');
});

test('real-demo CSP lists exactly the configured wss peers', () => {
  const csp = buildCsp(liveConfig());
  expect(connectSrc(csp)).toBe("connect-src 'self' wss://peer-a.example:8000 wss://peer-b.example:8443");
  expect(csp).not.toContain('*');
  expect(csp).not.toMatch(/\bwss:(\s|;|$)/);
});

test('real-demo CSP allows ws:// only for a loopback /ws peer', () => {
  const loopback = withPeers(liveConfig(), [PEER_A, '/ip4/127.0.0.1/tcp/8645/ws/p2p/16Uiu2HAmLocal']);
  expect(connectSrc(buildCsp(loopback))).toBe("connect-src 'self' wss://peer-a.example:8000 ws://127.0.0.1:8645");
  const remote = withPeers(liveConfig(), ['/dns4/peer-c.example/tcp/8645/ws/p2p/16Uiu2HAmRemote']);
  expect(() => buildCsp(remote)).toThrow(ConfigError);
});

test('real-demo startSeller serves configured peers in content-security-policy', async () => {
  // Real-demo config carries no sellerKeyId; startRuntime supplies the persisted identity.
  seller = await startSeller({ config: liveConfig(), sellerKeyId: 'seller-key-1', seedProduct: false, publicDir: browserDir(), startLoops: false, ...liveAdapters() });
  const res = await fetch(`${seller.publicUrl}/`);
  const csp = res.headers.get('content-security-policy') ?? '';
  expect(csp).toContain('wss://peer-a.example:8000');
  expect(csp).toContain('wss://peer-b.example:8443');
  expect(csp).not.toContain('*');
  expect(await res.text()).toContain('<title>built</title>');
});

test('real-demo serves built assets when publicDir has a trailing slash (dist/service/main.js passes ../browser/)', async () => {
  const dir = browserDir();
  mkdirSync(join(dir, 'assets'), { recursive: true });
  writeFileSync(join(dir, 'assets', 'index-test.js'), 'console.log(1)');
  seller = await startSeller({ config: liveConfig(), sellerKeyId: 'seller-key-1', seedProduct: false, publicDir: `${dir}/`, startLoops: false, ...liveAdapters() });
  const res = await fetch(`${seller.publicUrl}/assets/index-test.js`);
  expect(res.status).toBe(200);
  expect(await res.text()).toBe('console.log(1)');
  expect((await fetch(`${seller.publicUrl}/assets/..%2f..%2findex.html`)).status).toBe(404);
});

test('real-demo startSeller rejects a non-loopback /ws peer', async () => {
  const config = withPeers(liveConfig(), ['/dns4/peer-c.example/tcp/8645/ws/p2p/16Uiu2HAmRemote']);
  await expect(startSeller({ config, seedProduct: false, publicDir: browserDir(), startLoops: false, ...liveAdapters() }))
    .rejects.toThrow(ConfigError);
});

test('real-demo startSeller requires an explicit publicDir', async () => {
  await expect(startSeller({ config: liveConfig(), seedProduct: false, startLoops: false, ...liveAdapters() }))
    .rejects.toThrow(/publicDir/);
});

test('real-demo startSeller rejects a publicDir without index.html', async () => {
  await expect(startSeller({ config: liveConfig(), seedProduct: false, publicDir: browserDir(false), startLoops: false, ...liveAdapters() }))
    .rejects.toThrow(/index\.html/);
});

test('real-demo startSeller rejects a config without a live block', async () => {
  const { live: _live, ...withoutLive } = liveConfig();
  await expect(startSeller({ config: withoutLive, seedProduct: false, publicDir: browserDir(), startLoops: false, ...liveAdapters() }))
    .rejects.toThrow(/live/);
});

test('fixture startSeller keeps its fallback static serving', async () => {
  seller = await startSeller({ config: fixtureConfig(), seedProduct: false, startLoops: false });
  const res = await fetch(`${seller.publicUrl}/`);
  expect(res.status).toBe(200);
  expect(connectSrc(res.headers.get('content-security-policy') ?? '')).toBe("connect-src 'self'");
});

test('public-testnet CSP lists configured wss peers and keeps frame-ancestors none', () => {
  const csp = buildCsp(loadConfig(publicTestnetEnv()));
  expect(connectSrc(csp)).toBe("connect-src 'self' wss://peer-a.example:8000 wss://peer-b.example:8443");
  expect(csp).toContain("frame-ancestors 'none'");
  expect(csp).not.toContain('*');
});

test('embed.js is cross-origin and immutable; app pages are not', async () => {
  const dir = browserDir();
  writeFileSync(join(dir, 'embed.js'), '/* embed */');
  seller = await startSeller({ config: fixtureConfig(), seedProduct: false, publicDir: dir, startLoops: false });
  const page = await fetch(`${seller.publicUrl}/`);
  expect(page.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
  expect(page.headers.get('access-control-allow-origin')).not.toBe('*');
  const embed = await fetch(`${seller.publicUrl}/embed.js`);
  expect(embed.status).toBe(200);
  expect(await embed.text()).toBe('/* embed */');
  expect(embed.headers.get('cross-origin-resource-policy')).toBe('cross-origin');
  expect(embed.headers.get('access-control-allow-origin')).toBe('*');
  expect(embed.headers.get('cache-control')).toMatch(/immutable/);
});

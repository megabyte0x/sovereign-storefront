import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { consensusFingerprint } from '../../src/contracts/consensus.ts';
import { DEFAULT_POLICY } from '../../src/seller/payments.ts';
import {
  ConfigError,
  DEFAULT_MIN_CONFIRMATIONS,
  loadConfig,
  MissingLiveKeyError,
} from '../../src/config.ts';

const DESTINATION =
  'uregtest1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq';

function validEnv(overrides: Record<string, string | undefined> = {}): NodeJS.Dict<string> {
  return {
    SSF_MODE: 'fixture',
    SSF_NETWORK: 'test',
    SSF_MIN_CONFIRMATIONS: '10',
    SSF_MAX_HEALTH_AGE_MS: '120000',
    SSF_MAX_CIPHERTEXT_BYTES: '73',
    SSF_MAX_PLAINTEXT_BYTES: '41',
    SSF_INVOICE_TTL_MS: '86400000',
    SSF_PUBLIC_HOST: '127.0.0.1',
    SSF_PUBLIC_PORT: '8787',
    SSF_ADMIN_HOST: '127.0.0.1',
    SSF_ADMIN_PORT: '8788',
    SSF_DB_PATH: '/tmp/ssf-seller.sqlite',
    SSF_SELLER_KEY_ID: 'seller-key-1',
    SSF_DESTINATION: DESTINATION,
    SSF_ADAPTER_MESSAGING: 'fixture',
    SSF_ADAPTER_STORAGE: 'fixture',
    SSF_ADAPTER_SCANNER: 'fixture',
    SSF_ADMIN_TOKEN: 'admin-secret-not-for-browser',
    ...overrides,
  };
}

test('defaults minConfirmations to 10 and never to 0', () => {
  expect(DEFAULT_MIN_CONFIRMATIONS).toBe(10);
  expect(DEFAULT_POLICY.minConfirmations).toBe(10);
  const omitted = loadConfig(validEnv({ SSF_MIN_CONFIRMATIONS: undefined }));
  expect(omitted.minConfirmations).toBe(10);
  expect(omitted.minConfirmations).not.toBe(0);
  expect(omitted.minConfirmations).not.toBe(1);
});

test('accepts zakura chain reported as test and never mainnet', () => {
  const cfg = loadConfig(validEnv({ SSF_NETWORK: 'test' }));
  expect(cfg.network).toBe('test');
  expect(() => loadConfig(validEnv({ SSF_NETWORK: 'mainnet' }))).toThrow(ConfigError);
  expect(() => loadConfig(validEnv({ SSF_NETWORK: 'main' }))).toThrow(/mainnet/i);
});

test('accepts regtest as a product network while invoice network stays test', () => {
  const cfg = loadConfig(validEnv({ SSF_NETWORK: 'regtest' }));
  expect(cfg.productNetwork).toBe('regtest');
  expect(cfg.network).toBe('test');
});

test('rejects nonpositive confirmation thresholds', () => {
  expect(() => loadConfig(validEnv({ SSF_MIN_CONFIRMATIONS: '0' }))).toThrow(ConfigError);
  expect(() => loadConfig(validEnv({ SSF_MIN_CONFIRMATIONS: '-1' }))).toThrow(ConfigError);
});

test('rejects missing freshness and size limits', () => {
  expect(() => loadConfig(validEnv({ SSF_MAX_HEALTH_AGE_MS: undefined }))).toThrow(/maxHealthAgeMs|freshness|MAX_HEALTH_AGE/i);
  expect(() => loadConfig(validEnv({ SSF_MAX_CIPHERTEXT_BYTES: undefined }))).toThrow(/ciphertext|size/i);
  expect(() => loadConfig(validEnv({ SSF_MAX_PLAINTEXT_BYTES: undefined }))).toThrow(/plaintext|size/i);
  expect(() => loadConfig(validEnv({ SSF_MAX_HEALTH_AGE_MS: '0' }))).toThrow(ConfigError);
  expect(() => loadConfig(validEnv({ SSF_MAX_CIPHERTEXT_BYTES: '0' }))).toThrow(ConfigError);
});

test('rejects fixture adapters in real-demo mode', () => {
  expect(() => loadConfig(validEnv({
    SSF_MODE: 'real-demo',
    SSF_ADAPTER_MESSAGING: 'fixture',
    SSF_ADAPTER_STORAGE: 'real',
    SSF_ADAPTER_SCANNER: 'real',
  }))).toThrow(/fixture/i);
  expect(() => loadConfig(validEnv({
    SSF_MODE: 'real-demo',
    SSF_ADAPTER_MESSAGING: 'real',
    SSF_ADAPTER_STORAGE: 'fixture',
    SSF_ADAPTER_SCANNER: 'real',
  }))).toThrow(/fixture/i);
  expect(() => loadConfig(validEnv({
    SSF_MODE: 'real-demo',
    SSF_ADAPTER_MESSAGING: 'real',
    SSF_ADAPTER_STORAGE: 'real',
    SSF_ADAPTER_SCANNER: 'fixture',
  }))).toThrow(/fixture/i);
});

test('real-demo does not quietly default missing adapters to fixtures', () => {
  expect(() => loadConfig(validEnv({
    SSF_MODE: 'real-demo',
    SSF_ADAPTER_MESSAGING: undefined,
    SSF_ADAPTER_STORAGE: undefined,
    SSF_ADAPTER_SCANNER: undefined,
  }))).toThrow(ConfigError);
});

test('real-demo accepts explicit real adapters', () => {
  const cfg = loadConfig(liveEnv());
  expect(cfg.mode).toBe('real-demo');
  expect(cfg.adapters).toEqual({
    messaging: 'real',
    storage: 'real',
    scanner: 'real',
  });
  expect(cfg.minConfirmations).toBe(10);
  expect(cfg.adminToken).toBe('admin-secret-from-file');
});

test('fixture mode loads a complete public and admin bind', () => {
  const cfg = loadConfig(validEnv());
  expect(cfg.mode).toBe('fixture');
  expect(cfg.publicHost).toBe('127.0.0.1');
  expect(cfg.adminHost).toBe('127.0.0.1');
  expect(cfg.publicPort).toBe(8787);
  expect(cfg.adminPort).toBe(8788);
  expect(cfg.maxHealthAgeMs).toBe(120_000);
  expect(cfg.maxCiphertextBytes).toBe(73);
  expect(cfg.destination).toBe(DESTINATION);
});

test('real messaging adapter does not fall back to fixture memory', async () => {
  const { startSeller } = await import('../../src/seller/server.ts');
  const cfg = loadConfig(validEnv({ SSF_ADAPTER_MESSAGING: 'real' }));
  await expect(startSeller({ config: cfg, seedProduct: false })).rejects.toThrow(/fixture|real messaging/i);
});


const ACTIVATIONS = {
  overwinter: 1, sapling: 1, blossom: 1, heartwood: 1, canopy: 1, nu5: 1, nu6: 1,
  'nu6-1': null, 'nu6-2': null, 'nu6-3': null,
};
const GENESIS = 'ab'.repeat(32);
let liveScratch = '';
let fileCounter = 0;

beforeEach(() => {
  liveScratch = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), 'ssf-live-cfg-'));
});
afterEach(() => {
  rmSync(liveScratch, { recursive: true, force: true });
});

function protectedFile(name: string, contents: string, mode = 0o600): string {
  fileCounter += 1;
  const path = join(liveScratch, `${fileCounter}-${name}`);
  writeFileSync(path, contents, { mode });
  chmodSync(path, mode);
  return path;
}

function scannerConfig(runtime: Record<string, unknown> = {}, mode = 0o600): string {
  return protectedFile('scanner.json', JSON.stringify({
    ufvk: 'not-a-real-ufvk',
    runtime: {
      sourceId: 'fixture-scanner',
      chain: { network: 'regtest', genesisHash: GENESIS, consensusFingerprint: consensusFingerprint('regtest', ACTIVATIONS) },
      activations: ACTIVATIONS,
      ...runtime,
    },
  }), mode);
}

function liveEnv(overrides: Record<string, string | undefined> = {}): NodeJS.Dict<string> {
  return validEnv({
    SSF_MODE: 'real-demo',
    SSF_NETWORK: 'regtest',
    SSF_ADAPTER_MESSAGING: 'real',
    SSF_ADAPTER_STORAGE: 'real',
    SSF_ADAPTER_SCANNER: 'real',
    SSF_DESTINATION: undefined,
    SSF_ADMIN_TOKEN: undefined,
    SSF_SELLER_KEY_ID: undefined,
    SSF_ADMIN_TOKEN_FILE: protectedFile('admin.token', 'admin-secret-from-file\n'),
    SSF_SCANNER_SOCKET: '/home/u/.local/state/ssf-live/scanner/.scanner.json.live-state/scanner.sock',
    SSF_SCANNER_ACCOUNT_ID: 'seller-account-0',
    SSF_SCANNER_CONFIG: scannerConfig(),
    SSF_WAKU_CONTENT_TOPIC: '/ssf/1/live-run/proto',
    WAKU_BOOTSTRAP_PEERS: '/dns4/a.example/tcp/8000/wss/p2p/16Uiu2HAmA,/dns4/b.example/tcp/443/wss/p2p/16Uiu2HAmB',
    LOGOSCTL: '/opt/logos/logosctl',
    LOGOS_NODE_A: '/var/lib/ssf/logos/node-a',
    LOGOS_NODE_B: '/var/lib/ssf/logos/node-b',
    ...overrides,
  });
}

test('real-demo loads explicit live configuration with a derived consensus fingerprint', () => {
  const cfg = loadConfig(liveEnv());
  expect(cfg.mode).toBe('real-demo');
  expect(cfg.productNetwork).toBe('regtest');
  expect(cfg.live).toBeDefined();
  const live = cfg.live!;
  expect(live.scannerSocket).toMatch(/scanner\.sock$/);
  expect(live.scannerAccountId).toBe('seller-account-0');
  expect(live.chain).toEqual({
    network: 'regtest',
    genesisHash: GENESIS,
    consensusFingerprint: consensusFingerprint('regtest', ACTIVATIONS),
  });
  expect(live.activations).toEqual(ACTIVATIONS);
  expect(live.waku).toEqual({
    contentTopic: '/ssf/1/live-run/proto',
    bootstrapPeers: ['/dns4/a.example/tcp/8000/wss/p2p/16Uiu2HAmA', '/dns4/b.example/tcp/443/wss/p2p/16Uiu2HAmB'],
    peerTimeoutMs: expect.any(Number),
  });
  expect(live.logos).toEqual({
    logosctlPath: '/opt/logos/logosctl',
    originConfigDir: '/var/lib/ssf/logos/node-a',
    replicaConfigDir: '/var/lib/ssf/logos/node-b',
  });
  expect(cfg.adminToken).toBe('admin-secret-from-file');
  expect(cfg.destination).toBe('');
  expect(cfg.minConfirmations).toBe(10);
});

test('real-demo rejects SSF_MIN_CONFIRMATIONS below the global floor of 10', () => {
  for (const value of ['1', '5', '9']) {
    expect(() => loadConfig(liveEnv({ SSF_MIN_CONFIRMATIONS: value }))).toThrow(ConfigError);
    expect(() => loadConfig(liveEnv({ SSF_MIN_CONFIRMATIONS: value }))).toThrow(/minConfirmations.*at least 10/);
  }
  expect(loadConfig(liveEnv({ SSF_MIN_CONFIRMATIONS: '10' })).minConfirmations).toBe(10);
  expect(loadConfig(liveEnv({ SSF_MIN_CONFIRMATIONS: '12' })).minConfirmations).toBe(12);
  // Fixture mode is unchanged: any positive threshold is accepted.
  expect(loadConfig(validEnv({ SSF_MIN_CONFIRMATIONS: '1' })).minConfirmations).toBe(1);
});

test('real-demo does not require SSF_DESTINATION and needs no seller key id env', () => {
  expect(() => loadConfig(liveEnv({ SSF_DESTINATION: undefined, SSF_SELLER_KEY_ID: undefined }))).not.toThrow();
});

test('real-demo requires SSF_NETWORK explicitly (live.env does not set it)', () => {
  expect(() => loadConfig(liveEnv({ SSF_NETWORK: undefined }))).toThrow(/SSF_NETWORK/);
});

test('real-demo rejects any raw consensus digest setting', () => {
  expect(() => loadConfig(liveEnv({ SSF_CONSENSUS_FINGERPRINT: 'c'.repeat(64) }))).toThrow(/consensus fingerprint.*derived/i);
  expect(() => loadConfig(liveEnv({ SSF_CHAIN_CONSENSUS_FINGERPRINT: 'c'.repeat(64) }))).toThrow(/consensus fingerprint.*derived/i);
});

test('real-demo rejects a scanner config whose recorded fingerprint disagrees with the derived one', () => {
  const bad = scannerConfig({ chain: { network: 'regtest', genesisHash: GENESIS, consensusFingerprint: 'c'.repeat(64) } });
  expect(() => loadConfig(liveEnv({ SSF_SCANNER_CONFIG: bad }))).toThrow(/consensus fingerprint/i);
});

test('real-demo rejects scanner config network drift and invalid activation schedules', () => {
  const testnet = scannerConfig({ chain: { network: 'test', genesisHash: GENESIS, consensusFingerprint: consensusFingerprint('test', ACTIVATIONS) } });
  expect(() => loadConfig(liveEnv({ SSF_SCANNER_CONFIG: testnet }))).toThrow(/network/i);
  const disordered = scannerConfig({ activations: { ...ACTIVATIONS, sapling: 0, overwinter: 5 } });
  expect(() => loadConfig(liveEnv({ SSF_SCANNER_CONFIG: disordered }))).toThrow(/consensus|activation/i);
});

test('real-demo reads secret-bearing files only when owner-only', () => {
  expect(() => loadConfig(liveEnv({ SSF_SCANNER_CONFIG: scannerConfig({}, 0o644) }))).toThrow(/protected|permission/i);
  expect(() => loadConfig(liveEnv({ SSF_ADMIN_TOKEN_FILE: protectedFile('open.token', 'x', 0o644) }))).toThrow(/protected|permission/i);
  expect(() => loadConfig(liveEnv({ SSF_ADMIN_TOKEN: 'inline-secret' }))).toThrow(/SSF_ADMIN_TOKEN_FILE/);
});

test('real-demo requires every live endpoint', () => {
  for (const key of ['SSF_SCANNER_SOCKET', 'SSF_SCANNER_ACCOUNT_ID', 'SSF_SCANNER_CONFIG', 'SSF_WAKU_CONTENT_TOPIC',
    'WAKU_BOOTSTRAP_PEERS', 'LOGOSCTL', 'LOGOS_NODE_A', 'LOGOS_NODE_B', 'SSF_ADMIN_TOKEN_FILE']) {
    expect(() => loadConfig(liveEnv({ [key]: undefined })), key).toThrow(new RegExp(key));
  }
});

test('real-demo rejects over-long or relative unix socket paths', () => {
  expect(() => loadConfig(liveEnv({ SSF_SCANNER_SOCKET: `/${'d'.repeat(120)}/scanner.sock` }))).toThrow(/SSF_SCANNER_SOCKET/);
  expect(() => loadConfig(liveEnv({ SSF_SCANNER_SOCKET: 'scanner.sock' }))).toThrow(/SSF_SCANNER_SOCKET/);
});

test('real-demo accepts only wss bootstrap peers', () => {
  expect(() => loadConfig(liveEnv({ WAKU_BOOTSTRAP_PEERS: '/dns4/a.example/tcp/8000/ws/p2p/16Uiu2HAmA' }))).toThrow(/WAKU_BOOTSTRAP_PEERS/);
  expect(() => loadConfig(liveEnv({ WAKU_BOOTSTRAP_PEERS: '/ip4/1.2.3.4/tcp/60000/p2p/16Uiu2HAmA' }))).toThrow(/WAKU_BOOTSTRAP_PEERS/);
  expect(() => loadConfig(liveEnv({ SSF_WAKU_CONTENT_TOPIC: 'not-a-topic' }))).toThrow(/SSF_WAKU_CONTENT_TOPIC/);
});

test('fixture mode keeps its existing contract and has no live block', () => {
  const cfg = loadConfig(validEnv());
  expect(cfg.live).toBeUndefined();
  expect(cfg.destination).toBe(DESTINATION);
});

test('real-demo raises the typed MissingLiveKeyError only for an absent live key', () => {
  for (const key of ['SSF_ADMIN_TOKEN_FILE', 'SSF_SCANNER_SOCKET', 'SSF_SCANNER_ACCOUNT_ID', 'SSF_SCANNER_CONFIG', 'SSF_WAKU_CONTENT_TOPIC', 'WAKU_BOOTSTRAP_PEERS', 'LOGOSCTL', 'LOGOS_NODE_A', 'LOGOS_NODE_B']) {
    let caught: unknown;
    try { loadConfig(liveEnv({ [key]: undefined })); } catch (error) { caught = error; }
    expect(caught, key).toBeInstanceOf(MissingLiveKeyError);
    expect((caught as MissingLiveKeyError).code).toBe('missing_live_key');
    expect((caught as MissingLiveKeyError).key).toBe(key);
  }
  const notMissing = [
    liveEnv({ SSF_ADMIN_TOKEN_FILE: protectedFile('loose.token', 'x\n', 0o644) }),
    liveEnv({ SSF_SCANNER_SOCKET: 'relative.sock' }),
    liveEnv({ SSF_ADMIN_TOKEN: 'inline' }),
    liveEnv({ SSF_NETWORK: undefined }),
  ];
  for (const env of notMissing) {
    let caught: unknown;
    try { loadConfig(env); } catch (error) { caught = error; }
    expect(caught).toBeInstanceOf(ConfigError);
    expect(caught).not.toBeInstanceOf(MissingLiveKeyError);
  }
});

// Subtask 10.6 review minors 2, 4 and 7.
test('minor 2: real-demo without a pin leaves sellerKeyId undefined, never an empty string', () => {
  const cfg = loadConfig(liveEnv());
  expect(cfg.sellerKeyId).toBeUndefined();
  expect('sellerKeyId' in cfg).toBe(false);
  const pin = '04' + 'ab'.repeat(64);
  expect(loadConfig(liveEnv({ SSF_SELLER_PUBLIC_KEY: pin })).sellerKeyId).toBe(pin);
  expect(loadConfig(validEnv()).sellerKeyId).toBe('seller-key-1');
});

test('minor 4: real-demo rejects health age and size limits above the global caps', () => {
  expect(() => loadConfig(liveEnv({ SSF_MAX_HEALTH_AGE_MS: '120001' }))).toThrow(ConfigError);
  expect(() => loadConfig(liveEnv({ SSF_MAX_CIPHERTEXT_BYTES: '74' }))).toThrow(ConfigError);
  expect(() => loadConfig(liveEnv({ SSF_MAX_PLAINTEXT_BYTES: '42' }))).toThrow(ConfigError);
  expect(() => loadConfig(liveEnv({ SSF_MAX_CIPHERTEXT_BYTES: '1048576' }))).toThrow(/ciphertext.*73/i);
  const atCaps = loadConfig(liveEnv({ SSF_MAX_HEALTH_AGE_MS: '120000', SSF_MAX_CIPHERTEXT_BYTES: '73', SSF_MAX_PLAINTEXT_BYTES: '41' }));
  expect([atCaps.maxHealthAgeMs, atCaps.maxCiphertextBytes, atCaps.maxPlaintextBytes]).toEqual([120000, 73, 41]);
  expect(loadConfig(liveEnv({ SSF_MAX_HEALTH_AGE_MS: '60000' })).maxHealthAgeMs).toBe(60000);
  // Fixture mode keeps its existing contract.
  expect(loadConfig(validEnv({ SSF_MAX_CIPHERTEXT_BYTES: '1048576' })).maxCiphertextBytes).toBe(1048576);
});

test('minor 7: real-demo rejects secret files owned by another uid', () => {
  const env = liveEnv();
  const ownUid = typeof process.getuid === 'function' ? process.getuid() : 1000;
  expect(() => loadConfig(env, { getuid: () => ownUid + 1 })).toThrow(/owner|uid/i);
  let caught: unknown;
  try { loadConfig(env, { getuid: () => ownUid + 1 }); } catch (error) { caught = error; }
  expect(caught).toBeInstanceOf(ConfigError);
  expect(caught).not.toBeInstanceOf(MissingLiveKeyError);
});

test.skipIf(typeof process.getuid !== 'function')('minor 7: real-demo accepts secret files owned by the current uid', () => {
  expect(() => loadConfig(liveEnv())).not.toThrow();
  expect(() => loadConfig(liveEnv(), { getuid: () => process.getuid!() })).not.toThrow();
});

import { readFileSync, statSync } from 'node:fs';
import { dirname, isAbsolute } from 'node:path';
import { ACTIVATION_ORDER, consensusFingerprint, type ActivationSchedule } from './contracts/consensus.ts';
import type { ChainIdentity } from './contracts/live.ts';
import type { WakuConfig } from './contracts/messages.ts';
import { assertNetwork, assertProductNetwork, assertTestnetShieldedAddress } from './contracts/validation.ts';
import { DEFAULT_MIN_CONFIRMATIONS as PAYMENT_DEFAULT_MIN } from './seller/payments.ts';

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

/**
 * A required real-demo live endpoint/key is absent. This is the ONLY config
 * error a substituted (memory-adapter) preflight may downgrade to SKIP; every
 * other ConfigError (permissions, fingerprint, network, secret policy,
 * malformed values) stays a hard failure.
 */
export class MissingLiveKeyError extends ConfigError {
  readonly code = 'missing_live_key' as const;
  readonly key: string;
  constructor(key: string) {
    super(`missing ${key}`);
    this.name = 'MissingLiveKeyError';
    this.key = key;
  }
}

export const DEFAULT_MIN_CONFIRMATIONS = PAYMENT_DEFAULT_MIN;

export type AdapterKind = 'real' | 'fixture';
export type AppMode = 'fixture' | 'real-demo';

/** Linux sun_path is 108 bytes; keep headroom like scripts/live-infra/paths.ts. */
export const MAX_UNIX_SOCKET_PATH_BYTES = 100;
export const DEFAULT_WAKU_PEER_TIMEOUT_MS = 30_000;

/**
 * Server-only live wiring for `SSF_MODE=real-demo`. Nothing here may be
 * serialised into browser config: the scanner config file holds the UFVK and
 * is only read for its public chain identity/activation schedule, and the
 * admin token is read from an owner-only file.
 */
export type LiveConfig = {
  dataDir: string;
  scannerSocket: string;
  scannerAccountId: string;
  chain: ChainIdentity;
  activations: ActivationSchedule;
  waku: WakuConfig;
  logos: { logosctlPath: string; originConfigDir: string; replicaConfigDir: string };
  /** Optional pin; when set, the persisted seller identity must match it. */
  sellerPublicKeyPin?: string;
};

export type RuntimeConfig = {
  mode: AppMode;
  network: 'test';
  productNetwork: 'test' | 'regtest';
  minConfirmations: number;
  maxHealthAgeMs: number;
  maxCiphertextBytes: number;
  maxPlaintextBytes: number;
  invoiceTtlMs: number;
  publicHost: string;
  publicPort: number;
  adminHost: string;
  adminPort: number;
  dbPath: string;
  /**
   * Fixture: SSF_SELLER_KEY_ID. Real-demo: the SSF_SELLER_PUBLIC_KEY pin, or
   * undefined when unpinned; the runtime then uses the persisted identity.
   * Never the empty string, so an unset key can't be published.
   */
  sellerKeyId?: string;
  destination: string;
  adminToken: string;
  adapters: {
    messaging: AdapterKind;
    storage: AdapterKind;
    scanner: AdapterKind;
  };
  live?: LiveConfig;
};

function read(env: NodeJS.Dict<string>, key: string): string | undefined {
  const value = env[key];
  if (value === undefined || value === '') return undefined;
  return value;
}

function required(env: NodeJS.Dict<string>, key: string): string {
  const value = read(env, key);
  if (value === undefined) {
    throw new ConfigError(`missing ${key}`);
  }
  return value;
}

function requiredPositiveInt(env: NodeJS.Dict<string>, key: string, label: string): number {
  const raw = read(env, key);
  if (raw === undefined) {
    throw new ConfigError(`missing ${label}`);
  }
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new ConfigError(`invalid ${label}`);
  }
  return value;
}

function optionalPort(env: NodeJS.Dict<string>, key: string, fallback: number): number {
  const raw = read(env, key);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0 || value > 65535) {
    throw new ConfigError(`invalid ${key}`);
  }
  return value;
}

function parseMode(raw: string | undefined): AppMode {
  if (raw === undefined || raw === 'fixture') return 'fixture';
  if (raw === 'real-demo') return 'real-demo';
  throw new ConfigError(`invalid SSF_MODE: ${raw}`);
}

function parseAdapter(env: NodeJS.Dict<string>, key: string, mode: AppMode): AdapterKind {
  const raw = read(env, key);
  if (mode === 'real-demo') {
    if (raw !== 'real') {
      throw new ConfigError(`real-demo mode rejects fixture adapters (${key})`);
    }
    return 'real';
  }
  if (raw === undefined || raw === 'fixture') return 'fixture';
  if (raw === 'real') return 'real';
  throw new ConfigError(`invalid ${key}`);
}

const RAW_DIGEST_KEY = /CONSENSUS_(FINGERPRINT|DIGEST)/;
const HEX32 = /^[0-9a-f]{64}$/;
const CONTENT_TOPIC_RE = /^\/[A-Za-z0-9._-]+\/[0-9]+\/[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;
const WSS_PEER_RE = /^\/(dns4|dns6|dns|ip4|ip6)\/[^/]+\/tcp\/[0-9]{1,5}\/(wss|tls\/ws)\/p2p\/[A-Za-z0-9]+$/;

function requiredLive(env: NodeJS.Dict<string>, key: string): string {
  const value = read(env, key);
  if (value === undefined) throw new MissingLiveKeyError(key);
  return value;
}

function absolutePath(env: NodeJS.Dict<string>, key: string): string {
  const value = requiredLive(env, key);
  if (!isAbsolute(value)) throw new ConfigError(`invalid ${key}: must be an absolute path`);
  return value;
}

/** Per-call seams for loadConfig. Defaults read the real process. */
export type LoadConfigDeps = {
  /** Current uid; undefined on platforms without process.getuid (owner check skipped). */
  getuid?: () => number;
};

/** Real-demo ceilings (global limits): health age, ciphertext and plaintext sizes. */
export const REAL_DEMO_MAX_HEALTH_AGE_MS = 120_000;
export const REAL_DEMO_MAX_CIPHERTEXT_BYTES = 73;
export const REAL_DEMO_MAX_PLAINTEXT_BYTES = 41;
export const REAL_DEMO_MIN_CONFIRMATIONS = 10;

function defaultGetuid(): (() => number) | undefined {
  return typeof process.getuid === 'function' ? () => process.getuid!() : undefined;
}

/**
 * Reads a secret-bearing file only if it is a regular file with no group/other
 * access, owned by the current uid (where the platform has one).
 */
function readProtectedFile(path: string, key: string, getuid: (() => number) | undefined): string {
  let stat;
  try {
    stat = statSync(path);
  } catch {
    throw new ConfigError(`unreadable ${key}`);
  }
  if (!stat.isFile()) throw new ConfigError(`invalid ${key}: not a regular file`);
  if ((stat.mode & 0o077) !== 0) {
    throw new ConfigError(`${key} must be a protected owner-only file (permission 0600)`);
  }
  if (getuid !== undefined && stat.uid !== getuid()) {
    throw new ConfigError(`${key} must be owned by the current uid`);
  }
  return readFileSync(path, 'utf8');
}

function parseLiveChain(env: NodeJS.Dict<string>, productNetwork: 'test' | 'regtest', getuid: (() => number) | undefined): {
  chain: ChainIdentity;
  activations: ActivationSchedule;
} {
  const path = absolutePath(env, 'SSF_SCANNER_CONFIG');
  let parsed: unknown;
  try {
    parsed = JSON.parse(readProtectedFile(path, 'SSF_SCANNER_CONFIG', getuid));
  } catch (error) {
    if (error instanceof ConfigError) throw error;
    throw new ConfigError('invalid SSF_SCANNER_CONFIG: malformed JSON');
  }
  const runtime = (parsed as { runtime?: unknown } | null)?.runtime as
    | { chain?: Record<string, unknown>; activations?: Record<string, unknown> }
    | undefined;
  const chain = runtime?.chain;
  const activations = runtime?.activations;
  if (!chain || typeof chain !== 'object' || !activations || typeof activations !== 'object') {
    throw new ConfigError('invalid SSF_SCANNER_CONFIG: missing runtime chain/activations');
  }
  if (chain.network !== productNetwork) {
    throw new ConfigError('SSF_SCANNER_CONFIG chain network does not match SSF_NETWORK');
  }
  if (typeof chain.genesisHash !== 'string' || !HEX32.test(chain.genesisHash)) {
    throw new ConfigError('invalid SSF_SCANNER_CONFIG: genesis hash');
  }
  let derived: string;
  try {
    derived = consensusFingerprint(productNetwork, activations);
  } catch (error) {
    throw new ConfigError(error instanceof Error ? error.message : 'invalid consensus activation schedule');
  }
  if (chain.consensusFingerprint !== undefined && chain.consensusFingerprint !== derived) {
    throw new ConfigError('SSF_SCANNER_CONFIG consensus fingerprint does not match the one derived from its activation schedule');
  }
  const schedule: ActivationSchedule = {};
  for (const name of ACTIVATION_ORDER) {
    schedule[name] = (activations[name] ?? null) as number | null;
  }
  return {
    chain: { network: productNetwork, genesisHash: chain.genesisHash, consensusFingerprint: derived },
    activations: schedule,
  };
}

function parseLive(env: NodeJS.Dict<string>, productNetwork: 'test' | 'regtest', dbPath: string, getuid: (() => number) | undefined): LiveConfig {
  for (const key of Object.keys(env)) {
    if (RAW_DIGEST_KEY.test(key) && read(env, key) !== undefined) {
      throw new ConfigError(`${key} rejected: consensus fingerprint is always derived from the activation schedule`);
    }
  }
  const scannerSocket = absolutePath(env, 'SSF_SCANNER_SOCKET');
  if (Buffer.byteLength(scannerSocket) > MAX_UNIX_SOCKET_PATH_BYTES) {
    throw new ConfigError(`invalid SSF_SCANNER_SOCKET: longer than ${MAX_UNIX_SOCKET_PATH_BYTES} bytes`);
  }
  const scannerAccountId = requiredLive(env, 'SSF_SCANNER_ACCOUNT_ID');
  const { chain, activations } = parseLiveChain(env, productNetwork, getuid);
  const contentTopic = requiredLive(env, 'SSF_WAKU_CONTENT_TOPIC');
  if (!CONTENT_TOPIC_RE.test(contentTopic)) throw new ConfigError('invalid SSF_WAKU_CONTENT_TOPIC');
  const bootstrapPeers = requiredLive(env, 'WAKU_BOOTSTRAP_PEERS').split(',').map((peer) => peer.trim()).filter(Boolean);
  if (bootstrapPeers.length === 0 || bootstrapPeers.some((peer) => !WSS_PEER_RE.test(peer))) {
    throw new ConfigError('invalid WAKU_BOOTSTRAP_PEERS: expected comma-separated wss multiaddrs');
  }
  const peerTimeoutRaw = read(env, 'SSF_WAKU_PEER_TIMEOUT_MS');
  const peerTimeoutMs = peerTimeoutRaw === undefined
    ? DEFAULT_WAKU_PEER_TIMEOUT_MS
    : requiredPositiveInt(env, 'SSF_WAKU_PEER_TIMEOUT_MS', 'SSF_WAKU_PEER_TIMEOUT_MS');
  const pin = read(env, 'SSF_SELLER_PUBLIC_KEY');
  if (pin !== undefined && !/^[0-9a-f]{130}$/.test(pin)) throw new ConfigError('invalid SSF_SELLER_PUBLIC_KEY');
  return {
    dataDir: dirname(dbPath),
    scannerSocket,
    scannerAccountId,
    chain,
    activations,
    waku: { contentTopic, bootstrapPeers, peerTimeoutMs },
    logos: {
      logosctlPath: absolutePath(env, 'LOGOSCTL'),
      originConfigDir: absolutePath(env, 'LOGOS_NODE_A'),
      replicaConfigDir: absolutePath(env, 'LOGOS_NODE_B'),
    },
    ...(pin === undefined ? {} : { sellerPublicKeyPin: pin }),
  };
}

export function loadConfig(env: NodeJS.Dict<string> = process.env, deps: LoadConfigDeps = {}): RuntimeConfig {
  const getuid = deps.getuid ?? defaultGetuid();
  const mode = parseMode(read(env, 'SSF_MODE'));
  if (mode === 'real-demo' && read(env, 'SSF_NETWORK') === undefined) {
    throw new ConfigError('missing SSF_NETWORK (real-demo requires regtest or test explicitly)');
  }
  const networkRaw = read(env, 'SSF_NETWORK') ?? 'test';
  if (networkRaw === 'mainnet' || networkRaw === 'main') {
    throw new ConfigError('mainnet is forbidden');
  }
  try {
    assertProductNetwork(networkRaw);
  } catch (error) {
    throw new ConfigError(error instanceof Error ? error.message : String(error));
  }
  const productNetwork = networkRaw as 'test' | 'regtest';
  try {
    assertNetwork('test');
  } catch (error) {
    throw new ConfigError(error instanceof Error ? error.message : String(error));
  }

  const minRaw = read(env, 'SSF_MIN_CONFIRMATIONS');
  let minConfirmations = DEFAULT_MIN_CONFIRMATIONS;
  if (minRaw !== undefined) {
    const parsed = Number(minRaw);
    if (!Number.isInteger(parsed) || parsed <= 0) {
      throw new ConfigError('invalid minConfirmations');
    }
    minConfirmations = parsed;
  }
  if (minConfirmations === 0) {
    throw new ConfigError('minConfirmations must be positive');
  }
  // Global constraint: real-demo never settles on fewer than 10 confirmations.
  // A caller may raise the threshold, never lower it.
  if (mode === 'real-demo' && minConfirmations < REAL_DEMO_MIN_CONFIRMATIONS) {
    throw new ConfigError(`invalid minConfirmations: real-demo requires at least ${REAL_DEMO_MIN_CONFIRMATIONS}`);
  }

  const maxHealthAgeMs = requiredPositiveInt(env, 'SSF_MAX_HEALTH_AGE_MS', 'maxHealthAgeMs');
  const maxCiphertextBytes = requiredPositiveInt(env, 'SSF_MAX_CIPHERTEXT_BYTES', 'ciphertext size limit');
  const maxPlaintextBytes = requiredPositiveInt(env, 'SSF_MAX_PLAINTEXT_BYTES', 'plaintext size limit');
  if (mode === 'real-demo') {
    if (maxHealthAgeMs > REAL_DEMO_MAX_HEALTH_AGE_MS) {
      throw new ConfigError(`invalid maxHealthAgeMs: real-demo allows at most ${REAL_DEMO_MAX_HEALTH_AGE_MS}`);
    }
    if (maxCiphertextBytes > REAL_DEMO_MAX_CIPHERTEXT_BYTES) {
      throw new ConfigError(`invalid ciphertext size limit: real-demo allows at most ${REAL_DEMO_MAX_CIPHERTEXT_BYTES}`);
    }
    if (maxPlaintextBytes > REAL_DEMO_MAX_PLAINTEXT_BYTES) {
      throw new ConfigError(`invalid plaintext size limit: real-demo allows at most ${REAL_DEMO_MAX_PLAINTEXT_BYTES}`);
    }
  }
  const invoiceTtlMs = requiredPositiveInt(env, 'SSF_INVOICE_TTL_MS', 'invoiceTtlMs');
  const dbPath = required(env, 'SSF_DB_PATH');
  const adapters = {
    messaging: parseAdapter(env, 'SSF_ADAPTER_MESSAGING', mode),
    storage: parseAdapter(env, 'SSF_ADAPTER_STORAGE', mode),
    scanner: parseAdapter(env, 'SSF_ADAPTER_SCANNER', mode),
  };
  let destination = '';
  let adminToken: string;
  let sellerKeyId: string | undefined;
  let live: LiveConfig | undefined;
  if (mode === 'real-demo') {
    // Live invoices use unique scanner-allocated receivers; SSF_DESTINATION
    // is neither required nor used. Secrets come only from protected files.
    if (read(env, 'SSF_ADMIN_TOKEN') !== undefined) {
      throw new ConfigError('SSF_ADMIN_TOKEN is not accepted in real-demo; use SSF_ADMIN_TOKEN_FILE');
    }
    if (read(env, 'SSF_SELLER_KEY_ID') !== undefined) {
      throw new ConfigError('SSF_SELLER_KEY_ID is not accepted in real-demo; the persisted seller identity is authoritative (pin with SSF_SELLER_PUBLIC_KEY)');
    }
    adminToken = readProtectedFile(absolutePath(env, 'SSF_ADMIN_TOKEN_FILE'), 'SSF_ADMIN_TOKEN_FILE', getuid).trim();
    if (adminToken.length === 0) throw new ConfigError('empty SSF_ADMIN_TOKEN_FILE');
    live = parseLive(env, productNetwork, dbPath, getuid);
    sellerKeyId = live.sellerPublicKeyPin;
  } else {
    destination = required(env, 'SSF_DESTINATION');
    try {
      assertTestnetShieldedAddress(destination);
    } catch (error) {
      throw new ConfigError(error instanceof Error ? error.message : String(error));
    }
    adminToken = required(env, 'SSF_ADMIN_TOKEN');
    sellerKeyId = required(env, 'SSF_SELLER_KEY_ID');
  }

  return {
    mode,
    network: 'test',
    productNetwork,
    minConfirmations,
    maxHealthAgeMs,
    maxCiphertextBytes,
    maxPlaintextBytes,
    invoiceTtlMs,
    publicHost: read(env, 'SSF_PUBLIC_HOST') ?? '127.0.0.1',
    publicPort: optionalPort(env, 'SSF_PUBLIC_PORT', 8787),
    adminHost: read(env, 'SSF_ADMIN_HOST') ?? '127.0.0.1',
    adminPort: optionalPort(env, 'SSF_ADMIN_PORT', 8788),
    dbPath,
    ...(sellerKeyId === undefined ? {} : { sellerKeyId }),
    destination,
    adminToken,
    adapters,
    ...(live === undefined ? {} : { live }),
  };
}

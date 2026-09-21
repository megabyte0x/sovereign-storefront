import { assertNetwork, assertProductNetwork, assertTestnetShieldedAddress } from './contracts/validation.ts';
import { DEFAULT_MIN_CONFIRMATIONS as PAYMENT_DEFAULT_MIN } from './seller/payments.ts';

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

export const DEFAULT_MIN_CONFIRMATIONS = PAYMENT_DEFAULT_MIN;

export type AdapterKind = 'real' | 'fixture';
export type AppMode = 'fixture' | 'real-demo';

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
  sellerKeyId: string;
  destination: string;
  adminToken: string;
  adapters: {
    messaging: AdapterKind;
    storage: AdapterKind;
    scanner: AdapterKind;
  };
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

export function loadConfig(env: NodeJS.Dict<string> = process.env): RuntimeConfig {
  const mode = parseMode(read(env, 'SSF_MODE'));
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

  const maxHealthAgeMs = requiredPositiveInt(env, 'SSF_MAX_HEALTH_AGE_MS', 'maxHealthAgeMs');
  const maxCiphertextBytes = requiredPositiveInt(env, 'SSF_MAX_CIPHERTEXT_BYTES', 'ciphertext size limit');
  const maxPlaintextBytes = requiredPositiveInt(env, 'SSF_MAX_PLAINTEXT_BYTES', 'plaintext size limit');
  const invoiceTtlMs = requiredPositiveInt(env, 'SSF_INVOICE_TTL_MS', 'invoiceTtlMs');
  const destination = required(env, 'SSF_DESTINATION');
  try {
    assertTestnetShieldedAddress(destination);
  } catch (error) {
    throw new ConfigError(error instanceof Error ? error.message : String(error));
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
    dbPath: required(env, 'SSF_DB_PATH'),
    sellerKeyId: required(env, 'SSF_SELLER_KEY_ID'),
    destination,
    adminToken: required(env, 'SSF_ADMIN_TOKEN'),
    adapters: {
      messaging: parseAdapter(env, 'SSF_ADAPTER_MESSAGING', mode),
      storage: parseAdapter(env, 'SSF_ADAPTER_STORAGE', mode),
      scanner: parseAdapter(env, 'SSF_ADAPTER_SCANNER', mode),
    },
  };
}

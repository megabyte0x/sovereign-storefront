import { assertCanonicalAmountZat, ValidationError } from './validation.ts';

export type AppMode = 'fixture' | 'real-demo' | 'public-testnet';

export type NetworkProfile = {
  network: 'test' | 'regtest';
  uaPrefix: 'utest1' | 'uregtest1';
  ufvkPrefix: 'uviewtest' | 'uviewregtest';
  minConfirmationsFloor: number;
  /** Testnet only, display only, never fetched by the app. Omitted until a URL is chosen. */
  explorerTxUrl?: string;
};

export const TESTNET_PROFILE: NetworkProfile = {
  network: 'test',
  uaPrefix: 'utest1',
  ufvkPrefix: 'uviewtest',
  minConfirmationsFloor: 3,
};

export const REGTEST_PROFILE: NetworkProfile = {
  network: 'regtest',
  uaPrefix: 'uregtest1',
  ufvkPrefix: 'uviewregtest',
  minConfirmationsFloor: 10,
};

export function profileFor(network: 'test' | 'regtest'): NetworkProfile {
  return network === 'test' ? TESTNET_PROFILE : REGTEST_PROFILE;
}

/** D5(a). Ciphertext cap is this plus 32, not a free-set env value. */
export const PUBLIC_MAX_PLAINTEXT_BYTES = 8 * 1024 * 1024;

export type ProductSummary = {
  version: string;
  title: string;
  description: string;
  amountZat: string;
  network: 'test' | 'regtest';
  sizeBytes: number;
  mediaType: string;
  available: boolean;
};

export type EmbedConfig = {
  storefrontOrigin: string;
  allowedEmbedOrigins: string[] | '*';
};

export type CheckoutResult = {
  type: 'ssf:checkout';
  version: string;
  requestId: string;
  state: 'invoiced' | 'paid' | 'delivered' | 'cancelled';
};

/** Gateway options. Implemented by 3.2, wired by 3.3. Type only. */
export type ServeCiphertextOptions = {
  maxBytes: number;
  digest: string;
};

const PRODUCT_KEYS: Record<string, true> = {
  version: true,
  title: true,
  description: true,
  amountZat: true,
  network: true,
  sizeBytes: true,
  mediaType: true,
  available: true,
};
const CHECKOUT_KEYS: Record<string, true> = {
  type: true,
  version: true,
  requestId: true,
  state: true,
};
const CHECKOUT_STATES: Record<string, true> = {
  invoiced: true,
  paid: true,
  delivered: true,
  cancelled: true,
};

function requiredText(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new ValidationError(`invalid ${field}`);
  }
  return value;
}

export function validateProductSummary(x: unknown): ProductSummary {
  if (x === null || typeof x !== 'object' || Array.isArray(x)) {
    throw new ValidationError('invalid product summary');
  }
  const record = x as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (PRODUCT_KEYS[key] !== true) throw new ValidationError(`unknown product summary key: ${key}`);
  }
  const version = requiredText(record.version, 'version');
  const title = requiredText(record.title, 'title');
  const description = requiredText(record.description, 'description');
  if (typeof record.amountZat !== 'string') throw new ValidationError('invalid amountZat');
  assertCanonicalAmountZat(record.amountZat);
  if (record.network !== 'test' && record.network !== 'regtest') {
    throw new ValidationError('invalid product network');
  }
  if (typeof record.sizeBytes !== 'number' || !Number.isInteger(record.sizeBytes) || record.sizeBytes < 0) {
    throw new ValidationError('invalid sizeBytes');
  }
  const mediaType = requiredText(record.mediaType, 'mediaType');
  if (typeof record.available !== 'boolean') throw new ValidationError('invalid available');
  return {
    version,
    title,
    description,
    amountZat: record.amountZat,
    network: record.network,
    sizeBytes: record.sizeBytes,
    mediaType,
    available: record.available,
  };
}

export function validateCheckoutResult(x: unknown): CheckoutResult {
  if (x === null || typeof x !== 'object' || Array.isArray(x)) {
    throw new ValidationError('invalid checkout result');
  }
  const record = x as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (CHECKOUT_KEYS[key] !== true) throw new ValidationError(`unknown checkout result key: ${key}`);
  }
  if (record.type !== 'ssf:checkout') throw new ValidationError('invalid checkout type');
  const version = requiredText(record.version, 'version');
  const requestId = requiredText(record.requestId, 'requestId');
  if (typeof record.state !== 'string' || CHECKOUT_STATES[record.state] !== true) {
    throw new ValidationError('invalid checkout state');
  }
  return {
    type: 'ssf:checkout',
    version,
    requestId,
    state: record.state as CheckoutResult['state'],
  };
}

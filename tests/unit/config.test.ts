import { expect, test } from 'vitest';
import { DEFAULT_POLICY } from '../../src/seller/payments.ts';
import {
  ConfigError,
  DEFAULT_MIN_CONFIRMATIONS,
  loadConfig,
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
  const cfg = loadConfig(validEnv({
    SSF_MODE: 'real-demo',
    SSF_ADAPTER_MESSAGING: 'real',
    SSF_ADAPTER_STORAGE: 'real',
    SSF_ADAPTER_SCANNER: 'real',
  }));
  expect(cfg.mode).toBe('real-demo');
  expect(cfg.adapters).toEqual({
    messaging: 'real',
    storage: 'real',
    scanner: 'real',
  });
  expect(cfg.minConfirmations).toBe(10);
  expect(cfg.adminToken).toBe('admin-secret-not-for-browser');
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

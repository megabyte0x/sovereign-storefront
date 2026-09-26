import { describe, expect, it } from 'vitest';
import { buildLiveEnv } from '../../scripts/start-live.ts';
import { loadConfig } from '../../src/config.ts';

const LIVE_ENV = 'SSF_SCANNER_SOCKET=/tmp/s.sock\nWAKU_BOOTSTRAP_PEERS=/ip4/127.0.0.1/tcp/1\n';
const DEFAULTS = {
  scannerConfig: '/state/scanner.json',
  adminTokenFile: '/repo/.runtime/live/seller/admin.token',
  dbPath: '/repo/.runtime/live/seller/seller.sqlite',
};

// Task 10.7 live finding: the compiled entrypoint launched by start:live exited
// with `startup failed: ConfigError` (missing maxHealthAgeMs) because the
// wrapper never supplied the limits loadConfig requires.
describe('buildLiveEnv real-demo limits', () => {
  it('fills the real-demo global limits loadConfig requires', () => {
    const env = buildLiveEnv(LIVE_ENV, {}, DEFAULTS);
    expect(env.SSF_MAX_HEALTH_AGE_MS).toBe('120000');
    expect(env.SSF_MAX_CIPHERTEXT_BYTES).toBe('73');
    expect(env.SSF_MAX_PLAINTEXT_BYTES).toBe('41');
    expect(env.SSF_MIN_CONFIRMATIONS).toBe('10');
    expect(Number(env.SSF_INVOICE_TTL_MS)).toBeGreaterThan(0);
  });

  it('lets the caller tighten a limit', () => {
    const env = buildLiveEnv(LIVE_ENV, { SSF_MAX_HEALTH_AGE_MS: '60000', SSF_INVOICE_TTL_MS: '1000' }, DEFAULTS);
    expect(env.SSF_MAX_HEALTH_AGE_MS).toBe('60000');
    expect(env.SSF_INVOICE_TTL_MS).toBe('1000');
  });

  it('produces an env whose limits pass loadConfig limit parsing (no missing-limit ConfigError)', () => {
    const env = buildLiveEnv(LIVE_ENV, {}, DEFAULTS);
    let message = '';
    try {
      loadConfig(env);
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    // Other live preconditions (files on disk) may still fail here; the limits must not.
    expect(message).not.toMatch(/maxHealthAgeMs|size limit|invoiceTtlMs|minConfirmations/);
  });
});

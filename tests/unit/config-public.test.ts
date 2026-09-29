import { describe, expect, it } from 'vitest';
import { loadConfig, ConfigError } from '../../src/config.ts';
import { publicEnv } from './helpers/public-env.ts';

describe('public-testnet config', () => {
  it('accepts a complete testnet env', () => {
    const c = loadConfig(publicEnv());
    expect(c.mode).toBe('public-testnet');
    expect(c.productNetwork).toBe('test');
    expect(c.publicOrigin).toBe('https://store.example.org');
  });
  it('rejects regtest', () => expect(() => loadConfig(publicEnv({ SSF_NETWORK: 'regtest' }))).toThrow(ConfigError));
  it('rejects http origin', () => expect(() => loadConfig(publicEnv({ SSF_PUBLIC_ORIGIN: 'http://x.org' }))).toThrow(/SSF_PUBLIC_ORIGIN/));
  it('rejects plaintext cap above 8 MiB', () => expect(() => loadConfig(publicEnv({ SSF_MAX_PLAINTEXT_BYTES: String(8 * 1024 * 1024 + 1) }))).toThrow(/plaintext/));
  it('derives ciphertext cap', () => expect(loadConfig(publicEnv({ SSF_MAX_PLAINTEXT_BYTES: '1000' })).maxCiphertextBytes).toBe(1032));
  it('rejects confirmations below floor', () => expect(() => loadConfig(publicEnv({ SSF_MIN_CONFIRMATIONS: '2' }))).toThrow(/minConfirmations/));
  it('accepts 3 confirmations on testnet', () => expect(loadConfig(publicEnv({ SSF_MIN_CONFIRMATIONS: '3' })).minConfirmations).toBe(3));
  it('rejects inline admin token', () => expect(() => loadConfig(publicEnv({ SSF_ADMIN_TOKEN: 'x' }))).toThrow(/SSF_ADMIN_TOKEN/));
  it('still forbids mainnet', () => expect(() => loadConfig(publicEnv({ SSF_NETWORK: 'main' }))).toThrow(/mainnet/));
  it('parses embed origins', () => expect(loadConfig(publicEnv({ SSF_EMBED_ORIGINS: 'https://a.org,https://b.org' })).embed.allowedEmbedOrigins).toEqual(['https://a.org', 'https://b.org']));
});

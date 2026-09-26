import { describe, expect, it } from 'vitest';
import { buildLiveEnv, checkDist, readLiveEnvFile } from '../../scripts/start-live.ts';

const LIVE_ENV = [
  '# comment',
  'SSF_SCANNER_SOCKET=/tmp/s.sock',
  'SSF_WAKU_CONTENT_TOPIC=/ssf/1/x/proto',
  'WAKU_BOOTSTRAP_PEERS="/ip4/127.0.0.1/tcp/1"',
  '',
].join('\n');

const DEFAULTS = {
  scannerConfig: '/state/scanner.json',
  adminTokenFile: '/repo/.runtime/live/seller/admin.token',
  dbPath: '/repo/.runtime/live/seller/seller.sqlite',
};

describe('buildLiveEnv', () => {
  it('overlays mode, network and real adapters on top of live.env and the caller env', () => {
    const env = buildLiveEnv(LIVE_ENV, { SSF_MODE: 'fixture', SSF_ADAPTER_SCANNER: 'memory', PATH: '/bin' }, DEFAULTS);
    expect(env.SSF_MODE).toBe('real-demo');
    expect(env.SSF_NETWORK).toBe('regtest');
    expect(env.SSF_ADAPTER_MESSAGING).toBe('real');
    expect(env.SSF_ADAPTER_STORAGE).toBe('real');
    expect(env.SSF_ADAPTER_SCANNER).toBe('real');
    expect(env.SSF_SCANNER_SOCKET).toBe('/tmp/s.sock');
    expect(env.WAKU_BOOTSTRAP_PEERS).toBe('/ip4/127.0.0.1/tcp/1');
    expect(env.PATH).toBe('/bin');
  });

  it('fills default paths unless the caller already set them', () => {
    const env = buildLiveEnv(LIVE_ENV, {}, DEFAULTS);
    expect(env.SSF_SCANNER_CONFIG).toBe(DEFAULTS.scannerConfig);
    expect(env.SSF_ADMIN_TOKEN_FILE).toBe(DEFAULTS.adminTokenFile);
    expect(env.SSF_DB_PATH).toBe(DEFAULTS.dbPath);
    const custom = buildLiveEnv(LIVE_ENV, { SSF_DB_PATH: '/x/db.sqlite', SSF_SCANNER_CONFIG: '/y.json' }, DEFAULTS);
    expect(custom.SSF_DB_PATH).toBe('/x/db.sqlite');
    expect(custom.SSF_SCANNER_CONFIG).toBe('/y.json');
  });

  it('never carries an inline admin token or seller key id', () => {
    const env = buildLiveEnv(`${LIVE_ENV}SSF_ADMIN_TOKEN=deadbeef\n`, { SSF_ADMIN_TOKEN: 'cafe', SSF_SELLER_KEY_ID: 'k' }, DEFAULTS);
    expect(env.SSF_ADMIN_TOKEN).toBeUndefined();
    expect(env.SSF_SELLER_KEY_ID).toBeUndefined();
    expect(Object.values(env).join('\n')).not.toContain('deadbeef');
  });
});

describe('readLiveEnvFile', () => {
  it('rejects a live.env that is not 0600', () => {
    expect(() =>
      readLiveEnvFile('/l/live.env', { stat: () => ({ mode: 0o100644 }), read: () => LIVE_ENV }),
    ).toThrow(/0600/);
  });

  it('returns text for a 0600 live.env', () => {
    expect(readLiveEnvFile('/l/live.env', { stat: () => ({ mode: 0o100600 }), read: () => LIVE_ENV })).toBe(LIVE_ENV);
  });
});

describe('checkDist', () => {
  it('reports missing when either build output is absent', () => {
    expect(checkDist('/repo', (p) => !p.endsWith('index.html'))).toBe(false);
    expect(checkDist('/repo', (p) => !p.endsWith('main.js'))).toBe(false);
    expect(checkDist('/repo', () => true)).toBe(true);
  });
});

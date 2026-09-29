import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { decoratePublicIndex, formatDoctor, runPublicDoctor, type DoctorProbes } from '../../scripts/public-doctor.ts';
import { loadPublicEnv, startPublic } from '../../scripts/start-public.ts';

const HTML = '<!doctype html><title>store</title>';
const HTML_SHA = createHash('sha256').update(HTML).digest('hex');
const SRI = `sha384-${createHash('sha384').update('embed').digest('base64')}`;

function passingProbes(overrides: Partial<DoctorProbes> = {}): DoctorProbes {
  return {
    tls: async () => ({ ok: true, reason: 'cert ok' }),
    http: async (url) => {
      if (url.endsWith(':8788') || url.endsWith('/admin/health')) return undefined;
      if (url.endsWith('/embed.js')) {
        return { status: 200, body: new TextEncoder().encode('embed'), headers: {} };
      }
      if (url.endsWith('/index.html') || url.endsWith('/')) {
        return { status: 200, body: new TextEncoder().encode(HTML), headers: {} };
      }
      return { status: 200, body: new Uint8Array(), headers: {} };
    },
    scanner: async () => ({ scannerTip: 100, lightwalletdTip: 102 }),
    logosA: async () => ({ ok: true, reason: 'listening' }),
    replica: async () => ({ present: true, digestMatch: true, reason: 'digest match' }),
    wssRoundTrip: async () => ({ ok: true, reason: 'signed' }),
    backupAgeMs: async () => 60_000,
    readBuildHtml: async () => new TextEncoder().encode(HTML),
    readEmbedSri: async () => SRI,
    embedBody: async () => new TextEncoder().encode('embed'),
    ...overrides,
  };
}

const baseEnv: Record<string, string> = {
  SSF_PUBLIC_ORIGIN: 'https://store.agentmascot.app',
};

describe('public doctor', () => {
  it('all pass exits 0 and omits delivery-wss when SSF_WSS_ORIGIN is unset', async () => {
    const result = await runPublicDoctor({ strict: true, env: baseEnv, probes: passingProbes() });
    expect(result.exitCode).toBe(0);
    expect(result.rows.map((row) => row.id)).not.toContain('delivery-wss');
    expect(result.rows.every((row) => row.status === 'PASS')).toBe(true);
  });

  it('one SKIP under --strict exits 1', async () => {
    const result = await runPublicDoctor({
      strict: true,
      env: baseEnv,
      probes: passingProbes({ backupAgeMs: async () => undefined }),
    });
    expect(result.rows.find((row) => row.id === 'backup-age')?.status).toBe('SKIP');
    expect(result.exitCode).toBe(1);
  });

  it('html-integrity fails when a script tag is injected', async () => {
    const injected = `${HTML}<script>bad()</script>`;
    const result = await runPublicDoctor({
      strict: false,
      env: baseEnv,
      probes: passingProbes({
        http: async (url) => {
          if (url.endsWith('/embed.js')) return { status: 200, body: new TextEncoder().encode('embed'), headers: {} };
          if (url.includes(':8788') || url.endsWith('/admin/health')) return undefined;
          return { status: 200, body: new TextEncoder().encode(injected), headers: {} };
        },
      }),
    });
    const row = result.rows.find((item) => item.id === 'html-integrity');
    expect(row?.status).toBe('FAIL');
    expect(result.exitCode).toBe(1);
    expect(HTML_SHA).not.toBe(createHash('sha256').update(injected).digest('hex'));
  });

  it('admin-not-public passes a 404 and fails a 200 admin body', async () => {
    const notFound = await runPublicDoctor({
      strict: false,
      env: baseEnv,
      probes: passingProbes({
        http: async (url) => {
          if (url.endsWith(':8788') || url.endsWith('/admin/health')) {
            return { status: 404, body: new TextEncoder().encode('not found'), headers: {} };
          }
          if (url.endsWith('/embed.js')) return { status: 200, body: new TextEncoder().encode('embed'), headers: {} };
          return { status: 200, body: new TextEncoder().encode(HTML), headers: {} };
        },
      }),
    });
    expect(notFound.rows.find((item) => item.id === 'admin-not-public')?.status).toBe('PASS');
    const open = await runPublicDoctor({
      strict: false,
      env: baseEnv,
      probes: passingProbes({
        http: async (url) => {
          if (url.endsWith('/admin/health')) return { status: 200, body: new TextEncoder().encode('{"ok":true}'), headers: {} };
          if (url.endsWith(':8788')) return undefined;
          if (url.endsWith('/embed.js')) return { status: 200, body: new TextEncoder().encode('embed'), headers: {} };
          return { status: 200, body: new TextEncoder().encode(HTML), headers: {} };
        },
      }),
    });
    expect(open.rows.find((item) => item.id === 'admin-not-public')?.status).toBe('FAIL');
  });

  it('html-integrity accepts the seller decoration and still fails an extra script', async () => {
    const built = '<!doctype html><main id="app"></main>';
    const env = { ...baseEnv, SSF_MIN_CONFIRMATIONS: '3', SSF_NETWORK: 'test', SSF_EMBED_ORIGINS: 'https://store.example' };
    const decorated = decoratePublicIndex(built, env);
    expect(decorated).not.toBe(built);
    expect(decorated).not.toContain('<script');
    const healthy = await runPublicDoctor({
      strict: false,
      env,
      probes: passingProbes({
        readBuildHtml: async () => new TextEncoder().encode(built),
        http: async (url) => {
          if (url.endsWith('/embed.js')) return { status: 200, body: new TextEncoder().encode('embed'), headers: {} };
          if (url.endsWith(':8788') || url.endsWith('/admin/health')) return undefined;
          if (url.endsWith('/index.html')) return { status: 200, body: new TextEncoder().encode(decorated), headers: {} };
          return { status: 200, body: new TextEncoder().encode(built), headers: {} };
        },
      }),
    });
    expect(healthy.rows.find((item) => item.id === 'html-integrity')?.status).toBe('PASS');
    const injected = await runPublicDoctor({
      strict: false,
      env,
      probes: passingProbes({
        readBuildHtml: async () => new TextEncoder().encode(built),
        http: async (url) => {
          if (url.endsWith('/embed.js')) return { status: 200, body: new TextEncoder().encode('embed'), headers: {} };
          if (url.endsWith(':8788') || url.endsWith('/admin/health')) return undefined;
          return { status: 200, body: new TextEncoder().encode(`${decorated}<script>bad()</script>`), headers: {} };
        },
      }),
    });
    expect(injected.rows.find((item) => item.id === 'html-integrity')?.status).toBe('FAIL');
  });

  it('output never contains a token, UFVK, utest1 address, URI, or tunnel credential', async () => {
    const poison = [
      'admin-token-value',
      'uviewtest1notreal',
      'utest1qqqqsecretaddr',
      'zcash:utest1qqqqsecretaddr',
      'TunnelSecret=eyJhbGciOiJub25lIn0',
    ].join(' ');
    const result = await runPublicDoctor({
      strict: false,
      env: baseEnv,
      probes: passingProbes({
        tls: async () => ({ ok: false, reason: poison }),
      }),
    });
    const text = formatDoctor(result.rows);
    expect(text).not.toContain('admin-token-value');
    expect(text).not.toContain('uviewtest1notreal');
    expect(text).not.toContain('utest1qqqq');
    expect(text).not.toContain('zcash:');
    expect(text).not.toContain('TunnelSecret');
    expect(text).not.toContain('eyJhbGci');
  });
});

describe('start-public', () => {
  it('reads SSF_ENV_FILE and execs dist/service/main.js without printing env values', () => {
    const secret = 'admin-token-value-do-not-print';
    const logs: string[] = [];
    let argv: string[] = [];
    let childEnv: NodeJS.ProcessEnv = {};
    const code = startPublic({
      env: { SSF_ENV_FILE: '/etc/ssf/public-testnet.env', PATH: '/usr/bin' },
      readFile: () => `SSF_MODE=public-testnet\nSSF_ADMIN_TOKEN_FILE=/run/token\n# ${secret}\nLEAK=${secret}\n`,
      exec: (nextArgv, nextEnv) => {
        argv = nextArgv;
        childEnv = nextEnv;
      },
      stdout: (line) => logs.push(line),
      stderr: (line) => logs.push(line),
      root: '/app',
    });
    expect(code).toBe(0);
    expect(argv.at(-1)).toBe('/app/dist/service/main.js');
    expect(childEnv.LEAK).toBe(secret);
    expect(childEnv.SSF_MODE).toBe('public-testnet');
    expect(logs.join('\n')).not.toContain(secret);
    const kept = startPublic({
      env: { SSF_ENV_FILE: '/etc/ssf/public-testnet.env', SSF_LOGOS_ADVERTISE_HOST: '100.64.0.8' },
      readFile: () => 'SSF_LOGOS_ADVERTISE_HOST=\nSSF_MODE=public-testnet\n',
      exec: (_argv, nextEnv) => { childEnv = nextEnv; },
      stdout: () => undefined,
      stderr: () => undefined,
      root: '/app',
    });
    expect(kept).toBe(0);
    expect(childEnv.SSF_LOGOS_ADVERTISE_HOST).toBe('100.64.0.8');
    expect(childEnv.SSF_MODE).toBe('public-testnet');
    expect(logs.join('\n')).not.toContain(secret);
    expect(loadPublicEnv('SSF_MODE=public-testnet\n')).toEqual({ SSF_MODE: 'public-testnet' });
  });
});

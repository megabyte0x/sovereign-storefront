import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parsePublicCapture } from '../../scripts/live-observe.ts';

const ROOT = join(import.meta.dirname, '../..');
const SCRIPT = join(ROOT, 'scripts/live-observe.ts');

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'live-observe-'));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

const BUILD_INFO = {
  sourceCommit: 'a'.repeat(40),
  dirtyDiffDigest: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
  sourceManifestDigest: 'b'.repeat(64),
  buildTimestamp: '2026-09-26T00:00:00.000Z',
  adapterEntrypoints: ['dist/service/adapters/scanner.js', 'dist/service/adapters/storage.js', 'dist/service/adapters/waku.js'],
};

const SELLER_LOG = [
  'public http://127.0.0.1:8787',
  'admin http://127.0.0.1:8788',
  'ready scanner=true messaging=true checkout=false products=0',
  '{"event":"runtime.component","component":"storage","status":"started","ok":true}',
  '{"event":"runtime.component","component":"scanner","status":"started","ok":true}',
  '{"event":"runtime.component","component":"waku","status":"started","ok":true}',
].join('\n');

function writeSources(): void {
  writeFileSync(join(home, 'build-info.json'), `${JSON.stringify(BUILD_INFO)}\n`);
  writeFileSync(join(home, 'seller.log'), `${SELLER_LOG}\n`);
}

function run(...args: string[]): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, ['--experimental-strip-types', SCRIPT, ...args], {
    cwd: ROOT,
    env: { ...process.env, SSF_OBSERVE_ROOT: home },
    encoding: 'utf8',
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function observations(): Record<string, unknown> {
  return JSON.parse(readFileSync(join(home, 'observations.json'), 'utf8')) as Record<string, unknown>;
}

function initializePublicRecorderState(): void {
  writeSources();
  const initialized = run('init', '--build-info', join(home, 'build-info.json'), '--log', join(home, 'seller.log'));
  if (initialized.status !== 0) throw new Error('failed to initialize recorder fixture');
  const current = observations();
  current.profile = 'public';
  writeFileSync(join(home, 'observations.json'), `${JSON.stringify(current)}\n`);
}

function captureProtocol(overrides: Partial<Record<'identity' | 'build' | 'modules' | 'log', string>> = {}): string {
  return [
    overrides.identity ?? `I|${'a'.repeat(64)}|sha256:${'b'.repeat(64)}|registry.example/ssf:release|true|true`,
    overrides.build ?? `B|${Buffer.from(JSON.stringify(BUILD_INFO)).toString('base64')}`,
    overrides.modules ?? ['scanner', 'storage', 'messaging'].map((name) => `M|${name}|${'c'.repeat(64)}`).join('\n'),
    overrides.log ?? `L|${Buffer.from(SELLER_LOG).toString('base64')}`,
  ].join('\n');
}

describe('parsePublicCapture', () => {
  it('requires one live identity, build record, each adapter artifact hash, and retained log', () => {
    const capture = parsePublicCapture(captureProtocol());
    expect(capture.containerId).toBe('a'.repeat(64));
    expect(capture.imageId).toBe(`sha256:${'b'.repeat(64)}`);
    expect(capture.moduleHashes).toEqual({
      scanner: 'c'.repeat(64), storage: 'c'.repeat(64), messaging: 'c'.repeat(64),
    });
    expect(capture.sellerFacts.ready).toEqual({ scanner: true, messaging: true, checkout: false, products: 0 });
    for (const malformed of [
      captureProtocol({ identity: '' }),
      captureProtocol({ identity: `I|short|sha256:${'b'.repeat(64)}|image|true` }),
      captureProtocol({ identity: `I|${'a'.repeat(64)}|sha256:${'b'.repeat(64)}|registry.example/ssf:release|true|false` }),
      captureProtocol({ build: `B|${Buffer.from('{}').toString('base64')}` }),
      captureProtocol({ build: 'B|not-json' }),
      captureProtocol({ modules: 'M|scanner|not-a-digest' }),
      captureProtocol({ log: `L|${Buffer.from('no ready line').toString('base64')}` }),
      captureProtocol({ log: 'L|' }),
    ]) {
      expect(() => parsePublicCapture(malformed)).toThrow(/live VPS evidence is missing or inconsistent/);
    }
  });

  it('accepts the deployed seller shape: extra adapter entrypoints and timestamped component events', () => {
    const deployedBuild = {
      ...BUILD_INFO,
      adapterEntrypoints: [
        'dist/service/adapters/credentials.js', 'dist/service/adapters/live.js', 'dist/service/adapters/scanner.js',
        'dist/service/adapters/storage.js', 'dist/service/adapters/waku.js', 'dist/service/adapters/wallet-scanner.js',
      ],
    };
    const deployedLog = [
      'ready scanner=true messaging=true checkout=true products=2',
      '{"event":"runtime.component","ts":1790598163465,"component":"storage","status":"started","ok":true}',
      '{"event":"runtime.component","ts":1790598163467,"component":"scanner","status":"started","ok":true}',
      '{"event":"runtime.component","ts":1790598163472,"component":"waku","status":"started","ok":true}',
    ].join('\n');
    const capture = parsePublicCapture(captureProtocol({
      build: `B|${Buffer.from(JSON.stringify(deployedBuild)).toString('base64')}`,
      log: `L|${Buffer.from(deployedLog).toString('base64')}`,
    }));
    expect(capture.sellerFacts.ready.products).toBe(2);
    const missingModule = { ...BUILD_INFO, adapterEntrypoints: ['dist/service/adapters/scanner.js', 'dist/service/adapters/waku.js'] };
    expect(() => parsePublicCapture(captureProtocol({ build: `B|${Buffer.from(JSON.stringify(missingModule)).toString('base64')}` })))
      .toThrow(/live VPS evidence is missing or inconsistent/);
  });

  it('the remote collector reads only the log since the latest container start', () => {
    const source = readFileSync(SCRIPT, 'utf8');
    const script = source.slice(source.indexOf('String.raw`') + 'String.raw`'.length, source.indexOf('`;\n\nexport type PublicCapture'));
    expect(script).toMatch(/started=\$\(docker inspect --format '\{\{\.State\.StartedAt\}\}' "\$container"\)/);
    expect(script).toMatch(/docker logs --since "\$started" "\$container"/);
    expect(script).not.toMatch(/docker logs --tail/);
  });

  it('the remote collector keeps timestamped component events', () => {
    const source = readFileSync(SCRIPT, 'utf8');
    const script = source.slice(source.indexOf('String.raw`') + 'String.raw`'.length, source.indexOf('`;\n\nexport type PublicCapture'));
    const filter = /python3 -c '([\s\S]*?)'\)/.exec(script)?.[1];
    expect(filter).toBeDefined();
    const input = [
      'noise',
      'ready scanner=true messaging=true checkout=true products=2',
      '{"event":"runtime.component","ts":1,"component":"storage","status":"started","ok":true}',
      '{"event":"runtime.component","ts":2,"component":"scanner","status":"started","ok":true}',
      '{"event":"runtime.component","ts":3,"component":"waku","status":"started","ok":true}',
      '{"event":"runtime.component","ts":4,"component":"waku","status":"started","ok":true,"secret":"x"}',
    ].join('\n');
    const result = spawnSync('python3', ['-c', filter!], { input, encoding: 'utf8' });
    expect(result.status).toBe(0);
    expect(result.stdout.trim().split('\n')).toEqual([
      'ready scanner=true messaging=true checkout=true products=2',
      '{"event":"runtime.component","component":"scanner","status":"started","ok":true}',
      '{"event":"runtime.component","component":"storage","status":"started","ok":true}',
      '{"event":"runtime.component","component":"waku","status":"started","ok":true}',
    ]);
  });
});

describe('live-observe', () => {
  it('refuses an unknown stage id', () => {
    writeSources();
    expect(run('init', '--build-info', join(home, 'build-info.json'), '--log', join(home, 'seller.log')).status).toBe(0);
    const result = run('stage', 'not-a-stage', '--status', 'PASS', '--evidence', 'nope');
    expect(result.status).not.toBe(0);
    expect(JSON.stringify(observations())).not.toContain('not-a-stage');
  });

  it('turns secret-shaped evidence into FAIL and never writes the value', () => {
    writeSources();
    expect(run('init', '--build-info', join(home, 'build-info.json'), '--log', join(home, 'seller.log')).status).toBe(0);
    const secret = 'zcash:uregtest1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq';
    const result = run('stage', 'publish', '--status', 'PASS', '--evidence', secret);
    expect(result.status).toBe(0);
    const file = observations();
    expect(JSON.stringify(file)).not.toContain('zcash:');
    expect(JSON.stringify(file)).not.toContain('uregtest1');
    const stages = file.stages as Array<{ id: string; status: string }>;
    expect(stages.find((stage) => stage.id === 'publish')?.status).toBe('FAIL');
  });

  it('writes observations.json mode 0600', () => {
    writeSources();
    expect(run('init', '--build-info', join(home, 'build-info.json'), '--log', join(home, 'seller.log')).status).toBe(0);
    expect(statSync(join(home, 'observations.json')).mode & 0o777).toBe(0o600);
  });

  it('finalize on a partial file lists the missing stages and exits nonzero', () => {
    writeSources();
    expect(run('init', '--build-info', join(home, 'build-info.json'), '--log', join(home, 'seller.log')).status).toBe(0);
    const result = run('finalize', '--out', join(home, 'report.json'));
    expect(result.status).not.toBe(0);
    expect(result.stdout).toContain('origin-stop');
    expect(result.stdout).toContain('NOT_RUN');
  });

  it('keeps the last row when the same stage is recorded twice and notes the overwrite', () => {
    writeSources();
    expect(run('init', '--build-info', join(home, 'build-info.json'), '--log', join(home, 'seller.log')).status).toBe(0);
    expect(run('stage', 'publish', '--status', 'FAIL', '--evidence', 'first attempt').status).toBe(0);
    const second = run('stage', 'publish', '--status', 'PASS', '--evidence', 'second attempt');
    expect(second.status).toBe(0);
    expect(second.stdout).toMatch(/overwrite/i);
    const stages = observations().stages as Array<{ id: string; status: string; evidence?: string[] }>;
    const rows = stages.filter((stage) => stage.id === 'publish');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: 'PASS', evidence: ['second attempt'] });
    expect(JSON.stringify(observations())).toContain('overwrite');
  });

  it('rejects hand-authored public deployment evidence and local provenance shortcuts without contacting the Pi', () => {
    writeSources();
    const manual = run('--profile', 'public', 'init', '--build-info', join(home, 'build-info.json'), '--log', join(home, 'seller.log'));
    expect(manual.status).not.toBe(0);
    expect(manual.stderr).toContain('live VPS evidence is missing or inconsistent');
    expect(existsSync(join(home, 'observations.json'))).toBe(false);

    const evidencePath = join(home, 'deployment-evidence.json');
    const fakeSecret = 'tailscale-pi-running-container';
    writeFileSync(evidencePath, JSON.stringify({ provenance: fakeSecret, target: 'root@ssf-replica' }), { mode: 0o600 });
    const forged = run('--profile', 'public', 'init', '--deployment-evidence', evidencePath);
    expect(forged.status).not.toBe(0);
    expect(forged.stderr).toContain('live VPS evidence is missing or inconsistent');
    expect(forged.stderr).not.toContain(fakeSecret);
    expect(existsSync(join(home, 'observations.json'))).toBe(false);
  });

  it('refuses to write a public report without direct Pi evidence', () => {
    initializePublicRecorderState();
    const outPath = join(home, 'report.json');
    const result = run('--profile', 'public', 'finalize', '--out', outPath);
    expect(result.status).not.toBe(0);
    expect(result.stdout).toContain('no authenticated Pi capture in observations');
    expect(existsSync(outPath)).toBe(false);
  });

  it('public profile records an embed stage and refuses a regtest stage id', () => {
    initializePublicRecorderState();
    expect(observations().profile).toBe('public');
    expect(run('--profile', 'public', 'stage', 'embed-invoice', '--status', 'PASS', '--evidence', 'popup showed invoice').status).toBe(0);
    const refused = run('--profile', 'public', 'stage', 'publish', '--status', 'PASS', '--evidence', 'no');
    expect(refused.status).not.toBe(0);
    expect(JSON.stringify(observations())).not.toContain('"id":"publish"');
  });
});

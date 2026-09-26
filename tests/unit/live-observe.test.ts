import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

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
});

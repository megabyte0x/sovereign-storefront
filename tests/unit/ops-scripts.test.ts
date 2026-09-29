import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { archiveHasCleartextUfvk } from '../../deploy/ops/backup-guard.ts';
import { buildHealthPayload } from '../../deploy/ops/health-payload.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');

function text(rel: string): string {
  return readFileSync(join(ROOT, rel), 'utf8');
}

function referencedScripts(source: string): string[] {
  const found = new Set<string>();
  for (const match of source.matchAll(/(?:scripts|deploy\/ops)\/[A-Za-z0-9_./-]+\.ts/g)) {
    found.add(match[0]);
  }
  return [...found];
}

describe('ops scripts', () => {
  const backup = text('deploy/ops/backup.sh');
  const health = text('deploy/ops/healthcheck.sh');
  const cron = text('deploy/ops/crontab.example');
  const runbook = text('deploy/ops/RUNBOOK.md');

  it('references only commands that exist in this repo', () => {
    const packageScripts = Object.keys(JSON.parse(text('package.json')).scripts as Record<string, string>);
    for (const source of [backup, health]) {
      for (const rel of referencedScripts(source)) {
        expect(text(rel).length).toBeGreaterThan(0);
      }
      for (const match of source.matchAll(/npm run ([A-Za-z0-9:_-]+)/g)) {
        expect(packageScripts).toContain(match[1]);
      }
    }
    expect(backup).toContain('scripts/backup-live.ts');
    expect(backup).toContain('export');
    expect(backup).toContain('verify');
    expect(health).toContain('scripts/public-doctor.ts');
    expect(health).toContain('--strict');
    expect(health).not.toMatch(/echo\s+.*SSF_HEALTH_URL/);
    expect(health).not.toMatch(/printf\s+.*SSF_HEALTH_URL/);
  });

  it('keeps the backup directory at mode 0700 and 14 copies', () => {
    expect(backup).toMatch(/chmod 0700/);
    expect(backup).toMatch(/\b14\b/);
    const guard = backup.indexOf('backup-guard.ts');
    const push = backup.indexOf('rsync -a');
    expect(guard).toBeGreaterThan(-1);
    expect(push).toBeGreaterThan(guard);
  });

  it('refuses a cleartext UFVK before a push would be allowed', () => {
    const sealed = Buffer.from('SSBK sealed archive without a viewing key');
    expect(archiveHasCleartextUfvk(sealed)).toBe(false);
    const leaked = Buffer.from('SSBK prefix uviewtest1notarealkey suffix');
    expect(archiveHasCleartextUfvk(leaked)).toBe(true);
    expect(archiveHasCleartextUfvk(Buffer.from('{"ufvk":"present"}'))).toBe(true);
  });

  it('healthcheck payload builder strips secret shapes', () => {
    const raw = [
      'scanner FAIL tip lag',
      'ufvk uviewtest1abcdefghijklmnopqrstuvwxyz',
      'zcash:utest1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq',
      'Bearer secret-token-value',
      'tunnel credential eyJhbGciOiJIUzI1NiJ9.payload.sig',
    ].join('\n');
    const payload = buildHealthPayload(raw, 1);
    expect(payload).toMatch(/FAIL/);
    expect(payload).toContain('scanner FAIL tip lag');
    expect(payload).not.toMatch(/uview/i);
    expect(payload).not.toMatch(/ufvk/i);
    expect(payload).not.toMatch(/utest1/i);
    expect(payload).not.toMatch(/zcash:/i);
    expect(payload).not.toMatch(/bearer/i);
    expect(payload).not.toMatch(/secret-token/i);
    expect(payload).not.toMatch(/eyJ/);
    expect(buildHealthPayload('tls PASS cert ok', 0)).toMatch(/^public-doctor PASS/);
  });

  it('crontab example is every 5 minutes and nightly, with no secret material', () => {
    expect(cron).toMatch(/\*\/5/);
    expect(cron).toMatch(/backup\.sh/);
    expect(cron).toMatch(/healthcheck\.sh/);
    expect(cron).not.toMatch(/uview|eyJ|Bearer /);
  });

  it('runbook covers the operator procedures and forbids a second scanner', () => {
    expect(runbook).toMatch(/logos-b/);
    expect(runbook).toMatch(/replica-agent/);
    expect(runbook).toMatch(/logos-a/);
    expect(runbook).toMatch(/cloudflared/);
    expect(runbook).toMatch(/Pi down/i);
    expect(runbook).toMatch(/unpublish/i);
    expect(runbook).toMatch(/admin token/i);
    expect(runbook).toMatch(/birthday/i);
    expect(runbook).toMatch(/lightwalletd/i);
    expect(runbook).toMatch(/power loss/i);
    expect(runbook).toMatch(/full/i);
    expect(runbook).toMatch(/tunnel/i);
    expect(runbook).toMatch(/backup:live restore|backup-live\.ts restore/);
    expect(runbook).toMatch(/same UFVK|same viewing key/i);
    expect(runbook).toMatch(/0700/);
  });
});

describe('compose log rotation', () => {
  it('is already applied on every compose file', () => {
    for (const rel of ['deploy/compose.yaml', 'deploy/compose.replica.yaml']) {
      const source = text(rel);
      expect(source).toContain('max-size: 10m');
      expect(source).toContain('max-file: "5"');
      expect(source).toContain('driver: local');
    }
  });
});

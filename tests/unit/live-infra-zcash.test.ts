import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { assertOwnedEnvName, clearStaleScannerState, pollUntil, serveCommand } from '../../scripts/live-infra/zcash-up.ts';

describe('zcash-up', () => {
  it('only operates on the owned ths environment', () => {
    expect(() => assertOwnedEnvName('ssf-live')).not.toThrow();
    for (const other of ['default', 'ssf-task1', 'p-happy', '']) {
      expect(() => assertOwnedEnvName(other)).toThrow('not an owned environment');
    }
  });
  it('builds serve with a config path and never a key argument', () => {
    const argv = serveCommand('/abs/.runtime/live/scanner/scanner.json');
    expect(argv).toEqual(['run', '--locked', '--release', '--quiet', '--manifest-path',
      'services/scanner/Cargo.toml', '--', 'serve', '--config', '/abs/.runtime/live/scanner/scanner.json']);
    expect(argv.join(' ')).not.toMatch(/uview|ufvk|seed/i);
  });
  it('pollUntil reports the last error on timeout', async () => {
    let n = 0;
    await expect(pollUntil(async () => { n += 1; throw new Error(`ENOENT attempt ${n}`); }, 20, 'thing', 5))
      .rejects.toThrow(/^thing did not become ready within 20ms \(last: ENOENT attempt \d+\)$/);
  });
  it('pollUntil truncates the last error to 200 chars and hides JSON bodies', async () => {
    const long = pollUntil(async () => { throw new Error('x'.repeat(500)); }, 5, 'long', 1);
    const e1: Error = await long.catch((e: Error) => e);
    const last = /\(last: (.*)\)$/s.exec(e1.message)?.[1] ?? '';
    expect(last.length).toBe(200);
    const bodyLeak = pollUntil(async () => JSON.parse('SECRET-BODY-MARKER not json'), 5, 'json', 1);
    const e2: Error = await bodyLeak.catch((e: Error) => e);
    expect(e2.message).not.toContain('SECRET-BODY-MARKER');
    expect(e2.message).toMatch(/\(last: invalid JSON response\)$/);
  });
  it('pollUntil omits the suffix when no attempt threw', async () => {
    await expect(pollUntil(async () => undefined, 5, 'quiet', 1)).rejects.toThrow(/^quiet did not become ready within 5ms$/);
  });
  it('clearStaleScannerState removes only scanner.json and its live-state dir', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'ssf-stale-'));
    const json = path.join(dir, 'scanner.json');
    writeFileSync(json, '{}\n');
    mkdirSync(path.join(dir, '.scanner.json.live-state'));
    writeFileSync(path.join(dir, '.scanner.json.live-state', 'wallet.sqlite'), '');
    writeFileSync(path.join(dir, 'serve.log'), '');
    clearStaleScannerState(json, { serving: false });
    expect(existsSync(json)).toBe(false);
    expect(existsSync(path.join(dir, '.scanner.json.live-state'))).toBe(false);
    expect(existsSync(path.join(dir, 'serve.log'))).toBe(true);
    clearStaleScannerState(json, { serving: false }); // idempotent when already absent
    rmSync(dir, { recursive: true, force: true });
  });
  it('clearStaleScannerState refuses while a serve process holds the state', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'ssf-stale-'));
    const json = path.join(dir, 'scanner.json');
    writeFileSync(json, '{}\n');
    expect(() => clearStaleScannerState(json, { serving: true })).toThrow(/serve is running/);
    expect(existsSync(json)).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });
  it('pollUntil resolves as soon as a value is returned', async () => {
    let n = 0;
    await expect(pollUntil(async () => (++n >= 2 ? 'ok' : undefined), 1_000, 'r', 1)).resolves.toBe('ok');
  });
});

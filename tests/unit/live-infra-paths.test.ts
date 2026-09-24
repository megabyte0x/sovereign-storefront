import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  SCANNER_DIR,
  SCANNER_JSON,
  SCANNER_SOCKET,
  assertSocketPathFits,
  resolveScannerDir,
} from '../../scripts/live-infra/paths.ts';

describe('live-infra scanner paths', () => {
  it('assertSocketPathFits accepts an 80-byte absolute path', () => {
    const p = `/${'a'.repeat(79)}`;
    expect(Buffer.byteLength(p)).toBe(80);
    expect(() => assertSocketPathFits(p)).not.toThrow();
  });

  it('assertSocketPathFits rejects a 101-byte path', () => {
    const p = `/${'a'.repeat(100)}`;
    expect(Buffer.byteLength(p)).toBe(101);
    expect(() => assertSocketPathFits(p)).toThrow('unix socket path too long (101 bytes > 100)');
  });

  it('assertSocketPathFits rejects a relative path', () => {
    expect(() => assertSocketPathFits('rel/scanner.sock')).toThrow(/absolute/);
  });

  it('SCANNER_SOCKET fits and derives from SCANNER_DIR', () => {
    expect(() => assertSocketPathFits(SCANNER_SOCKET)).not.toThrow();
    expect(SCANNER_JSON).toBe(path.join(SCANNER_DIR, 'scanner.json'));
    expect(SCANNER_SOCKET).toBe(path.join(SCANNER_DIR, '.scanner.json.live-state', 'scanner.sock'));
  });

  it('resolveScannerDir honours an absolute SSF_LIVE_SCANNER_DIR', () => {
    expect(resolveScannerDir({ SSF_LIVE_SCANNER_DIR: '/tmp/x/scanner' }, '/home/u')).toBe('/tmp/x/scanner');
  });

  it('resolveScannerDir rejects a relative SSF_LIVE_SCANNER_DIR', () => {
    expect(() => resolveScannerDir({ SSF_LIVE_SCANNER_DIR: 'rel/scanner' }, '/home/u')).toThrow(/absolute/);
  });

  it('resolveScannerDir defaults to XDG_STATE_HOME or ~/.local/state', () => {
    expect(resolveScannerDir({}, '/home/u')).toBe('/home/u/.local/state/ssf-live/scanner');
    expect(resolveScannerDir({ XDG_STATE_HOME: '/xdg' }, '/home/u')).toBe('/xdg/ssf-live/scanner');
  });
});

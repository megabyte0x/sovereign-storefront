import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, test } from 'vitest';
import { main, type BackupLiveDeps, type Proc } from '../../scripts/backup-live.ts';
import { loadOrCreateSellerIdentity } from '../../src/seller/identity.ts';

let roots: string[] = [];
afterEach(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  roots = [];
});

const SCANNER_INFO = { accountId: '0', sourceId: 'src-1', network: 'regtest', reservedHighWater: '7', allocationCount: 3 };

type Fx = {
  root: string;
  repoRoot: string;
  sellerDb: string;
  scannerConfig: string;
  keyFile: string;
  scannerBin: string;
  publicKeyHex: string;
};

function fixture(): Fx {
  const root = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), 'ssf-backup-live-'));
  roots.push(root);
  const repoRoot = join(root, 'repo');
  mkdirSync(repoRoot);
  const sellerDir = join(root, 'seller');
  mkdirSync(sellerDir, { mode: 0o700 });
  const sellerDb = join(sellerDir, 'seller.sqlite');
  const db = new DatabaseSync(sellerDb);
  db.exec('PRAGMA journal_mode=WAL');
  db.exec('CREATE TABLE marker (v TEXT)');
  db.exec("INSERT INTO marker VALUES ('row')");
  db.close();
  const identity = loadOrCreateSellerIdentity(sellerDb);
  const scannerDir = join(root, 'scanner');
  mkdirSync(scannerDir, { mode: 0o700 });
  const scannerConfig = join(scannerDir, 'scanner.json');
  writeFileSync(scannerConfig, JSON.stringify({
    ufvk: 'uviewregtest1fixtureonlyfullviewingkey',
    birthday: 1,
    runtime: { sourceId: 'src-1', chain: { network: 'regtest' } },
  }), { mode: 0o600 });
  const state = join(scannerDir, '.scanner.json.live-state');
  mkdirSync(state, { mode: 0o700 });
  writeFileSync(join(state, 'wallet.sqlite'), Buffer.from('wallet-opaque'), { mode: 0o600 });
  writeFileSync(join(state, 'scanner.sqlite'), Buffer.from('scanner-opaque'), { mode: 0o600 });
  const keyFile = join(sellerDir, 'backup.key');
  writeFileSync(keyFile, `${randomBytes(32).toString('hex')}\n`, { mode: 0o600 });
  chmodSync(keyFile, 0o600);
  return {
    root, repoRoot, sellerDb, scannerConfig, keyFile,
    scannerBin: join(repoRoot, 'services/scanner/target/release/sovereign-storefront-scanner'),
    publicKeyHex: identity.publicKeyHex,
  };
}

type Recorded = { out: string[]; err: string[]; scannerCalls: Array<{ bin: string; args: string[] }> };

function deps(procs: Proc[] = [], info: unknown = SCANNER_INFO): { deps: BackupLiveDeps; rec: Recorded } {
  const rec: Recorded = { out: [], err: [], scannerCalls: [] };
  return {
    rec,
    deps: {
      processes: () => procs,
      runScanner: async (bin, args) => {
        rec.scannerCalls.push({ bin, args });
        return { code: 0, stdout: `${JSON.stringify(info)}\n` };
      },
      out: line => rec.out.push(line),
      err: line => rec.err.push(line),
      now: () => new Date('2026-09-26T00:00:00.000Z'),
    },
  };
}

function common(fx: Fx): string[] {
  return [
    '--repo-root', fx.repoRoot,
    '--seller-db', fx.sellerDb,
    '--scanner-config', fx.scannerConfig,
    '--key-file', fx.keyFile,
    '--scanner-bin', fx.scannerBin,
  ];
}

describe('backup:live export', () => {
  test('refuses while the scanner PID file points at a live scanner for this config', async () => {
    const fx = fixture();
    writeFileSync(join(fx.root, 'scanner', 'serve.pid'), '4242\n');
    const { deps: d, rec } = deps([{ pid: 4242, cmdline: `${fx.scannerBin} serve --config ${fx.scannerConfig}` }]);
    const code = await main(['export', ...common(fx), '--out', join(fx.root, 'out.ssbk')], d);
    expect(code).not.toBe(0);
    expect(rec.err.join('\n')).toMatch(/scanner is running \(pid 4242\)/);
    expect(rec.scannerCalls).toEqual([]);
    expect(existsSync(join(fx.root, 'out.ssbk'))).toBe(false);
  });

  test('refuses while the seller PID file points at a live seller of this repo', async () => {
    const fx = fixture();
    writeFileSync(join(fx.root, 'seller', 'seller.pid'), '5151\n');
    const { deps: d, rec } = deps([{ pid: 5151, cmdline: `node ${join(fx.repoRoot, 'dist/service/main.js')}` }]);
    const code = await main(['export', ...common(fx), '--out', join(fx.root, 'out.ssbk')], d);
    expect(code).not.toBe(0);
    expect(rec.err.join('\n')).toMatch(/seller is running \(pid 5151\)/);
    expect(existsSync(join(fx.root, 'out.ssbk'))).toBe(false);
  });

  test('refuses a live scanner process even without a PID file', async () => {
    const fx = fixture();
    const { deps: d, rec } = deps([{ pid: 77, cmdline: `${fx.scannerBin} serve --config ${fx.scannerConfig}` }]);
    expect(await main(['export', ...common(fx), '--out', join(fx.root, 'out.ssbk')], d)).not.toBe(0);
    expect(rec.err.join('\n')).toMatch(/scanner is running \(pid 77\)/);
  });

  test('a stale PID file whose pid now runs something else does not block', async () => {
    const fx = fixture();
    writeFileSync(join(fx.root, 'scanner', 'serve.pid'), '4242\n');
    const { deps: d, rec } = deps([{ pid: 4242, cmdline: '/usr/bin/bash' }]);
    const code = await main(['export', ...common(fx), '--out', join(fx.root, 'out.ssbk')], d);
    expect(rec.err).toEqual([]);
    expect(code).toBe(0);
  });

  test('calls scanner backup-info and passes its JSON as scannerInfo', async () => {
    const fx = fixture();
    const out = join(fx.root, 'backups', 'out.ssbk');
    const { deps: d, rec } = deps();
    const code = await main(['export', ...common(fx), '--out', out], d);
    expect(rec.err).toEqual([]);
    expect(code).toBe(0);
    expect(rec.scannerCalls).toEqual([{ bin: fx.scannerBin, args: ['backup-info', '--config', fx.scannerConfig] }]);
    expect(statSync(out).mode & 0o777).toBe(0o600);
    const text = rec.out.join('\n');
    expect(text).toContain(out);
    expect(text).toMatch(/version: 2/);
    expect(text).toMatch(/entries: 5/);
    expect(text).toMatch(/reservedHighWater: 7/);

    // The high-water mark came from backup-info, not from anywhere else.
    const { deps: v, rec: vrec } = deps();
    expect(await main(['verify', '--archive', out, '--key-file', fx.keyFile], v)).toBe(0);
    expect(vrec.out.join('\n')).toMatch(/reservedHighWater: 7/);
    expect(vrec.out.join('\n')).toMatch(/complete: true/);
  });

  test('rejects malformed backup-info output', async () => {
    const fx = fixture();
    const { deps: d, rec } = deps([], { accountId: '0' });
    expect(await main(['export', ...common(fx), '--out', join(fx.root, 'o.ssbk')], d)).not.toBe(0);
    expect(rec.err.join('\n')).toMatch(/backup-info/);
  });

  test('creates a missing key file 0600 and never prints it', async () => {
    const fx = fixture();
    rmSync(fx.keyFile);
    const { deps: d, rec } = deps();
    expect(await main(['export', ...common(fx), '--out', join(fx.root, 'o.ssbk')], d)).toBe(0);
    expect(statSync(fx.keyFile).mode & 0o777).toBe(0o600);
    const all = [...rec.out, ...rec.err].join('\n');
    expect(all).not.toMatch(/[0-9a-f]{64}/i);
  });
});

describe('backup:live verify key file', () => {
  test('uses the library key-file reader (same errors as export/restore)', async () => {
    const fx = fixture();
    chmodSync(fx.keyFile, 0o640);
    writeFileSync(join(fx.root, 'any.ssbk'), 'SSBK');
    const { deps: d, rec } = deps();
    expect(await main(['verify', '--archive', join(fx.root, 'any.ssbk'), '--key-file', fx.keyFile], d)).not.toBe(0);
    expect(rec.err.join('\n')).toContain('backup key file must be owner-only (permission 0600)');
  });
});

describe('backup:live restore', () => {
  async function exported(fx: Fx): Promise<string> {
    const out = join(fx.root, 'out.ssbk');
    const { deps: d } = deps();
    expect(await main(['export', ...common(fx), '--out', out], d)).toBe(0);
    return out;
  }

  test('writes into fresh dirs and prints only paths, version, entry count and next commands', async () => {
    const fx = fixture();
    const archive = await exported(fx);
    const sellerDir = join(fx.root, 'restored-seller');
    const scannerDir = join(fx.root, 'restored-scanner');
    const { deps: d, rec } = deps();
    const code = await main([
      'restore', '--archive', archive, '--key-file', fx.keyFile,
      '--seller-dir', sellerDir, '--scanner-dir', scannerDir,
      '--repo-root', fx.repoRoot, '--scanner-bin', fx.scannerBin,
    ], d);
    expect(rec.err).toEqual([]);
    expect(code).toBe(0);
    expect(rec.scannerCalls).toEqual([]); // restore prints the next commands, it runs none
    expect(readdirSync(sellerDir).sort()).toEqual(['seller-identity.json', 'seller.sqlite']);
    expect(existsSync(join(scannerDir, '.scanner.json.live-state', 'wallet.sqlite'))).toBe(true);

    const text = rec.out.join('\n');
    expect(text).toContain(sellerDir);
    expect(text).toContain(scannerDir);
    expect(text).toMatch(/version: 2/);
    expect(text).toMatch(/entries: 5/);
    // No hex run longer than 16 chars, apart from the public key prefix.
    const prefix = fx.publicKeyHex.slice(0, 16);
    expect(text).toContain(prefix);
    expect(text).not.toContain(fx.publicKeyHex);
    expect(text.replaceAll(prefix, '')).not.toMatch(/[0-9a-f]{17,}/i);
    expect(text).not.toMatch(/uview/);

    // Exact next commands, in order: restore-ack, start, rescan.
    const ack = `${fx.scannerBin} restore-ack --config ${join(scannerDir, 'scanner.json')} --new-epoch --reserve-gap 1000`;
    const ackAt = text.indexOf(ack);
    const serveAt = text.indexOf(`${fx.scannerBin} serve --config ${join(scannerDir, 'scanner.json')}`);
    const startAt = text.indexOf(`SSF_DB_PATH=${join(sellerDir, 'seller.sqlite')}`);
    const rescanAt = text.search(/rescan/i);
    expect(ackAt).toBeGreaterThanOrEqual(0);
    expect(serveAt).toBeGreaterThan(ackAt);
    expect(startAt).toBeGreaterThan(serveAt);
    expect(text).toContain('npm run start:live');
    expect(rescanAt).toBeGreaterThan(ackAt);

    // The reserve gap is explained, and the original stack must be retired.
    expect(text).toMatch(/reserve-gap/);
    expect(text).toMatch(/after the backup/i);
    expect(text).toMatch(/retire|decommission/i);
    // The start command names every env key real-demo requires (values are paths only).
    const startLine = rec.out.find(line => line.includes('npm run start:live'))!;
    for (const key of ['SSF_MODE=real-demo', 'SSF_NETWORK=regtest', 'SSF_ADMIN_TOKEN_FILE=', `SSF_SCANNER_CONFIG=${join(scannerDir, 'scanner.json')}`, `SSF_DB_PATH=${join(sellerDir, 'seller.sqlite')}`]) {
      expect(startLine).toContain(key);
    }
    expect(text).toContain('runbook');
  });

  test('refuses a non-empty target and does not create the key file', async () => {
    const fx = fixture();
    const archive = await exported(fx);
    const sellerDir = join(fx.root, 'busy');
    mkdirSync(sellerDir);
    writeFileSync(join(sellerDir, 'x'), 'x');
    const { deps: d, rec } = deps();
    expect(await main([
      'restore', '--archive', archive, '--key-file', fx.keyFile,
      '--seller-dir', sellerDir, '--scanner-dir', join(fx.root, 'fresh'),
    ], d)).not.toBe(0);
    expect(rec.err.join('\n')).toMatch(/not empty/);

    const missingKey = join(fx.root, 'nokey');
    const { deps: d2 } = deps();
    expect(await main([
      'restore', '--archive', archive, '--key-file', missingKey,
      '--seller-dir', join(fx.root, 's2'), '--scanner-dir', join(fx.root, 'c2'),
    ], d2)).not.toBe(0);
    expect(existsSync(missingKey)).toBe(false);
  });

  test('requires explicit restore target dirs', async () => {
    const fx = fixture();
    const { deps: d, rec } = deps();
    expect(await main(['restore', '--archive', join(fx.root, 'a'), '--key-file', fx.keyFile], d)).not.toBe(0);
    expect(rec.err.join('\n')).toMatch(/--seller-dir/);
  });
});

import { existsSync, rmSync } from 'node:fs';
import { execFile } from 'node:child_process';
import path from 'node:path';
import { LIVE_ROOT } from './paths.ts';

const LOGOS_ROOT = path.join(LIVE_ROOT, 'logos');
const NODE_DIRS = [path.join(LOGOS_ROOT, 'node-a'), path.join(LOGOS_ROOT, 'node-b')];

function execFileEnv(cmd: string, args: string[], env: NodeJS.ProcessEnv, ms: number): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${cmd} ${args.join(' ')} timed out`)), ms);
    execFile(cmd, args, { env, maxBuffer: 32 * 1024 * 1024 }, (err, stdout, stderr) => {
      clearTimeout(timer);
      if (err) { reject(new Error(`${cmd} ${args.join(' ')} failed: ${stderr || err.message}`)); return; }
      resolve({ stdout, stderr });
    });
  });
}

const LOGOSCTL_ENV = { ...process.env, APPIMAGE_EXTRACT_AND_RUN: '1' };

async function callJson(logosctlPath: string, configDir: string, args: string[], ms = 30_000): Promise<any> {
  const { stdout } = await execFileEnv(logosctlPath, ['--config-dir', configDir, '--json', ...args], LOGOSCTL_ENV, ms);
  return JSON.parse(stdout.trim());
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function tearDownNode(logosctlPath: string, nodeDir: string, purge: boolean): Promise<void> {
  if (!existsSync(nodeDir)) return;
  const status = await callJson(logosctlPath, nodeDir, ['daemon', 'status']).catch(() => undefined);
  if (status?.daemon?.status !== 'running') {
    if (purge) {
      const storageData = path.join(nodeDir, 'storage-data');
      if (existsSync(storageData)) rmSync(storageData, { recursive: true, force: true });
    }
    return;
  }

  await callJson(logosctlPath, nodeDir, ['call', 'storage_module', 'stop']).catch(() => undefined);
  // Best-effort: give the async stop a bounded moment to settle before destroy.
  await sleep(15_000);
  await callJson(logosctlPath, nodeDir, ['call', 'storage_module', 'destroy']).catch(() => undefined);
  await callJson(logosctlPath, nodeDir, ['daemon', 'stop']).catch(() => undefined);

  if (purge) {
    const storageData = path.join(nodeDir, 'storage-data');
    if (existsSync(storageData)) rmSync(storageData, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  const purge = process.argv.includes('--purge');
  const logosctlPath = path.join(LOGOS_ROOT, 'bin', 'logosctl-aarch64.AppImage');
  if (!existsSync(logosctlPath)) {
    process.stdout.write('logos=down (nothing to tear down)\n');
    return;
  }
  for (const nodeDir of NODE_DIRS) {
    await tearDownNode(logosctlPath, nodeDir, purge);
  }
  process.stdout.write('logos=down\n');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    process.stderr.write(`logos-down failed: ${e?.message ?? e}\n`);
    process.exitCode = 1;
  });
}

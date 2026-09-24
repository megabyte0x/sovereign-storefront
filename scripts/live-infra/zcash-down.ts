import { existsSync, readFileSync, rmSync } from 'node:fs';
import { execFile } from 'node:child_process';
import path from 'node:path';
import { LIVE_ROOT, SCANNER_DIR } from './paths.ts';
import { assertOwnedEnvName } from './zcash-up.ts';

function execPlain(cmd: string, args: string[], ms = 60_000): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${cmd} ${args.join(' ')} timed out`)), ms);
    execFile(cmd, args, { maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      clearTimeout(timer);
      if (err) { reject(new Error(`${cmd} ${args.join(' ')} failed: ${stderr || err.message}`)); return; }
      resolve({ stdout, stderr });
    });
  });
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function stopOwnedProcess(pid: number, mustInclude: string[]): Promise<void> {
  let cmdline = '';
  try {
    cmdline = readFileSync(`/proc/${pid}/cmdline`, 'utf8');
  } catch {
    return; // already gone
  }
  if (!mustInclude.every((needle) => cmdline.includes(needle))) {
    return; // not ours; do not touch it
  }
  try { process.kill(pid, 'SIGTERM'); } catch { return; }
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try { process.kill(pid, 0); } catch { return; }
    await sleep(500);
  }
}

export async function zcashDown(options: { reset?: boolean } = {}): Promise<void> {
  const envName = process.env.THS_ENV_NAME ?? 'ssf-live';
  assertOwnedEnvName(envName);

  const scannerDir = SCANNER_DIR;
  const zcashDir = path.join(LIVE_ROOT, 'zcash');
  const servePidPath = path.join(scannerDir, 'serve.pid');
  if (existsSync(servePidPath)) {
    const pid = Number(readFileSync(servePidPath, 'utf8').trim());
    if (Number.isInteger(pid)) await stopOwnedProcess(pid, ['sovereign-storefront-scanner', 'serve']);
  }

  await execPlain('ths', ['stop', '--name', envName, '--json']).catch(() => undefined);

  // `ths stop` tears down the environment's resources but does not kill the
  // separately-launched foreground `ths start --name <env>` process this
  // script spawned to own it — that process lingers indefinitely (harmlessly,
  // since its environment is gone) unless killed explicitly here.
  const thsPidPath = path.join(zcashDir, 'ths.pid');
  if (existsSync(thsPidPath)) {
    const pid = Number(readFileSync(thsPidPath, 'utf8').trim());
    if (Number.isInteger(pid)) await stopOwnedProcess(pid, ['ths', 'start', envName]);
  }

  if (options.reset) {
    await execPlain('ths', ['reset', '--name', envName, '--force', '--json']).catch(() => undefined);
    if (existsSync(scannerDir)) rmSync(scannerDir, { recursive: true, force: true });
  }

  const dockerCheck = await execPlain('docker', ['ps', '--filter', `name=tsz-${envName}`, '-q']).catch(() => ({ stdout: '' }));
  if (dockerCheck.stdout.trim().length > 0) {
    throw new Error(`owned docker containers still present for ${envName}`);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const reset = process.argv.includes('--reset');
  zcashDown({ reset }).then(
    () => { process.stdout.write('zcash=down\n'); },
    (e) => {
      process.stderr.write(`zcash-down failed: ${e?.message ?? e}\n`);
      process.exitCode = 1;
    },
  );
}

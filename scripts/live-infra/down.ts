import { execFile, spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SCANNER_DIR } from './paths.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const DOWN_ORDER = ['logos', 'zcash'] as const;
export type DownStage = (typeof DOWN_ORDER)[number];

const STAGE_SCRIPTS: Record<DownStage, string> = {
  logos: 'logos-down.ts',
  zcash: 'zcash-down.ts',
};

/** Owned-leftover probes. Each must print nothing (after self-filtering) when torn down. */
export function leftoverChecks(): { kind: string; argv: string[] }[] {
  return [
    { kind: 'docker-container', argv: ['docker', 'ps', '--filter', 'name=tsz-ssf-live', '-q'] },
    { kind: 'logos-node-process', argv: ['pgrep', '-f', 'logos/node-(a|b)'] },
    { kind: 'ths-start-process', argv: ['pgrep', '-f', 'ths start --name ssf-live( |$)'] },
  ];
}

/** Non-empty output lines, minus PIDs belonging to this process chain. */
export function isLeftover(stdout: string, ignorePids: number[]): string[] {
  const ignore = new Set(ignorePids.map(String));
  return stdout.split('\n').map((l) => l.trim()).filter((l) => l !== '' && !ignore.has(l));
}

function runCapture(argv: string[]): Promise<{ code: number; stdout: string }> {
  return new Promise((resolve) => {
    execFile(argv[0], argv.slice(1), { maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
      const code = err ? (typeof (err as NodeJS.ErrnoException & { code?: unknown }).code === 'number' ? Number((err as { code: number }).code) : 127) : 0;
      resolve({ code, stdout: String(stdout ?? '') });
    });
  });
}

function runStage(stage: DownStage): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['--experimental-strip-types', path.join(__dirname, STAGE_SCRIPTS[stage])], {
      env: process.env,
      stdio: 'inherit',
    });
    child.on('error', () => resolve(1));
    child.on('close', (code) => resolve(code ?? 1));
  });
}

function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM'; }
}

async function main(): Promise<void> {
  let failed = false;
  for (const stage of DOWN_ORDER) {
    const code = await runStage(stage);
    if (code !== 0) { process.stdout.write(`${stage}-down exit=${code}\n`); failed = true; }
  }

  const leftovers: string[] = [];
  const self = [process.pid, process.ppid];
  for (const check of leftoverChecks()) {
    const r = await runCapture(check.argv);
    // pgrep exits 1 on no match; docker exits 0 with empty output.
    if (r.code !== 0 && r.code !== 1) { leftovers.push(`${check.kind}: check failed (exit ${r.code})`); continue; }
    const hits = isLeftover(r.stdout, self);
    if (hits.length > 0) leftovers.push(`${check.kind}: ${hits.length} still present`);
  }
  const servePidPath = path.join(SCANNER_DIR, 'serve.pid');
  if (existsSync(servePidPath)) {
    const pid = Number(readFileSync(servePidPath, 'utf8').trim());
    if (Number.isInteger(pid) && pid > 0 && pidAlive(pid)) leftovers.push('scanner-serve: serve.pid names a live process');
  }

  for (const l of leftovers) process.stdout.write(`leftover ${l}\n`);
  if (leftovers.length > 0 || failed) {
    process.exitCode = 1;
    return;
  }
  process.stdout.write('infra=down leftovers=none\n');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    process.stderr.write(`down failed: ${e?.message ?? e}\n`);
    process.exitCode = 1;
  });
}

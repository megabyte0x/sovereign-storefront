import { spawn } from 'node:child_process';
import { chmodSync, openSync, closeSync, writeSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { LIVE_ROOT, ensurePrivateDir } from './paths.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const UP_ORDER = ['zcash', 'logos', 'waku'] as const;
export type UpStage = (typeof UP_ORDER)[number];

const STAGE_SCRIPTS: Record<UpStage, string> = {
  zcash: 'zcash-up.ts',
  logos: 'logos-up.ts',
  waku: 'waku-peers.ts',
};

export type StageResult = { code: number; statusLine: string; logPath: string };
export type StageRunner = (stage: string) => Promise<StageResult>;
export type RunStagesResult = { ok: boolean; failed?: string; logPath?: string; lines: string[] };

/** Run stages in order; stop at the first nonzero exit. Pure given the injected runner. */
export async function runStages(stages: readonly string[], runner: StageRunner): Promise<RunStagesResult> {
  const lines: string[] = [];
  for (const stage of stages) {
    const r = await runner(stage);
    if (r.code !== 0) return { ok: false, failed: stage, logPath: r.logPath, lines };
    lines.push(r.statusLine);
  }
  return { ok: true, lines };
}

/** Last non-empty line of a child's stdout. */
export function finalStatusLine(stdout: string): string {
  const lines = stdout.split('\n').map((l) => l.trim()).filter((l) => l !== '');
  return lines.length > 0 ? lines[lines.length - 1] : '';
}

const ROW_LINE = /^(zcash|scanner|logos-a|logos-b|logos-replication|waku) (PASS|FAIL|SKIP)\b/;

/** Only the doctor's `<row> <STATUS> <reason>` lines. */
export function doctorRowLines(stdout: string): string[] {
  return stdout.split('\n').filter((l) => ROW_LINE.test(l));
}

function timestamp(): string {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

/**
 * Run a live-infra script as a child (inherited env plus `extraEnv`), sending
 * stdout and stderr to a 0600 diag log. Returns the exit code and the stdout.
 */
function runScript(script: string, logName: string, extraEnv: Record<string, string> = {}): Promise<{ code: number; stdout: string; logPath: string }> {
  const diagDir = path.join(LIVE_ROOT, 'diag');
  ensurePrivateDir(LIVE_ROOT);
  ensurePrivateDir(diagDir);
  const logPath = path.join(diagDir, `${logName}-${timestamp()}.log`);
  const fd = openSync(logPath, 'a', 0o600);
  chmodSync(logPath, 0o600);
  return new Promise((resolve) => {
    let stdout = '';
    const child = spawn(process.execPath, ['--experimental-strip-types', path.join(__dirname, script)], {
      env: { ...process.env, ...extraEnv },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.on('data', (b: Buffer) => { stdout += b.toString('utf8'); writeSync(fd, b); });
    child.stderr.on('data', (b: Buffer) => { writeSync(fd, b); });
    child.on('error', (e) => { writeSync(fd, `spawn error: ${e.message}\n`); });
    child.on('close', (code, signal) => {
      if (signal) writeSync(fd, `terminated by ${signal}\n`);
      closeSync(fd);
      resolve({ code: code ?? 1, stdout, logPath });
    });
  });
}

const realRunner: StageRunner = async (stage) => {
  const r = await runScript(STAGE_SCRIPTS[stage as UpStage], `up-${stage}`);
  const statusLine = finalStatusLine(r.stdout);
  if (r.code === 0) process.stdout.write(`${statusLine}\n`);
  return { code: r.code, statusLine, logPath: r.logPath };
};

async function main(): Promise<void> {
  const res = await runStages(UP_ORDER, realRunner);
  if (!res.ok) {
    process.stdout.write(`${res.failed} FAILED (log: ${res.logPath})\n`);
    process.exitCode = 1;
    return;
  }
  const doctor = await runScript('doctor.ts', 'up-doctor', { SSF_STRICT_LIVE: '1' });
  for (const line of doctorRowLines(doctor.stdout)) process.stdout.write(`${line}\n`);
  if (doctor.code !== 0) process.stdout.write(`doctor exit=${doctor.code} (log: ${doctor.logPath})\n`);
  process.exitCode = doctor.code;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    process.stderr.write(`up failed: ${e?.message ?? e}\n`);
    process.exitCode = 1;
  });
}

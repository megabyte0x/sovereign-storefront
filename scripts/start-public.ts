// Seller container entrypoint. Reads SSF_ENV_FILE and execs the built service.
// Never prints env values, file contents, or tokens.
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const DEFAULT_ENV_FILE = '/etc/ssf/public-testnet.env';

export function loadPublicEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
    if (!match) continue;
    let value = match[2] ?? '';
    if (value.length >= 2 && (value[0] === '"' || value[0] === "'") && value.at(-1) === value[0]) {
      value = value.slice(1, -1);
    }
    out[match[1]!] = value;
  }
  return out;
}

export function publicEnvPath(env: NodeJS.Dict<string>): string {
  const configured = env.SSF_ENV_FILE;
  return configured !== undefined && configured.length > 0 ? configured : DEFAULT_ENV_FILE;
}

export type StartPublicDeps = {
  env: NodeJS.Dict<string>;
  readFile: (file: string) => string;
  exec: (argv: string[], env: NodeJS.ProcessEnv) => void;
  stdout: (line: string) => void;
  stderr: (line: string) => void;
  root: string;
};

/** Load the env file over the caller env and exec dist/service/main.js. Returns 0, or 1 without printing values. */
export function startPublic(deps: StartPublicDeps): number {
  const file = publicEnvPath(deps.env);
  let text: string;
  try {
    text = deps.readFile(file);
  } catch {
    deps.stderr('startup failed: env file\n');
    return 1;
  }
  const loaded = loadPublicEnv(text);
  const childEnv: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(deps.env)) {
    if (typeof value === 'string') childEnv[key] = value;
  }
  for (const [key, value] of Object.entries(loaded)) {
    if (value === '' && typeof childEnv[key] === 'string' && childEnv[key] !== '') continue;
    childEnv[key] = value;
  }
  deps.exec([process.execPath, path.join(deps.root, 'dist/service/main.js')], childEnv);
  return 0;
}

function isMain(): boolean {
  const argv1 = process.argv[1];
  if (!argv1) return false;
  return path.resolve(argv1) === fileURLToPath(import.meta.url);
}

if (isMain()) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const code = startPublic({
    env: process.env,
    readFile: (file) => readFileSync(file, 'utf8'),
    exec: (argv, env) => {
      const result = spawnSync(argv[0]!, argv.slice(1), { env, stdio: 'inherit' });
      process.exit(result.status ?? 1);
    },
    stdout: (line) => process.stdout.write(line),
    stderr: (line) => process.stderr.write(line),
    root,
  });
  if (code !== 0) process.exit(code);
}

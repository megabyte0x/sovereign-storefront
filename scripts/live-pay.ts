/**
 * Owned payer CLI for the live stack. It funds a seller-issued ZIP-321 URI from
 * the disposable ths faucet, mines blocks and reads confirmations — against the
 * owned `ssf-live` ths env ONLY. It never reads seller or scanner keys, and it
 * never prints a full destination address or any child-process output.
 *
 *   live-pay fund --uri <zip321>
 *   live-pay mine --blocks <N>
 *   live-pay confirmations --txid <hex64>
 *
 * The env name comes from `THS_ENV_NAME` in `.runtime/live/live.env` (or the
 * process env, which must agree). Any other name is refused.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { run } from './qualify-payments.ts';

export const OWNED_THS_ENV = 'ssf-live';
/** Envs this CLI must never act on (listed explicitly so refusals are auditable). */
export const REFUSED_THS_ENVS: readonly string[] = ['ssf-task1', 'ssf-task3-live', 'default', 'p-happy'];

/** ths faucet caps a single send at 5 ZEC. */
const MAX_FUND_ZAT = 500_000_000n;
const MAX_MINE_BLOCKS = 100;
const REDACT_PREFIX_CHARS = 6;
const ZAT_PER_ZEC = 100_000_000n;

export type LivePayRunResult = { code: number; stdout: string; stderr: string };
export type LivePayRunner = (command: string, args: string[]) => Promise<LivePayRunResult>;
export type LivePayFetch = (url: string, init?: RequestInit) => Promise<Response>;

export type LivePayArgs =
  | { command: 'fund'; uri: string }
  | { command: 'mine'; blocks: number }
  | { command: 'confirmations'; txid: string };

export type Zip321Payment = { address: string; amount: string; amountZat: bigint };

export function resolveOwnedEnv(env: Record<string, string | undefined>): string {
  const name = env.THS_ENV_NAME;
  if (name === undefined || name === '') throw new Error('THS_ENV_NAME is not set');
  if (REFUSED_THS_ENVS.includes(name)) throw new Error(`refusing non-owned ths env: ${name}`);
  if (name !== OWNED_THS_ENV) throw new Error('refusing ths env: only the owned env is allowed');
  return name;
}

/** A short, non-identifying prefix of an address for logs. */
export function redactAddress(address: string): string {
  const hrpEnd = address.indexOf('1');
  const head = hrpEnd > 0 ? hrpEnd + 1 : 0;
  return `${address.slice(0, head + REDACT_PREFIX_CHARS)}…`;
}

function amountToZat(amount: string): bigint {
  const match = /^(0|[1-9][0-9]*)(?:\.([0-9]{1,8}))?$/.exec(amount);
  if (!match) throw new Error('zip321 amount is malformed');
  const whole = BigInt(match[1]);
  const fraction = BigInt((match[2] ?? '').padEnd(8, '0'));
  return whole * ZAT_PER_ZEC + fraction;
}

/** Parse a single-payment regtest ZIP-321 URI carrying exactly one `amount`. */
export function parseZip321(uri: string): Zip321Payment {
  if (!uri.startsWith('zcash:')) throw new Error('zip321 scheme is not zcash:');
  const body = uri.slice('zcash:'.length);
  if (body.includes('#')) throw new Error('zip321 URI has a fragment');
  const marker = body.indexOf('?');
  if (marker <= 0) throw new Error('zip321 URI needs an address and an amount');
  const address = body.slice(0, marker);
  if (!/^uregtest1[02-9ac-hj-np-z]{20,}$/.test(address)) {
    throw new Error('zip321 address is not a regtest unified address');
  }
  const params = new URLSearchParams(body.slice(marker + 1));
  const keys = [...params.keys()];
  if (keys.length !== 1 || keys[0] !== 'amount') throw new Error('zip321 URI must carry exactly one amount');
  const amount = params.get('amount') ?? '';
  const amountZat = amountToZat(amount);
  if (amountZat <= 0n || amountZat > MAX_FUND_ZAT) throw new Error('zip321 amount is out of range');
  return { address, amount, amountZat };
}

export function parseLivePayArgs(argv: readonly string[]): LivePayArgs {
  const [command, flag, value, ...rest] = argv;
  if (rest.length !== 0 || value === undefined) throw new Error('usage: live-pay fund --uri <zip321> | mine --blocks <N> | confirmations --txid <hex>');
  if (command === 'fund' && flag === '--uri') {
    parseZip321(value);
    return { command, uri: value };
  }
  if (command === 'mine' && flag === '--blocks') {
    if (!/^[1-9][0-9]*$/.test(value) || Number(value) > MAX_MINE_BLOCKS) throw new Error('--blocks must be 1..100');
    return { command, blocks: Number(value) };
  }
  if (command === 'confirmations' && flag === '--txid') {
    if (!/^[0-9a-f]{64}$/.test(value)) throw new Error('--txid must be 64 lowercase hex characters');
    return { command, txid: value };
  }
  throw new Error('usage: live-pay fund --uri <zip321> | mine --blocks <N> | confirmations --txid <hex>');
}

function jsonObject(text: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(text);
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function txidFrom(stdout: string): string | null {
  const record = jsonObject(stdout);
  const candidate = record?.txid ?? record?.transaction_id;
  // JSON field only: any other 64-hex in stdout (block hashes) is not the txid.
  return typeof candidate === 'string' && /^[0-9a-f]{64}$/.test(candidate) ? candidate : null;
}

async function confirmations(
  name: string,
  txid: string,
  runner: LivePayRunner,
  fetchImpl: LivePayFetch,
): Promise<number> {
  const endpoints = await runner('ths', ['endpoints', '--name', name, '--json']);
  const rpc = endpoints.code === 0 ? jsonObject(endpoints.stdout)?.rpc : undefined;
  if (typeof rpc !== 'string' || !/^http:\/\/(127\.0\.0\.1|localhost|\[::1\]):[0-9]+\/?$/.test(rpc)) {
    throw new Error('ths rpc endpoint is unavailable');
  }
  const response = await fetchImpl(rpc, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '1.0', id: 'ssf-live-pay', method: 'getrawtransaction', params: [txid, 1] }),
  });
  if (!response.ok) throw new Error('node RPC request failed');
  const envelope = jsonObject(await response.text());
  const result = envelope?.result;
  const count = result !== null && typeof result === 'object' ? (result as Record<string, unknown>).confirmations : undefined;
  if (envelope?.error !== null || typeof count !== 'number' || !Number.isSafeInteger(count) || count < 0) {
    throw new Error('node RPC did not return a confirmation count');
  }
  return count;
}

export async function runLivePay(
  argv: readonly string[],
  deps: {
    env: Record<string, string | undefined>;
    runner?: LivePayRunner;
    fetch?: LivePayFetch;
    log?: (line: string) => void;
  },
): Promise<number> {
  const log = deps.log ?? ((line: string) => process.stdout.write(`${line}\n`));
  const runner = deps.runner ?? ((command: string, args: string[]) => run(command, args));
  const fetchImpl = deps.fetch ?? ((url: string, init?: RequestInit) => fetch(url, init));
  let args: LivePayArgs;
  let name: string;
  try {
    name = resolveOwnedEnv(deps.env);
    args = parseLivePayArgs(argv);
  } catch (error) {
    log(`live-pay: ${error instanceof Error ? error.message : 'invalid invocation'}`);
    return 2;
  }
  try {
    if (args.command === 'fund') {
      const payment = parseZip321(args.uri);
      const result = await runner('ths', ['faucet', '--name', name, '--amount', payment.amount, '--json', payment.address]);
      if (result.code !== 0) {
        log(`live-pay: faucet failed env=${name} to=${redactAddress(payment.address)}`);
        return 1;
      }
      log(`funded env=${name} to=${redactAddress(payment.address)} amount_zat=${payment.amountZat} txid=${txidFrom(result.stdout) ?? 'unknown'}`);
      return 0;
    }
    if (args.command === 'mine') {
      const result = await runner('ths', ['mine', '--name', name, String(args.blocks)]);
      if (result.code !== 0) {
        log(`live-pay: mine failed env=${name}`);
        return 1;
      }
      log(`mined=${args.blocks} env=${name}`);
      return 0;
    }
    const count = await confirmations(name, args.txid, runner, fetchImpl);
    log(`txid=${args.txid} confirmations=${count} env=${name}`);
    return 0;
  } catch (error) {
    log(`live-pay: ${args.command} failed: ${error instanceof Error ? error.message : 'unknown error'}`);
    return 1;
  }
}

/** Reads only THS_ENV_NAME from live.env; no other value is loaded or printed. */
function ownedEnvFromLiveEnv(file: string, processEnv: NodeJS.ProcessEnv): Record<string, string | undefined> {
  let fromFile: string | undefined;
  try {
    const line = readFileSync(file, 'utf8').split('\n').find((item) => item.startsWith('THS_ENV_NAME='));
    fromFile = line?.slice('THS_ENV_NAME='.length).trim().replace(/^['"]|['"]$/g, '');
  } catch {
    fromFile = undefined;
  }
  const fromProcess = processEnv.THS_ENV_NAME;
  if (fromFile !== undefined && fromProcess !== undefined && fromProcess !== fromFile) {
    return { THS_ENV_NAME: `mismatch:${fromProcess}` };
  }
  return { THS_ENV_NAME: fromFile ?? fromProcess };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const env = ownedEnvFromLiveEnv(path.join(root, '.runtime/live/live.env'), process.env);
  runLivePay(process.argv.slice(2), { env }).then((code) => {
    process.exitCode = code;
  }, () => {
    process.stdout.write('live-pay: unexpected failure\n');
    process.exitCode = 1;
  });
}

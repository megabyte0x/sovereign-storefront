import { expect, test } from 'vitest';
import {
  OWNED_THS_ENV,
  REFUSED_THS_ENVS,
  parseLivePayArgs,
  parseZip321,
  redactAddress,
  resolveOwnedEnv,
  runLivePay,
  type LivePayRunner,
} from '../../scripts/live-pay.ts';

const ADDRESS = `uregtest1${'q'.repeat(40)}xyzTAIL`.toLowerCase().replace('xyztail', 'tar9ma7ker');
const URI = `zcash:${ADDRESS}?amount=0.0123`;
const TXID = 'ab'.repeat(32);

type Call = { command: string; args: string[] };

function fakeRunner(outputs: Record<string, { code: number; stdout: string }> = {}): {
  runner: LivePayRunner;
  calls: Call[];
} {
  const calls: Call[] = [];
  const runner: LivePayRunner = async (command, args) => {
    calls.push({ command, args });
    const sub = args[0] ?? '';
    const out = outputs[sub] ?? { code: 0, stdout: '' };
    return { code: out.code, stdout: out.stdout, stderr: `stderr mentions ${ADDRESS}` };
  };
  return { runner, calls };
}

function capture(): { log: (line: string) => void; lines: string[] } {
  const lines: string[] = [];
  return { log: (line) => lines.push(line), lines };
}

test('owned env is ssf-live and ssf-task1 is refused', () => {
  expect(OWNED_THS_ENV).toBe('ssf-live');
  expect(REFUSED_THS_ENVS).toEqual(expect.arrayContaining(['ssf-task1', 'ssf-task3-live', 'default', 'p-happy']));
});

test('resolveOwnedEnv refuses every non-owned env name, including a missing one', () => {
  expect(resolveOwnedEnv({ THS_ENV_NAME: 'ssf-live' })).toBe('ssf-live');
  for (const name of ['ssf-task1', 'ssf-task3-live', 'default', 'p-happy', 'ssf-live2', 'SSF-LIVE', ' ssf-live']) {
    expect(() => resolveOwnedEnv({ THS_ENV_NAME: name })).toThrow(/refus/i);
  }
  expect(() => resolveOwnedEnv({})).toThrow(/THS_ENV_NAME/);
});

test('parseZip321 parses the address and amount exactly', () => {
  expect(parseZip321(URI)).toEqual({ address: ADDRESS, amount: '0.0123', amountZat: 1_230_000n });
  expect(parseZip321(`zcash:${ADDRESS}?amount=1`)).toEqual({ address: ADDRESS, amount: '1', amountZat: 100_000_000n });
  expect(parseZip321(`zcash:${ADDRESS}?amount=0.00000001`).amountZat).toBe(1n);
  expect(parseZip321(`zcash:${ADDRESS}?amount=5`).amountZat).toBe(500_000_000n);
});

test('parseZip321 rejects malformed, ambiguous or unfundable URIs', () => {
  const bad = [
    ADDRESS,
    `bitcoin:${ADDRESS}?amount=1`,
    `zcash:${ADDRESS}`,
    `zcash:${ADDRESS}?amount=1&amount=1`,
    `zcash:${ADDRESS}?amount=1&memo=aGk`,
    `zcash:${ADDRESS}?amount=0`,
    `zcash:${ADDRESS}?amount=-1`,
    `zcash:${ADDRESS}?amount=1e-3`,
    `zcash:${ADDRESS}?amount=.5`,
    `zcash:${ADDRESS}?amount=0.000000001`,
    `zcash:${ADDRESS}?amount=5.00000001`,
    `zcash:${ADDRESS}?amount=1#frag`,
    `zcash:u1${'q'.repeat(40)}?amount=1`,
    `zcash:utest1${'q'.repeat(40)}?amount=1`,
    `zcash:uregtest1BAD?amount=1`,
    `zcash:?amount=1`,
  ];
  for (const uri of bad) expect(() => parseZip321(uri), uri).toThrow();
});

test('redactAddress keeps only a short prefix', () => {
  const red = redactAddress(ADDRESS);
  expect(red.startsWith('uregtest1')).toBe(true);
  expect(red.length).toBeLessThan(20);
  expect(red).not.toContain('tar9ma7ker');
});

test('parseLivePayArgs accepts the three commands and nothing else', () => {
  expect(parseLivePayArgs(['fund', '--uri', URI])).toEqual({ command: 'fund', uri: URI });
  expect(parseLivePayArgs(['mine', '--blocks', '3'])).toEqual({ command: 'mine', blocks: 3 });
  expect(parseLivePayArgs(['confirmations', '--txid', TXID])).toEqual({ command: 'confirmations', txid: TXID });
  for (const argv of [
    [], ['fund'], ['fund', '--uri'], ['mine', '--blocks', '0'], ['mine', '--blocks', '1.5'],
    ['mine', '--blocks', '101'], ['confirmations', '--txid', 'zz'], ['stop'], ['fund', '--uri', URI, '--name', 'ssf-task1'],
  ]) {
    expect(() => parseLivePayArgs(argv), argv.join(' ')).toThrow();
  }
});

test('fund calls ths faucet on ssf-live with the exact amount and never logs the full address', async () => {
  const { runner, calls } = fakeRunner({ faucet: { code: 0, stdout: JSON.stringify({ txid: TXID, address: ADDRESS }) } });
  const { log, lines } = capture();
  const code = await runLivePay(['fund', '--uri', URI], { env: { THS_ENV_NAME: 'ssf-live' }, runner, log });
  expect(code).toBe(0);
  expect(calls).toEqual([
    { command: 'ths', args: ['faucet', '--name', 'ssf-live', '--amount', '0.0123', '--json', ADDRESS] },
  ]);
  const output = lines.join('\n');
  expect(output).not.toContain(ADDRESS);
  expect(output).not.toContain('tar9ma7ker');
  expect(output).toContain(redactAddress(ADDRESS));
  expect(output).toContain(`txid=${TXID}`);
});

test('every command refuses a non-owned env before running anything', async () => {
  for (const argv of [['fund', '--uri', URI], ['mine', '--blocks', '1'], ['confirmations', '--txid', TXID]]) {
    const { runner, calls } = fakeRunner();
    const { log, lines } = capture();
    const code = await runLivePay(argv, { env: { THS_ENV_NAME: 'ssf-task1' }, runner, log });
    expect(code).not.toBe(0);
    expect(calls).toEqual([]);
    expect(lines.join('\n')).not.toContain(ADDRESS);
  }
});

test('fund failure reports a fixed message without child output', async () => {
  const { runner } = fakeRunner({ faucet: { code: 1, stdout: `failed for ${ADDRESS}` } });
  const { log, lines } = capture();
  const code = await runLivePay(['fund', '--uri', URI], { env: { THS_ENV_NAME: 'ssf-live' }, runner, log });
  expect(code).not.toBe(0);
  expect(lines.join('\n')).not.toContain(ADDRESS);
  expect(lines.join('\n')).toMatch(/faucet failed/);
});

test('mine calls ths mine on ssf-live only', async () => {
  const { runner, calls } = fakeRunner();
  const { log, lines } = capture();
  expect(await runLivePay(['mine', '--blocks', '9'], { env: { THS_ENV_NAME: 'ssf-live' }, runner, log })).toBe(0);
  expect(calls).toEqual([{ command: 'ths', args: ['mine', '--name', 'ssf-live', '9'] }]);
  expect(lines.join('\n')).toContain('mined=9');
});

test('confirmations reads the node RPC endpoint of ssf-live and reports the count', async () => {
  const { runner, calls } = fakeRunner({
    endpoints: { code: 0, stdout: JSON.stringify({ rpc: 'http://127.0.0.1:18232', dashboard: 'http://127.0.0.1:1' }) },
  });
  const requests: { url: string; body: unknown }[] = [];
  const fetchImpl = async (url: string, init?: RequestInit): Promise<Response> => {
    requests.push({ url, body: JSON.parse(String(init?.body)) });
    return new Response(JSON.stringify({ result: { txid: TXID, confirmations: 4 }, error: null }), { status: 200 });
  };
  const { log, lines } = capture();
  const code = await runLivePay(['confirmations', '--txid', TXID], {
    env: { THS_ENV_NAME: 'ssf-live' }, runner, log, fetch: fetchImpl,
  });
  expect(code).toBe(0);
  expect(calls).toEqual([{ command: 'ths', args: ['endpoints', '--name', 'ssf-live', '--json'] }]);
  expect(requests).toHaveLength(1);
  expect(requests[0].url).toBe('http://127.0.0.1:18232');
  expect(requests[0].body).toMatchObject({ method: 'getrawtransaction', params: [TXID, 1] });
  expect(lines.join('\n')).toContain(`txid=${TXID} confirmations=4`);
});

test('confirmations fails closed when the RPC answer is not a count', async () => {
  const { runner } = fakeRunner({ endpoints: { code: 0, stdout: JSON.stringify({ rpc: 'http://127.0.0.1:18232' }) } });
  const fetchImpl = async (): Promise<Response> =>
    new Response(JSON.stringify({ result: { txid: TXID }, error: null }), { status: 200 });
  const { log } = capture();
  const code = await runLivePay(['confirmations', '--txid', TXID], {
    env: { THS_ENV_NAME: 'ssf-live' }, runner, log, fetch: fetchImpl,
  });
  expect(code).not.toBe(0);
});

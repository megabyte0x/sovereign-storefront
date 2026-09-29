import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, test } from 'vitest';
import * as walletModule from '../../scripts/public-t01-wallet.ts';
import {
  MAX_SENDS,
  parseTestnetZip321,
  redactWalletText,
  runPublicT01Wallet,
  type SenderRunner,
} from '../../scripts/public-t01-wallet.ts';
import { walletSend } from '../../scripts/public-t01-live.ts';

const RECEIVER = `utest1${'q'.repeat(100)}`;
const OTHER_RECEIVER = `utest1${'z'.repeat(100)}`;
const TXID = 'ab'.repeat(32);
const scratchRoot = process.env.TMPDIR ?? tmpdir();
let dir = '';
let ledger = '';
let tempDir = '';

const digestOf = (uri: string) => createHash('sha256').update(uri).digest('hex');

type Reply = { code: number; stdout: string };
type Call = { args: readonly string[]; uriFile?: string; uriContent?: string };
/** Per-command reply, or a queue of replies consumed in order (the last repeats). */
type Script = Partial<Record<'status' | 'pay' | 'tx-status' | 'rebroadcast', Reply | Reply[]>>;

const json = (value: unknown, code = 0): Reply => ({ code, stdout: `${JSON.stringify(value)}\n` });
const status = (spendableZat: string, extra: Record<string, unknown> = {}) =>
  json({ network: 'test', tip: 1000, spendableZat, orchardZat: '0', ironwoodZat: spendableZat, ...extra });
const funded = { status: status('10000000') };
const payOk = (digest: string, broadcast = 'accepted', code = 0) =>
  json({ attemptId: digest, txid: TXID, targetHeight: 1001, expiryHeight: 1021, broadcast }, code);
const txStatus = (digest: string, state: string, extra: Record<string, unknown> = {}) =>
  json({ attemptId: digest, txid: TXID, state, minedHeight: state === 'mined' ? 1005 : null, tip: 1010, expiryHeight: 1021, ...extra });

/** Fake `ssf-buyer-sender` speaking the frozen JSON contract; records every argv and the URI file it saw. */
function fakeSender(script: Script, calls: Call[]): SenderRunner {
  const queues = new Map<string, Reply[]>();
  return async (args) => {
    const call: Call = { args: [...args] };
    const fileAt = args.indexOf('--uri-file');
    if (fileAt >= 0) {
      call.uriFile = args[fileAt + 1];
      call.uriContent = readFileSync(call.uriFile!, 'utf8');
    }
    calls.push(call);
    const command = args[0] as keyof Script;
    const entry = script[command];
    if (entry === undefined) return json({ error: 'unexpected command' }, 1);
    if (!Array.isArray(entry)) return entry;
    if (!queues.has(command)) queues.set(command, [...entry]);
    const queue = queues.get(command)!;
    return queue.length > 1 ? queue.shift()! : queue[0]!;
  };
}

const commands = (calls: Call[], command: string) => calls.filter((call) => call.args[0] === command);
const readSends = () => JSON.parse(readFileSync(ledger, 'utf8')).sends as Array<Record<string, unknown>>;

function io() {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, write: { stdout: (s: string) => out.push(s), stderr: (s: string) => err.push(s) } };
}

beforeEach(() => {
  dir = mkdtempSync(join(scratchRoot, 'ssf-t01-wallet-'));
  ledger = join(dir, 'sends.json');
  tempDir = join(dir, 'tmp');
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const deps = (runner: SenderRunner, write: ReturnType<typeof io>['write']) => ({ runner, ledgerPath: ledger, tempDir, ...write });

test('parses a testnet invoice URI with an optional base64url memo', () => {
  expect(parseTestnetZip321(`zcash:${RECEIVER}?amount=0.001`)).toEqual({ address: RECEIVER, amountZat: 100_000n, memo: null });
  expect(parseTestnetZip321(`zcash:${RECEIVER}?amount=0.001&memo=b3JkZXItMQ`).memo).toBe('order-1');
});

test.each([
  ['regtest address', `zcash:uregtest1${'q'.repeat(100)}?amount=0.001`],
  ['mainnet address', `zcash:u1${'q'.repeat(100)}?amount=0.001`],
  ['transparent address', 'zcash:tmXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX?amount=0.001'],
  ['missing amount', `zcash:${RECEIVER}`],
  ['extra parameter', `zcash:${RECEIVER}?amount=0.001&label=x`],
  ['amount above cap', `zcash:${RECEIVER}?amount=0.02`],
  ['zero amount', `zcash:${RECEIVER}?amount=0`],
])('refuses %s', (_label, uri) => {
  expect(() => parseTestnetZip321(uri)).toThrow();
});

test('zingo exports are gone', () => {
  expect('walletBinary' in walletModule).toBe(false);
  expect('walletArgs' in walletModule).toBe(false);
  expect('walletTransport' in walletModule).toBe(false);
});

test('send refuses a bad URI without invoking the sender or echoing the URI', async () => {
  const calls: Call[] = [];
  const { err, write } = io();
  const uri = `zcash:uregtest1${'q'.repeat(80)}?amount=0.001`;
  const code = await runPublicT01Wallet(['send', '--uri', uri], deps(fakeSender({}, calls), write));
  expect(code).toBe(2);
  expect(calls).toHaveLength(0);
  expect(err.join('')).toContain('no wallet command was invoked');
  expect(err.join('')).not.toContain(uri);
});

test('send checks status, pays through a private URI file, records the txid and never puts the URI on argv', async () => {
  const calls: Call[] = [];
  const { out, err, write } = io();
  const uri = `zcash:${RECEIVER}?amount=0.001&memo=b3JkZXItMQ`;
  const digest = digestOf(uri);
  const code = await runPublicT01Wallet(['send', '--uri', uri], deps(fakeSender({ ...funded, pay: payOk(digest) }, calls), write));
  expect(code).toBe(0);
  expect(calls.map((call) => call.args[0])).toEqual(['status', 'pay']);
  const pay = commands(calls, 'pay')[0]!;
  expect(pay.args).toEqual(['pay', '--uri-file', pay.uriFile, '--attempt-id', digest]);
  expect(pay.args).not.toContain('--lightwalletd');
  // The file held the exact digested string (no trailing newline) and is gone afterwards.
  expect(pay.uriContent).toBe(uri);
  expect(digestOf(pay.uriContent!)).toBe(digest);
  expect(existsSync(pay.uriFile!)).toBe(false);
  expect(readdirSync(tempDir)).toEqual([]);
  for (const call of calls) {
    expect(call.args.join(' ')).not.toContain(RECEIVER);
    expect(call.args.join(' ')).not.toContain('zcash:');
  }
  expect(out.join('')).toContain(TXID);
  expect(out.join('') + err.join('')).not.toContain(RECEIVER);
  const sends = readSends();
  expect(sends).toHaveLength(1);
  expect(sends[0]).toMatchObject({ status: 'sent', txid: TXID, amountZat: '100000', invoiceDigest: digest, expiryHeight: 1021 });
  expect(JSON.stringify(sends)).not.toContain(RECEIVER);
  expect(statSync(ledger).mode & 0o777).toBe(0o600);
});

test('the URI file is removed even when the sender refuses', async () => {
  const calls: Call[] = [];
  const { write } = io();
  const uri = `zcash:${RECEIVER}?amount=0.001`;
  await runPublicT01Wallet(['send', '--uri', uri], deps(fakeSender({ ...funded, pay: json({ error: 'invoice refused' }, 2) }, calls), write));
  const pay = commands(calls, 'pay')[0]!;
  expect(pay.uriContent).toBe(uri);
  expect(existsSync(pay.uriFile!)).toBe(false);
});

test('insufficient balance refuses before paying', async () => {
  const calls: Call[] = [];
  const { err, write } = io();
  const code = await runPublicT01Wallet(['send', '--uri', `zcash:${RECEIVER}?amount=0.001`],
    deps(fakeSender({ status: status('100000'), pay: payOk('x') }, calls), write));
  expect(code).toBe(2);
  expect(commands(calls, 'pay')).toHaveLength(0);
  expect(err.join('')).toMatch(/balance/);
  expect(existsSync(ledger)).toBe(false);
});

test('an unavailable status refuses before paying or recording', async () => {
  const calls: Call[] = [];
  const { err, write } = io();
  const code = await runPublicT01Wallet(['send', '--uri', `zcash:${RECEIVER}?amount=0.001`],
    deps(fakeSender({ status: json({ error: 'sync failed' }, 1) }, calls), write));
  expect(code).toBe(2);
  expect(commands(calls, 'pay')).toHaveLength(0);
  expect(err.join('')).toContain('wallet status is unavailable (sync failed)');
  expect(existsSync(ledger)).toBe(false);
});

test(`a send beyond ${MAX_SENDS} purchases is refused`, async () => {
  writeFileSync(ledger, JSON.stringify({ sends: [
    { status: 'sent', txid: 'aa'.repeat(32), amountZat: '100000', invoiceDigest: '1'.repeat(64) },
    { status: 'sent', txid: 'bb'.repeat(32), amountZat: '100000', invoiceDigest: '2'.repeat(64) },
  ] }), { mode: 0o600 });
  const calls: Call[] = [];
  const { err, write } = io();
  const code = await runPublicT01Wallet(['send', '--uri', `zcash:${RECEIVER}?amount=0.001`], deps(fakeSender({ ...funded }, calls), write));
  expect(code).toBe(2);
  expect(calls).toHaveLength(0);
  expect(err.join('')).toMatch(/purchase cap/);
});

test('the same invoice is never paid twice', async () => {
  const calls: Call[] = [];
  const { write } = io();
  const uri = `zcash:${RECEIVER}?amount=0.001`;
  const runner = fakeSender({ ...funded, pay: payOk(digestOf(uri)) }, calls);
  expect(await runPublicT01Wallet(['send', '--uri', uri], deps(runner, write))).toBe(0);
  expect(await runPublicT01Wallet(['send', '--uri', uri], deps(runner, write))).toBe(2);
  expect(commands(calls, 'pay')).toHaveLength(1);
});

test('exit 2 from pay removes the pending record and reports nothing was broadcast', async () => {
  const calls: Call[] = [];
  const { err, write } = io();
  const code = await runPublicT01Wallet(['send', '--uri', `zcash:${RECEIVER}?amount=0.001`],
    deps(fakeSender({ ...funded, pay: json({ error: 'attempt id mismatch' }, 2) }, calls), write));
  expect(code).toBe(2);
  expect(readSends()).toEqual([]);
  expect(err.join('')).toContain('attempt id mismatch; nothing was broadcast');
  expect(commands(calls, 'tx-status')).toHaveLength(0);
});

test('exit 3, then tx-status mined, records the send as sent by the chain', async () => {
  const calls: Call[] = [];
  const { out, write } = io();
  const uri = `zcash:${RECEIVER}?amount=0.001`;
  const digest = digestOf(uri);
  const code = await runPublicT01Wallet(['send', '--uri', uri],
    deps(fakeSender({ ...funded, pay: payOk(digest, 'unknown', 3), 'tx-status': txStatus(digest, 'mined') }, calls), write));
  expect(code).toBe(0);
  expect(commands(calls, 'tx-status').map((call) => call.args)).toEqual([['tx-status', '--attempt-id', digest]]);
  expect(commands(calls, 'pay')).toHaveLength(1);
  expect(readSends()[0]).toMatchObject({ status: 'sent', resolvedBy: 'chain', txid: TXID, expiryHeight: 1021 });
  expect(out.join('')).toContain(TXID);
});

test('exit 3, then expired, marks the attempt expired without a manual edit and refuses to pay the same invoice again', async () => {
  const calls: Call[] = [];
  const { err, write } = io();
  const uri = `zcash:${RECEIVER}?amount=0.001`;
  const digest = digestOf(uri);
  const first = fakeSender({ ...funded, pay: payOk(digest, 'unknown', 3), 'tx-status': txStatus(digest, 'expired', { tip: 1030 }) }, calls);
  expect(await runPublicT01Wallet(['send', '--uri', uri], deps(first, write))).toBe(3);
  expect(err.join('')).toMatch(/UNRESOLVED/);
  expect(readSends()).toEqual([expect.objectContaining({ status: 'expired', resolvedBy: 'chain', invoiceDigest: digest })]);
  expect(commands(calls, 'rebroadcast')).toHaveLength(0);

  // The sender keeps the attempt file forever: a re-send could only report the old
  // attempt. Refuse before invoking anything and ask for a new invoice.
  const later: Call[] = [];
  const again = io();
  const second = fakeSender({ ...funded, pay: payOk(digest) }, later);
  expect(await runPublicT01Wallet(['send', '--uri', uri], deps(second, again.write))).toBe(2);
  expect(again.err.join('')).toMatch(/request a new invoice/);
  expect(commands(later, 'pay')).toHaveLength(0);
  expect(later).toHaveLength(0);
  expect(readSends().map((send) => send.status)).toEqual(['expired']);
});

test.each(['sent', 'expired'])('send refuses an invoice whose digest already has a %s record, without calling pay', async (state) => {
  const uri = `zcash:${RECEIVER}?amount=0.001`;
  const digest = digestOf(uri);
  writeFileSync(ledger, JSON.stringify({ sends: [
    { status: state, invoiceDigest: digest, amountZat: '100000', ...(state === 'sent' ? { txid: TXID } : {}) },
  ] }), { mode: 0o600 });
  const calls: Call[] = [];
  const { err, write } = io();
  expect(await runPublicT01Wallet(['send', '--uri', uri], deps(fakeSender({ ...funded, pay: payOk(digest) }, calls), write))).toBe(2);
  expect(err.join('')).toMatch(/request a new invoice/);
  expect(commands(calls, 'pay')).toHaveLength(0);
  expect(readSends()).toHaveLength(1);
});

test('send refuses an invoice whose digest has a pending record that stays unresolved, without calling pay', async () => {
  const uri = `zcash:${RECEIVER}?amount=0.001`;
  const digest = digestOf(uri);
  writeFileSync(ledger, JSON.stringify({ sends: [{ status: 'pending', invoiceDigest: digest, amountZat: '100000', txid: TXID }] }), { mode: 0o600 });
  const calls: Call[] = [];
  const { write } = io();
  const runner = fakeSender({ ...funded, pay: payOk(digest), 'tx-status': txStatus(digest, 'mempool') }, calls);
  expect(await runPublicT01Wallet(['send', '--uri', uri], deps(runner, write))).toBe(2);
  expect(commands(calls, 'pay')).toHaveLength(0);
  expect(readSends()).toEqual([expect.objectContaining({ status: 'pending', txid: TXID })]);
});

test('not_found before expiry rebroadcasts once with the same attempt id, stays pending and refuses a new send', async () => {
  const calls: Call[] = [];
  const { err, write } = io();
  const uri = `zcash:${RECEIVER}?amount=0.001`;
  const digest = digestOf(uri);
  const runner = fakeSender({
    ...funded,
    pay: payOk(digest, 'unknown', 3),
    'tx-status': txStatus(digest, 'not_found'),
    rebroadcast: payOk(digest, 'accepted'),
  }, calls);
  expect(await runPublicT01Wallet(['send', '--uri', uri], deps(runner, write))).toBe(3);
  expect(commands(calls, 'rebroadcast').map((call) => call.args)).toEqual([['rebroadcast', '--attempt-id', digest]]);
  expect(readSends()).toEqual([expect.objectContaining({ status: 'pending', txid: TXID, invoiceDigest: digest })]);

  const other = `zcash:${OTHER_RECEIVER}?amount=0.001`;
  const before = commands(calls, 'pay').length;
  expect(await runPublicT01Wallet(['send', '--uri', other], deps(runner, write))).toBe(2);
  expect(err.join('')).toMatch(/unresolved/);
  expect(commands(calls, 'pay')).toHaveLength(before);
  expect(before).toBe(1);
});

test('exit 4 (attempt already exists) is resolved like exit 3 and never pays a second time', async () => {
  const calls: Call[] = [];
  const { write } = io();
  const uri = `zcash:${RECEIVER}?amount=0.001`;
  const digest = digestOf(uri);
  const code = await runPublicT01Wallet(['send', '--uri', uri],
    deps(fakeSender({ ...funded, pay: payOk(digest, 'unknown', 4), 'tx-status': txStatus(digest, 'mined') }, calls), write));
  expect(code).toBe(0);
  expect(commands(calls, 'pay')).toHaveLength(1);
  expect(commands(calls, 'tx-status')).toHaveLength(1);
  expect(readSends()[0]).toMatchObject({ status: 'sent', resolvedBy: 'chain', txid: TXID });
});

test('an exit 4 that stays in the mempool keeps the record pending and blocks any replay', async () => {
  const calls: Call[] = [];
  const { write } = io();
  const uri = `zcash:${RECEIVER}?amount=0.001`;
  const digest = digestOf(uri);
  const runner = fakeSender({ ...funded, pay: payOk(digest, 'unknown', 4), 'tx-status': txStatus(digest, 'mempool') }, calls);
  expect(await runPublicT01Wallet(['send', '--uri', uri], deps(runner, write))).toBe(3);
  // The exit-4 attempt shape recorded the txid and expiry height before resolving.
  expect(readSends()).toEqual([expect.objectContaining({ status: 'pending', txid: TXID, expiryHeight: 1021 })]);
  expect(await runPublicT01Wallet(['send', '--uri', uri], deps(runner, write))).toBe(2);
  expect(commands(calls, 'pay')).toHaveLength(1);
  expect(readSends()).toEqual([expect.objectContaining({ status: 'pending' })]);
});

test('tx-status exit 3 (unreadable attempt or chain unreachable) keeps the record pending, never removes it', async () => {
  const digest = '5'.repeat(64);
  writeFileSync(ledger, JSON.stringify({ sends: [{ status: 'pending', invoiceDigest: digest, amountZat: '100000' }] }), { mode: 0o600 });
  for (const error of ['attempt file is unreadable', 'lightwalletd is unreachable']) {
    const calls: Call[] = [];
    const { out, write } = io();
    expect(await runPublicT01Wallet(['resolve'], deps(fakeSender({ 'tx-status': json({ error }, 3), rebroadcast: payOk(digest) }, calls), write))).toBe(0);
    expect(JSON.parse(out.join(''))).toEqual({ sent: 0, expired: 0, removed: 0, pending: 1, rebroadcast: 0 });
    expect(commands(calls, 'rebroadcast')).toHaveLength(0);
    expect(readSends()).toEqual([expect.objectContaining({ status: 'pending', invoiceDigest: digest })]);
    expect(readSends()[0]).not.toHaveProperty('txid');
  }
});

test('tx-status output for a different attempt id is not adopted and leaves the record pending', async () => {
  const digest = '6'.repeat(64);
  writeFileSync(ledger, JSON.stringify({ sends: [{ status: 'pending', invoiceDigest: digest, amountZat: '100000' }] }), { mode: 0o600 });
  for (const reply of [txStatus('7'.repeat(64), 'mined'), txStatus('7'.repeat(64), 'expired'), json({ txid: TXID, state: 'mined', expiryHeight: 1021 })]) {
    const calls: Call[] = [];
    const { out, write } = io();
    expect(await runPublicT01Wallet(['resolve'], deps(fakeSender({ 'tx-status': reply }, calls), write))).toBe(0);
    expect(JSON.parse(out.join(''))).toMatchObject({ sent: 0, expired: 0, pending: 1 });
    const [record] = readSends();
    expect(record).toMatchObject({ status: 'pending', invoiceDigest: digest });
    expect(record).not.toHaveProperty('txid');
    expect(record).not.toHaveProperty('expiryHeight');
  }
});

test('pay output for a different attempt id records no txid and resolves to pending', async () => {
  const calls: Call[] = [];
  const { write } = io();
  const uri = `zcash:${RECEIVER}?amount=0.001`;
  const digest = digestOf(uri);
  const wrong = '8'.repeat(64);
  const code = await runPublicT01Wallet(['send', '--uri', uri],
    deps(fakeSender({ ...funded, pay: payOk(wrong, 'accepted', 0), 'tx-status': txStatus(wrong, 'mined') }, calls), write));
  expect(code).toBe(3);
  const [record] = readSends();
  expect(record).toMatchObject({ status: 'pending', invoiceDigest: digest });
  expect(record).not.toHaveProperty('txid');
});

test('a legacy pending record without a txid is removed when the sender has no attempt recorded', async () => {
  const legacyDigest = '3'.repeat(64);
  writeFileSync(ledger, JSON.stringify({ sends: [{ status: 'pending', invoiceDigest: legacyDigest, amountZat: '100000' }] }), { mode: 0o600 });
  const calls: Call[] = [];
  const { out, write } = io();
  const code = await runPublicT01Wallet(['resolve'], deps(fakeSender({ 'tx-status': json({ error: 'no attempt recorded' }, 2) }, calls), write));
  expect(code).toBe(0);
  expect(calls.map((call) => call.args)).toEqual([['tx-status', '--attempt-id', legacyDigest]]);
  expect(readSends()).toEqual([]);
  expect(JSON.parse(out.join(''))).toEqual({ sent: 0, expired: 0, removed: 1, pending: 0, rebroadcast: 0 });
});

test('a pending record with a txid is kept when the sender has no attempt recorded', async () => {
  writeFileSync(ledger, JSON.stringify({ sends: [{ status: 'pending', invoiceDigest: '4'.repeat(64), amountZat: '100000', txid: TXID }] }), { mode: 0o600 });
  const calls: Call[] = [];
  const { write } = io();
  expect(await runPublicT01Wallet(['resolve'], deps(fakeSender({ 'tx-status': json({ error: 'no attempt recorded' }, 2) }, calls), write))).toBe(0);
  expect(readSends()).toEqual([expect.objectContaining({ status: 'pending', txid: TXID })]);
});

test('an expired (never-mined) attempt does not block other invoices or count toward the cap', async () => {
  const uri = `zcash:${RECEIVER}?amount=0.001`;
  const digest = digestOf(uri);
  // The expired attempt is for an earlier invoice (the same digest is refused; see above).
  writeFileSync(ledger, JSON.stringify({ sends: [
    { status: 'expired', invoiceDigest: digestOf(`zcash:${OTHER_RECEIVER}?amount=0.001`), amountZat: '100000', failedAtHeight: 4411154 },
    { status: 'sent', invoiceDigest: 'x'.repeat(64), amountZat: '100000', txid: TXID },
  ] }), { mode: 0o600 });
  const calls: Call[] = [];
  const { write } = io();
  expect(await runPublicT01Wallet(['send', '--uri', uri], deps(fakeSender({ ...funded, pay: payOk(digest) }, calls), write))).toBe(0);
  expect(commands(calls, 'pay')).toHaveLength(1);
  expect(readSends().map((s) => s.status)).toEqual(['expired', 'sent', 'sent']);
  // Cap now reached by two live sends; a third invoice is refused.
  const third = `zcash:${RECEIVER}?amount=0.002`;
  expect(await runPublicT01Wallet(['send', '--uri', third], deps(fakeSender({ ...funded, pay: payOk(digestOf(third)) }, calls), write))).toBe(2);
  expect(commands(calls, 'pay')).toHaveLength(1);
});

test('wallet diagnostics redact receivers and keys but keep txids and error prose', () => {
  const text = `send to ${RECEIVER} failed: transport error; txid ${TXID}; key uviewtest1${'a'.repeat(200)}`;
  const red = redactWalletText(text);
  expect(red).not.toContain(RECEIVER);
  expect(red).not.toContain('uviewtest1');
  expect(red).toContain(TXID);
  expect(red).toContain('transport error');
});

test('status reports pool balances, tip and the send ledger without secrets', async () => {
  const calls: Call[] = [];
  const { out, write } = io();
  const runner = fakeSender({ status: json({ network: 'test', tip: 1234, spendableZat: '10000000', orchardZat: '2000000', ironwoodZat: '8000000' }) }, calls);
  const code = await runPublicT01Wallet(['status'], deps(runner, write));
  expect(code).toBe(0);
  expect(calls.map((call) => call.args)).toEqual([['status']]);
  expect(JSON.parse(out.join(''))).toEqual({
    network: 'test', tip: 1234, spendableZat: '10000000', orchardZat: '2000000', ironwoodZat: '8000000',
    sends: 0, pending: 0, remaining: MAX_SENDS,
  });
});

test('a malformed sender status is refused', async () => {
  const { err, write } = io();
  const runner = fakeSender({ status: json({ network: 'main', tip: 1, spendableZat: '1', orchardZat: '0', ironwoodZat: '1' }) }, []);
  expect(await runPublicT01Wallet(['status'], deps(runner, write))).toBe(2);
  expect(err.join('')).toContain('wallet status is malformed');
});

test('unknown commands are refused without invoking the sender', async () => {
  const calls: Call[] = [];
  const { err, write } = io();
  expect(await runPublicT01Wallet(['shield'], deps(fakeSender({}, calls), write))).toBe(2);
  expect(calls).toHaveLength(0);
  expect(err.join('')).toContain('no wallet command was invoked');
});

// walletSend (scripts/public-t01-live.ts): polls `resolve` after an unknown outcome.
type Run = typeof runPublicT01Wallet;

function ledgerRun(uri: string, resolveTo: (poll: number) => 'pending' | 'sent' | 'expired'): { run: Run; argv: string[][] } {
  const argv: string[][] = [];
  let polls = 0;
  const run: Run = async (args) => {
    argv.push([...args]);
    if (args[0] === 'send') {
      writeFileSync(ledger, JSON.stringify({ sends: [{ status: 'pending', invoiceDigest: digestOf(uri), amountZat: '100000' }] }));
      return 3;
    }
    polls += 1;
    const state = resolveTo(polls);
    writeFileSync(ledger, JSON.stringify({ sends: [{ status: state, invoiceDigest: digestOf(uri), amountZat: '100000', ...(state === 'sent' ? { txid: TXID } : {}) }] }));
    return 0;
  };
  return { run, argv };
}

test('walletSend resolves an unknown outcome to sent on the second poll', async () => {
  const uri = `zcash:${RECEIVER}?amount=0.001`;
  const { run, argv } = ledgerRun(uri, (poll) => (poll >= 2 ? 'sent' : 'pending'));
  const sleeps: number[] = [];
  const result = await walletSend(uri, { run, ledgerPath: ledger, pollIntervalMs: 1, pollBudgetMs: 10, sleep: async (ms) => { sleeps.push(ms); } });
  expect(result).toEqual({ kind: 'sent', txid: TXID });
  expect(argv).toEqual([['send', '--uri', uri], ['resolve'], ['resolve']]);
  expect(sleeps).toEqual([1, 1]);
});

test('walletSend reports ambiguous when the send stays pending for the whole budget, and never sends again', async () => {
  const uri = `zcash:${RECEIVER}?amount=0.001`;
  const { run, argv } = ledgerRun(uri, () => 'pending');
  const result = await walletSend(uri, { run, ledgerPath: ledger, pollIntervalMs: 1, pollBudgetMs: 5, sleep: async () => undefined });
  expect(result).toEqual({ kind: 'ambiguous' });
  expect(argv.filter((args) => args[0] === 'send')).toHaveLength(1);
  expect(argv.filter((args) => args[0] === 'resolve')).toHaveLength(5);
});

test('walletSend with a zero poll interval does not poll and reports ambiguous', async () => {
  const uri = `zcash:${RECEIVER}?amount=0.001`;
  const { run, argv } = ledgerRun(uri, () => 'sent');
  const result = await walletSend(uri, { run, ledgerPath: ledger, pollIntervalMs: 0, pollBudgetMs: 10, sleep: async () => undefined });
  expect(result).toEqual({ kind: 'ambiguous' });
  expect(argv).toEqual([['send', '--uri', uri]]);
});

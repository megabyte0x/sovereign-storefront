// R4.4: the scanner allocation `expiresAt` is Unix SECONDS on the wire (an
// opaque u64 in services/scanner/src/allocate.rs, same unit as the scanner's
// `checkedAt`/`firstSeenAt`). Seller invoices use milliseconds. The live
// adapter boundary converts once and rejects unit mismatches.
import { createServer } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { createLiveReceiptSource } from '../../src/adapters/live.ts';
import { WalletScannerUnavailableError } from '../../src/adapters/wallet-scanner.ts';
import { fixtureAllocation } from '../support/live-fixtures.ts';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { await Promise.all(cleanup.splice(0).map((close) => close())); });

type Echo = (request: Record<string, unknown>) => unknown;

async function scanner(reply: Echo): Promise<{ path: string; seen: Array<Record<string, unknown>> }> {
  const directory = await mkdtemp(join(process.env.TMPDIR ?? '/tmp', 'ssf-expires-'));
  const path = join(directory, 's.sock');
  const seen: Array<Record<string, unknown>> = [];
  const server = createServer((socket) => {
    let raw = '';
    socket.on('data', (chunk) => { raw += chunk.toString('utf8'); });
    socket.on('end', () => {
      const request = JSON.parse(raw.slice(raw.indexOf('\r\n\r\n') + 4)) as Record<string, unknown>;
      seen.push(request);
      const body = JSON.stringify(reply(request));
      socket.end(`HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
    });
  });
  await new Promise<void>((resolve, reject) => server.listen(path, resolve).once('error', reject));
  cleanup.push(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  });
  return { path, seen };
}

const base = fixtureAllocation();
const allocationFor = (expiresAt: unknown) => ({
  ...base, expiresAt, paymentUri: `zcash:${base.destination}?amount=1`,
});
const source = (path: string) => createLiveReceiptSource({ scannerSocket: path, chain: base.chain, scannerAccountId: base.accountId });
const request = (expiresAt: number) => ({
  allocationId: base.allocationId, chain: base.chain, accountId: base.accountId, amountZat: base.amountZat, expiresAt,
});

// A realistic invoice expiry: Date.now()-style ms, deliberately not a whole second.
const EXPIRES_MS = 1_790_000_000_123;
const EXPIRES_S = Math.ceil(EXPIRES_MS / 1000);

test('invoice expiresAt (ms) is sent to the scanner in Unix seconds and round-trips unchanged', async () => {
  const { path, seen } = await scanner((body) => allocationFor(body.expiresAt));
  const allocation = await source(path).allocateReceiver(request(EXPIRES_MS));
  expect(seen[0]?.expiresAt).toBe(EXPIRES_S);
  expect(allocation.expiresAt).toBe(EXPIRES_MS);
});

test('the seconds conversion rounds up so the scanner never expires an allocation early', async () => {
  const { path, seen } = await scanner((body) => allocationFor(body.expiresAt));
  await source(path).allocateReceiver(request(1_790_000_000_000));
  await source(path).allocateReceiver(request(1_790_000_000_001));
  expect(seen.map((body) => body.expiresAt)).toEqual([1_790_000_000, 1_790_000_001]);
});

test('a scanner that answers in milliseconds is rejected at the boundary, not silently accepted', async () => {
  const { path } = await scanner(() => allocationFor(EXPIRES_MS));
  await expect(source(path).allocateReceiver(request(EXPIRES_MS))).rejects.toThrow(/allocation terms mismatch|expiresAt/);
});

test('a scanner that answers with a different seconds value is rejected', async () => {
  const { path } = await scanner((body) => allocationFor((body.expiresAt as number) + 1));
  await expect(source(path).allocateReceiver(request(EXPIRES_MS))).rejects.toThrow(/allocation terms mismatch|expiresAt/);
});

test('a seconds-valued (or non-integer) invoice expiresAt is rejected before any scanner I/O', async () => {
  const { path, seen } = await scanner((body) => allocationFor(body.expiresAt));
  for (const bad of [EXPIRES_S, 2_000_000, 0, -1, EXPIRES_MS + 0.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1]) {
    const error = await source(path).allocateReceiver(request(bad)).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(TypeError);
    expect(error).not.toBeInstanceOf(WalletScannerUnavailableError);
    expect(String(error)).toMatch(/expiresAt/);
  }
  expect(seen).toEqual([]);
});

import { createServer } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { createWalletScanner, WalletScannerUnavailableError } from '../../src/adapters/wallet-scanner.ts';
import { fixtureAllocation, fixtureSnapshot } from '../support/live-fixtures.ts';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { await Promise.all(cleanup.splice(0).map((close) => close())); });

type SocketReply = { status: number; body?: unknown; holdOpen?: boolean };

async function socketServer(respond: (request: string) => SocketReply): Promise<string> {
  const directory = await mkdtemp(join(process.env.TMPDIR ?? '/tmp', 'ssf-wallet-scanner-'));
  const path = join(directory, 'scanner.sock');
  const server = createServer((socket) => {
    let request = '';
    socket.on('data', (chunk) => { request += chunk.toString('utf8'); });
    socket.on('end', () => {
      const reply = respond(request);
      if (reply.holdOpen) return;
      const body = JSON.stringify(reply.body ?? { error: 'unavailable' });
      socket.end(`HTTP/1.1 ${reply.status} test\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
    });
  });
  await new Promise<void>((resolve, reject) => server.listen(path, resolve).once('error', reject));
  cleanup.push(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  });
  return path;
}

function zip321AmountString(amountZat: string): string {
  const total = BigInt(amountZat);
  const coins = total / 100_000_000n;
  const zats = total % 100_000_000n;
  if (zats === 0n) return coins.toString();
  return `${coins.toString()}.${zats.toString().padStart(8, '0').replace(/0+$/, '')}`;
}

function validAllocation() {
  const allocation = fixtureAllocation();
  return {
    ...allocation,
    paymentUri: `zcash:${allocation.destination}?amount=${zip321AmountString(allocation.amountZat)}`,
  };
}

test('validated adapter speaks framed HTTP and pins source chain and account', async () => {
  const allocation = validAllocation();
  const snapshot = fixtureSnapshot();
  const path = await socketServer((request) => ({
    status: 200,
    body: request.startsWith('GET /v1/snapshot') ? snapshot : allocation,
  }));
  const source = createWalletScanner({ socketPath: path, expectedChain: snapshot.chain, accountId: snapshot.accountId });

  await expect(source.snapshot()).resolves.toEqual(snapshot);
  await expect(source.allocateReceiver({
    allocationId: allocation.allocationId, chain: allocation.chain, accountId: allocation.accountId,
    amountZat: allocation.amountZat, expiresAt: allocation.expiresAt,
  })).resolves.toEqual(allocation);
  await source.close();
});

test('adapter rejects malformed, unknown, unavailable, and timed out HTTP responses as unavailable', async () => {
  const snapshot = fixtureSnapshot();
  for (const reply of [
    { status: 503, body: { error: 'unavailable' } },
    { status: 404, body: { error: 'not_found' } },
    { status: 200, body: { not: 'a snapshot' } },
    { status: 200, holdOpen: true },
  ]) {
    const path = await socketServer(() => reply);
    const source = createWalletScanner({ socketPath: path, expectedChain: snapshot.chain, accountId: snapshot.accountId });
    await expect(source.snapshot()).rejects.toBeInstanceOf(WalletScannerUnavailableError);
  }
});

test('adapter accepts a fractional-coin ZIP-321 amount and rejects the raw zatoshi literal', async () => {
  const snapshot = fixtureSnapshot();
  const request = { ...validAllocation(), amountZat: '123456789' };
  const correct = await (async () => {
    const path = await socketServer(() => ({ status: 200, body: { ...request, paymentUri: `zcash:${request.destination}?amount=1.23456789` } }));
    return createWalletScanner({ socketPath: path, expectedChain: snapshot.chain, accountId: snapshot.accountId });
  })();
  await expect(correct.allocateReceiver({
    allocationId: request.allocationId, chain: request.chain, accountId: request.accountId,
    amountZat: request.amountZat, expiresAt: request.expiresAt,
  })).resolves.toMatchObject({ paymentUri: `zcash:${request.destination}?amount=1.23456789` });

  const rawZatUri = await (async () => {
    const path = await socketServer(() => ({ status: 200, body: { ...request, paymentUri: `zcash:${request.destination}?amount=${request.amountZat}` } }));
    return createWalletScanner({ socketPath: path, expectedChain: snapshot.chain, accountId: snapshot.accountId });
  })();
  await expect(rawZatUri.allocateReceiver({
    allocationId: request.allocationId, chain: request.chain, accountId: request.accountId,
    amountZat: request.amountZat, expiresAt: request.expiresAt,
  })).rejects.toThrow(/amount/i);
});

test('adapter independently rejects payment URI amount and destination mismatch', async () => {
  const snapshot = fixtureSnapshot();
  const request = validAllocation();
  for (const allocation of [
    { ...request, paymentUri: `zcash:${request.destination}?amount=2` },
    { ...request, paymentUri: `zcash:other-destination?amount=${request.amountZat}` },
  ]) {
    const path = await socketServer(() => ({ status: 200, body: allocation }));
    const source = createWalletScanner({ socketPath: path, expectedChain: snapshot.chain, accountId: snapshot.accountId });
    await expect(source.allocateReceiver({
      allocationId: request.allocationId, chain: request.chain, accountId: request.accountId,
      amountZat: request.amountZat, expiresAt: request.expiresAt,
    })).rejects.toThrow(/payment URI/i);
  }
});

test('adapter refuses response identity drift and reports missing socket as typed unavailable', async () => {
  const snapshot = fixtureSnapshot();
  const drifted = fixtureSnapshot({
    accountId: 'other-account',
    receipts: fixtureSnapshot().receipts.map((receipt) => ({ ...receipt, accountId: 'other-account' })),
  });
  const driftPath = await socketServer(() => ({ status: 200, body: drifted }));
  const drift = createWalletScanner({ socketPath: driftPath, expectedChain: snapshot.chain, accountId: snapshot.accountId });
  await expect(drift.snapshot()).rejects.toThrow(/account/);

  const missing = createWalletScanner({ socketPath: join('/definitely-missing', 'scanner.sock'), expectedChain: snapshot.chain, accountId: snapshot.accountId });
  await expect(missing.snapshot()).rejects.toBeInstanceOf(WalletScannerUnavailableError);
});

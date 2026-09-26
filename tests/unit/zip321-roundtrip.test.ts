import { createServer } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { createWalletScanner } from '../../src/adapters/wallet-scanner.ts';
import { fixtureAllocation, fixtureSnapshot } from '../support/live-fixtures.ts';

// Cross-language vector produced by the scanner's `zip321_payment_uri` and
// round-tripped through the `zip321` crate parser in
// services/scanner/src/wallet.rs (`zip321_payment_uri_round_trips_through_the_zip321_parser_exactly`).
// Not a secret: regtest Orchard default address of the all-0x5a public test seed.
const VECTOR_DESTINATION = 'uregtest1swq6jh60987eysqul5q97nklr60h30yyf0yu44f2pa0glwffk2r562vanhmfa867vtrk36yj0tw20ex4fn390tuu25m6ptst3c4dey2e';
const VECTOR_AMOUNT_ZAT = '100000';
const VECTOR_URI = `zcash:${VECTOR_DESTINATION}?amount=0.001`;

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { await Promise.all(cleanup.splice(0).map((close) => close())); });

async function scannerReturning(body: unknown): Promise<string> {
  const directory = await mkdtemp(join(process.env.TMPDIR ?? '/tmp', 'ssf-zip321-'));
  const path = join(directory, 'scanner.sock');
  const server = createServer((socket) => {
    socket.on('data', () => undefined);
    socket.on('end', () => {
      const payload = JSON.stringify(body);
      socket.end(`HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(payload)}\r\n\r\n${payload}`);
    });
  });
  await new Promise<void>((resolve, reject) => server.listen(path, resolve).once('error', reject));
  cleanup.push(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  });
  return path;
}

async function allocateWith(paymentUri: string) {
  const snapshot = fixtureSnapshot();
  const allocation = fixtureAllocation({ amountZat: VECTOR_AMOUNT_ZAT, destination: VECTOR_DESTINATION, paymentUri });
  const source = createWalletScanner({
    socketPath: await scannerReturning(allocation),
    expectedChain: snapshot.chain,
    accountId: snapshot.accountId,
  });
  return source.allocateReceiver({
    allocationId: allocation.allocationId, chain: allocation.chain, accountId: allocation.accountId,
    amountZat: allocation.amountZat, expiresAt: allocation.expiresAt,
  });
}

test('validatePaymentUri accepts the exact scanner/zip321 cross-language vector', async () => {
  await expect(allocateWith(VECTOR_URI)).resolves.toMatchObject({
    paymentUri: VECTOR_URI, destination: VECTOR_DESTINATION, amountZat: VECTOR_AMOUNT_ZAT,
  });
});

test('validatePaymentUri rejects an amount mismatch against the vector', async () => {
  for (const amount of ['0.01', '0.0010', '100000', '0.00100001']) {
    await expect(allocateWith(`zcash:${VECTOR_DESTINATION}?amount=${amount}`)).rejects.toThrow(/amount mismatch/);
  }
});

test('validatePaymentUri rejects an address mismatch against the vector', async () => {
  const flipped = `${VECTOR_DESTINATION.slice(0, -1)}${VECTOR_DESTINATION.endsWith('e') ? 'f' : 'e'}`;
  for (const destination of [flipped, VECTOR_DESTINATION.toUpperCase(), `${VECTOR_DESTINATION}x`]) {
    await expect(allocateWith(`zcash:${destination}?amount=0.001`)).rejects.toThrow(/destination mismatch/);
  }
});

test('validatePaymentUri rejects any extra ZIP-321 parameter on the vector', async () => {
  for (const extra of ['memo=AA', 'label=x', 'message=x', 'req-foo=1', 'amount=0.001', 'address.1=x']) {
    await expect(allocateWith(`${VECTOR_URI}&${extra}`)).rejects.toThrow(/amount mismatch/);
  }
});

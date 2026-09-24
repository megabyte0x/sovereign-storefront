import { createConnection } from 'node:net';
import type { AllocateReceiver, ChainIdentity, ReceiptSource, ReceiverAllocation, ScanSnapshot } from '../contracts/live.ts';
import { sameChainIdentity, validateAllocation, validateSnapshot } from '../contracts/live-validation.ts';

const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 5_000;

export class WalletScannerUnavailableError extends Error {
  constructor() { super('wallet scanner is unavailable'); this.name = 'WalletScannerUnavailableError'; }
}

function parseHttpResponse(bytes: Buffer): unknown {
  const marker = bytes.indexOf('\r\n\r\n');
  if (marker < 0) throw new WalletScannerUnavailableError();
  const lines = bytes.subarray(0, marker).toString('ascii').split('\r\n');
  const status = /^HTTP\/1\.1 ([1-5][0-9]{2}) [^\r\n]+$/.exec(lines[0] ?? '');
  if (!status) throw new WalletScannerUnavailableError();
  const headers = new Map<string, string>();
  for (const line of lines.slice(1)) {
    const separator = line.indexOf(':');
    if (separator <= 0) throw new WalletScannerUnavailableError();
    const name = line.slice(0, separator).toLowerCase();
    const value = line.slice(separator + 1).trim();
    if (headers.has(name)) throw new WalletScannerUnavailableError();
    headers.set(name, value);
  }
  if (headers.get('content-type') !== 'application/json') throw new WalletScannerUnavailableError();
  const length = headers.get('content-length');
  if (!length || !/^(0|[1-9][0-9]*)$/.test(length)) throw new WalletScannerUnavailableError();
  const body = bytes.subarray(marker + 4);
  if (body.length !== Number(length) || Number(length) > MAX_RESPONSE_BYTES) throw new WalletScannerUnavailableError();
  if (Number(status[1]) < 200 || Number(status[1]) >= 300) throw new WalletScannerUnavailableError();
  try { return JSON.parse(body.toString('utf8')); } catch { throw new WalletScannerUnavailableError(); }
}

const ZAT_PER_COIN = 100_000_000n;

/**
 * Canonical ZIP-321 decimal-ZEC rendering of a zatoshi amount, matching the
 * `zip321` Rust crate's `amount_str` exactly (coins[.zats] with trailing
 * fractional zeros trimmed, no decimal point for whole-coin amounts). The
 * scanner service generates payment URIs with this crate, so the adapter
 * must compare against the same canonical string rather than the raw
 * zatoshi value, which never appears literally in a real ZIP-321 URI.
 */
function zip321AmountString(amountZat: string): string {
  const total = BigInt(amountZat);
  const coins = total / ZAT_PER_COIN;
  const zats = total % ZAT_PER_COIN;
  if (zats === 0n) return coins.toString();
  const fraction = zats.toString().padStart(8, '0').replace(/0+$/, '');
  return `${coins.toString()}.${fraction}`;
}

function validatePaymentUri(allocation: ReceiverAllocation): void {
  if (!allocation.paymentUri.startsWith('zcash:')) throw new TypeError('wallet scanner payment URI is malformed');
  const encoded = allocation.paymentUri.slice('zcash:'.length);
  const marker = encoded.indexOf('?');
  if (marker <= 0 || encoded.indexOf('#') >= 0) throw new TypeError('wallet scanner payment URI is malformed');
  const destination = encoded.slice(0, marker);
  const query = encoded.slice(marker + 1);
  if (destination !== allocation.destination) throw new TypeError('wallet scanner payment URI destination mismatch');
  const parameters = new URLSearchParams(query);
  if (parameters.size !== 1 || parameters.getAll('amount').length !== 1
    || parameters.get('amount') !== zip321AmountString(allocation.amountZat)) {
    throw new TypeError('wallet scanner payment URI amount mismatch');
  }
}

export function createWalletScanner(input: {
  socketPath: string;
  expectedChain: ChainIdentity;
  accountId: string;
}): ReceiptSource {
  if (!input.socketPath.startsWith('/') || input.accountId.length === 0) throw new TypeError('invalid wallet scanner configuration');
  let closed = false;
  let pinnedSourceId: string | undefined;

  const requireLive = (): void => { if (closed) throw new WalletScannerUnavailableError(); };
  const pin = (chain: ChainIdentity, accountId: string, sourceId?: string): void => {
    if (!sameChainIdentity(chain, input.expectedChain)) throw new TypeError('wallet scanner chain mismatch');
    if (accountId !== input.accountId) throw new TypeError('wallet scanner account mismatch');
    if (sourceId !== undefined) {
      if (pinnedSourceId !== undefined && pinnedSourceId !== sourceId) throw new TypeError('wallet scanner source mismatch');
      pinnedSourceId = sourceId;
    }
  };
  const request = async (method: 'GET' | 'POST', path: string, body?: unknown): Promise<unknown> => {
    requireLive();
    const payload = body === undefined ? '' : JSON.stringify(body);
    const raw = `${method} ${path} HTTP/1.1\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(payload)}\r\n\r\n${payload}`;
    return new Promise<unknown>((resolve, reject) => {
      const socket = createConnection(input.socketPath);
      const chunks: Buffer[] = [];
      let size = 0;
      let settled = false;
      const unavailable = (): void => {
        if (settled) return;
        settled = true;
        socket.destroy();
        reject(new WalletScannerUnavailableError());
      };
      socket.setTimeout(REQUEST_TIMEOUT_MS, unavailable);
      socket.once('error', unavailable);
      socket.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > MAX_RESPONSE_BYTES) { unavailable(); return; }
        chunks.push(chunk);
      });
      socket.once('end', () => {
        if (settled) return;
        try {
          const response = parseHttpResponse(Buffer.concat(chunks));
          settled = true;
          resolve(response);
        } catch (error) {
          if (error instanceof WalletScannerUnavailableError) unavailable();
          else unavailable();
        }
      });
      socket.once('connect', () => socket.end(raw));
    });
  };

  return {
    async snapshot(): Promise<ScanSnapshot> {
      let snapshot: ScanSnapshot;
      try { snapshot = validateSnapshot(await request('GET', '/v1/snapshot')); } catch (error) {
        if (error instanceof WalletScannerUnavailableError) throw error;
        throw new WalletScannerUnavailableError();
      }
      pin(snapshot.chain, snapshot.accountId, snapshot.sourceId);
      return snapshot;
    },
    async allocateReceiver(requestInput: AllocateReceiver): Promise<ReceiverAllocation> {
      pin(requestInput.chain, requestInput.accountId);
      let allocation: ReceiverAllocation;
      try { allocation = validateAllocation(await request('POST', '/v1/allocations', requestInput)); } catch (error) {
        if (error instanceof WalletScannerUnavailableError) throw error;
        throw new WalletScannerUnavailableError();
      }
      pin(allocation.chain, allocation.accountId);
      if (allocation.allocationId !== requestInput.allocationId || allocation.amountZat !== requestInput.amountZat || allocation.expiresAt !== requestInput.expiresAt) {
        throw new TypeError('wallet scanner allocation terms mismatch');
      }
      validatePaymentUri(allocation);
      return allocation;
    },
    async close(): Promise<void> { closed = true; },
  };
}

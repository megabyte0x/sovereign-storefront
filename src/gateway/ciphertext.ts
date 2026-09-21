import type { IncomingMessage, ServerResponse } from 'node:http';
import { FIRST_RELEASE_MAX_CIPHERTEXT_BYTES } from '../adapters/crypto.ts';

const CIPHERTEXT_PREFIX = '/ciphertext/';
const PRODUCT_VERSION_RE = /^[A-Za-z0-9_-]{1,128}$/;

export type CiphertextLookup = (productVersion: string) => Promise<Uint8Array>;

export type CiphertextInspect =
  | { ok: true; productVersion: string }
  | { ok: false; status: 400 };

export function inspectCiphertextPath(rawUrl: string | undefined): CiphertextInspect {
  const pathOnly = String(rawUrl ?? '').split('?')[0];
  if (
    pathOnly.includes('..') ||
    pathOnly.includes('%') ||
    pathOnly.includes('\\') ||
    pathOnly.includes('//') ||
    pathOnly.includes('./')
  ) {
    return { ok: false, status: 400 };
  }
  if (!pathOnly.startsWith(CIPHERTEXT_PREFIX)) {
    return { ok: false, status: 400 };
  }
  const productVersion = pathOnly.slice(CIPHERTEXT_PREFIX.length);
  if (!PRODUCT_VERSION_RE.test(productVersion)) {
    return { ok: false, status: 400 };
  }
  return { ok: true, productVersion };
}

function write(res: ServerResponse, status: number, body: string | Uint8Array, headers: Record<string, string> = {}) {
  const payload = typeof body === 'string' ? Buffer.from(body) : Buffer.from(body);
  res.writeHead(status, {
    'content-type': 'text/plain; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    ...headers,
    'content-length': String(payload.byteLength),
  });
  res.end(payload);
}

function statusForLookupError(error: unknown): number {
  const message = error instanceof Error ? error.message : String(error);
  if (/unpublished|not found|unknown product/i.test(message)) return 404;
  if (/replica|unavailable|disconnected/i.test(message)) return 503;
  return 500;
}

export function createCiphertextHandler(options: {
  getPublishedCiphertext: CiphertextLookup;
  maxCiphertextBytes?: number;
  maxConcurrent?: number;
}): (req: IncomingMessage, res: ServerResponse) => void {
  const maxCiphertextBytes = options.maxCiphertextBytes ?? FIRST_RELEASE_MAX_CIPHERTEXT_BYTES;
  const maxConcurrent = options.maxConcurrent ?? 2;
  let inFlight = 0;

  return (req, res) => {
    if (req.method !== 'GET') {
      write(res, 405, 'rejected');
      return;
    }
    const inspected = inspectCiphertextPath(req.url);
    if (!inspected.ok) {
      write(res, inspected.status, 'rejected');
      return;
    }
    if (inFlight >= maxConcurrent) {
      write(res, 429, 'rejected');
      return;
    }
    inFlight += 1;
    void (async () => {
      try {
        const body = await options.getPublishedCiphertext(inspected.productVersion);
        if (body.byteLength > maxCiphertextBytes) {
          write(res, 413, 'rejected');
          return;
        }
        const filename = `${inspected.productVersion}.ssf1`;
        write(res, 200, body, {
          'content-type': 'application/octet-stream',
          'content-disposition': `attachment; filename="${filename}"`,
        });
      } catch (error) {
        write(res, statusForLookupError(error), 'rejected');
      } finally {
        inFlight -= 1;
      }
    })();
  };
}

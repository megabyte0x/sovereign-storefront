import type { IncomingMessage, ServerResponse } from 'node:http';
import { PayloadTooLarge } from '../adapters/crypto.ts';
import type { CryptoAdapter, StorageAdapter } from '../contracts/types.ts';
import type { OperationalLogger } from '../ops/log.ts';
import { publishProduct } from './admin.ts';
import { PRODUCT_VERSION_RE } from './catalogue.ts';

/**
 * Private admin publication route: `POST /admin/products`.
 *
 * Runs inside the seller process so it uses the seller's own crypto key store
 * and (live) storage adapter. The caller has already checked admin auth. The
 * handler returns `false` for any other method/path so the caller can continue.
 */
export type AdminPublishDeps = {
  dbPath: string;
  network: 'test' | 'regtest';
  crypto: CryptoAdapter;
  storage: StorageAdapter;
  logger: OperationalLogger;
  maxBodyBytes?: number;
  /** Forwarded to publishProduct. Omitted keeps the real-demo 41-byte default. */
  maxPlaintextBytes?: number;
};

export type AdminPublishHandler = (req: IncomingMessage, res: ServerResponse) => Promise<boolean>;

export const ADMIN_PUBLISH_PATH = '/admin/products';
const DEFAULT_MAX_BODY_BYTES = 4 * 1024;
const AMOUNT_RE = /^(0|[1-9][0-9]*)$/;
const BASE64_RE = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function pathOf(req: IncomingMessage): string {
  const raw = req.url ?? '/';
  const q = raw.indexOf('?');
  return q === -1 ? raw : raw.slice(0, q);
}

async function readBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  const declared = Number(req.headers['content-length']);
  if (Number.isFinite(declared) && declared > limit) {
    req.resume();
    throw new HttpError(413, 'payload too large');
  }
  const chunks: Buffer[] = [];
  let total = 0;
  let tooLarge = false;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    total += buf.byteLength;
    if (total > limit) tooLarge = true;
    if (!tooLarge) chunks.push(buf);
  }
  if (tooLarge) throw new HttpError(413, 'payload too large');
  return Buffer.concat(chunks);
}

type PublishBody = {
  version: string;
  description: string;
  amountZat: string;
  plaintext: Uint8Array;
};

function parseBody(raw: Buffer): PublishBody {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.toString('utf8'));
  } catch {
    throw new HttpError(400, 'malformed json');
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new HttpError(400, 'malformed payload');
  }
  const { version, description, amountZat, plaintextBase64 } = parsed as Record<string, unknown>;
  if (typeof version !== 'string' || !PRODUCT_VERSION_RE.test(version)) {
    throw new HttpError(400, 'invalid version');
  }
  if (typeof description !== 'string' || description.length === 0) {
    throw new HttpError(400, 'invalid description');
  }
  if (typeof amountZat !== 'string' || !AMOUNT_RE.test(amountZat)) {
    throw new HttpError(400, 'amountZat must be an integer string');
  }
  if (typeof plaintextBase64 !== 'string' || plaintextBase64.length === 0 || !BASE64_RE.test(plaintextBase64)) {
    throw new HttpError(400, 'invalid plaintextBase64');
  }
  const plaintext = new Uint8Array(Buffer.from(plaintextBase64, 'base64'));
  return { version, description, amountZat, plaintext };
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.setHeader('content-length', Buffer.byteLength(payload));
  res.end(payload);
}

/** Map a publishProduct failure to an HTTP status without echoing inputs. */
function classify(error: unknown): { status: number; message: string } {
  if (error instanceof HttpError) return { status: error.status, message: error.message };
  if (error instanceof PayloadTooLarge) return { status: 413, message: 'payload too large' };
  const message = error instanceof Error ? error.message : '';
  if (/immutable/i.test(message)) return { status: 409, message: 'product version already published' };
  if (/invalid identifier|malformed payload|amount must|network/i.test(message)) {
    return { status: 400, message: 'invalid product' };
  }
  // Replica verification failure, or the storage adapter itself unavailable.
  return { status: 503, message: 'replica unavailable' };
}

export function createAdminPublishHandler(deps: AdminPublishDeps): AdminPublishHandler {
  const limit = deps.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  return async (req, res) => {
    if (req.method !== 'POST' || pathOf(req) !== ADMIN_PUBLISH_PATH) return false;
    try {
      const body = parseBody(await readBody(req, limit));
      const manifest = await publishProduct({
        dbPath: deps.dbPath,
        version: body.version,
        description: body.description,
        amountZat: body.amountZat,
        network: deps.network,
        plaintext: body.plaintext,
        crypto: deps.crypto,
        storage: deps.storage,
        replicaId: 'replica',
        ...(deps.maxPlaintextBytes === undefined ? {} : { maxPlaintextBytes: deps.maxPlaintextBytes }),
      });
      deps.logger.log({ event: 'admin.publish', ok: true, code: 201 });
      sendJson(res, 201, { version: manifest.version, ciphertextCid: manifest.ciphertextCid, replica: true });
    } catch (error) {
      const { status, message } = classify(error);
      deps.logger.log({ event: 'admin.publish', ok: false, code: status });
      if (!res.headersSent) sendJson(res, status, { error: message });
    }
    return true;
  };
}

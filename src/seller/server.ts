import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { existsSync, readFileSync } from 'node:fs';
import { extname, join, normalize, sep } from 'node:path';
import { createCredentialAdapter } from '../adapters/credentials.ts';
import { createCryptoAdapter } from '../adapters/crypto.ts';
import { createMemoryMessaging } from '../adapters/messaging.ts';
import { MemoryScanner } from '../adapters/scanner.ts';
import { createMemoryStorageAdapter } from '../adapters/storage.ts';
import { ConfigError, type RuntimeConfig } from '../config.ts';
import type {
  CredentialAdapter,
  OrderStatus,
  Scanner,
  SellerStore,
  ServiceAvailability,
  StorageAdapter,
} from '../contracts/types.ts';
import { MAX_PAYLOAD_BYTES } from '../contracts/validation.ts';
import { createCiphertextHandler } from '../gateway/ciphertext.ts';
import { publishProduct } from './admin.ts';
import { openCatalogue } from './catalogue.ts';
import { openStore } from './db.ts';
import { createFulfillment } from './fulfillment.ts';
import { createPayments } from './payments.ts';

const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

const FIXTURE_PLAINTEXT = new TextEncoder().encode('sovereign-storefront harmless fixture v1\n');

export type SellerServer = {
  publicUrl: string;
  adminUrl: string;
  close: () => Promise<void>;
};

export type SellerOptions = {
  config: RuntimeConfig;
  seedProduct?: boolean;
  availability?: Partial<ServiceAvailability>;
  publicDir?: string;
  storage?: StorageAdapter;
  scanner?: Scanner;
  credentials?: CredentialAdapter;
};

function listen(server: Server, host: string, port: number): Promise<{ url: string; port: number }> {
  return new Promise((resolve, reject) => {
    server.listen(port, host, () => {
      const addr = server.address();
      if (!addr || typeof addr === 'string') {
        reject(new Error('server did not bind'));
        return;
      }
      resolve({ url: `http://${host}:${addr.port}`, port: addr.port });
    });
    server.on('error', reject);
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

function applySecurityHeaders(res: ServerResponse): void {
  res.setHeader('content-security-policy', CSP);
  res.setHeader('x-content-type-options', 'nosniff');
  res.setHeader('cache-control', 'no-store');
  res.setHeader('referrer-policy', 'no-referrer');
}

function send(res: ServerResponse, status: number, body: string | Uint8Array, headers: Record<string, string> = {}): void {
  applySecurityHeaders(res);
  const payload = typeof body === 'string' ? Buffer.from(body) : Buffer.from(body);
  res.writeHead(status, {
    'content-type': 'text/plain; charset=utf-8',
    ...headers,
    'content-length': String(payload.byteLength),
  });
  res.end(payload);
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  send(res, status, JSON.stringify(body), { 'content-type': 'application/json; charset=utf-8' });
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.byteLength;
      if (size > MAX_PAYLOAD_BYTES) {
        reject(new Error('payload exceeds size limit'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function decodeProof(value: unknown): Uint8Array {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error('proof required');
  }
  return new Uint8Array(Buffer.from(value, 'base64'));
}

function contentTypeFor(filePath: string): string {
  switch (extname(filePath)) {
    case '.html': return 'text/html; charset=utf-8';
    case '.css': return 'text/css; charset=utf-8';
    case '.js': return 'text/javascript; charset=utf-8';
    case '.svg': return 'image/svg+xml';
    default: return 'application/octet-stream';
  }
}

function safeJoin(root: string, requestPath: string): string | null {
  const relative = requestPath.replace(/^\/+/, '');
  if (relative.includes('\0') || relative.includes('..')) return null;
  const resolved = normalize(join(root, relative));
  const rootPath = normalize(root) + sep;
  if (resolved !== normalize(root) && !resolved.startsWith(rootPath)) return null;
  return resolved;
}

export async function startSeller(options: SellerOptions): Promise<SellerServer> {
  const { config } = options;
  if (config.mode === 'real-demo') {
    if (
      config.adapters.messaging !== 'real'
      || config.adapters.storage !== 'real'
      || config.adapters.scanner !== 'real'
    ) {
      throw new ConfigError('real-demo mode rejects fixture adapters');
    }
    if (!options.storage || !options.scanner) {
      throw new ConfigError('real-demo mode requires real adapters; refusing fixture fallback');
    }
  }

  const storage = options.storage ?? createMemoryStorageAdapter();
  const scanner = options.scanner ?? new MemoryScanner();
  const credentials = options.credentials ?? createCredentialAdapter();
  const messaging = createMemoryMessaging();

  if (scanner instanceof MemoryScanner && !options.scanner) {
    scanner.replaceSnapshot([], { id: 'rev-10', height: 10 }, true, Date.now());
  }

  if (options.seedProduct) {
    await publishProduct({
      dbPath: config.dbPath,
      version: 'book-v1',
      description: 'Harmless fixture',
      amountZat: '100000000',
      network: config.productNetwork,
      plaintext: FIXTURE_PLAINTEXT,
      crypto: createCryptoAdapter(),
      storage,
      replicaId: 'replica',
    });
  }

  const availabilityOverride = options.availability ?? {};
  const catalogue = openCatalogue({
    dbPath: config.dbPath,
    storage,
    probes: {
      messaging: async () => availabilityOverride.messaging ?? true,
      scanner: async () => {
        if (availabilityOverride.scanner === false) return false;
        const health = await scanner.health();
        return health.healthy && health.caughtUp;
      },
    },
  });

  const store: SellerStore = await openStore(config.dbPath);
  const payments = createPayments({
    store,
    scanner,
    policy: {
      minConfirmations: config.minConfirmations,
      maxHealthAgeMs: config.maxHealthAgeMs,
    },
  });
  createFulfillment({ store, payments, messaging, credentials });

  const publicDir = options.publicDir
    ?? (existsSync(join(process.cwd(), 'dist/browser/index.html'))
      ? join(process.cwd(), 'dist/browser')
      : process.cwd());

  const ciphertext = createCiphertextHandler({
    maxCiphertextBytes: config.maxCiphertextBytes,
    getPublishedCiphertext: (productVersion) => catalogue.getPublishedCiphertext(productVersion),
  });

  const publicServer = createServer((req, res) => {
    void handlePublic(req, res);
  });
  const adminServer = createServer((req, res) => {
    void handleAdmin(req, res);
  });

  async function handlePublic(req: IncomingMessage, res: ServerResponse): Promise<void> {
    applySecurityHeaders(res);
    const path = (req.url ?? '/').split('?')[0] ?? '/';
    try {
      if (path.startsWith('/admin')) {
        send(res, 404, 'not found');
        return;
      }
      if (path === '/api/payment-override' || path === '/api/mark-paid') {
        send(res, 404, 'not found');
        return;
      }
      if (path.startsWith('/ciphertext/')) {
        ciphertext(req, res);
        return;
      }
      if (req.method === 'GET' && (path === '/' || path === '/index.html')) {
        const indexPath = join(publicDir, 'index.html');
        const html = existsSync(indexPath)
          ? readFileSync(indexPath, 'utf8')
          : '<!DOCTYPE html><html><head><meta charset="utf-8"><title>Sovereign Storefront</title></head><body><main id="app"></main></body></html>';
        send(res, 200, html, { 'content-type': 'text/html; charset=utf-8' });
        return;
      }
      if (req.method === 'GET' && (path.startsWith('/assets/') || path.startsWith('/src/'))) {
        const filePath = safeJoin(publicDir, path);
        if (!filePath || !existsSync(filePath)) {
          send(res, 404, 'not found');
          return;
        }
        send(res, 200, readFileSync(filePath), { 'content-type': contentTypeFor(filePath) });
        return;
      }
      if (req.method === 'GET' && path === '/api/product') {
        const published = catalogue.listPublished()[0];
        if (!published) {
          sendJson(res, 404, { error: 'unpublished product' });
          return;
        }
        sendJson(res, 200, {
          version: published.version,
          description: published.description,
          amountZat: published.amountZat,
          network: published.network,
          fileSize: published.fileSize,
          fileFormatVersion: published.fileFormatVersion,
          sellerKeyId: config.sellerKeyId,
        });
        return;
      }
      if (req.method === 'GET' && path === '/api/availability') {
        sendJson(res, 200, await catalogue.currentAvailability());
        return;
      }
      if (req.method === 'POST' && path === '/api/orders') {
        const payload = JSON.parse(await readBody(req)) as {
          requestId?: string;
          productVersion?: string;
          buyerKeyId?: string;
          proof?: string;
        };
        if (!payload.requestId || !payload.productVersion || !payload.buyerKeyId) {
          sendJson(res, 400, { error: 'malformed payload' });
          return;
        }
        const proof = decodeProof(payload.proof);
        const ok = await credentials.verifyPossession(payload.buyerKeyId, proof);
        if (!ok) {
          sendJson(res, 403, { error: 'proof rejected' });
          return;
        }
        const availability = await catalogue.currentAvailability();
        const order = await store.createOrder({
          requestId: payload.requestId,
          buyerKeyId: payload.buyerKeyId,
          productVersion: payload.productVersion,
        });
        const invoice = await store.getOrCreateInvoice({
          orderId: order.id,
          buyerKeyId: payload.buyerKeyId,
          productVersion: payload.productVersion,
          now: Date.now(),
          availability,
        });
        payments.cacheInvoice(invoice);
        sendJson(res, 200, invoice);
        return;
      }
      if (req.method === 'POST' && (path === '/api/status' || path === '/api/recover')) {
        const payload = JSON.parse(await readBody(req)) as { orderId?: string; proof?: string };
        if (!payload.orderId) {
          sendJson(res, 400, { error: 'malformed payload' });
          return;
        }
        const invoice = await store.getInvoice(payload.orderId);
        if (!invoice) {
          sendJson(res, 404, { error: 'order not found' });
          return;
        }
        const proof = decodeProof(payload.proof);
        const ok = await credentials.verifyPossession(invoice.buyerKeyId, proof);
        if (!ok) {
          sendJson(res, 403, { error: 'proof rejected' });
          return;
        }
        if (path === '/api/status') {
          const status: OrderStatus = await payments.orderStatus(payload.orderId);
          sendJson(res, 200, status);
          return;
        }
        const decision = await payments.authorizeRelease(payload.orderId);
        if (!decision.disclose || !decision.package) {
          sendJson(res, 403, { error: 'not eligible' });
          return;
        }
        sendJson(res, 200, {
          orderId: decision.package.orderId,
          productVersion: decision.package.productVersion,
        });
        return;
      }
      send(res, 404, 'not found');
    } catch (error) {
      const message = error instanceof Error ? error.message : 'error';
      const status = /checkout unavailable/i.test(message)
        ? 503
        : /proof|own order/i.test(message)
          ? 403
          : 400;
      sendJson(res, status, { error: message });
    }
  }

  async function handleAdmin(req: IncomingMessage, res: ServerResponse): Promise<void> {
    applySecurityHeaders(res);
    const header = req.headers.authorization ?? '';
    if (header !== `Bearer ${config.adminToken}`) {
      send(res, 401, 'unauthorized');
      return;
    }
    const path = (req.url ?? '/').split('?')[0] ?? '/';
    if (req.method === 'GET' && path === '/admin/health') {
      sendJson(res, 200, { ok: true, mode: config.mode });
      return;
    }
    send(res, 404, 'not found');
  }

  const publicBind = await listen(publicServer, config.publicHost, config.publicPort);
  const adminBind = await listen(adminServer, config.adminHost, config.adminPort);

  return {
    publicUrl: publicBind.url,
    adminUrl: adminBind.url,
    async close() {
      catalogue.close();
      await store.close();
      await closeServer(publicServer);
      await closeServer(adminServer);
    },
  };
}



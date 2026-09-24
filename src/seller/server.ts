import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { existsSync, readFileSync } from 'node:fs';
import { extname, join, normalize, sep } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createCredentialAdapter } from '../adapters/credentials.ts';
import { createCryptoAdapter } from '../adapters/crypto.ts';
import { createMemoryMessaging, type FulfillmentMessaging } from '../adapters/messaging.ts';
import { MemoryScanner } from '../adapters/scanner.ts';
import { createMemoryStorageAdapter } from '../adapters/storage.ts';
import { ConfigError, type RuntimeConfig } from '../config.ts';
import { silentLogger, type OperationalLogger } from '../ops/log.ts';
import type {
  CredentialAdapter,
  DeliveryPackage,
  OrderStatus,
  SellerStore,
  ServiceAvailability,
  StorageAdapter,
} from '../contracts/types.ts';
import type { ReceiptSource } from '../contracts/live.ts';
import { MAX_PAYLOAD_BYTES } from '../contracts/validation.ts';
import { createCiphertextHandler } from '../gateway/ciphertext.ts';
import { publishProduct } from './admin.ts';
import { openCatalogue } from './catalogue.ts';
import { openStore } from './db.ts';
import { createFulfillment } from './fulfillment.ts';
import { loadOrCreateSellerIdentity } from './identity.ts';
import { createInvoiceIssuer } from './issuance.ts';
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
  scanner?: ReceiptSource;
  credentials?: CredentialAdapter;
  messaging?: FulfillmentMessaging;
  logger?: OperationalLogger;
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

function serializeDeliveryPackage(pkg: DeliveryPackage): {
  orderId: string;
  productVersion: string;
  buyerKeyId: string;
  encryptedEnvelope: string;
  packageId?: string;
} {
  return {
    orderId: pkg.orderId,
    productVersion: pkg.productVersion,
    buyerKeyId: pkg.buyerKeyId,
    encryptedEnvelope: Buffer.from(pkg.encryptedEnvelope).toString('base64'),
    packageId: pkg.packageId,
  };
}

function applyStoreSettings(dbPath: string, destination: string, invoiceTtlMs: number): void {
  const db = new DatabaseSync(dbPath);
  try {
    db.exec('PRAGMA busy_timeout = 5000');
    const upsert = db.prepare(
      `INSERT INTO store_settings (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    );
    upsert.run('destination', destination);
    upsert.run('invoice_ttl_ms', String(invoiceTtlMs));
  } finally {
    db.close();
  }
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
    if (!options.storage || !options.scanner || !options.messaging) {
      throw new ConfigError('real-demo mode requires real adapters; refusing fixture fallback');
    }
  }

  const storage = options.storage ?? createMemoryStorageAdapter();
  const scanner = options.scanner ?? new MemoryScanner();
  const credentials = options.credentials ?? createCredentialAdapter();
  const crypto = createCryptoAdapter({ credentials });
  if (config.adapters.messaging === 'real' && !options.messaging) {
    throw new ConfigError('real messaging adapter required; refusing fixture fallback');
  }
  const messaging = options.messaging ?? createMemoryMessaging();
  const logger = options.logger ?? silentLogger;

  if (scanner instanceof MemoryScanner) {
    scanner.setChainNetwork(config.productNetwork);
  }
  if (scanner instanceof MemoryScanner && !options.scanner) {
    scanner.replaceSnapshot([], { id: 'rev-10', height: 10 }, true, Date.now());
  }

  const startupSnapshot = await scanner.snapshot();
  const chain = startupSnapshot.chain;
  const accountId = startupSnapshot.accountId;

  if (options.seedProduct) {
    await publishProduct({
      dbPath: config.dbPath,
      version: 'book-v1',
      description: 'Harmless fixture',
      amountZat: '100000000',
      network: chain.network,
      plaintext: FIXTURE_PLAINTEXT,
      crypto,
      storage,
      replicaId: 'replica',
    });
  }

  const availabilityOverride = options.availability ?? {};
  loadOrCreateSellerIdentity(config.dbPath);
  const catalogue = openCatalogue({
    dbPath: config.dbPath,
    storage,
    probes: {
      messaging: async () => availabilityOverride.messaging ?? true,
      scanner: async () => {
        if (availabilityOverride.scanner === false) return false;
        const snapshot = await scanner.snapshot();
        return snapshot.health === 'ready' && snapshot.caughtUp;
      },
      ...(availabilityOverride.storageReplica === undefined
        ? {}
        : { storageReplica: async () => availabilityOverride.storageReplica === true }),
    },
  });

  const store: SellerStore = await openStore(config.dbPath);
  applyStoreSettings(config.dbPath, config.destination, config.invoiceTtlMs);
  for (const key of catalogue.listProductKeys()) {
    const raw = key.rawKey instanceof Uint8Array ? key.rawKey : new Uint8Array(key.rawKey);
    await crypto.importProductKey(key.keyRef, raw, key.digestHex);
  }
  const payments = createPayments({
    store,
    scanner,
    policy: {
      minConfirmations: config.minConfirmations,
      maxHealthAgeMs: config.maxHealthAgeMs,
    },
    preparePackage: async (invoice) => {
      const manifest = catalogue.getManifest(invoice.productVersion);
      if (!manifest?.sellerKeyRef) {
        throw new Error('unpublished product');
      }
      const sealed = await crypto.sealDelivery({
        orderId: invoice.orderId,
        productVersion: invoice.productVersion,
        buyerKeyId: invoice.buyerKeyId,
        productKeyRef: manifest.sellerKeyRef,
      });
      return {
        orderId: invoice.orderId,
        productVersion: invoice.productVersion,
        buyerKeyId: invoice.buyerKeyId,
        encryptedEnvelope: sealed,
      };
    },
  });
  const fulfillment = createFulfillment({ store, payments, messaging, credentials });
  const issuer = createInvoiceIssuer({
    store,
    scanner,
    chain,
    accountId,
    ttlMs: config.invoiceTtlMs,
    now: Date.now,
    availability: async () => catalogue.currentAvailability(),
  });
  const dispatchTimer = setInterval(() => {
    void payments.reconcileFromScanner()
      .then(() => fulfillment.dispatchPending())
      .catch(() => undefined);
  }, 2_000);
  dispatchTimer.unref();

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

  function requestPath(req: IncomingMessage): string {
    return (req.url ?? '/').split('?')[0] ?? '/';
  }

  function logRequest(req: IncomingMessage): void {
    logger.log({
      event: 'http.request',
      method: req.method ?? 'GET',
      path: requestPath(req),
    });
  }

  function logResponse(req: IncomingMessage, status: number): void {
    logger.log({
      event: 'http.response',
      method: req.method ?? 'GET',
      path: requestPath(req),
      status,
      ok: status < 400,
    });
  }

  const sendPublic = (req: IncomingMessage, res: ServerResponse, status: number, body: string | Uint8Array, headers: Record<string, string> = {}): void => {
    logResponse(req, status);
    send(res, status, body, headers);
  };

  const sendPublicJson = (req: IncomingMessage, res: ServerResponse, status: number, body: unknown): void => {
    logResponse(req, status);
    sendJson(res, status, body);
  };

  async function handlePublic(req: IncomingMessage, res: ServerResponse): Promise<void> {
    applySecurityHeaders(res);
    logRequest(req);
    const path = requestPath(req);
    try {
      if (path.startsWith('/admin')) {
        sendPublic(req, res, 404, 'not found');
        return;
      }
      if (path === '/api/payment-override' || path === '/api/mark-paid') {
        sendPublic(req, res, 404, 'not found');
        return;
      }
      if (config.mode === 'real-demo' && (path === '/api/orders' || path === '/api/status' || path === '/api/recover')) {
        // Task 7: real-demo checkout/status/recovery must go through the
        // authenticated Waku application path (Task 9), not this HTTP
        // fallback. These routes stay reachable only in fixture mode for
        // the pre-existing deterministic browser tests that exercise them.
        sendPublic(req, res, 404, 'not found');
        return;
      }
      if (path.startsWith('/ciphertext/')) {
        ciphertext(req, res);
        logResponse(req, 0);
        return;
      }
      if (req.method === 'GET' && (path === '/' || path === '/index.html')) {
        const indexPath = join(publicDir, 'index.html');
        const html = existsSync(indexPath)
          ? readFileSync(indexPath, 'utf8')
          : '<!DOCTYPE html><html><head><meta charset="utf-8"><title>Sovereign Storefront</title></head><body><main id="app"></main></body></html>';
        sendPublic(req, res, 200, html, { 'content-type': 'text/html; charset=utf-8' });
        return;
      }
      if (req.method === 'GET' && (path.startsWith('/assets/') || path.startsWith('/src/'))) {
        const filePath = safeJoin(publicDir, path);
        if (!filePath || !existsSync(filePath)) {
          sendPublic(req, res, 404, 'not found');
          return;
        }
        sendPublic(req, res, 200, readFileSync(filePath), { 'content-type': contentTypeFor(filePath) });
        return;
      }
      if (req.method === 'GET' && path === '/api/product') {
        const published = catalogue.listPublished()[0];
        if (!published) {
          sendPublicJson(req, res, 404, { error: 'unpublished product' });
          return;
        }
        sendPublicJson(req, res, 200, {
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
        sendPublicJson(req, res, 200, await catalogue.currentAvailability());
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
          sendPublicJson(req, res, 400, { error: 'malformed payload' });
          return;
        }
        const proof = decodeProof(payload.proof);
        const ok = await credentials.verifyPossession(payload.buyerKeyId, proof, {
          orderId: payload.requestId,
        });
        if (!ok) {
          sendPublicJson(req, res, 403, { error: 'proof rejected' });
          return;
        }
        const manifest = catalogue.getManifest(payload.productVersion);
        if (!manifest?.amountZat) {
          sendPublicJson(req, res, 400, { error: 'unpublished product' });
          return;
        }
        const invoice = await issuer.issue({
          requestId: payload.requestId,
          buyerKeyId: payload.buyerKeyId,
          productVersion: payload.productVersion,
          expectedAmountZat: manifest.amountZat,
        });
        payments.cacheInvoice(invoice);
        logger.log({ event: 'invoice.issued' });
        sendPublicJson(req, res, 200, invoice);
        return;
      }
      if (req.method === 'POST' && (path === '/api/status' || path === '/api/recover')) {
        const payload = JSON.parse(await readBody(req)) as { orderId?: string; proof?: string };
        if (!payload.orderId) {
          sendPublicJson(req, res, 400, { error: 'malformed payload' });
          return;
        }
        const invoice = await store.getInvoice(payload.orderId);
        if (!invoice) {
          sendPublicJson(req, res, 404, { error: 'order not found' });
          return;
        }
        const proof = decodeProof(payload.proof);
        const ok = await credentials.verifyPossession(invoice.buyerKeyId, proof, {
          orderId: payload.orderId,
        });
        if (!ok) {
          sendPublicJson(req, res, 403, { error: 'proof rejected' });
          return;
        }
        payments.cacheInvoice(invoice);
        await payments.reconcileFromScanner();
        if (path === '/api/status') {
          const status: OrderStatus = await payments.orderStatus(payload.orderId);
          sendPublicJson(req, res, 200, status);
          return;
        }
        const decision = await payments.authorizeRelease(payload.orderId);
        if (!decision.disclose || !decision.package) {
          sendPublicJson(req, res, 403, { error: 'not eligible' });
          return;
        }
        try {
          await fulfillment.dispatchPending();
        } catch {
          // Send failure does not withhold the recovery package.
        }
        sendPublicJson(req, res, 200, serializeDeliveryPackage(decision.package));
        return;
      }
      sendPublic(req, res, 404, 'not found');
    } catch (error) {
      const message = error instanceof Error ? error.message : 'error';
      const status = /checkout unavailable/i.test(message)
        ? 503
        : /proof|own order/i.test(message)
          ? 403
          : 400;
      logger.log({ event: 'error', code: status });
      sendPublicJson(req, res, status, { error: message });
    }
  }

  async function handleAdmin(req: IncomingMessage, res: ServerResponse): Promise<void> {
    applySecurityHeaders(res);
    logRequest(req);
    const header = req.headers.authorization ?? '';
    const authorized = header === `Bearer ${config.adminToken}`;
    logger.log({ event: 'admin.auth', ok: authorized });
    if (!authorized) {
      logResponse(req, 401);
      send(res, 401, 'unauthorized');
      return;
    }
    const path = requestPath(req);
    if (req.method === 'GET' && path === '/admin/health') {
      logResponse(req, 200);
      sendJson(res, 200, { ok: true, mode: config.mode });
      return;
    }
    logResponse(req, 404);
    send(res, 404, 'not found');
  }

  const publicBind = await listen(publicServer, config.publicHost, config.publicPort);
  const adminBind = await listen(adminServer, config.adminHost, config.adminPort);

  return {
    publicUrl: publicBind.url,
    adminUrl: adminBind.url,
    async close() {
      clearInterval(dispatchTimer);
      catalogue.close();
      await store.close();
      await closeServer(publicServer);
      await closeServer(adminServer);
    },
  };
}



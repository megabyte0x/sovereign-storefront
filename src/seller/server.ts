import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { existsSync, readFileSync } from 'node:fs';
import { extname, join, resolve, sep } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createCredentialAdapter } from '../adapters/credentials.ts';
import { createCryptoAdapter } from '../adapters/crypto.ts';
import { createMemoryMessaging, type FulfillmentMessaging } from '../adapters/messaging.ts';
import { MemoryScanner } from '../adapters/scanner.ts';
import { createMemoryStorageAdapter } from '../adapters/storage.ts';
import { ConfigError, type RuntimeConfig } from '../config.ts';
import { createAdminPublishHandler } from './admin-publish.ts';
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
import { openCatalogue, type AvailabilityProbes } from './catalogue.ts';
import { isScannerUnavailable } from './messages.ts';
import { openStore } from './db.ts';
import { createFulfillment } from './fulfillment.ts';
import { loadOrCreateSellerIdentity } from './identity.ts';
import { createInvoiceIssuer } from './issuance.ts';
import { createPayments, type Payments } from './payments.ts';

const PEER_ADDR_RE = /^\/(dns4|dns6|dns|ip4|ip6)\/([^/]+)\/tcp\/([0-9]{1,5})\/(wss|tls\/ws|ws)(?:\/|$)/;
const CSP_HOST_RE = /^[A-Za-z0-9.-]+$|^[0-9A-Fa-f:]+$/;

function isLoopbackHost(proto: string, host: string): boolean {
  if (proto === 'ip4') return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host);
  if (proto === 'ip6') return host === '::1';
  return host === 'localhost';
}

/** Map one Waku peer multiaddr to a single CSP connect-src origin. */
function peerOrigin(peer: string): string {
  const match = PEER_ADDR_RE.exec(peer);
  if (!match) throw new ConfigError('invalid Waku peer multiaddr for CSP');
  const [, proto = '', host = '', portRaw = '', transport = ''] = match;
  const port = Number(portRaw);
  if (!Number.isInteger(port) || port < 1 || port > 65535 || !CSP_HOST_RE.test(host)) {
    throw new ConfigError('invalid Waku peer multiaddr for CSP');
  }
  const hostPart = proto === 'ip6' ? `[${host}]` : host;
  if (transport === 'ws') {
    if (!isLoopbackHost(proto, host)) throw new ConfigError('plain ws:// Waku peer is allowed only on loopback');
    return `ws://${hostPart}:${port}`;
  }
  return `wss://${hostPart}:${port}`;
}

/**
 * Content-Security-Policy for the public server. Fixture mode keeps
 * connect-src 'self'; real-demo adds exactly one origin per configured Waku
 * peer (never a wildcard or bare scheme). Throws ConfigError on a peer that
 * would need plain ws:// to a non-loopback host.
 */
export function buildCsp(config: RuntimeConfig): string {
  const connect = ["'self'"];
  if (config.mode === 'real-demo') {
    for (const peer of config.live?.waku.bootstrapPeers ?? []) {
      const origin = peerOrigin(peer);
      if (!connect.includes(origin)) connect.push(origin);
    }
  }
  return [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self'",
    "img-src 'self' data:",
    `connect-src ${connect.join(' ')}`,
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join('; ');
}

/** Real-demo serves only an explicit built browser directory; fixture keeps its dev fallback. */
function resolvePublicDir(config: RuntimeConfig, explicit: string | undefined): string {
  if (config.mode === 'real-demo') {
    if (explicit === undefined) throw new ConfigError('real-demo mode requires an explicit publicDir (built dist/browser)');
    if (!existsSync(join(explicit, 'index.html'))) throw new ConfigError('real-demo publicDir must contain index.html');
    return explicit;
  }
  if (explicit !== undefined) return explicit;
  // Fixture mode only: developer fallback to the working directory.
  return existsSync(join(process.cwd(), 'dist/browser/index.html'))
    ? join(process.cwd(), 'dist/browser')
    : process.cwd();
}

const FIXTURE_PLAINTEXT = new TextEncoder().encode('sovereign-storefront harmless fixture v1\n');

/** Seller business components, shared by the HTTP and Waku transports. */
export type SellerCore = {
  sellerKeyId: string;
  store: SellerStore;
  payments: Payments;
  issuer: ReturnType<typeof createInvoiceIssuer>;
  fulfillment: ReturnType<typeof createFulfillment>;
  catalogue: ReturnType<typeof openCatalogue>;
};

export type SellerServer = {
  publicUrl: string;
  adminUrl: string;
  core: SellerCore;
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
  /** Validated persisted seller identity; overrides config.sellerKeyId everywhere. */
  sellerKeyId?: string;
  /** Replace availability probes (live runtime supplies real readiness probes). */
  probes?: Partial<AvailabilityProbes>;
  /** Cached per-product replica readiness; request paths then never touch storage. */
  replicaReady?: (productVersion: string) => boolean;
  /** Default true. The live runtime owns its own bounded loops instead. */
  startLoops?: boolean;
  /** Runs after components are built and before any listener accepts traffic. */
  beforeListen?: (core: SellerCore) => Promise<void>;
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

const DEFAULT_CSP = buildCsp({ mode: 'fixture' } as RuntimeConfig);

/** A per-instance CSP set earlier on the response is kept; otherwise the self-only default applies. */
function applySecurityHeaders(res: ServerResponse, csp?: string): void {
  if (csp !== undefined || !res.hasHeader('content-security-policy')) {
    res.setHeader('content-security-policy', csp ?? DEFAULT_CSP);
  }
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

function applyStoreSettings(dbPath: string, destination: string | null, invoiceTtlMs: number): void {
  const db = new DatabaseSync(dbPath);
  try {
    db.exec('PRAGMA busy_timeout = 5000');
    const upsert = db.prepare(
      `INSERT INTO store_settings (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    );
    if (destination !== null) upsert.run('destination', destination);
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
  // resolve() drops a trailing separator, so a root given as `.../browser/`
  // (as dist/service/main.js passes it) still contains its own files.
  const base = resolve(root);
  const resolved = resolve(base, relative);
  if (resolved !== base && !resolved.startsWith(base + sep)) return null;
  return resolved;
}

export async function startSeller(options: SellerOptions): Promise<SellerServer> {
  const config: RuntimeConfig = options.sellerKeyId === undefined
    ? options.config
    : { ...options.config, sellerKeyId: options.sellerKeyId };
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
    if (!config.live) {
      throw new ConfigError('real-demo mode requires a live config block');
    }
  }
  // Fail before any store/listener work: invalid peers or a missing built UI.
  const publicCsp = buildCsp(config);
  const publicDir = resolvePublicDir(config, options.publicDir);
  // Real-demo config omits sellerKeyId; the runtime supplies the persisted identity.
  const sellerKeyId = config.sellerKeyId;
  if (!sellerKeyId) throw new ConfigError('seller key id unavailable');

  const storage = options.storage ?? createMemoryStorageAdapter();
  const scanner = options.scanner ?? new MemoryScanner();
  const credentials = options.credentials ?? createCredentialAdapter();
  const crypto = createCryptoAdapter({ credentials });
  if (config.adapters.messaging === 'real' && !options.messaging) {
    throw new ConfigError('real messaging adapter required; refusing fixture fallback');
  }
  const messaging = options.messaging ?? createMemoryMessaging();
  const logger = options.logger ?? silentLogger;
  const adminPublish = createAdminPublishHandler({
    dbPath: config.dbPath,
    network: config.productNetwork,
    crypto,
    storage,
    logger,
    maxBodyBytes: 4096,
  });

  if (scanner instanceof MemoryScanner) {
    scanner.setChainNetwork(config.productNetwork);
  }
  if (scanner instanceof MemoryScanner && !options.scanner) {
    scanner.replaceSnapshot([], { id: 'rev-10', height: 10 }, true, Date.now());
  }

  // Live identity comes from validated config (the wallet scanner pins every
  // response against it); never from whatever the scanner first reports.
  let chain = config.live?.chain;
  let accountId = config.live?.scannerAccountId;
  if (!chain || !accountId) {
    const startupSnapshot = await scanner.snapshot();
    chain = startupSnapshot.chain;
    accountId = startupSnapshot.accountId;
  }

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
  if (options.sellerKeyId === undefined) loadOrCreateSellerIdentity(config.dbPath);
  const catalogue = openCatalogue({
    dbPath: config.dbPath,
    storage,
    ...(options.replicaReady ? { replicaReady: options.replicaReady } : {}),
    probes: options.probes ?? {
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
  applyStoreSettings(config.dbPath, config.mode === 'real-demo' ? null : config.destination, config.invoiceTtlMs);
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
    availability: config.mode === 'real-demo'
      ? async (productVersion) => catalogue.productAvailability(productVersion)
      : async () => catalogue.currentAvailability(),
  });
  const core: SellerCore = { sellerKeyId, store, payments, issuer, fulfillment, catalogue };
  let dispatchTimer: ReturnType<typeof setInterval> | undefined;
  if (options.startLoops !== false) {
    dispatchTimer = setInterval(() => {
      void payments.reconcileFromScanner()
        .then(() => fulfillment.dispatchPending())
        .catch((error: unknown) => {
          logger.log({ event: 'error', code: error instanceof Error ? error.name : 'Error' });
        });
    }, 2_000);
    dispatchTimer.unref();
  }

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
    applySecurityHeaders(res, publicCsp);
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
      if (config.mode === 'real-demo' && (path === '/api/orders' || path === '/api/status' || path === '/api/recover' || path === '/api/acknowledge')) {
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
      if (req.method === 'GET' && path === '/api/waku-config') {
        // Real-demo only: the browser's Waku bootstrap. Exactly the frozen
        // PublicWakuConfig fields; bootstrapPeers is the same list buildCsp()
        // derives connect-src from. Fixture mode falls through to 404.
        if (config.mode !== 'real-demo' || !config.live) {
          sendPublic(req, res, 404, 'not found');
          return;
        }
        sendPublicJson(req, res, 200, {
          sellerKeyId: config.sellerKeyId,
          network: config.productNetwork,
          contentTopic: config.live.waku.contentTopic,
          bootstrapPeers: [...config.live.waku.bootstrapPeers],
        });
        return;
      }
      if (req.method === 'GET' && path === '/api/availability') {
        const productVersion = new URL(req.url ?? '/', 'http://localhost').searchParams.get('productVersion');
        sendPublicJson(req, res, 200, await catalogue.currentAvailability(productVersion ?? undefined));
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
        if (path === '/api/status') {
          // Parity with the Waku dispatcher: a scanner outage still yields a
          // status (orderStatus maps it to verification 'unavailable').
          await payments.reconcileFromScanner().catch(() => undefined);
          const status: OrderStatus = await payments.orderStatus(payload.orderId);
          sendPublicJson(req, res, 200, status);
          return;
        }
        let decision: Awaited<ReturnType<typeof payments.authorizeRelease>>;
        try {
          await payments.reconcileFromScanner();
          decision = await payments.authorizeRelease(payload.orderId);
        } catch (error) {
          if (!isScannerUnavailable(error)) throw error;
          logger.log({ event: 'error', code: 503 });
          sendPublicJson(req, res, 503, { error: 'verification unavailable' });
          return;
        }
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
    if (await adminPublish(req, res)) {
      logResponse(req, res.statusCode);
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

  const closeCore = async (): Promise<void> => {
    if (dispatchTimer) clearInterval(dispatchTimer);
    catalogue.close();
    await store.close();
  };
  let publicBind: { url: string; port: number };
  let adminBind: { url: string; port: number };
  try {
    await options.beforeListen?.(core);
    publicBind = await listen(publicServer, config.publicHost, config.publicPort);
    try {
      adminBind = await listen(adminServer, config.adminHost, config.adminPort);
    } catch (error) {
      await closeServer(publicServer);
      throw error;
    }
  } catch (error) {
    await closeCore();
    throw error;
  }

  return {
    publicUrl: publicBind.url,
    adminUrl: adminBind.url,
    core,
    async close() {
      await closeServer(publicServer);
      await closeServer(adminServer);
      await closeCore();
    },
  };
}



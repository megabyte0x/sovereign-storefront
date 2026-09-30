import { createCredentialAdapter } from '../adapters/credentials.ts';
import { FIRST_RELEASE_MAX_CIPHERTEXT_BYTES, createCryptoAdapter, splitDeliveryEnvelope } from '../adapters/crypto.ts';
import { qrSvgMarkup } from './payment-request.ts';
import {
  allowNewCheckout,
  type BrowserPurchase,
  type CredentialAdapter,
  type DeliveryPackage,
  type Invoice,
  type OrderStatus,
  type OrderTransport,
  type PurchaseStore,
  type ServiceAvailability,
} from '../contracts/types.ts';
import { beginCheckout, paymentInstructions, renderPaymentInstructions } from './checkout.ts';
import { decryptDownload, downloadCiphertext, PUBLIC_TESTNET_MAX_CIPHERTEXT_BYTES } from './download.ts';
import { BEARER_SECRET_WARNING, openPurchaseStore, renderBackupGuidance, type PurchaseStoreOptions } from './purchases.ts';
import { browserWakuNetworkSettings, createWakuOrderTransport, type WakuSellerConfig } from './waku-transport.ts';
import type { WakuConfig, WakuSession } from '../contracts/messages.ts';
import { profileFor, validateCheckoutResult, validateProductSummary, type CheckoutResult, type ProductSummary } from '../contracts/public.ts';

export type ProductViewModel = {
  version: string;
  description: string;
  amountZat: string;
  network: 'test' | 'regtest';
  fileSize: number | null;
  fileFormatVersion: string | null;
  sellerKeyId: string;
};

export type VisibleStatus = {
  paymentLabel: string;
  deliveryLabel: string;
  verificationLabel: string;
  paid: boolean;
  unpaid: boolean;
  scannerProblem: boolean;
  exceptions: string[];
};

export type RenderRoot = {
  innerHTML: string;
  querySelector(selector: string): unknown;
};

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[char] ?? char));
}

function zatToAmount(zat: string): string {
  const n = BigInt(zat);
  const whole = n / 100_000_000n;
  const frac = n % 100_000_000n;
  if (frac === 0n) return whole.toString();
  return `${whole.toString()}.${frac.toString().padStart(8, '0').replace(/0+$/, '')}`;
}

export function formatZec(amountZat: string): string {
  return `${zatToAmount(amountZat)} ZEC`;
}

export function networkBadgeText(network: 'test' | 'regtest'): string {
  const profile = profileFor(network);
  const name = profile.network === 'test' ? 'testnet' : 'regtest';
  return `${name} · ${profile.uaPrefix}`;
}

export function confirmationNotice(network: 'test' | 'regtest', minConfirmations: number): string {
  const name = profileFor(network).network === 'test' ? 'testnet' : 'regtest';
  return `${name}: delivered after ${minConfirmations} confirmations`;
}

function utf8ToBase64Url(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  const base64 = btoa(binary);
  return base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function encodeZip321(invoice: Invoice): string {
  const address = invoice.destination;
  if (
    /^(t[13]|tm)/.test(address)
    || address.startsWith('zs1')
    || address.startsWith('u1')
    || (
      !/^ztestsapling1[0-9a-z]+$/.test(address)
      && !/^utest1[0-9a-z]+$/.test(address)
      && !/^uregtest1[0-9a-z]+$/.test(address)
    )
  ) {
    throw new Error('address is not a testnet or regtest shielded receiver');
  }
  const params = [`amount=${zatToAmount(invoice.amountZat)}`];
  if (invoice.attributionRef) {
    params.push(`memo=${utf8ToBase64Url(invoice.attributionRef)}`);
  }
  return `zcash:${invoice.destination}?${params.join('&')}`;
}

export function buyerVisibleStatus(status: OrderStatus): VisibleStatus {
  const exceptions = status.exceptions.map((item) => item.code);
  const scannerProblem = status.verification === 'unavailable' || status.verification === 'stale';
  const paid = status.payment === 'confirmed';
  const unpaid = status.payment === 'awaiting' && !scannerProblem;
  const paymentLabel = status.payment === 'awaiting' && scannerProblem
    ? 'Waiting on scanner'
    : status.payment === 'awaiting'
      ? 'Awaiting payment'
      : status.payment === 'detected'
        ? 'Payment detected'
        : status.payment === 'confirming'
          ? 'Confirming'
          : status.payment === 'confirmed'
            ? 'Paid'
            : status.payment === 'review_required'
              ? 'Review required'
              : 'Reorganized';
  const deliveryLabel = status.delivery === 'retry_required'
    ? 'Delivery failed'
    : status.delivery === 'acknowledged'
      ? 'Delivered'
      : status.delivery === 'sent_unacknowledged'
        ? 'Sent'
        : status.delivery === 'queued'
          ? 'Queued'
          : status.delivery === 'prepared'
            ? 'Preparing delivery'
            : 'Locked';
  const verificationLabel = status.verification === 'unavailable'
    ? 'Scanner unavailable'
    : status.verification === 'stale'
      ? 'Scanner stale: reconnect'
      : 'Verification available';
  return {
    paymentLabel,
    deliveryLabel,
    verificationLabel,
    paid,
    unpaid,
    scannerProblem,
    exceptions,
  };
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function parseDeliveryPackage(body: unknown): DeliveryPackage {
  if (typeof body !== 'object' || body === null) {
    throw new Error('recover failed: missing envelope');
  }
  const row = body as {
    orderId?: unknown;
    productVersion?: unknown;
    buyerKeyId?: unknown;
    encryptedEnvelope?: unknown;
    packageId?: unknown;
  };
  if (
    typeof row.orderId !== 'string'
    || typeof row.productVersion !== 'string'
    || typeof row.buyerKeyId !== 'string'
    || typeof row.encryptedEnvelope !== 'string'
    || row.encryptedEnvelope.length === 0
  ) {
    throw new Error('recover failed: missing envelope');
  }
  return {
    orderId: row.orderId,
    productVersion: row.productVersion,
    buyerKeyId: row.buyerKeyId,
    encryptedEnvelope: base64ToBytes(row.encryptedEnvelope),
    packageId: typeof row.packageId === 'string' && /^[0-9a-f]{64}$/i.test(row.packageId) ? row.packageId.toLowerCase() : undefined,
  };
}

export function createBrowserTransport(
  credentials: CredentialAdapter,
  origin = '',
  fetchImpl: typeof fetch = (input, init) => fetch(input, init),
): OrderTransport {
  async function post(path: string, body: unknown): Promise<Response> {
    return fetchImpl(`${origin}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  return {
    async create(record) {
      const proof = await credentials.provePossession(record.credentialId, {
        orderId: record.requestId,
      });
      const material = JSON.parse(new TextDecoder().decode(await credentials.exportBackupMaterial(record.credentialId))) as {
        publicKeyHex: string;
      };
      const response = await post('/api/orders', {
        requestId: record.requestId,
        productVersion: record.productVersion,
        buyerKeyId: material.publicKeyHex,
        proof: bytesToBase64(proof),
      });
      if (!response.ok) {
        throw new Error(`order create failed: ${response.status}`);
      }
      return await response.json() as Invoice;
    },
    async status(orderId, credentialId) {
      const proof = await credentials.provePossession(credentialId, { orderId });
      const response = await post('/api/status', {
        orderId,
        proof: bytesToBase64(proof),
      });
      if (!response.ok) {
        throw new Error(`status failed: ${response.status}`);
      }
      return await response.json() as OrderStatus;
    },
    async recover(orderId, credentialId) {
      const proof = await credentials.provePossession(credentialId, { orderId });
      const response = await post('/api/recover', { orderId, proof: bytesToBase64(proof) });
      if (!response.ok) throw new Error(`recover failed: ${response.status}`);
      return parseDeliveryPackage(await response.json());
    },
    async acknowledge(orderId, credentialId, packageId) {
      const proof = await credentials.provePossession(credentialId, { orderId });
      const response = await post('/api/acknowledge', { orderId, packageId, proof: bytesToBase64(proof) });
      if (!response.ok) throw new Error(`acknowledge failed: ${response.status}`);
    },
  };
}

function navPurchasesMarkup(): string {
  return '<button type="button" id="nav-purchases">My purchases</button>';
}

function qrMarkup(uri: string): string {
  const escaped = escapeHtml(uri);
  return `<div data-zip321-qr="true" data-zip321-uri="${escaped}" role="img" aria-label="Payment request QR">
    ${qrSvgMarkup(uri)}
  </div>`;
}

export function renderProductView(root: RenderRoot, input: {
  product: ProductViewModel;
  availability: ServiceAvailability;
  sellerKeyId: string;
  minConfirmations?: number;
}): void {
  const allowed = allowNewCheckout(input.availability);
  const size = input.product.fileSize == null ? 'unknown size' : `${input.product.fileSize} bytes`;
  const format = input.product.fileFormatVersion ?? 'unknown format';
  const floor = input.minConfirmations ?? profileFor(input.product.network).minConfirmationsFloor;
  root.innerHTML = `
    <section id="view-product">
      <h1>${escapeHtml(input.product.description)}</h1>
      <p id="product-price">${escapeHtml(formatZec(input.product.amountZat))}</p>
      <p id="testnet-badge" role="status">${escapeHtml(networkBadgeText(input.product.network))}</p>
      <p id="confirmation-floor">${escapeHtml(confirmationNotice(input.product.network, floor))}</p>
      <p id="seller-identity">${escapeHtml(input.sellerKeyId)}</p>
      <p id="file-details">${escapeHtml(format)} · ${escapeHtml(size)}</p>
      <p id="checkout-unavailable" ${allowed ? 'hidden' : ''}>New checkout is unavailable while a required service is down. Existing purchases can still be recovered.</p>
      <button type="button" id="buy" ${allowed ? '' : 'disabled'}>Buy</button>
      <button type="button" id="nav-purchases">My purchases</button>
    </section>
  `;
}

export function renderCheckoutView(root: RenderRoot, input: {
  purchase: BrowserPurchase;
  now: number;
  persisted: boolean;
  minConfirmations?: number;
}): void {
  const network = input.purchase.network ?? input.purchase.invoice?.network ?? 'test';
  const floor = input.minConfirmations ?? profileFor(network).minConfirmationsFloor;
  const notice = `<p id="confirmation-floor">${escapeHtml(confirmationNotice(network, floor))}</p>`;
  const invoice = input.persisted ? paymentInstructions(input.purchase, input.now) : null;
  if (!input.persisted || !input.purchase.invoice) {
    root.innerHTML = `
      <section id="view-checkout">
        <h1>Checkout</h1>
        <p>Saving this purchase locally before any wallet request.</p>
        ${notice}
        <div id="payment" data-wallet-request="blocked"></div>
        ${navPurchasesMarkup()}
      </section>
    `;
    return;
  }
  if (!invoice) {
    root.innerHTML = `
      <section id="view-checkout">
        <h1>Checkout</h1>
        ${notice}
        <div id="payment"></div>
        ${navPurchasesMarkup()}
      </section>
    `;
    const payment = (root as { querySelector(selector: string): { textContent: string | null; dataset: Record<string, string> } | null }).querySelector('#payment');
    if (payment) {
      renderPaymentInstructions(payment, input.purchase, input.now);
    }
    return;
  }
  const uri = encodeZip321(invoice);
  const escapedUri = escapeHtml(uri);
  root.innerHTML = `
    <section id="view-checkout">
      <h1>Checkout</h1>
      <p>Pay ${escapeHtml(formatZec(invoice.amountZat))} on testnet.</p>
      ${notice}
      ${qrMarkup(uri)}
      <pre id="zip321-uri">${escapedUri}</pre>
      <button type="button" id="copy-uri">Copy payment URI</button>
      <a id="open-uri" href="${escapedUri}" data-wallet-request="ready">Open payment URI</a>
      <p>Payment URI is shown exactly. Wallet memo and receiver preservation has not been verified in this browser.</p>
      ${navPurchasesMarkup()}
    </section>
  `;
}

export function renderStatusView(root: RenderRoot, orderStatus: OrderStatus): void {
  const visible = buyerVisibleStatus(orderStatus);
  const exceptionText = visible.exceptions.length
    ? `<ul id="status-exceptions">${visible.exceptions.map((code) => `<li>${escapeHtml(code)}</li>`).join('')}</ul>`
    : '';
  root.innerHTML = `
    <section id="view-status">
      <h1>Purchase status</h1>
      <p id="payment-label">${escapeHtml(visible.paymentLabel)}</p>
      <p id="delivery-label">${escapeHtml(visible.deliveryLabel)}</p>
      <p id="verification-label" data-verification="${escapeHtml(orderStatus.verification)}">${escapeHtml(visible.verificationLabel)}</p>
      <p role="note">This status is informational until confirmed by a seller-authenticated response.</p>
      ${exceptionText}
      ${navPurchasesMarkup()}
    </section>
  `;
}

export function renderPurchasesView(root: RenderRoot, input: { purchases: BrowserPurchase[]; notice?: string }): void {
  const rows = input.purchases.map((item) => (
    `<li><button type="button" data-request-id="${escapeHtml(item.requestId)}">${escapeHtml(item.requestId)}</button></li>`
  )).join('');
  root.innerHTML = `
    <section id="view-purchases">
      <h1>My purchases</h1>
      <p id="backup-warning"></p>
      <button type="button" id="export-backup">Export backup</button>
      <label for="import-backup">Import backup <input type="file" id="import-backup" accept=".backup"></label>
      ${input.notice ? `<p role="status" id="import-status">${escapeHtml(input.notice)}</p>` : ''}
      <ul>${rows}</ul>
    </section>
  `;
  const warning = (root as { querySelector(selector: string): { textContent: string | null; setAttribute(name: string, value: string): void } | null }).querySelector('#backup-warning');
  if (warning) {
    renderBackupGuidance(warning);
  }
}

export type BrowserViewRenderer = {
  product: typeof renderProductView;
  checkout: typeof renderCheckoutView;
  status: typeof renderStatusView;
  purchases: typeof renderPurchasesView;
  catalogue: (root: RenderRoot, input: {
    items: ProductSummary[];
    product: ProductViewModel;
    availability: ServiceAvailability;
    sellerKeyId: string;
    minConfirmations: number;
  }) => void;
  missing: (root: RenderRoot) => void;
  error: (root: RenderRoot) => void;
};

export type BrowserHooks = {
  buyerVisibleStatus: typeof buyerVisibleStatus;
  encodeZip321: typeof encodeZip321;
  renderProductView: typeof renderProductView;
  renderCheckoutView: typeof renderCheckoutView;
  renderStatusView: typeof renderStatusView;
  renderPurchasesView: typeof renderPurchasesView;
  createBrowserTransport: typeof createBrowserTransport;
  createCredentialAdapter: typeof createCredentialAdapter;
  decryptDownload: typeof decryptDownload;
};

function exposeHooks(): void {
  const w = (globalThis as { window?: { __ssf?: BrowserHooks } }).window;
  if (!w) return;
  w.__ssf = {
    buyerVisibleStatus,
    encodeZip321,
    renderProductView,
    renderCheckoutView,
    renderStatusView,
    renderPurchasesView,
    createBrowserTransport,
    createCredentialAdapter,
    decryptDownload,
  };
}

function pageOrigin(): string {
  return (globalThis as { location?: { origin?: string } }).location?.origin ?? '';
}

function newRequestId(): string {
  const id = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto?.randomUUID?.();
  return id ?? `req-${Date.now()}`;
}

function closestAttribute(target: unknown, name: string): string | null {
  let node = target as { getAttribute?(attr: string): string | null; id?: string; parentElement?: unknown } | null;
  while (node) {
    const value = node.getAttribute?.(name);
    if (value) return value;
    if (name === 'id' && node.id) return node.id;
    node = (node.parentElement as typeof node) ?? null;
  }
  return null;
}

function setDataAttribute(target: unknown, id: string, name: string, value: string): void {
  let node = target as { id?: string; setAttribute?(n: string, v: string): void; parentElement?: unknown } | null;
  while (node) {
    if (node.id === id) {
      node.setAttribute?.(name, value);
      return;
    }
    node = (node.parentElement as typeof node) ?? null;
  }
}

function downloadBytes(filename: string, data: Uint8Array): void {
  const g = globalThis as unknown as {
    Blob?: new (parts: Uint8Array[], options?: { type?: string }) => object;
    URL?: { createObjectURL(blob: object): string; revokeObjectURL(url: string): void };
    document?: { createElement(tag: string): { href: string; download: string; click(): void } };
  };
  if (!g.Blob || !g.URL || !g.document) return;
  const blob = new g.Blob([data], { type: 'application/octet-stream' });
  const url = g.URL.createObjectURL(blob);
  const anchor = g.document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  g.URL.revokeObjectURL(url);
}

type AppRoot = RenderRoot & {
  addEventListener(type: string, listener: (event: { target: unknown }) => unknown): void;
};

/** GET /api/waku-config. Fixture mode 404s. Absent wakuNetwork means DefaultNetworkConfig. */
export type PublicWakuConfig = {
  sellerKeyId: string;
  network: 'regtest' | 'test';
  contentTopic: string;
  bootstrapPeers: string[];
  wakuNetwork?: { clusterId: number; shards: number[] };
};

/**
 * `fixture`: the seller answered 404 → HTTP transport (fixture seller only).
 * `waku`: real-demo → every order call runs over a Waku session scoped to the
 * purchase credential it acts for. `unavailable`: waku-config could not be
 * read or was malformed → no order transport at all (never HTTP).
 */
export type TransportMode = 'fixture' | 'waku' | 'unavailable';

export type BrowserAppDeps = {
  renderer?: BrowserViewRenderer;
  fetch?: typeof fetch;
  credentials?: CredentialAdapter;
  openStore?: (options: PurchaseStoreOptions) => Promise<PurchaseStore>;
  /** Defaults to `credentials.createWakuSession`. */
  createSession?: (credentialId: string, config: WakuConfig) => Promise<WakuSession>;
  /**
   * Verified decrypt of a recovered package. Defaults to `decryptDownload`.
   * An acknowledgement is sent only after this resolves.
   */
  decrypt?: typeof decryptDownload;
  origin?: string;
  peerTimeoutMs?: number;
};

export type BrowserApp = { transportMode: TransportMode };

const DEFAULT_PEER_TIMEOUT_MS = 10_000;

const VERIFICATION_UNAVAILABLE: OrderStatus = {
  payment: 'awaiting',
  delivery: 'locked',
  verification: 'unavailable',
  exceptions: [{ code: 'verification_unavailable' }],
};

function parsePublicWakuConfig(body: unknown): PublicWakuConfig | null {
  if (typeof body !== 'object' || body === null) return null;
  const row = body as Record<string, unknown>;
  if (typeof row.sellerKeyId !== 'string' || !/^[0-9a-f]{66}$|^[0-9a-f]{130}$/i.test(row.sellerKeyId)) return null;
  if (row.network !== 'regtest' && row.network !== 'test') return null;
  if (typeof row.contentTopic !== 'string' || row.contentTopic.length === 0) return null;
  if (!Array.isArray(row.bootstrapPeers) || !row.bootstrapPeers.every((p) => typeof p === 'string' && p.length > 0)) return null;
  const bootstrapPeers = [...row.bootstrapPeers as string[]];
  let wakuNetwork: { clusterId: number; shards: number[] } | undefined;
  if ('wakuNetwork' in row) {
    const field = row.wakuNetwork;
    if (typeof field !== 'object' || field === null || Array.isArray(field)) return null;
    const network = field as Record<string, unknown>;
    const keys = Object.keys(network);
    if (keys.length !== 2 || network.clusterId === undefined || network.shards === undefined) return null;
    if (!Number.isInteger(network.clusterId) || !Array.isArray(network.shards)) return null;
    if (!network.shards.every((shard) => Number.isInteger(shard))) return null;
    wakuNetwork = { clusterId: network.clusterId as number, shards: [...network.shards as number[]] };
    try {
      browserWakuNetworkSettings({ network: wakuNetwork, bootstrapPeers });
    } catch {
      return null;
    }
  }
  return {
    sellerKeyId: row.sellerKeyId.toLowerCase(),
    network: row.network,
    contentTopic: row.contentTopic,
    bootstrapPeers,
    ...(wakuNetwork === undefined ? {} : { wakuNetwork }),
  };
}

/**
 * One-shot boot probe. A 404 is only a fixture-mode *candidate*: fixture mode
 * also requires the fixture seller's product marker (`network === 'test'`).
 * A 404 on any other origin is `unavailable`, never a fail-open HTTP attempt.
 */
async function probeWakuConfig(fetchImpl: typeof fetch): Promise<PublicWakuConfig | 'fixture-candidate' | null> {
  try {
    const res = await fetchImpl('/api/waku-config');
    if (!res.ok) {
      // Drain the body so the request completes (an unread body keeps it open).
      await res.text().catch(() => undefined);
      return res.status === 404 ? 'fixture-candidate' : null;
    }
    return parsePublicWakuConfig(await res.json());
  } catch {
    return null;
  }
}

/** Runs `fn` with an order transport for exactly one purchase credential. */
type ScopedTransport = <T>(credentialId: string, fn: (transport: OrderTransport) => Promise<T>) => Promise<T>;

export async function startBrowserApp(root: RenderRoot, deps: BrowserAppDeps = {}): Promise<BrowserApp> {
  exposeHooks();
  const fetchImpl: typeof fetch = deps.fetch ?? ((input, init) => fetch(input, init));
  const pathname = (globalThis as { location?: { pathname?: string } }).location?.pathname || '/';
  const routeMatch = /^\/p\/([A-Za-z0-9_-]{1,128})$/.exec(pathname);
  let routeProduct: string | null = null;
  if (routeMatch?.[1]) {
    try {
      routeProduct = decodeURIComponent(routeMatch[1]);
    } catch {
      routeProduct = null;
    }
  }
  let product: ProductViewModel = {
    version: 'book-v1',
    description: 'Product',
    amountZat: '100000000',
    network: 'test',
    fileSize: null,
    fileFormatVersion: null,
    sellerKeyId: '',
  };
  let availability: ServiceAvailability = {
    productPublished: false,
    messaging: false,
    storageReplica: false,
    scanner: false,
  };
  let catalogueItems: ProductSummary[] = [];
  let routeFound = routeProduct === null;
  const wakuProbe = probeWakuConfig(fetchImpl);
  try {
    const productsPath = routeProduct
      ? `/api/products/${encodeURIComponent(routeProduct)}`
      : '/api/products';
    const availabilityPath = routeProduct
      ? `/api/availability?productVersion=${encodeURIComponent(routeProduct)}`
      : '/api/availability';
    const [productRes, availabilityRes, productsRes] = await Promise.all([
      fetchImpl('/api/product'),
      fetchImpl(availabilityPath),
      fetchImpl(productsPath),
    ]);
    if (productRes.ok) {
      product = await productRes.json() as ProductViewModel;
    }
    if (availabilityRes.ok) {
      availability = await availabilityRes.json() as ServiceAvailability;
    }
    if (productsRes.ok) {
      const body: unknown = await productsRes.json();
      if (routeProduct) {
        const summary = validateProductSummary(body);
        routeFound = summary.version === routeProduct;
        product = {
          ...product,
          version: summary.version,
          description: summary.description,
          amountZat: summary.amountZat,
          network: summary.network,
          fileSize: summary.sizeBytes,
          fileFormatVersion: product.version === summary.version ? product.fileFormatVersion : summary.mediaType,
        };
        catalogueItems = [summary];
      } else if (Array.isArray(body)) {
        catalogueItems = body.map((item) => validateProductSummary(item));
      }
    } else {
      await productsRes.text().catch(() => undefined);
    }
  } catch {
    // Product metadata is informational until the seller answers.
  }

  const credentials = deps.credentials ?? createCredentialAdapter();
  const decrypt = deps.decrypt ?? decryptDownload;
  const origin = deps.origin ?? pageOrigin();

  // Transport selection happens exactly once, here. Real-demo never uses HTTP
  // order routes, and a Waku failure never falls back to them. The store opens
  // after the probe so a verified waku-config can supply the content topic a
  // v2 backup's delivery is re-verified against.
  const probe = await wakuProbe;
  let transportMode: TransportMode;
  let withTransport: ScopedTransport;
  let checkoutNetwork: 'regtest' | 'test' = 'test';
  // Fixture mode needs the 404 *and* the fixture seller's product marker.
  // A misrouting proxy 404 on a real-demo origin (network !== 'test') yields
  // unavailable rather than a fail-open HTTP attempt.
  const wakuConfigProbe = probe !== null && probe !== 'fixture-candidate'
    && (!product.sellerKeyId || product.sellerKeyId.toLowerCase() === probe.sellerKeyId)
    ? probe
    : null;
  const storePromise: Promise<PurchaseStore> = (deps.openStore ?? openPurchaseStore)({
    sellerOrigin: origin,
    sellerKeyId: product.sellerKeyId,
    credentials,
    ...(wakuConfigProbe ? { contentTopic: wakuConfigProbe.contentTopic } : {}),
  });
  if (probe === 'fixture-candidate' && product.network === 'test') {
    transportMode = 'fixture';
    const http = createBrowserTransport(credentials, '', fetchImpl);
    withTransport = async (_credentialId, fn) => fn(http);
  } else if (wakuConfigProbe) {
    transportMode = 'waku';
    checkoutNetwork = wakuConfigProbe.network;
    const wakuConfig = {
      contentTopic: wakuConfigProbe.contentTopic,
      bootstrapPeers: wakuConfigProbe.bootstrapPeers,
      peerTimeoutMs: deps.peerTimeoutMs ?? DEFAULT_PEER_TIMEOUT_MS,
      ...(wakuConfigProbe.wakuNetwork === undefined ? {} : { network: wakuConfigProbe.wakuNetwork }),
    };
    const createSession = deps.createSession
      ?? ((credentialId: string, config: WakuConfig) => credentials.createWakuSession(credentialId, config));
    const sellerConfig: WakuSellerConfig = {
      sellerKeyId: wakuConfigProbe.sellerKeyId,
      network: wakuConfigProbe.network,
      amountZat: product.amountZat,
      productVersion: product.version,
    };
    withTransport = async (credentialId, fn) => {
      // A fresh session per purchase credential: its signing/decryption key
      // is that credential's key, so each purchase speaks as its own buyer.
      const session = await createSession(credentialId, wakuConfig);
      try {
        const store = await storePromise;
        const transport = createWakuOrderTransport(credentials, session, sellerConfig, store);
        // Subscribe before any request so a seller-pushed delivery arriving
        // while this session is open is verified and persisted.
        await transport.listen();
        return await fn(transport);
      } finally {
        await session.close().catch(() => undefined);
      }
    };
  } else {
    transportMode = 'unavailable';
    availability = { ...availability, messaging: false };
    withTransport = async () => {
      throw new Error('order messaging unavailable');
    };
  }

  // Checkout learns the credential only inside beginCheckout, so route each
  // call to a transport scoped to the record's own credential.
  const checkoutTransport: OrderTransport = {
    create: (record) => withTransport(record.credentialId, (t) => t.create(record)),
    status: (orderId, credentialId) => withTransport(credentialId, (t) => t.status(orderId, credentialId)),
    recover: (orderId, credentialId) => withTransport(credentialId, (t) => t.recover(orderId, credentialId)),
    acknowledge: (orderId, credentialId, packageId) => withTransport(credentialId, (t) => t.acknowledge(orderId, credentialId, packageId)),
  };

  const dataset = root as { getAttribute?(name: string): string | null; dataset?: Record<string, string> };
  const configuredFloor = Number(dataset.dataset?.minConfirmations ?? dataset.getAttribute?.('data-min-confirmations') ?? '');
  const minConfirmations = Number.isInteger(configuredFloor) && configuredFloor > 0
    ? configuredFloor
    : profileFor(product.network).minConfirmationsFloor;
  const embedOrigins = dataset.dataset?.embedOrigins ?? dataset.getAttribute?.('data-embed-origins') ?? '';
  const search = (globalThis as { location?: { search?: string } }).location?.search ?? '';
  const embedCheckout = new URLSearchParams(search).get('embed') === '1';
  let openerOrigin = '';
  const referrer = (globalThis as { document?: { referrer?: string } }).document?.referrer ?? '';
  if (referrer) {
    try {
      openerOrigin = new URL(referrer).origin;
    } catch {
      openerOrigin = '';
    }
  }
  let postedPurchase: BrowserPurchase | null = null;
  const originAllowed = (candidate: string): boolean => {
    if (embedOrigins === '*') return true;
    return embedOrigins.split(',').map((part) => part.trim()).includes(candidate);
  };
  const postCheckout = (purchase: BrowserPurchase): void => {
    if (!embedCheckout || !openerOrigin || !originAllowed(openerOrigin)) return;
    const result: CheckoutResult = {
      type: 'ssf:checkout',
      version: purchase.productVersion,
      requestId: purchase.requestId,
      state: 'invoiced',
    };
    try {
      validateCheckoutResult(result);
    } catch {
      return;
    }
    const opener = (globalThis as { opener?: { postMessage?(data: CheckoutResult, origin: string): void } | null }).opener;
    opener?.postMessage?.(result, openerOrigin);
  };
  if (embedCheckout) {
    (globalThis as { addEventListener?(type: string, listener: (event: { origin: string; data: unknown; source: unknown }) => void): void })
      .addEventListener?.('message', (event) => {
        if (!event.data || typeof event.data !== 'object' || !('type' in event.data) || event.data.type !== 'ssf:hello') return;
        if (event.source !== (globalThis as { opener?: unknown }).opener) return;
        if (!originAllowed(event.origin)) return;
        openerOrigin = event.origin;
        if (postedPurchase) postCheckout(postedPurchase);
      });
  }

  const showProduct = (): void => {
    (deps.renderer?.product ?? renderProductView)(root, {
      product,
      availability,
      sellerKeyId: product.sellerKeyId,
      minConfirmations,
    });
  };

  const showHome = (): void => {
    if (catalogueItems.length === 0) {
      showProduct();
      return;
    }
    if (deps.renderer) {
      deps.renderer.catalogue(root, {
        items: catalogueItems,
        product,
        availability,
        sellerKeyId: product.sellerKeyId,
        minConfirmations,
      });
      return;
    }
    const rows = catalogueItems.map((item) => (
      `<li><a href="/p/${escapeHtml(encodeURIComponent(item.version))}">${escapeHtml(item.title)}</a> `
      + `<span>${escapeHtml(formatZec(item.amountZat))}</span> `
      + `<span>${escapeHtml(networkBadgeText(item.network))}</span></li>`
    )).join('');
    const featured: RenderRoot = { innerHTML: '', querySelector() { return null; } };
    renderProductView(featured, {
      product,
      availability,
      sellerKeyId: product.sellerKeyId,
      minConfirmations,
    });
    root.innerHTML = `<section id="view-catalogue"><h1>Catalogue</h1><ul>${rows}</ul></section>${featured.innerHTML}`;
  };

  const showCheckout = (purchase: BrowserPurchase): void => {
    (deps.renderer?.checkout ?? renderCheckoutView)(root, {
      purchase,
      now: Date.now(),
      persisted: true,
      minConfirmations,
    });
  };

  const showPurchases = async (): Promise<void> => {
    const store = await storePromise;
    const purchases = await store.list();
    const skipped = (purchases as { skipped?: number }).skipped ?? 0;
    (deps.renderer?.purchases ?? renderPurchasesView)(root, {
      purchases,
      ...(skipped > 0 ? { notice: 'Some purchases could not be read' } : {}),
    });
  };

  const onBuy = async (): Promise<void> => {
    if (!allowNewCheckout(availability)) return;
    try {
      const store = await storePromise;
      const draft = {
        version: 1 as const,
        requestId: newRequestId(),
        productVersion: product.version,
        sellerOrigin: origin,
        sellerKeyId: product.sellerKeyId,
      };
      await beginCheckout(store, checkoutTransport, credentials, draft, { network: checkoutNetwork });
      const saved = await store.get(draft.requestId);
      if (!saved) {
        throw new Error('purchase draft was not persisted');
      }
      showCheckout(saved);
      postedPurchase = saved;
      postCheckout(saved);
    } catch {
      if (deps.renderer) deps.renderer.error(root);
      else root.innerHTML = `<section id="view-error"><h1>Checkout could not start</h1><p>Your purchase record may still be in this browser. Open My purchases to inspect it.</p>${navPurchasesMarkup()}</section>`;
    }
  };

  const onCopy = async (target: unknown): Promise<void> => {
    const uriEl = root.querySelector('#zip321-uri') as { textContent?: string | null } | null;
    const uri = uriEl?.textContent ?? '';
    if (!uri) return;
    const nav = (globalThis as { navigator?: { clipboard?: { writeText(text: string): Promise<void> } } }).navigator;
    try {
      await nav?.clipboard?.writeText(uri);
    } catch {
      // Copy/link alternatives remain visible if the clipboard API is blocked.
    }
    setDataAttribute(target, 'copy-uri', 'data-copied', 'true');
  };

  const onExport = async (target: unknown): Promise<void> => {
    const store = await storePromise;
    const purchases = await store.list();
    for (const item of purchases) {
      const data = await store.exportBackup(item.requestId);
      downloadBytes(`purchase-${item.requestId}.backup`, data);
    }
    setDataAttribute(target, 'export-backup', 'data-exported', 'true');
  };

  // Import a purchase backup chosen through the file control; the store
  // verifies and migrates it. Errors show a fixed message (no backup detail).
  const onImport = async (target: unknown): Promise<void> => {
    const input = target as { files?: ArrayLike<{ arrayBuffer(): Promise<ArrayBuffer> }>; value?: string };
    const file = input.files?.[0];
    if (!file) return;
    const store = await storePromise;
    let notice = 'Backup imported';
    try {
      await store.importBackup(new Uint8Array(await file.arrayBuffer()));
    } catch {
      notice = 'Backup could not be imported';
    }
    if (typeof input.value === 'string') input.value = '';
    (deps.renderer?.purchases ?? renderPurchasesView)(root, { purchases: await store.list(), notice });
  };

  const onOpenPurchase = async (requestId: string): Promise<void> => {
    const store = await storePromise;
    const purchase = await store.get(requestId);
    if (!purchase?.orderId) return;
    const orderId = purchase.orderId;
    const credentialId = purchase.credentialId;
    try {
      // One transport (one Waku session in real-demo) scoped to *this*
      // purchase's credential, for both the status and the recover call.
      await withTransport(credentialId, async (transport) => {
        const orderStatus = await transport.status(orderId, credentialId);
        (deps.renderer?.status ?? renderStatusView)(root, orderStatus);
        try {
          const pkg = await transport.recover(orderId, credentialId);
          const maxCiphertextBytes = checkoutNetwork === 'regtest'
            ? FIRST_RELEASE_MAX_CIPHERTEXT_BYTES
            : PUBLIC_TESTNET_MAX_CIPHERTEXT_BYTES;
          const ciphertext = await downloadCiphertext(
            `/ciphertext/${encodeURIComponent(pkg.productVersion)}`,
            splitDeliveryEnvelope(pkg.encryptedEnvelope).header.digestHex,
            undefined,
            maxCiphertextBytes,
            fetchImpl,
          );
          const blob = await decrypt(pkg, ciphertext, {
            crypto: createCryptoAdapter({ credentials }),
            credentialId,
            maxCiphertextBytes,
          });
          downloadBytes(`${pkg.productVersion}.bin`, new Uint8Array(await blob.arrayBuffer()));
          // Acknowledge only after a verified decrypt, over the same scoped transport.
          if (pkg.packageId) await transport.acknowledge(orderId, credentialId, pkg.packageId);
        } catch {
          // Status is informational; recovery may be ineligible until payment confirms.
        }
      });
    } catch {
      // No verified answer (Waku failed to start, no peers, timeout): show the
      // existing "verification unavailable" state. Never retry over HTTP.
      (deps.renderer?.status ?? renderStatusView)(root, VERIFICATION_UNAVAILABLE);
    }
  };

  (root as AppRoot).addEventListener('click', (event) => {
    const id = closestAttribute(event.target, 'id');
    if (id === 'buy') {
      void onBuy();
      return;
    }
    if (id === 'copy-uri') {
      void onCopy(event.target);
      return;
    }
    if (id === 'nav-purchases') {
      void showPurchases();
      return;
    }
    if (id === 'export-backup') {
      void onExport(event.target);
      return;
    }
    const requestId = closestAttribute(event.target, 'data-request-id');
    if (requestId) {
      void onOpenPurchase(requestId);
    }
  });

  (root as AppRoot).addEventListener('change', (event) => {
    if (closestAttribute(event.target, 'id') === 'import-backup') void onImport(event.target);
  });

  if (routeProduct && !routeFound) {
    if (deps.renderer) deps.renderer.missing(root);
    else root.innerHTML = `<section id="view-missing"><h1>Product not found</h1>${navPurchasesMarkup()}</section>`;
  } else if (routeProduct) {
    showProduct();
  } else {
    showHome();
  }
  void storePromise;
  return { transportMode };
}

exposeHooks();

export { BEARER_SECRET_WARNING };

import { createCredentialAdapter } from '../adapters/credentials.ts';
import { createCryptoAdapter } from '../adapters/crypto.ts';
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
import { decryptDownload } from './download.ts';
import { BEARER_SECRET_WARNING, openPurchaseStore, renderBackupGuidance } from './purchases.ts';

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

type RenderRoot = {
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
      ? 'Scanner stale — reconnect'
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
  };
}

export function createBrowserTransport(
  credentials: CredentialAdapter,
  origin = '',
): OrderTransport {
  async function post(path: string, body: unknown): Promise<Response> {
    return fetch(`${origin}${path}`, {
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
      const response = await post('/api/recover', {
        orderId,
        proof: bytesToBase64(proof),
      });
      if (!response.ok) {
        throw new Error(`recover failed: ${response.status}`);
      }
      return parseDeliveryPackage(await response.json());
    },
  };
}

function navPurchasesMarkup(): string {
  return '<button type="button" id="nav-purchases">My purchases</button>';
}

function qrMarkup(uri: string): string {
  const escaped = escapeHtml(uri);
  return `<div data-zip321-qr="true" data-zip321-uri="${escaped}" role="img" aria-label="Payment request QR">
    <svg viewBox="0 0 21 21" width="168" height="168" aria-hidden="true">
      <rect width="21" height="21" fill="#fff"/>
      <rect x="0" y="0" width="7" height="7" fill="#111"/>
      <rect x="14" y="0" width="7" height="7" fill="#111"/>
      <rect x="0" y="14" width="7" height="7" fill="#111"/>
      <rect x="2" y="2" width="3" height="3" fill="#fff"/>
      <rect x="16" y="2" width="3" height="3" fill="#fff"/>
      <rect x="2" y="16" width="3" height="3" fill="#fff"/>
    </svg>
  </div>`;
}

export function renderProductView(root: RenderRoot, input: {
  product: ProductViewModel;
  availability: ServiceAvailability;
  sellerKeyId: string;
}): void {
  const allowed = allowNewCheckout(input.availability);
  const size = input.product.fileSize == null ? 'unknown size' : `${input.product.fileSize} bytes`;
  const format = input.product.fileFormatVersion ?? 'unknown format';
  root.innerHTML = `
    <section id="view-product">
      <h1>${escapeHtml(input.product.description)}</h1>
      <p id="product-price">${escapeHtml(formatZec(input.product.amountZat))}</p>
      <p id="testnet-badge" role="status">Testnet</p>
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
}): void {
  const invoice = input.persisted ? paymentInstructions(input.purchase, input.now) : null;
  if (!input.persisted || !input.purchase.invoice) {
    root.innerHTML = `
      <section id="view-checkout">
        <h1>Checkout</h1>
        <p>Saving this purchase locally before any wallet request.</p>
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

export function renderPurchasesView(root: RenderRoot, input: { purchases: BrowserPurchase[] }): void {
  const rows = input.purchases.map((item) => (
    `<li><button type="button" data-request-id="${escapeHtml(item.requestId)}">${escapeHtml(item.requestId)}</button></li>`
  )).join('');
  root.innerHTML = `
    <section id="view-purchases">
      <h1>My purchases</h1>
      <p id="backup-warning"></p>
      <button type="button" id="export-backup">Export backup</button>
      <ul>${rows}</ul>
    </section>
  `;
  const warning = (root as { querySelector(selector: string): { textContent: string | null; setAttribute(name: string, value: string): void } | null }).querySelector('#backup-warning');
  if (warning) {
    renderBackupGuidance(warning);
  }
}

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

async function startBrowserApp(root: RenderRoot): Promise<void> {
  exposeHooks();
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
  try {
    const [productRes, availabilityRes] = await Promise.all([
      fetch('/api/product'),
      fetch('/api/availability'),
    ]);
    if (productRes.ok) {
      product = await productRes.json() as ProductViewModel;
    }
    if (availabilityRes.ok) {
      availability = await availabilityRes.json() as ServiceAvailability;
    }
  } catch {
    // Product metadata is informational until the seller answers.
  }

  const credentials = createCredentialAdapter();
  const transport = createBrowserTransport(credentials);
  const origin = pageOrigin();
  const storePromise: Promise<PurchaseStore> = openPurchaseStore({
    sellerOrigin: origin,
    sellerKeyId: product.sellerKeyId,
    credentials,
  });

  const showProduct = (): void => {
    renderProductView(root, {
      product,
      availability,
      sellerKeyId: product.sellerKeyId,
    });
  };

  const showCheckout = (purchase: BrowserPurchase): void => {
    renderCheckoutView(root, {
      purchase,
      now: Date.now(),
      persisted: true,
    });
  };

  const showPurchases = async (): Promise<void> => {
    const store = await storePromise;
    renderPurchasesView(root, { purchases: await store.list() });
  };

  const onBuy = async (): Promise<void> => {
    if (!allowNewCheckout(availability)) return;
    const store = await storePromise;
    const draft = {
      version: 1 as const,
      requestId: newRequestId(),
      productVersion: product.version,
      sellerOrigin: origin,
      sellerKeyId: product.sellerKeyId,
    };
    await beginCheckout(store, transport, credentials, draft);
    const saved = await store.get(draft.requestId);
    if (!saved) {
      throw new Error('purchase draft was not persisted');
    }
    showCheckout(saved);
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

  const onOpenPurchase = async (requestId: string): Promise<void> => {
    const store = await storePromise;
    const purchase = await store.get(requestId);
    if (!purchase?.orderId) return;
    const orderStatus = await transport.status(purchase.orderId, purchase.credentialId);
    renderStatusView(root, orderStatus);
    try {
      const pkg = await transport.recover(purchase.orderId, purchase.credentialId);
      const cipherRes = await fetch(`/ciphertext/${encodeURIComponent(pkg.productVersion)}`);
      if (!cipherRes.ok) return;
      const ciphertext = new Uint8Array(await cipherRes.arrayBuffer());
      const blob = await decryptDownload(pkg, ciphertext, {
        crypto: createCryptoAdapter({ credentials }),
        credentialId: purchase.credentialId,
      });
      downloadBytes(`${pkg.productVersion}.bin`, new Uint8Array(await blob.arrayBuffer()));
    } catch {
      // Status is informational; recovery may be ineligible until payment confirms.
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

  showProduct();
  void storePromise;
}

exposeHooks();
const doc = (globalThis as { document?: { getElementById(id: string): RenderRoot | null } }).document;
const appRoot = doc?.getElementById('app');
if (appRoot) {
  void startBrowserApp(appRoot);
}

export { BEARER_SECRET_WARNING };

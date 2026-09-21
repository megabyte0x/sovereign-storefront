import { createCredentialAdapter } from '../adapters/credentials.ts';
import {
  allowNewCheckout,
  type BrowserPurchase,
  type CredentialAdapter,
  type Invoice,
  type OrderStatus,
  type OrderTransport,
  type ServiceAvailability,
} from '../contracts/types.ts';
import { paymentInstructions, renderPaymentInstructions } from './checkout.ts';
import { BEARER_SECRET_WARNING, renderBackupGuidance } from './purchases.ts';

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
      const proof = await credentials.provePossession(record.credentialId);
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
      const proof = await credentials.provePossession(credentialId);
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
      const proof = await credentials.provePossession(credentialId);
      const response = await post('/api/recover', {
        orderId,
        proof: bytesToBase64(proof),
      });
      if (!response.ok) {
        throw new Error(`recover failed: ${response.status}`);
      }
      return await response.json() as never;
    },
  };
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
      </section>
    `;
    return;
  }
  if (!invoice) {
    root.innerHTML = `
      <section id="view-checkout">
        <h1>Checkout</h1>
        <div id="payment"></div>
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
  };
}

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
  renderProductView(root, {
    product,
    availability,
    sellerKeyId: product.sellerKeyId,
  });
  const doc = globalThis as unknown as {
    document: {
      getElementById(id: string): { addEventListener(type: string, listener: () => void): void } | null;
    };
  };
  doc.document.getElementById('nav-purchases')?.addEventListener('click', () => {
    renderPurchasesView(root, { purchases: [] });
  });
}

exposeHooks();
const doc = (globalThis as { document?: { getElementById(id: string): RenderRoot | null } }).document;
const appRoot = doc?.getElementById('app');
if (appRoot) {
  void startBrowserApp(appRoot);
}

export { BEARER_SECRET_WARNING };

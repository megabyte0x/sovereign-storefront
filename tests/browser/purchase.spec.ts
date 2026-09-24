import { rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';
import { createServer, type ViteDevServer } from 'vite';
import { createCredentialAdapter } from '../../src/adapters/credentials.ts';
import { createMemoryMessaging } from '../../src/adapters/messaging.ts';
import { MemoryScanner } from '../../src/adapters/scanner.ts';
import { loadConfig } from '../../src/config.ts';
import { startSeller, type SellerServer } from '../../src/seller/server.ts';
import {
  buyerVisibleStatus,
  encodeZip321,
  type BrowserHooks,
} from '../../src/browser/app.ts';
import type { Invoice, OrderStatus } from '../../src/contracts/types.ts';

declare const window: { __ssf: BrowserHooks };
declare const document: {
  getElementById(id: string): {
    innerHTML: string;
    querySelector(selector: string): unknown;
  } | null;
  createElement(tag: string): {
    innerHTML: string;
    querySelector(selector: string): {
      textContent: string | null;
      getAttribute(name: string): string | null;
    } | null;
    textContent: string | null;
  };
};
declare const location: { origin: string };

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const ORIGIN = 'http://127.0.0.1:4174';
const CHROMIUM = '/usr/bin/chromium';
const CHROMIUM_ARGS = ['--no-sandbox', '--disable-dev-shm-usage'];

const DESTINATION =
  'uregtest1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq';
const CONFIG_DESTINATION =
  'uregtest1zconfigdestinationqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq';

test.use({
  launchOptions: {
    executablePath: CHROMIUM,
    args: CHROMIUM_ARGS,
  },
});

test.describe.configure({ mode: 'serial' });

let vite: ViteDevServer;
let seller: SellerServer;
let scanner: MemoryScanner;
let messaging: ReturnType<typeof createMemoryMessaging>;

const invoice: Invoice = {
  id: 'inv-1',
  orderId: 'ord-1',
  productVersion: 'book-v1',
  buyerKeyId: 'buyer-1',
  network: 'test',
  amountZat: '100000000',
  destination: DESTINATION,
  attributionRef: 'attr-demo-1',
  expiresAt: Date.now() + 86_400_000,
};

function status(partial: Partial<OrderStatus> & Pick<OrderStatus, 'payment'>): OrderStatus {
  return {
    delivery: 'locked',
    verification: 'available',
    exceptions: [],
    ...partial,
  };
}

test.beforeAll(async () => {
  rmSync(join(ROOT, '.tmp-purchase-spec.sqlite'), { force: true });
  const config = loadConfig({
    SSF_MODE: 'fixture',
    SSF_NETWORK: 'test',
    SSF_MIN_CONFIRMATIONS: '10',
    SSF_MAX_HEALTH_AGE_MS: '120000',
    SSF_MAX_CIPHERTEXT_BYTES: '73',
    SSF_MAX_PLAINTEXT_BYTES: '41',
    SSF_INVOICE_TTL_MS: '86400000',
    SSF_PUBLIC_HOST: '127.0.0.1',
    SSF_PUBLIC_PORT: '0',
    SSF_ADMIN_HOST: '127.0.0.1',
    SSF_ADMIN_PORT: '0',
    SSF_DB_PATH: join(ROOT, '.tmp-purchase-spec.sqlite'),
    SSF_SELLER_KEY_ID: 'seller-key-1',
    SSF_DESTINATION: CONFIG_DESTINATION,
    SSF_ADAPTER_MESSAGING: 'fixture',
    SSF_ADAPTER_STORAGE: 'fixture',
    SSF_ADAPTER_SCANNER: 'fixture',
    SSF_ADMIN_TOKEN: 'admin-secret-not-for-browser',
  });
  scanner = new MemoryScanner();
  scanner.replaceSnapshot([], { id: 'rev-10', height: 10 }, true, Date.now());
  messaging = createMemoryMessaging();
  seller = await startSeller({
    config,
    seedProduct: true,
    scanner,
    messaging,
  });
  vite = await createServer({
    root: ROOT,
    server: {
      host: '127.0.0.1',
      port: 4174,
      strictPort: true,
      proxy: {
        '/api': seller.publicUrl,
        '/ciphertext': seller.publicUrl,
      },
    },
  });
  await vite.listen();
});

test.afterAll(async () => {
  await vite?.close();
  await seller?.close();
});

async function ready(page: Page): Promise<void> {
  await page.goto(ORIGIN + '/', { waitUntil: 'domcontentloaded' });
  await page.locator('#app').waitFor();
}

test('ordinary flow has no email or registration requirement', async ({ page }) => {
  await ready(page);
  await expect(page.locator('#view-product')).toBeVisible();
  expect(await page.locator('input[type="email"]').count()).toBe(0);
  expect(await page.locator('input[type="password"]').count()).toBe(0);
  await expect(page.locator('#app')).not.toContainText(/register|sign up|create account/i);
});

test('product view shows fixed ZEC price, file details, seller identity and testnet badge', async ({ page }) => {
  await ready(page);
  await expect(page.locator('#view-product')).toContainText(/1(\.0+)? ZEC/);
  await expect(page.locator('#view-product')).toContainText(/testnet/i);
  await expect(page.locator('#seller-identity')).toContainText('seller-key-1');
  await expect(page.locator('#file-details')).toBeVisible();
  await expect(page.locator('#buy')).toBeVisible();
  await expect(page.locator('#nav-purchases')).toBeVisible();
});

test('wallet request is absent until the purchase is persisted', async ({ page }) => {
  await ready(page);
  expect(await page.locator('#zip321-uri').count()).toBe(0);
  expect(await page.locator('a[href^="zcash:"]').count()).toBe(0);
  const blocked = await page.evaluate(() => {
    const root = document.createElement('div');
    const api = window.__ssf;
    api.renderCheckoutView(root, {
      purchase: {
        version: 1,
        requestId: 'req-draft',
        productVersion: 'book-v1',
        sellerOrigin: location.origin,
        sellerKeyId: 'seller-key-1',
        credentialId: 'cred-1',
        orderId: null,
        invoice: null,
      },
      now: Date.now(),
      persisted: false,
    });
    return {
      uri: root.querySelector('#zip321-uri')?.textContent ?? null,
      wallet: root.querySelector('[data-wallet-request]')?.getAttribute('data-wallet-request') ?? null,
      href: root.querySelector('a[href^="zcash:"]')?.getAttribute('href') ?? null,
    };
  });
  expect(blocked.uri).toBeNull();
  expect(blocked.href).toBeNull();
  expect(blocked.wallet).not.toBe('ready');
});

test('confirming is distinct from paid', () => {
  const confirming = buyerVisibleStatus(status({ payment: 'confirming' }));
  const paid = buyerVisibleStatus(status({ payment: 'confirmed' }));
  expect(confirming.paymentLabel).toMatch(/confirming/i);
  expect(confirming.paid).toBe(false);
  expect(paid.paid).toBe(true);
  expect(paid.paymentLabel).toMatch(/paid/i);
  expect(confirming.paymentLabel).not.toBe(paid.paymentLabel);
});

test('failed delivery is never labelled unpaid', () => {
  const visible = buyerVisibleStatus(status({
    payment: 'confirmed',
    delivery: 'retry_required',
    exceptions: [{ code: 'delivery_failed' }],
  }));
  expect(visible.paid).toBe(true);
  expect(visible.unpaid).toBe(false);
  expect(visible.deliveryLabel).toMatch(/delivery/i);
  expect(visible.paymentLabel).not.toMatch(/unpaid/i);
});

test('confirmed plus review is visible as paid with a separate exception', () => {
  const visible = buyerVisibleStatus(status({
    payment: 'confirmed',
    exceptions: [{ code: 'overpayment' }],
  }));
  expect(visible.paid).toBe(true);
  expect(visible.unpaid).toBe(false);
  expect(visible.exceptions).toContain('overpayment');
  expect(visible.paymentLabel).toMatch(/paid/i);
});

test('awaiting plus verification unavailable is a scanner problem, not unpaid', () => {
  const visible = buyerVisibleStatus(status({
    payment: 'awaiting',
    verification: 'unavailable',
    exceptions: [{ code: 'verification_unavailable' }],
  }));
  expect(visible.scannerProblem).toBe(true);
  expect(visible.unpaid).toBe(false);
  expect(visible.paymentLabel).not.toMatch(/unpaid/i);
  expect(visible.verificationLabel).toMatch(/scanner|verification|unavailable/i);
});

test('status view shows reconnect and stale scanner from OrderStatus.verification', async ({ page }) => {
  await ready(page);
  const labels = await page.evaluate(() => {
    const root = document.createElement('div');
    window.__ssf.renderStatusView(root, {
      payment: 'awaiting',
      delivery: 'locked',
      verification: 'stale',
      exceptions: [{ code: 'verification_unavailable' }],
    });
    return {
      text: root.textContent,
      verification: root.querySelector('[data-verification]')?.getAttribute('data-verification'),
    };
  });
  expect(labels.verification).toBe('stale');
  expect(labels.text).toMatch(/stale|reconnect|scanner/i);
  expect(labels.text).not.toMatch(/unpaid/i);
});

test('product view refuses new checkout when availability is down', async ({ page }) => {
  await ready(page);
  await page.evaluate(() => {
    window.__ssf.renderProductView(document.getElementById('app')!, {
      product: {
        version: 'book-v1',
        description: 'Harmless fixture',
        amountZat: '100000000',
        network: 'test',
        fileSize: 73,
        fileFormatVersion: 'SSF1',
        sellerKeyId: 'seller-key-1',
      },
      availability: {
        productPublished: true,
        messaging: true,
        storageReplica: true,
        scanner: false,
      },
      sellerKeyId: 'seller-key-1',
    });
  });
  await expect(page.locator('#buy')).toBeDisabled();
  await expect(page.locator('#checkout-unavailable')).toBeVisible();
  await expect(page.locator('#nav-purchases')).toBeEnabled();
});

test('expired unpaid invoice does not show ordinary payment instructions', async ({ page }) => {
  await ready(page);
  const result = await page.evaluate((inv) => {
    const root = document.createElement('div');
    const expired = {
      ...inv,
      expiresAt: Date.now() - 1000,
    };
    window.__ssf.renderCheckoutView(root, {
      purchase: {
        version: 1,
        requestId: 'req-expired',
        productVersion: 'book-v1',
        sellerOrigin: location.origin,
        sellerKeyId: 'seller-key-1',
        credentialId: 'cred-1',
        orderId: expired.orderId,
        invoice: expired,
      },
      now: Date.now(),
      persisted: true,
    });
    return {
      uri: root.querySelector('#zip321-uri')?.textContent ?? null,
      payment: root.querySelector('[data-payment]')?.getAttribute('data-payment'),
      text: root.textContent,
    };
  }, invoice);
  expect(result.uri).toBeNull();
  expect(result.payment).toBe('blocked');
  expect(result.text).toMatch(/expired/i);
  expect(result.text).toMatch(/new request ID/i);
  expect(result.text).not.toMatch(/Pay 100000000/);
});

test('renders the exact ZIP-321 URI with copy and link alternatives and does not claim wallet verification', async ({ page }) => {
  const uri = encodeZip321(invoice);
  expect(uri.startsWith(`zcash:${DESTINATION}?`)).toBe(true);
  expect(uri).toContain('amount=1');
  await ready(page);
  const rendered = await page.evaluate((inv) => {
    const root = document.createElement('div');
    window.__ssf.renderCheckoutView(root, {
      purchase: {
        version: 1,
        requestId: 'req-pay',
        productVersion: 'book-v1',
        sellerOrigin: location.origin,
        sellerKeyId: 'seller-key-1',
        credentialId: 'cred-1',
        orderId: inv.orderId,
        invoice: inv,
      },
      now: Date.now(),
      persisted: true,
    });
    return {
      uri: root.querySelector('#zip321-uri')?.textContent,
      qr: root.querySelector('[data-zip321-qr]')?.getAttribute('data-zip321-uri'),
      href: root.querySelector('#open-uri')?.getAttribute('href'),
      copy: root.querySelector('#copy-uri')?.textContent,
      text: root.textContent,
    };
  }, invoice);
  expect(rendered.uri).toBe(uri);
  expect(rendered.qr).toBe(uri);
  expect(rendered.href).toBe(uri);
  expect(rendered.copy).toMatch(/copy/i);
  expect(rendered.text).not.toMatch(/Zashi|Zodl/i);
  expect(rendered.text).toMatch(/not (been )?verif/i);
});

test('status and recover requests include possession proofs bound to the order', async ({ page }) => {
  await ready(page);
  const seen: Array<{ url: string; body: string }> = [];
  await page.route('**/api/status', async (route) => {
    seen.push({ url: route.request().url(), body: route.request().postData() ?? '' });
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        payment: 'awaiting',
        delivery: 'locked',
        verification: 'available',
        exceptions: [],
      }),
    });
  });
  await page.route('**/api/recover', async (route) => {
    seen.push({ url: route.request().url(), body: route.request().postData() ?? '' });
    await route.fulfill({
      status: 403,
      contentType: 'application/json',
      body: JSON.stringify({ error: 'not eligible' }),
    });
  });
  await page.evaluate(async () => {
    const credentials = window.__ssf.createCredentialAdapter();
    const transport = window.__ssf.createBrowserTransport(credentials);
    const created = await credentials.createPurchaseCredential();
    await transport.status('ord-bound', created.credentialId);
    try {
      await transport.recover('ord-bound', created.credentialId);
    } catch {
      // recover may fail; the request still must carry a proof
    }
  });
  expect(seen.length).toBeGreaterThanOrEqual(1);
  for (const item of seen) {
    const payload = JSON.parse(item.body) as { orderId?: string; proof?: string };
    expect(payload.orderId).toBe('ord-bound');
    expect(typeof payload.proof).toBe('string');
    expect(payload.proof?.length ?? 0).toBeGreaterThan(0);
  }
});

test('public routes have no payment override and keep admin off the public bind', async ({ page }) => {
  await ready(page);
  const publicUrl = seller.publicUrl;
  const override = await page.request.post(`${publicUrl}/api/payment-override`, {
    data: { orderId: 'ord-1', payment: 'confirmed' },
  });
  expect(override.status()).toBeGreaterThanOrEqual(400);
  const markPaid = await page.request.post(`${publicUrl}/api/mark-paid`, {
    data: { orderId: 'ord-1' },
  });
  expect(markPaid.status()).toBeGreaterThanOrEqual(400);
  const adminOnPublic = await page.request.post(`${publicUrl}/admin/publish`, {
    data: {},
  });
  expect(adminOnPublic.status()).toBeGreaterThanOrEqual(400);
});

test('seller sets a strict CSP and serves local assets only', async ({ page }) => {
  const res = await page.request.get(seller.publicUrl + '/');
  const csp = res.headers()['content-security-policy'] ?? '';
  expect(csp).toMatch(/default-src 'self'/);
  expect(csp).not.toMatch(/\*/);
  expect(csp).toMatch(/object-src 'none'/);
  const html = await res.text();
  expect(html).not.toMatch(/https:\/\/cdn\.|googletagmanager|google-analytics/i);
  expect(html).not.toMatch(/admin-secret-not-for-browser/);
});

test('My purchases export repeats the bearer-secret warning', async ({ page }) => {
  await ready(page);
  await page.evaluate(() => {
    window.__ssf.renderPurchasesView(document.getElementById('app')!, {
      purchases: [],
    });
  });
  await expect(page.locator('#backup-warning')).toContainText(/grants access to the purchase/i);
  await expect(page.locator('#backup-warning')).toContainText(/not an ordinary receipt/i);
  await expect(page.locator('#backup-warning')).toHaveAttribute('data-backup-kind', 'bearer-secret');
});

test('ciphertext download is offered as an attachment', async ({ page }) => {
  const res = await page.request.get(`${seller.publicUrl}/ciphertext/book-v1`);
  expect(res.status()).toBe(200);
  expect(res.headers()['content-disposition'] ?? '').toMatch(/attachment/);
  expect(res.headers()['content-type'] ?? '').toMatch(/octet-stream/);
});

test('Buy click persists checkout through DOM handlers and lists the purchase', async ({ page }) => {
  await ready(page);
  await expect(page.locator('#buy')).toBeEnabled();
  await page.locator('#buy').click();
  await expect(page.locator('#view-checkout')).toBeVisible();
  // Task 7's real invoice issuer mints a fresh unique-receiver address per
  // order (Section 3.2); it does not reuse the config-level SSF_DESTINATION.
  await expect(page.locator('#zip321-uri')).toContainText(/^zcash:uregtest1/);
  await expect(page.locator('#copy-uri')).toBeVisible();
  await page.locator('#copy-uri').click();
  await expect(page.locator('#copy-uri')).toHaveAttribute('data-copied', 'true');
  await page.locator('#nav-purchases').click();
  await expect(page.locator('#view-purchases')).toBeVisible();
  await expect(page.locator('button[data-request-id]')).toHaveCount(1);
  await page.locator('#export-backup').click();
  await expect(page.locator('#export-backup')).toHaveAttribute('data-exported', 'true');
  await page.locator('button[data-request-id]').click();
  await expect(page.locator('#view-status')).toBeVisible();
});

test('recover returns the delivery package envelope to an authenticated buyer', async ({ page }) => {
  const credentials = createCredentialAdapter();
  const created = await credentials.createPurchaseCredential();
  const requestId = `req-recover-${Date.now()}`;
  const createProof = Buffer.from(await credentials.provePossession(created.credentialId, { orderId: requestId })).toString('base64');
  const orderRes = await page.request.post(`${seller.publicUrl}/api/orders`, {
    data: {
      requestId,
      productVersion: 'book-v1',
      buyerKeyId: created.buyerKeyId,
      proof: createProof,
    },
  });
  expect(orderRes.ok()).toBe(true);
  const createdInvoice = await orderRes.json() as Invoice;
  if (createdInvoice.attribution?.kind !== 'receiver') {
    throw new Error('expected a receiver-attributed invoice');
  }
  scanner.setReceiptReceiver('out-recover-envelope', createdInvoice.attribution.receiver);
  scanner.replaceSnapshot([{
    outputId: 'out-recover-envelope',
    invoiceId: null,
    amountZat: createdInvoice.amountZat,
    confirmations: 10,
    canonical: true,
    receivedAt: Date.now(),
    revision: { id: 'rev-1', height: 1 },
  }], { id: 'rev-10', height: 10 }, true, Date.now());

  const recoverRes = await page.request.post(`${seller.publicUrl}/api/recover`, {
    data: {
      orderId: createdInvoice.orderId,
      proof: Buffer.from(await credentials.provePossession(created.credentialId, { orderId: createdInvoice.orderId })).toString('base64'),
    },
  });
  expect(recoverRes.status()).toBe(200);
  const body = await recoverRes.json() as {
    orderId?: string;
    productVersion?: string;
    buyerKeyId?: string;
    encryptedEnvelope?: string;
  };
  expect(body.orderId).toBe(createdInvoice.orderId);
  expect(body.productVersion).toBe('book-v1');
  expect(body.buyerKeyId).toBe(created.buyerKeyId);
  expect(typeof body.encryptedEnvelope).toBe('string');
  const envelope = Buffer.from(body.encryptedEnvelope ?? '', 'base64');
  expect(envelope.byteLength).toBeGreaterThan(0);
  expect(Array.from(envelope)).not.toEqual([1]);
  expect(envelope.subarray(0, 4).toString()).toBe('SSDL');
  expect(messaging.sent.some((pkg) => pkg.orderId === createdInvoice.orderId)).toBe(true);
});

test('browser recover decodes the delivery envelope bytes', async ({ page }) => {
  await ready(page);
  await page.route('**/api/recover', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        orderId: 'ord-env',
        productVersion: 'book-v1',
        buyerKeyId: 'buyer',
        encryptedEnvelope: Buffer.from([7, 7, 7]).toString('base64'),
      }),
    });
  });
  const bytes = await page.evaluate(async () => {
    const credentials = window.__ssf.createCredentialAdapter();
    const transport = window.__ssf.createBrowserTransport(credentials);
    const created = await credentials.createPurchaseCredential();
    const pkg = await transport.recover('ord-env', created.credentialId);
    return Array.from(pkg.encryptedEnvelope);
  });
  expect(bytes).toEqual([7, 7, 7]);
});

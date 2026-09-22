import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test, chromium, type Page } from '@playwright/test';
import { createServer, type ViteDevServer } from 'vite';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const ORIGIN = 'http://127.0.0.1:4173';

type Harness = {
  purchases: typeof import('../../src/browser/purchases.ts');
  checkout: typeof import('../../src/browser/checkout.ts');
  fakeCredentials: () => import('../../src/contracts/types.ts').CredentialAdapter;
  fakeTransport: (
    credentials: import('../../src/contracts/types.ts').CredentialAdapter,
  ) => import('../../src/contracts/types.ts').OrderTransport;
  quotaIndexedDB: () => import('../../src/browser/purchases.ts').IDBFactoryLike;
};

declare const window: { __ssf: Harness };
declare const location: { origin: string; href: string };
declare const document: {
  getElementById(id: string): {
    textContent: string | null;
    getAttribute(name: string): string | null;
    dataset: Record<string, string>;
    setAttribute(name: string, value: string): void;
  } | null;
};
const CHROMIUM = '/usr/bin/chromium';
const CHROMIUM_ARGS = ['--no-sandbox', '--disable-dev-shm-usage'];

const HARNESS_HTML = `<!DOCTYPE html>
<html>
  <body>
    <div id="backup-warning"></div>
    <div id="recovery-guidance"></div>
    <div id="payment"></div>
    <script type="module">
      import * as purchases from '/src/browser/purchases.ts';
      import * as checkout from '/src/browser/checkout.ts';

      function fakeCredentials() {
        let n = 0;
        const keys = new Map();
        return {
          async createPurchaseCredential() {
            n += 1;
            const credentialId = 'cred-' + n;
            const privateKeyHex = n.toString(16).padStart(64, 'a');
            const publicKeyHex = n.toString(16).padStart(64, 'b');
            keys.set(credentialId, { privateKeyHex, publicKeyHex });
            return { credentialId, buyerKeyId: publicKeyHex, exportable: true };
          },
          async provePossession(id, _challenge) {
            const rec = keys.get(id);
            if (!rec) throw new Error('unknown credential');
            return new TextEncoder().encode(rec.privateKeyHex);
          },
          async verifyPossession(buyerKeyId, proof) {
            const hex = new TextDecoder().decode(proof);
            for (const rec of keys.values()) {
              if (rec.privateKeyHex === hex) return rec.publicKeyHex === buyerKeyId;
            }
            return false;
          },
          async decryptWrapped() {
            throw new Error('not used');
          },
          async exportBackupMaterial(id) {
            const rec = keys.get(id);
            if (!rec) throw new Error('unknown credential');
            return new TextEncoder().encode(JSON.stringify({ v: 1, ...rec }));
          },
          async importBackupMaterial(data) {
            const parsed = JSON.parse(new TextDecoder().decode(data));
            n += 1;
            const credentialId = 'cred-imported-' + n;
            keys.set(credentialId, {
              privateKeyHex: parsed.privateKeyHex,
              publicKeyHex: parsed.publicKeyHex,
            });
            return { credentialId, buyerKeyId: parsed.publicKeyHex };
          },
        };
      }

      function fakeTransport(credentials) {
        return {
          async create(record) {
            const material = JSON.parse(
              new TextDecoder().decode(await credentials.exportBackupMaterial(record.credentialId)),
            );
            return {
              id: 'inv-' + record.requestId,
              orderId: 'ord-' + record.requestId,
              productVersion: record.productVersion,
              buyerKeyId: material.publicKeyHex,
              network: 'test',
              amountZat: '100000000',
              destination: 'uregtest1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq',
              attributionRef: 'attr-1',
              expiresAt: Date.now() + 86_400_000,
            };
          },
          async status() { throw new Error('unused'); },
          async recover() { throw new Error('unused'); },
        };
      }

      function quotaIndexedDB() {
        return {
          open() {
            const db = {
              objectStoreNames: { contains: (name) => name === 'purchases' },
              createObjectStore() {},
              transaction() {
                const tx = { error: null, oncomplete: null, onerror: null, onabort: null };
                tx.objectStore = () => ({
                  put() {
                    const req = { result: undefined, error: null, onsuccess: null, onerror: null };
                    queueMicrotask(() => {
                      const err = new Error('quota exceeded');
                      err.name = 'QuotaExceededError';
                      req.error = err;
                      tx.error = err;
                      req.onerror?.();
                      tx.onerror?.();
                      tx.onabort?.();
                    });
                    return req;
                  },
                  get() {
                    const req = { result: undefined, error: null, onsuccess: null, onerror: null };
                    queueMicrotask(() => req.onsuccess?.());
                    return req;
                  },
                  getAll() {
                    const req = { result: [], error: null, onsuccess: null, onerror: null };
                    queueMicrotask(() => req.onsuccess?.());
                    return req;
                  },
                });
                return tx;
              },
              close() {},
            };
            const req = { result: db, error: null, onsuccess: null, onerror: null, onupgradeneeded: null };
            queueMicrotask(() => {
              req.onupgradeneeded?.();
              req.onsuccess?.();
            });
            return req;
          },
        };
      }

      window.__ssf = { purchases, checkout, fakeCredentials, fakeTransport, quotaIndexedDB };
    </script>
  </body>
</html>`;

test.use({
  launchOptions: {
    executablePath: CHROMIUM,
    args: CHROMIUM_ARGS,
  },
});

test.describe.configure({ mode: 'serial' });

let vite: ViteDevServer;

test.beforeAll(async () => {
  vite = await createServer({
    root: ROOT,
    appType: 'custom',
    server: { host: '127.0.0.1', port: 4173, strictPort: true },
    plugins: [{
      name: 'recovery-harness',
      configureServer(server) {
        server.middlewares.use((req, res, next) => {
          const url = req.url?.split('?')[0];
          if (url === '/' || url === '/index.html') {
            res.setHeader('Content-Type', 'text/html; charset=utf-8');
            res.end(HARNESS_HTML);
            return;
          }
          next();
        });
      },
    }],
  });
  await vite.listen();
});

test.afterAll(async () => {
  await vite?.close();
});

async function ready(page: Page): Promise<void> {
  await page.goto(ORIGIN + '/', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => Boolean(window.__ssf));
}

function launchOpts() {
  return { headless: true, executablePath: CHROMIUM, args: CHROMIUM_ARGS };
}

test('bearer-secret warning is visible at export and in recovery guidance', async ({ page }) => {
  await ready(page);
  await page.evaluate(() => {
    window.__ssf.purchases.renderBackupGuidance(document.getElementById('backup-warning')!);
    window.__ssf.purchases.renderStorageFailureGuidance(document.getElementById('recovery-guidance')!);
  });
  await expect(page.locator('#backup-warning')).toContainText('grants access to the purchase');
  await expect(page.locator('#backup-warning')).toContainText('not an ordinary receipt');
  await expect(page.locator('#backup-warning')).toHaveAttribute('data-backup-kind', 'bearer-secret');
  await expect(page.locator('#backup-warning')).toHaveAttribute('data-password-required', 'false');
  await expect(page.locator('#recovery-guidance')).toContainText('re-import');
});

test('navigator.storage.persist rejection or absence does not break stored checkout', async ({ page }) => {
  await ready(page);
  const result = await page.evaluate(async () => {
    const { purchases, checkout, fakeCredentials, fakeTransport } = window.__ssf;
    const denied = await purchases.requestPersistentStorage(async () => {
      throw new Error('persist rejected');
    });
    const absent = await purchases.requestPersistentStorage(null);
    const credentials = fakeCredentials();
    const store = await purchases.openPurchaseStore({
      sellerOrigin: location.origin,
      sellerKeyId: 'seller-key-1',
      credentials,
      persist: async () => false,
      dbName: 'ssf-persist-denied',
    });
    const invoice = await checkout.beginCheckout(store, fakeTransport(credentials), credentials, {
      version: 1,
      requestId: 'req-persist',
      productVersion: 'book-v1',
      sellerOrigin: location.origin,
      sellerKeyId: 'seller-key-1',
    });
    const loaded = await store.get('req-persist');
    return {
      denied,
      absent,
      invoiceId: invoice.id,
      credentialId: loaded?.credentialId ?? null,
      href: location.href,
    };
  });
  expect(result.denied).toBe('denied');
  expect(result.absent).toBe('unsupported');
  expect(result.invoiceId).toBe('inv-req-persist');
  expect(result.credentialId).toBeTruthy();
  expect(result.href).not.toMatch(/privateKey/i);
});

test('IndexedDB purchase survives closing and reopening a persistent browser context', async () => {
  const profileDir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), 'ssf-recovery-'));
  let firstId = '';
  try {
    const first = await chromium.launchPersistentContext(profileDir, launchOpts());
    try {
      const page = first.pages()[0] || await first.newPage();
      await ready(page);
      firstId = await page.evaluate(async () => {
        const { purchases, checkout, fakeCredentials, fakeTransport } = window.__ssf;
        const credentials = fakeCredentials();
        const store = await purchases.openPurchaseStore({
          sellerOrigin: location.origin,
          sellerKeyId: 'seller-key-1',
          credentials,
          persist: null,
          dbName: 'ssf-restart',
        });
        await checkout.beginCheckout(store, fakeTransport(credentials), credentials, {
          version: 1,
          requestId: 'req-restart',
          productVersion: 'book-v1',
          sellerOrigin: location.origin,
          sellerKeyId: 'seller-key-1',
        });
        const loaded = await store.get('req-restart');
        return loaded?.credentialId ?? '';
      });
      expect(firstId).toBeTruthy();
    } finally {
      await first.close();
    }

    const second = await chromium.launchPersistentContext(profileDir, launchOpts());
    try {
      const page = second.pages()[0] || await second.newPage();
      await ready(page);
      const recovered = await page.evaluate(async () => {
        const { purchases, fakeCredentials } = window.__ssf;
        const credentials = fakeCredentials();
        const store = await purchases.openPurchaseStore({
          sellerOrigin: location.origin,
          sellerKeyId: 'seller-key-1',
          credentials,
          persist: null,
          dbName: 'ssf-restart',
        });
        const loaded = await store.get('req-restart');
        if (!loaded?.credentialId || !loaded.invoice) {
          return {
            requestId: loaded?.requestId ?? null,
            productVersion: loaded?.productVersion ?? null,
            hasInvoice: Boolean(loaded?.invoice),
            credentialId: loaded?.credentialId ?? null,
            proofBytes: 0,
            verified: false,
          };
        }
        const proof = await credentials.provePossession(loaded.credentialId, {
          orderId: loaded.invoice.orderId,
        });
        const verified = await credentials.verifyPossession(loaded.invoice.buyerKeyId, proof, {
          orderId: loaded.invoice.orderId,
        });
        return {
          requestId: loaded.requestId,
          productVersion: loaded.productVersion,
          hasInvoice: true,
          credentialId: loaded.credentialId,
          proofBytes: proof.byteLength,
          verified,
        };
      });
      expect(recovered.requestId).toBe('req-restart');
      expect(recovered.productVersion).toBe('book-v1');
      expect(recovered.hasInvoice).toBe(true);
      expect(recovered.credentialId).toBeTruthy();
      expect(recovered.proofBytes).toBeGreaterThan(0);
      expect(recovered.verified).toBe(true);
    } finally {
      await second.close();
    }
  } finally {
    rmSync(profileDir, { recursive: true, force: true });
  }
});

test('private-session storage is gone after the context closes', async () => {
  const browser = await chromium.launch(launchOpts());
  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    await ready(page);
    await page.evaluate(async () => {
      const { purchases, fakeCredentials } = window.__ssf;
      const credentials = fakeCredentials();
      const created = await credentials.createPurchaseCredential();
      const store = await purchases.openPurchaseStore({
        sellerOrigin: location.origin,
        sellerKeyId: 'seller-key-1',
        credentials,
        persist: null,
        dbName: 'ssf-private',
      });
      await store.save({
        version: 1,
        requestId: 'req-private',
        productVersion: 'book-v1',
        sellerOrigin: location.origin,
        sellerKeyId: 'seller-key-1',
        credentialId: created.credentialId,
        orderId: null,
        invoice: null,
      });
    });
    await context.close();

    const fresh = await browser.newContext();
    const page2 = await fresh.newPage();
    await ready(page2);
    const loaded = await page2.evaluate(async () => {
      const { purchases, fakeCredentials } = window.__ssf;
      const store = await purchases.openPurchaseStore({
        sellerOrigin: location.origin,
        sellerKeyId: 'seller-key-1',
        credentials: fakeCredentials(),
        persist: null,
        dbName: 'ssf-private',
      });
      return store.get('req-private');
    });
    expect(loaded).toBeNull();
    await fresh.close();
  } finally {
    await browser.close();
  }
});

test('malformed and future backups are rejected; wrong-seller identity is not trusted', async ({ page }) => {
  await ready(page);
  const result = await page.evaluate(async () => {
    const { purchases, fakeCredentials } = window.__ssf;
    const credentials = fakeCredentials();
    const created = await credentials.createPurchaseCredential();
    const store = await purchases.openPurchaseStore({
      sellerOrigin: location.origin,
      sellerKeyId: 'seller-key-1',
      credentials,
      persist: null,
      dbName: 'ssf-backup-validate',
    });
    await store.save({
      version: 1,
      requestId: 'req-backup',
      productVersion: 'book-v1',
      sellerOrigin: location.origin,
      sellerKeyId: 'seller-key-1',
      credentialId: created.credentialId,
      orderId: null,
      invoice: null,
    });
    const good = await store.exportBackup('req-backup');
    const text = new TextDecoder().decode(good);
    const envelope = JSON.parse(text);
    const future = new TextEncoder().encode(JSON.stringify({ ...envelope, version: 99 }));
    const malformed = new TextEncoder().encode('not-json');
    const wrongSeller = new TextEncoder().encode(JSON.stringify({
      ...envelope,
      sellerKeyId: 'attacker-seller',
    }));
    const errors: string[] = [];
    for (const [label, data] of [
      ['future', future],
      ['malformed', malformed],
      ['wrong-seller', wrongSeller],
    ] as const) {
      try {
        await store.importBackup(data);
        errors.push(label + ': accepted');
      } catch (err) {
        errors.push(label + ': ' + (err instanceof Error ? err.message : String(err)));
      }
    }
    return { errors, warning: envelope.warning, hasScript: Object.hasOwn(envelope, 'script') };
  });
  expect(result.errors[0]).toMatch(/future: unsupported backup version/i);
  expect(result.errors[1]).toMatch(/malformed: malformed backup/i);
  expect(result.errors[2]).toMatch(/wrong-seller: imported seller identity does not match/i);
  expect(result.warning).toMatch(/bearer secret|not an ordinary receipt/i);
  expect(result.hasScript).toBe(false);
});

test('fresh context can import a portable backup after re-import confirmation', async () => {
  const browser = await chromium.launch(launchOpts());
  try {
    const source = await browser.newContext();
    const page = await source.newPage();
    await ready(page);
    const backup = await page.evaluate(async () => {
      const { purchases, fakeCredentials } = window.__ssf;
      const credentials = fakeCredentials();
      const created = await credentials.createPurchaseCredential();
      const store = await purchases.openPurchaseStore({
        sellerOrigin: location.origin,
        sellerKeyId: 'seller-key-1',
        credentials,
        persist: null,
        dbName: 'ssf-export',
      });
      await store.save({
        version: 1,
        requestId: 'req-portable',
        productVersion: 'book-v1',
        sellerOrigin: location.origin,
        sellerKeyId: 'seller-key-1',
        credentialId: created.credentialId,
        orderId: 'ord-portable',
        invoice: {
          id: 'inv-portable',
          orderId: 'ord-portable',
          productVersion: 'book-v1',
          buyerKeyId: created.buyerKeyId,
          network: 'test',
          amountZat: '100000000',
          destination: 'uregtest1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq',
          attributionRef: 'attr-1',
          expiresAt: Date.now() + 86_400_000,
        },
      });
      const bytes = await store.exportBackup('req-portable');
      return Array.from(bytes);
    });
    await source.close();

    const dest = await browser.newContext();
    const page2 = await dest.newPage();
    await ready(page2);
    const imported = await page2.evaluate(async (bytes) => {
      const { purchases, fakeCredentials } = window.__ssf;
      const store = await purchases.openPurchaseStore({
        sellerOrigin: location.origin,
        sellerKeyId: 'seller-key-1',
        credentials: fakeCredentials(),
        persist: null,
        dbName: 'ssf-import',
      });
      const downloadOnly = await store.get('req-portable');
      const restored = await purchases.recoverFromBackupBeforePayment(store, Uint8Array.from(bytes));
      return {
        downloadOnly,
        requestId: restored.requestId,
        productVersion: restored.productVersion,
        orderId: restored.orderId,
        href: location.href,
      };
    }, backup);
    expect(imported.downloadOnly).toBeNull();
    expect(imported.requestId).toBe('req-portable');
    expect(imported.productVersion).toBe('book-v1');
    expect(imported.orderId).toBe('ord-portable');
    expect(imported.href).not.toMatch(/privateKeyHex|publicKeyHex/i);
    await dest.close();
  } finally {
    await browser.close();
  }
});

test('storage quota failure blocks payment and offers backup/retry guidance', async ({ page }) => {
  await ready(page);
  const result = await page.evaluate(async () => {
    const { purchases, checkout, fakeCredentials, fakeTransport, quotaIndexedDB } = window.__ssf;
    const credentials = fakeCredentials();
    const store = await purchases.openPurchaseStore({
      sellerOrigin: location.origin,
      sellerKeyId: 'seller-key-1',
      credentials,
      indexedDB: quotaIndexedDB(),
      persist: null,
      dbName: 'ssf-quota',
    });
    const transport = fakeTransport(credentials);
    let thrown = '';
    try {
      await checkout.beginCheckout(store, transport, credentials, {
        version: 1,
        requestId: 'req-quota',
        productVersion: 'book-v1',
        sellerOrigin: location.origin,
        sellerKeyId: 'seller-key-1',
      });
    } catch (err) {
      thrown = err instanceof Error ? err.message : String(err);
    }
    purchases.renderStorageFailureGuidance(document.getElementById('recovery-guidance')!);
    return { thrown, payment: document.getElementById('recovery-guidance')?.getAttribute('data-payment') };
  });
  expect(result.thrown.length).toBeGreaterThan(0);
  expect(result.payment).toBe('blocked');
  await expect(page.locator('#recovery-guidance')).toContainText('Payment is blocked');
});

test('expired unpaid invoices do not present ordinary payment instructions', async ({ page }) => {
  await ready(page);
  const result = await page.evaluate(async () => {
    const { checkout } = window.__ssf;
    const purchase = {
      version: 1 as const,
      requestId: 'req-expired',
      productVersion: 'book-v1',
      sellerOrigin: location.origin,
      sellerKeyId: 'seller-key-1',
      credentialId: 'cred-1',
      orderId: 'ord-expired',
      invoice: {
        id: 'inv-expired',
        orderId: 'ord-expired',
        productVersion: 'book-v1',
        buyerKeyId: 'buyer-1',
        network: 'test' as const,
        amountZat: '100000000',
        destination: 'uregtest1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq',
        attributionRef: 'attr-1',
        expiresAt: Date.now() - 1000,
      },
    };
    checkout.renderPaymentInstructions(document.getElementById('payment')!, purchase, Date.now());
    return {
      instructions: checkout.paymentInstructions(purchase, Date.now()),
      text: document.getElementById('payment')?.textContent,
      state: document.getElementById('payment')?.getAttribute('data-payment'),
    };
  });
  expect(result.instructions).toBeNull();
  expect(result.state).toBe('blocked');
  expect(result.text).toMatch(/expired/i);
  expect(result.text).not.toMatch(/Pay 100000000/);
});

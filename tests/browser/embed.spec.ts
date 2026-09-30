import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import { MemoryScanner } from '../../src/adapters/scanner.ts';
import { createMemoryMessaging } from '../../src/adapters/messaging.ts';
import { loadConfig } from '../../src/config.ts';
import { startSeller, type SellerServer } from '../../src/seller/server.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const DESTINATION =
  'uregtest1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq';

test.use({
  launchOptions: {
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ?? '/usr/bin/chromium',
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  },
});

test.describe('embed popup checkout', () => {
  test.describe.configure({ mode: 'serial' });
  let seller: SellerServer | undefined;
  let embedder: Server | undefined;
  let storeOrigin = '';
  let embedderOrigin = '';
  let embedderHtml = '';
  let scratch = '';

  test.beforeAll(async () => {
    scratch = mkdtempSync(join(tmpdir(), 'ssf-embed-spec-'));
    embedder = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end(embedderHtml);
    });
    await new Promise<void>((resolve, reject) => {
      embedder!.once('error', reject);
      embedder!.listen(0, '127.0.0.1', resolve);
    });
    const embedderAddress = embedder.address();
    if (!embedderAddress || typeof embedderAddress === 'string') {
      throw new Error('embedder did not bind a TCP port');
    }
    embedderOrigin = `http://127.0.0.1:${(embedderAddress as AddressInfo).port}`;

    const scanner = new MemoryScanner();
    scanner.replaceSnapshot([], { id: 'rev-10', height: 10 }, true, Date.now());
    const config = loadConfig({
      SSF_MODE: 'fixture',
      SSF_NETWORK: 'test',
      SSF_MIN_CONFIRMATIONS: '3',
      SSF_MAX_HEALTH_AGE_MS: '120000',
      SSF_MAX_CIPHERTEXT_BYTES: '73',
      SSF_MAX_PLAINTEXT_BYTES: '41',
      SSF_INVOICE_TTL_MS: '86400000',
      SSF_PUBLIC_HOST: '127.0.0.1',
      SSF_PUBLIC_PORT: '0',
      SSF_ADMIN_HOST: '127.0.0.1',
      SSF_ADMIN_PORT: '0',
      SSF_DB_PATH: join(scratch, 'seller.sqlite'),
      SSF_SELLER_KEY_ID: 'seller-key-1',
      SSF_DESTINATION: DESTINATION,
      SSF_ADAPTER_MESSAGING: 'fixture',
      SSF_ADAPTER_STORAGE: 'fixture',
      SSF_ADAPTER_SCANNER: 'fixture',
      SSF_ADMIN_TOKEN: 'admin-secret-not-for-browser',
    });
    config.embed = {
      storefrontOrigin: 'http://127.0.0.1',
      allowedEmbedOrigins: [embedderOrigin],
    };
    seller = await startSeller({
      config,
      seedProduct: true,
      scanner,
      messaging: createMemoryMessaging(),
      publicDir: join(ROOT, 'dist/browser'),
      startLoops: false,
    });
    storeOrigin = seller.publicUrl;
    config.publicOrigin = storeOrigin;
    config.embed = { ...config.embed, storefrontOrigin: storeOrigin };
    embedderHtml = '<!DOCTYPE html><html><head>'
      + `<script src="${storeOrigin}/embed.js" crossorigin="anonymous" async></script>`
      + '</head><body><ssf-buy product="book-v1"></ssf-buy><p id="checkout-state">none</p><script>'
      + `window.addEventListener("message", function (event) { if (event.origin !== ${JSON.stringify(storeOrigin)}) return;`
      + 'var data = event.data; if (data && typeof data.state === "string") '
      + 'document.getElementById("checkout-state").textContent = data.state;'
      + '});</script></body></html>';
  });

  test.afterAll(async () => {
    await seller?.close().catch(() => undefined);
    if (embedder) {
      await new Promise<void>((resolve, reject) => {
        embedder!.close((error) => error ? reject(error) : resolve());
      });
    }
    if (scratch) rmSync(scratch, { recursive: true, force: true });
  });

  test('ssf-buy opens /p/<v>, Buy invoices, and the embedder receives invoiced', async ({ page }) => {
    await page.goto(`${embedderOrigin}/`, { waitUntil: 'domcontentloaded' });
    const popupPromise = page.waitForEvent('popup');
    await page.locator('ssf-buy').getByRole('button', { name: 'Buy' }).click();
    const popup = await popupPromise;
    await expect(popup).toHaveURL(/\/p\/book-v1/);
    await popup.getByRole('button', { name: 'Buy' }).click();
    await expect(popup.locator('#zip321-uri')).toBeVisible();
    await expect(page.locator('#checkout-state')).toHaveText('invoiced', { timeout: 15_000 });
  });
});

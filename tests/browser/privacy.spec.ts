import { rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test, type Page, type Request } from '@playwright/test';
import { createServer, type ViteDevServer } from 'vite';
import { createMemoryMessaging } from '../../src/adapters/messaging.ts';
import { MemoryScanner } from '../../src/adapters/scanner.ts';
import { loadConfig } from '../../src/config.ts';
import { startSeller, type SellerServer } from '../../src/seller/server.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const ORIGIN = 'http://127.0.0.1:4175';
const CHROMIUM = '/usr/bin/chromium';
const CHROMIUM_ARGS = ['--no-sandbox', '--disable-dev-shm-usage'];
const CONFIG_DESTINATION =
  'uregtest1zconfigdestinationqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq';
const PLAINTEXT_MARK = 'sovereign-storefront harmless fixture v1';
const THIRD_PARTY = [
  'google-analytics',
  'googletagmanager',
  'doubleclick',
  'facebook.net',
  'mixpanel',
  'segment.com',
  'sentry.io',
  'hotjar',
  'cloudflareinsights',
];

test.use({
  launchOptions: {
    executablePath: CHROMIUM,
    args: CHROMIUM_ARGS,
  },
});

test.describe.configure({ mode: 'serial' });

let vite: ViteDevServer;
let seller: SellerServer;

test.beforeAll(async () => {
  rmSync(join(ROOT, '.tmp-privacy-spec.sqlite'), { force: true });
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
    SSF_DB_PATH: join(ROOT, '.tmp-privacy-spec.sqlite'),
    SSF_SELLER_KEY_ID: 'seller-key-1',
    SSF_DESTINATION: CONFIG_DESTINATION,
    SSF_ADAPTER_MESSAGING: 'fixture',
    SSF_ADAPTER_STORAGE: 'fixture',
    SSF_ADAPTER_SCANNER: 'fixture',
    SSF_ADMIN_TOKEN: 'admin-secret-not-for-browser',
  });
  const scanner = new MemoryScanner();
  scanner.replaceSnapshot([], { id: 'rev-10', height: 10 }, true, Date.now());
  seller = await startSeller({
    config,
    seedProduct: true,
    scanner,
    messaging: createMemoryMessaging(),
  });
  vite = await createServer({
    root: ROOT,
    server: {
      host: '127.0.0.1',
      port: 4175,
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

function capture(page: Page): Request[] {
  const requests: Request[] = [];
  page.on('request', (req) => requests.push(req));
  return requests;
}

function isFirstParty(url: string): boolean {
  const parsed = new URL(url);
  return parsed.origin === ORIGIN || parsed.protocol === 'blob:' || parsed.protocol === 'data:';
}

test('checkout requests stay first-party with no credentials in URLs or plaintext delivery', async ({ page }) => {
  const requests = capture(page);
  await page.goto(ORIGIN + '/', { waitUntil: 'networkidle' });
  await page.locator('#app').waitFor();
  await page.locator('#buy').click();
  await page.locator('#view-checkout').waitFor();

  const urls = requests.map((req) => req.url());
  for (const url of urls) {
    expect(isFirstParty(url), url).toBe(true);
    for (const vendor of THIRD_PARTY) {
      expect(url.toLowerCase().includes(vendor), url).toBe(false);
    }
    const parsed = new URL(url);
    expect(parsed.search).not.toMatch(/proof|privateKey|credential|token|memo/i);
    expect(parsed.pathname).not.toMatch(/proof|privateKey/i);
  }

  const html = await page.content();
  expect(html).not.toContain(PLAINTEXT_MARK);
  expect(html).not.toMatch(/google-analytics|gtag\(|mixpanel/i);

  const scripts = await page.locator('script').evaluateAll((nodes) =>
    nodes.map((node) => ({
      src: node.getAttribute('src'),
      text: node.textContent ?? '',
    })),
  );
  for (const script of scripts) {
    if (script.src) {
      expect(isFirstParty(new URL(script.src, ORIGIN).href), script.src).toBe(true);
    }
    expect(script.text).not.toMatch(/google-analytics|gtag\(|mixpanel/i);
  }

  const ciphertext = await page.request.get(ORIGIN + '/ciphertext/book-v1');
  const body = await ciphertext.body();
  expect(body.includes(Buffer.from(PLAINTEXT_MARK))).toBe(false);
  expect(ciphertext.headers()['content-type'] ?? '').not.toMatch(/html/i);
});

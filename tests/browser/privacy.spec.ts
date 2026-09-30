import { rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test, type Page, type Request } from '@playwright/test';
import { createServer, type ViteDevServer } from 'vite';
import { createMemoryMessaging } from '../../src/adapters/messaging.ts';
import { MemoryScanner } from '../../src/adapters/scanner.ts';
import { loadConfig } from '../../src/config.ts';
import { startSeller, type SellerServer } from '../../src/seller/server.ts';
import {
  HARNESS_LABEL,
  STRICT_LIVE,
  startWakuSellerHarness,
  type WakuSellerHarness,
} from '../support/waku-seller-harness.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const ORIGIN = 'http://127.0.0.1:4175';
const CHROMIUM = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ?? '/usr/bin/chromium';
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
      src: (node as unknown as { getAttribute(name: string): string | null }).getAttribute('src'),
      text: (node as unknown as { textContent: string | null }).textContent ?? '',
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

/**
 * Real-demo privacy (Waku live, payment fixture): the order path never
 * touches the HTTP order routes, and every WebSocket the page opens goes to a
 * configured Waku bootstrap peer. Missing live peers → SKIP with the reason;
 * FAIL under SSF_STRICT_LIVE=1.
 */
test.describe(`real-demo (${HARNESS_LABEL})`, () => {
  test.describe.configure({ timeout: 180_000 });

  let harness: WakuSellerHarness | undefined;
  let skipReason = '';

  test.beforeAll(async () => {
    test.setTimeout(120_000);
    const result = await startWakuSellerHarness(ROOT);
    if (result.ok) {
      harness = result.harness;
      return;
    }
    if (STRICT_LIVE) throw new Error(`SSF_STRICT_LIVE=1: ${result.reason}`);
    skipReason = result.reason;
  });

  test.afterAll(async () => {
    await harness?.close();
  });

  test('no HTTP order routes; WebSockets only to configured Waku peers', async ({ page }) => {
    test.skip(!harness, `${HARNESS_LABEL} precondition: ${skipReason}`);
    const h = harness!;
    const requests = capture(page);
    const sockets: string[] = [];
    page.on('websocket', (ws) => sockets.push(ws.url()));

    await page.goto(h.url + '/');
    const buy = page.getByRole('button', { name: 'Buy' });
    await expect(buy).toBeEnabled({ timeout: 30_000 });
    await buy.click();
    // A create request reached the seller: it can only have come over Waku.
    await expect.poll(() => h.invoiceCount(), { timeout: 90_000 }).toBe(1);
    await page.getByRole('button', { name: 'My purchases' }).click();

    const forbidden = ['/api/orders', '/api/status', '/api/recover', '/api/acknowledge'];
    for (const req of requests) {
      const url = new URL(req.url());
      expect(forbidden.includes(url.pathname), req.url()).toBe(false);
    }
    // The real-demo seller is the only HTTP origin.
    for (const req of requests) {
      const url = new URL(req.url());
      if (url.protocol === 'http:' || url.protocol === 'https:') {
        expect(url.origin, req.url()).toBe(new URL(h.url).origin);
      }
    }

    const allowed = new Set(h.bootstrapPeers.map(peerSocketOrigin));
    expect(sockets.length, 'the page opened no Waku WebSocket').toBeGreaterThan(0);
    for (const target of sockets) {
      expect(allowed.has(new URL(target).origin), target).toBe(true);
    }
  });
});

/** `/dns4/host/tcp/443/wss/p2p/<id>` → `wss://host` (default port elided, as URL does). */
function peerSocketOrigin(peer: string): string {
  const match = /^\/(?:dns4|dns6|dns|ip4|ip6)\/([^/]+)\/tcp\/([0-9]+)\/(?:wss|tls\/ws)\//.exec(peer);
  if (!match) throw new Error('unexpected peer multiaddr shape');
  return new URL(`wss://${match[1]}:${match[2]}`).origin;
}

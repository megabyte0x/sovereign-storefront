import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';
import * as jsQrModule from 'jsqr';

type JsQrFn = (data: Uint8ClampedArray, width: number, height: number) => { data: string } | null;

function resolveJsQr(mod: unknown): JsQrFn {
  if (typeof mod === 'function') return mod as JsQrFn;
  if (mod && typeof mod === 'object' && 'default' in mod && typeof mod.default === 'function') {
    return mod.default as JsQrFn;
  }
  throw new Error('jsqr export is not a function');
}

const decodeQr = resolveJsQr(jsQrModule);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const PUBLIC_ORIGIN = process.env.PUBLIC_ORIGIN ?? '';
const EMBED_ORIGIN = process.env.EMBED_ORIGIN ?? '';
const missingEnv = [
  PUBLIC_ORIGIN ? '' : 'PUBLIC_ORIGIN',
  EMBED_ORIGIN ? '' : 'EMBED_ORIGIN',
].filter(Boolean).join(' and ');

const BOOKS = [
  { version: 'gift-of-the-magi', title: 'The Gift of the Magi' },
  { version: 'yellow-wallpaper', title: 'The Yellow Wallpaper' },
] as const;

type CheckoutEvent = { state?: string };
type CheckoutWindow = {
  __ssfCheckout?: CheckoutEvent[];
  addEventListener(type: string, listener: (event: { detail?: unknown }) => void): void;
};

test.beforeEach(() => {
  test.skip(missingEnv.length > 0, `missing ${missingEnv}`);
});

function decorateBuild(html: string): string {
  const attrs = [
    'data-min-confirmations="3"',
    'data-network="test"',
    `data-embed-origins="${EMBED_ORIGIN}"`,
    `data-public-origin="${PUBLIC_ORIGIN}"`,
  ].join(' ');
  if (!html.includes('id="app"')) return html;
  return html.replace(/<main id="app"[^>]*>/, `<main id="app" ${attrs}>`);
}

function rasterizeSvg(svg: string): { width: number; height: number; data: Uint8ClampedArray } {
  const viewBox = svg.match(/viewBox="0 0 (\d+) (\d+)"/);
  if (!viewBox) throw new Error('svg missing viewBox');
  const width = Number(viewBox[1]);
  const height = Number(viewBox[2]);
  const data = new Uint8ClampedArray(width * height * 4).fill(255);
  const rectRe = /<rect\b([^>]*?)\/?>/g;
  let match: RegExpExecArray | null;
  while ((match = rectRe.exec(svg))) {
    const attrs = match[1] ?? '';
    if (!/fill="#111"/.test(attrs)) continue;
    const xFound = attrs.match(/(?:^|\s)x="(\d+)"/);
    const yFound = attrs.match(/(?:^|\s)y="(\d+)"/);
    const wFound = attrs.match(/(?:^|\s)width="(\d+)"/);
    const hFound = attrs.match(/(?:^|\s)height="(\d+)"/);
    if (!xFound || !yFound || !wFound || !hFound) continue;
    const x0 = Number(xFound[1]);
    const y0 = Number(yFound[1]);
    const w = Number(wFound[1]);
    const h = Number(hFound[1]);
    for (let y = y0; y < y0 + h; y += 1) {
      for (let x = x0; x < x0 + w; x += 1) {
        const idx = (y * width + x) * 4;
        data[idx] = 0;
        data[idx + 1] = 0;
        data[idx + 2] = 0;
        data[idx + 3] = 255;
      }
    }
  }
  return { width, height, data };
}

async function rememberCheckout(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const events: Array<{ state?: string }> = [];
    const host = globalThis as unknown as CheckoutWindow;
    host.__ssfCheckout = events;
    host.addEventListener('ssf:checkout', (event) => {
      if (!('detail' in event) || !event.detail || typeof event.detail !== 'object' || !('state' in event.detail)) {
        events.push({});
        return;
      }
      const state = event.detail.state;
      events.push(typeof state === 'string' ? { state } : {});
    });
  });
}

test('catalogue lists both books with the testnet badge and 3 confirmations', async ({ page }) => {
  await page.goto(`${PUBLIC_ORIGIN}/`, { waitUntil: 'domcontentloaded' });
  await expect(page.locator('#view-catalogue')).toBeVisible();
  for (const book of BOOKS) {
    await expect(page.locator('#view-catalogue')).toContainText(book.title);
    await expect(page.locator(`#view-catalogue a[href="/p/${book.version}"]`)).toBeVisible();
  }
  await expect(page.locator('#testnet-badge')).toContainText('testnet');
  await expect(page.locator('#view-catalogue')).toContainText('testnet');
  await expect(page.locator('#confirmation-floor')).toContainText('3 confirmations');
});

test('embed buy opens a testnet invoice and the shop receives invoiced', async ({ page }) => {
  await rememberCheckout(page);
  await page.goto(`${EMBED_ORIGIN}/`, { waitUntil: 'domcontentloaded' });
  const buy = page.locator('ssf-buy[product="gift-of-the-magi"]').getByRole('button', { name: 'Buy' });
  await expect(buy).toBeVisible();
  const popupPromise = page.waitForEvent('popup');
  await buy.click();
  const popup = await popupPromise;
  await expect(popup).toHaveURL(/\/p\/gift-of-the-magi/);
  await popup.getByRole('button', { name: 'Buy' }).click();
  const uri = popup.locator('#zip321-uri');
  await expect(uri).toBeVisible({ timeout: 150_000 });
  const shown = (await uri.textContent())?.trim() ?? '';
  expect(shown).toMatch(/^zcash:utest1/);
  const svg = await popup.locator('[data-zip321-qr] svg').evaluate((el) => el.outerHTML);
  const bitmap = rasterizeSvg(svg);
  const decoded = decodeQr(bitmap.data, bitmap.width, bitmap.height);
  expect(decoded?.data, 'jsqr failed to decode the rendered QR').toBe(shown);
  await expect(page.locator('#checkout-status')).toHaveText('Invoice opened', { timeout: 15_000 });
  const events = await page.evaluate(() => {
    const host = globalThis as unknown as CheckoutWindow;
    return host.__ssfCheckout ?? [];
  });
  expect(events).toEqual(expect.arrayContaining([expect.objectContaining({ state: 'invoiced' })]));
});

test('ciphertext endpoint returns 200 with ETag and Range support', async ({ request }) => {
  const full = await request.get(`${PUBLIC_ORIGIN}/ciphertext/gift-of-the-magi`);
  expect(full.status()).toBe(200);
  const etag = full.headers().etag ?? '';
  expect(etag).toMatch(/^"[0-9a-f]{64}"$/);
  expect(full.headers()['accept-ranges']).toBe('bytes');
  const ranged = await request.get(`${PUBLIC_ORIGIN}/ciphertext/gift-of-the-magi`, {
    headers: { Range: 'bytes=0-15' },
  });
  expect(ranged.status()).toBe(206);
  expect(ranged.headers().etag).toBe(etag);
  expect(ranged.headers()['content-range']).toMatch(/^bytes 0-15\/\d+$/);
  expect((await ranged.body()).byteLength).toBe(16);
});

test('security headers reject wildcards and hide admin', async ({ request }) => {
  for (const path of ['/', '/index.html', '/p/gift-of-the-magi']) {
    const response = await request.get(`${PUBLIC_ORIGIN}${path}`);
    expect(response.status(), path).toBe(200);
    const headers = response.headers();
    const csp = headers['content-security-policy'] ?? '';
    expect(csp, path).not.toBe('');
    expect(csp, path).not.toContain('*');
    expect(csp, path).toContain("frame-ancestors 'none'");
    expect(headers['strict-transport-security'] ?? '', path).toMatch(/max-age=\d+/);
  }
  const admin = await request.get(`${PUBLIC_ORIGIN}/admin/health`);
  expect(admin.status()).toBe(404);
});

test('served index.html bytes equal the build', async ({ request }) => {
  const built = readFileSync(join(ROOT, 'dist/browser/index.html'));
  const response = await request.get(`${PUBLIC_ORIGIN}/index.html`);
  expect(response.status()).toBe(200);
  const served = Buffer.from(await response.body());
  const builtText = built.toString('utf8');
  const servedText = served.toString('utf8');
  const builtScripts = builtText.match(/<script/gi)?.length ?? 0;
  const servedScripts = servedText.match(/<script/gi)?.length ?? 0;
  expect(servedScripts).toBe(builtScripts);
  const decorated = Buffer.from(decorateBuild(builtText));
  expect(served.equals(decorated)).toBe(true);
});

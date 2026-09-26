/**
 * Waku live, payment fixture.
 *
 * Real-controls acceptance of the real-demo browser order path: the seller's
 * Waku session is a real `createWakuSession` over the live public bootstrap
 * peers pinned in `.runtime/live/live.env`; the browser opens its own real
 * Waku sessions from `/api/waku-config`. Only the payment is a labelled
 * `MemoryScanner` fixture (see tests/support/waku-seller-harness.ts).
 *
 * Controls are driven only through getByRole/getByText. No window.__ssf.
 * Missing live peers → SKIP with the reason; FAIL under SSF_STRICT_LIVE=1.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import {
  FIXTURE_PLAINTEXT,
  HARNESS_LABEL,
  STRICT_LIVE,
  startWakuSellerHarness,
  type WakuSellerHarness,
} from '../support/waku-seller-harness.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

test.use({
  launchOptions: {
    executablePath: '/usr/bin/chromium',
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  },
  acceptDownloads: true,
});

test.describe(`${HARNESS_LABEL}: real-controls purchase over live Waku`, () => {
  test.describe.configure({ mode: 'serial', timeout: 240_000 });

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

  test('buy → QR/URI → fixture pays → confirmed → open purchase → recover → download → decrypt → ack', async ({ page }) => {
    test.skip(!harness, `${HARNESS_LABEL} precondition: ${skipReason}`);
    const h = harness!;
    // Diagnostics only: error class/message text, never payloads or keys.
    const pageErrors: string[] = [];
    page.on('pageerror', (error) => pageErrors.push(error.message.slice(0, 200)));
    page.on('console', (msg) => {
      if (msg.type() === 'error') pageErrors.push(msg.text().slice(0, 200));
    });
    page.on('close', () => {
      if (pageErrors.length) console.log(`[waku-flow page errors]\n${pageErrors.join('\n')}`);
    });

    await page.goto(h.url + '/');
    const buy = page.getByRole('button', { name: 'Buy' });
    await expect(buy).toBeEnabled({ timeout: 30_000 });
    await buy.click();

    // The signed create request crossed the live Waku network and the seller issued an invoice.
    await expect.poll(() => h.invoiceCount(), { timeout: 90_000 }).toBe(1);
    // The invoice reply crossed back: the QR and exact ZIP-321 URI render.
    await expect(page.getByRole('img', { name: 'Payment request QR' })).toBeVisible({ timeout: 90_000 });
    await expect(page.getByText(/^zcash:uregtest1[0-9a-z]+\?amount=/)).toBeVisible();

    // Labelled fixture payment (10 confirmations).
    await h.pay();

    await page.getByRole('button', { name: 'My purchases' }).click();
    const row = page.getByRole('button', { name: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/ });
    await expect(row).toHaveCount(1);

    const download = page.waitForEvent('download', { timeout: 120_000 });
    await row.click();
    await expect(page.getByText('Paid', { exact: true })).toBeVisible({ timeout: 90_000 });

    const file = await download;
    const path = await file.path();
    expect(readFileSync(path, 'utf8')).toBe(FIXTURE_PLAINTEXT);

    // The seller released the package over Waku; the buyer acknowledges it.
    await expect.poll(() => h.deliveryState(), { timeout: 60_000 }).toBe('acknowledged');
  });
});

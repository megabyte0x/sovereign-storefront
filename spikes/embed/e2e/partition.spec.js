import { test, expect } from '@playwright/test';

const EMBEDDER = 'http://a.localhost:5001/embedder.html';
const STOREFRONT = 'http://s.localhost:5002/storefront.html';

function purchaseId(model) {
  return `${model}-${test.info().project.name}-${Date.now()}`;
}



test('(i) iframe IDB write is not visible at top-level storefront', async ({ page, context }) => {
  const id = purchaseId('iframe');
  await page.goto(`${EMBEDDER}?model=iframe&id=${encodeURIComponent(id)}`);
  const frame = page.frameLocator('#storefront-frame');
  await expect(frame.locator('#status')).toHaveText(/written|write-failed|write-mismatch/, {
    timeout: 20_000,
  });
  const iframeStatus = await frame.locator('#status').textContent();
  const iframeValue = await frame.locator('#value').textContent();

  const top = await context.newPage();
  await top.goto(`${STOREFRONT}?read=${encodeURIComponent(id)}`);
  await expect(top.locator('#status')).toHaveText(/found|missing|read-failed/);
  const topStatus = await top.locator('#status').textContent();
  const topValue = await top.locator('#value').textContent();
  const visible = topStatus === 'found' && topValue.includes(id);

  console.log(
    JSON.stringify({
      browser: test.info().project.name,
      model: 'iframe',
      iframeStatus,
      iframeValue,
      topStatus,
      topValue,
      visibleAtTopLevel: visible,
    }),
  );

  expect(visible, `iframe write leaked to first-party IDB (status=${topStatus})`).toBe(false);
});

test('(ii) popup IDB write is visible at top-level storefront', async ({ page, context }) => {
  const id = purchaseId('popup');
  await page.goto(`${EMBEDDER}?model=popup&id=${encodeURIComponent(id)}`);
  const popupPromise = page.waitForEvent('popup');
  await page.locator('#buy').click();
  const popup = await popupPromise;
  await expect(popup.locator('#status')).toHaveText(/written|write-failed|write-mismatch/, {
    timeout: 20_000,
  });
  const popupStatus = await popup.locator('#status').textContent();
  const popupValue = await popup.locator('#value').textContent();
  expect(popupStatus, `popup write failed: ${popupValue}`).toBe('written');

  const top = await context.newPage();
  await top.goto(`${STOREFRONT}?read=${encodeURIComponent(id)}`);
  await expect(top.locator('#status')).toHaveText(/found|missing|read-failed/);
  const topStatus = await top.locator('#status').textContent();
  const topValue = await top.locator('#value').textContent();
  const visible = topStatus === 'found' && topValue.includes(id);

  console.log(
    JSON.stringify({
      browser: test.info().project.name,
      model: 'popup',
      popupStatus,
      popupValue,
      topStatus,
      topValue,
      visibleAtTopLevel: visible,
    }),
  );

  expect(visible, `popup write not visible first-party (status=${topStatus} value=${topValue})`).toBe(
    true,
  );
});

test('(iii) popup posts CheckoutResult to window.opener', async ({ page }) => {
  const id = purchaseId('postmessage');
  await page.goto(`${EMBEDDER}?model=popup&id=${encodeURIComponent(id)}`);
  const popupPromise = page.waitForEvent('popup');
  await page.locator('#buy').click();
  const popup = await popupPromise;
  await expect(popup.locator('#status')).toHaveText('written', { timeout: 20_000 });
  await expect(page.locator('#message')).not.toHaveText('none', { timeout: 10_000 });
  const messageText = await page.locator('#message').textContent();
  const posted = await popup.evaluate(() => window.__ssf && window.__ssf.posted);
  const received = await page.evaluate(() => window.__ssfMessage);

  console.log(
    JSON.stringify({
      browser: test.info().project.name,
      model: 'postMessage',
      posted,
      messageText,
      received,
      visibleAtTopLevel: received != null && received.state === 'invoiced' && received.id === id,
    }),
  );

  expect(posted).toBe(true);
  expect(received).toEqual({ type: 'ssf-checkout', state: 'invoiced', id });
});

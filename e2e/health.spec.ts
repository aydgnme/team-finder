import { expect, test } from '@playwright/test';

// Also meant to run against production after deploy: proves the same-origin /api proxy and that the
// browser (WebKit included) sends first-party HttpOnly cookies back through it.
test('web reaches the API through the same-origin /api proxy and keeps its cookie', async ({ page }) => {
  const health = page.waitForResponse((r) => r.url().endsWith('/api/health'));
  await page.goto('/');
  expect(await (await health).json()).toMatchObject({ status: 'ok', cookieRoundTrip: false });

  // The app's own health check set the probe cookie; a second request from the page sends it back.
  const again = await page.evaluate(() => fetch('/api/health', { credentials: 'same-origin' }).then((r) => r.json()));
  expect(again).toMatchObject({ status: 'ok', cookieRoundTrip: true });
  expect(await page.evaluate(() => document.cookie)).not.toContain('tf_probe'); // HttpOnly
});

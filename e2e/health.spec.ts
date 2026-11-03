import { expect, test } from '@playwright/test';

test('web reaches the API through the same-origin /api proxy and keeps its cookie', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('health-status')).toHaveText('ok');
  await expect(page.getByTestId('health-cookie')).toHaveText('false');

  await page.getByRole('button', { name: 'Check again' }).click();
  await expect(page.getByTestId('health-cookie')).toHaveText('true');
});

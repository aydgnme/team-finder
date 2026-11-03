import { expect, test } from '@playwright/test';

// M2.5: the race page runs the real approve() twice at once; exactly one lane commits and the
// other is replayed and refused with CAPACITY_EXCEEDED.

test('Watch the race: one approval wins, the other is replayed and refused', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('goal')).toBeVisible();
  await page.getByRole('link', { name: 'How it works' }).click();
  await page.getByRole('button', { name: 'Run the race' }).click();

  const result = page.getByTestId('race-result');
  await expect(result.getByRole('heading')).toHaveText(
    /^✓ [AB] committed · ✗ [AB] refused \(CAPACITY_EXCEEDED\) · replays [1-9]\d*$/,
  );
  await expect(page.locator('.race-committed')).toHaveCount(1);
  await expect(page.locator('.race-refused')).toHaveCount(1);
  await expect(result.locator('.race-text')).toContainText('replay');
  await expect(page.getByTestId('live-region')).toContainText('was replayed and refused with CAPACITY_EXCEEDED');

  // Running it again works, and the visitor's own sandbox is untouched.
  await page.getByRole('button', { name: 'Run it again' }).click();
  await expect(result.getByRole('heading')).toContainText('committed');
  await page.getByRole('navigation', { name: 'Screens' }).getByRole('link', { name: 'Canvas' }).click();
  await expect(page.getByTestId('goal')).toHaveText('Staff Atlas: 2 slots open, AWS not covered');
});

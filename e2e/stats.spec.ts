import { expect, test } from '@playwright/test';

// M5: Stats-01. Dana sees Engineering's validated skills as bars with a level split, and the same
// numbers in a table. The seed is the 60-person company; Engineering keeps the Atlas cast.

test("a manager reads their department's skills", async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('goal')).toBeVisible();
  await page.getByLabel('Viewing as').selectOption({ label: 'Dana Okafor (Engineering Manager)' });
  await expect(page.getByTestId('live-region')).toContainText('Now viewing as');

  await page.getByRole('navigation', { name: 'Screens' }).getByRole('link', { name: 'Organization' }).click();
  await page.getByRole('link', { name: 'Departments' }).click();
  await page.getByRole('link', { name: 'Skill stats for Engineering' }).click();

  await expect(page.getByTestId('stats-title')).toHaveText('Engineering skills');
  await expect(page.getByTestId('stats-summary')).toContainText('8 people, 1 without a validated skill');
  const ts = page.getByTestId('stats-table').getByRole('row', { name: /TypeScript/ });
  await expect(ts.getByRole('cell').nth(1)).toHaveText('7');

  // The bar explains itself on hover and keyboard focus.
  await page.getByRole('img', { name: 'TypeScript: 7 of 8 people' }).focus();
  await expect(page.getByRole('tooltip')).toHaveText('TypeScript: 7 of 8 people');
  // Jo's pending Go claim is not counted.
  await expect(page.getByTestId('stats-table')).not.toContainText('Go');
});

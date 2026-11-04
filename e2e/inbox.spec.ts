import { expect, test, type Page } from '@playwright/test';

// M4a: the inbox (Notification-01), skill validation (Skill-04) and required skills (Project-10).
// Demo seed: Dana's inbox holds Leo's and Kai's Atlas proposals and Jo's pending Go claim.

async function persona(page: Page, label: string) {
  await page.getByLabel('Viewing as').selectOption({ label });
  await expect(page.getByTestId('live-region')).toContainText('Now viewing as');
}

const screens = (page: Page) => page.getByRole('navigation', { name: 'Screens' });

test('the manager is told about a skill claim, validates it, and the inbox catches up', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('goal')).toBeVisible();
  // Pat has nothing; switching to Dana refetches the badge for her.
  await expect(page.getByTestId('unread-badge')).toHaveCount(0);
  await persona(page, 'Dana Okafor (Engineering Manager)');
  await expect(page.getByTestId('unread-badge')).toHaveText('3 unread');

  await screens(page).getByRole('link', { name: /Inbox/ }).click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('3 unread');
  const claim = page.getByTestId('notification').filter({ hasText: 'Jo Park claimed Go' });
  await expect(claim).toContainText('it needs your validation');
  await claim.getByRole('link', { name: 'Open approvals' }).click();

  // Following it marks it read; the claim waits in Approvals below the proposals.
  await expect(page.getByTestId('unread-badge')).toHaveText('2 unread');
  const claims = page.getByTestId('skill-claims');
  await expect(claims).toContainText('Jo Park · Go');
  await claims.getByRole('button', { name: "Validate Jo Park's Go" }).click();
  await expect(page.getByTestId('live-region')).toHaveText("Jo Park's Go is validated.");
  await expect(page.getByTestId('skill-claims')).toHaveCount(0);

  await screens(page).getByRole('link', { name: /Inbox/ }).click();
  await page.getByRole('button', { name: 'Mark all read' }).click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('You are all caught up');
  await expect(page.getByTestId('unread-badge')).toHaveCount(0);
});

test('a claim waits for validation, and a PM sets minimum skill levels on a project', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('goal')).toBeVisible();

  await persona(page, 'Ana Silva (Backend Developer)');
  await screens(page).getByRole('link', { name: 'Organization' }).click();
  await page.getByRole('link', { name: 'Skills' }).click();
  await page.getByLabel('Skill to add').selectOption({ label: 'AWS' });
  await page.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(page.getByTestId('live-region')).toHaveText('AWS saved; waiting for validation.');
  await expect(page.getByTestId('my-skill-AWS')).toContainText('Pending validation');

  await persona(page, 'Pat Reyes (Project Manager)');
  await screens(page).getByRole('link', { name: 'Projects' }).click();
  await page.getByRole('button', { name: 'New project' }).click();
  const form = page.getByTestId('project-form');
  await form.getByLabel('Name', { exact: true }).fill('Gatekeeper');
  await form.getByLabel('Start', { exact: true }).fill('2030-01-07');
  await form.getByLabel('Deadline', { exact: true }).fill('2030-06-28');
  await form.getByLabel('Add a required skill').selectOption({ label: 'TypeScript' });
  await form.getByLabel('Minimum level in TypeScript').selectOption('5');
  await form.getByRole('button', { name: 'Create project' }).click();
  await expect(page.getByTestId('project-Gatekeeper')).toBeVisible();

  await page.getByTestId('project-Gatekeeper').getByRole('button', { name: 'Edit' }).click();
  await expect(page.getByTestId('project-form').getByLabel('Minimum level in TypeScript')).toHaveValue('5');
});

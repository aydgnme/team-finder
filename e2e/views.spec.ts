import { expect, test, type Page } from '@playwright/test';

// M3b: project, person and department views (Project-06..09), ending an assignment in two steps
// (Project-04/05), moving a project's dates with its team, and the admin "no approver" list.
// Demo seed: Pat is every project's PM, Dana manages Engineering, Olivia is the org admin.

async function persona(page: Page, label: string) {
  await page.getByLabel('Viewing as').selectOption({ label });
  await expect(page.getByTestId('live-region')).toContainText('Now viewing as');
}

test('the PM ends an assignment, the manager agrees, and it shows as past work', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('goal')).toBeVisible();
  await page.getByRole('navigation', { name: 'Screens' }).getByRole('link', { name: 'Projects' }).click();
  await page.getByTestId('project-Orion').getByRole('link', { name: 'Orion' }).click();
  await expect(page.getByTestId('project-title')).toHaveText('Orion');
  await expect(page.getByTestId('team-active')).toContainText('Mira Chen');

  const mira = page.getByTestId('team-active').getByTestId('member-Mira Chen');
  await mira.getByRole('button', { name: 'End assignment' }).click();
  await mira.getByLabel("Why end Mira Chen's assignment").fill('Moving to Atlas');
  await mira.getByRole('button', { name: 'Ask their manager' }).click();
  await expect(mira).toContainText('Ending: “Moving to Atlas”, waiting for their manager');

  await persona(page, 'Dana Okafor (Engineering Manager)');
  await page.getByRole('navigation', { name: 'Screens' }).getByRole('link', { name: 'Approvals' }).click();
  const row = page.getByTestId('approval-Mira Chen');
  await expect(row).toContainText('Ends their assignment');
  await expect(row).toContainText('Reason: “Moving to Atlas”');
  await expect(row).toContainText('Frees 2 h/day');
  await row.getByRole('button', { name: 'Approve ending Mira Chen on Orion' }).click();
  await expect(page.getByTestId('approved-banner')).toContainText('Mira Chen leaves Orion.');

  // Dana sees her people's projects: Mira's Orion work is now in the past.
  await page.getByRole('navigation', { name: 'Screens' }).getByRole('link', { name: 'Organization' }).click();
  await page.getByRole('link', { name: 'Departments' }).click();
  await page.getByTestId('dept-Engineering').getByRole('link', { name: 'Mira Chen' }).click();
  await expect(page.getByTestId('person-title')).toHaveText('Mira Chen');
  await expect(page.getByTestId('person-past')).toContainText('Orion');
});

test("a department's projects, filtered by status, for its manager", async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('goal')).toBeVisible();
  await persona(page, 'Dana Okafor (Engineering Manager)');
  await page.goto('/#/departments');
  await page.getByTestId('dept-Engineering').getByRole('link', { name: 'Projects' }).click();
  await expect(page.getByTestId('dept-projects-title')).toHaveText('Engineering projects');
  await expect(page.getByTestId('dept-projects')).toContainText('Helios');
  await page.getByLabel('Filter by status').selectOption({ label: 'In progress' });
  await expect(page.getByTestId('dept-projects').getByRole('listitem')).toHaveCount(2);
  await expect(page.getByTestId('dept-project-Orion')).toContainText('Kai Nakamura');
});

test('moving the start later moves the whole team with it', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('goal')).toBeVisible();
  await page.getByRole('navigation', { name: 'Screens' }).getByRole('link', { name: 'Projects' }).click();
  const atlas = page.getByTestId('project-Atlas');
  await atlas.getByRole('button', { name: 'Edit' }).click();
  const form = page.getByTestId('project-form');
  const start = await form.getByLabel('Start', { exact: true }).inputValue();
  const later = new Date(Date.parse(`${start}T00:00:00Z`) + 14 * 86_400_000).toISOString().slice(0, 10);
  await form.getByLabel('Start', { exact: true }).fill(later);
  await form.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByTestId('live-region')).toHaveText('Atlas saved.');

  await atlas.getByRole('link', { name: 'Atlas' }).click();
  const fromDay = new Date(`${later}T00:00:00Z`).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  });
  await expect(page.getByTestId('team-active').getByTestId('member-Ana Silva')).toContainText(fromDay);
  await expect(page.getByTestId('team-proposed').getByTestId('member-Leo Martin')).toContainText(fromDay);
});

test('admins see proposals that nobody can decide', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('goal')).toBeVisible();
  await persona(page, 'Dana Okafor (Engineering Manager)');
  await page.goto('/#/departments');
  await page
    .getByTestId('dept-Engineering')
    .getByRole('button', { name: 'Remove Kai Nakamura from Engineering' })
    .click();
  await expect(page.getByTestId('live-region')).toHaveText('Kai Nakamura left Engineering.');

  await persona(page, 'Olivia Grant (Organization admin)');
  await page.goto('/#/org');
  await expect(page.getByTestId('no-approver')).toContainText('Kai Nakamura · proposed for Atlas');
});

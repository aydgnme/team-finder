import { expect, test } from '@playwright/test';

// M2 journey (docs/plans/m2-auth-and-roles.md): create an organization, invite an employee who
// joins from another browser, grant them a role, sign out and back in. The demo stays sign-up free.

const PASSWORD = 'correct horse battery';

test('sign up, invite, join, grant a role, sign out and in again', async ({ page, browser }) => {
  const stamp = Date.now();
  const adminEmail = `admin.${stamp}@acme.example`;

  // The demo dock links to sign-up; following it creates no sandbox of its own.
  await page.goto('/');
  await expect(page.getByTestId('goal')).toBeVisible();
  await page.getByRole('link', { name: 'Create your organization' }).click();
  await expect(page.getByTestId('signup')).toBeVisible();

  await page.getByLabel('Organization name').fill('Acme Consulting');
  await page.getByLabel('Your name').fill('Mert Admin');
  await page.getByLabel('Work email').fill(adminEmail);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Create organization' }).click();

  await expect(page.getByTestId('org-title')).toHaveText('Acme Consulting');
  await expect(page.getByTestId('no-projects')).toBeVisible();
  await expect(page.getByTestId('signed-in-as')).toHaveText('Mert Admin');
  const link = await page.getByTestId('invite-link').inputValue();
  expect(link).toMatch(/#\/join\/[A-Za-z0-9_-]{43}$/);

  // Team roles: add one, a duplicate in another case is refused.
  await page.getByLabel('New team role').fill('Backend Developer');
  await page.getByRole('button', { name: 'Add' }).click();
  await expect(page.getByTestId('team-role-Backend Developer')).toBeVisible();
  await page.getByLabel('New team role').fill('backend developer');
  await page.getByRole('button', { name: 'Add' }).click();
  await expect(page.getByRole('alert')).toContainText('already exists');

  // An employee joins from a separate browser.
  const other = await browser.newContext();
  const emma = await other.newPage();
  await emma.goto(link);
  await expect(emma.getByRole('heading', { name: 'Join Acme Consulting' })).toBeVisible();
  await emma.getByLabel('Your name').fill('Emma Employee');
  await emma.getByLabel('Work email').fill(`emma.${stamp}@acme.example`);
  await emma.getByLabel('Password').fill(PASSWORD);
  await emma.getByRole('button', { name: 'Join Acme Consulting' }).click();
  await expect(emma.getByTestId('org-title')).toHaveText('Acme Consulting');
  await expect(emma.getByTestId('invite-link')).toHaveCount(0);
  await expect(emma.getByTestId('member-Emma Employee')).toContainText('Employee');

  // The admin makes Emma a project manager; she sees it on her next load.
  await page.reload();
  await page.getByTestId('member-Emma Employee').getByLabel('Project manager').check();
  await expect(page.getByTestId('live-region')).toHaveText('Roles updated for Emma Employee.');
  await emma.reload();
  await expect(emma.getByTestId('member-Emma Employee')).toContainText('Project manager');
  await other.close();

  // The last admin cannot drop their own admin role.
  await page.getByTestId('member-Mert Admin').getByLabel('Admin').uncheck();
  await expect(page.getByTestId('member-Mert Admin').getByRole('alert')).toContainText('at least one admin');

  // Sign out, then back in.
  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page.getByTestId('login')).toBeVisible();
  await page.getByLabel('Email').fill(adminEmail);
  await page.getByLabel('Password').fill('wrong password!!');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByTestId('auth-error')).toContainText('Email or password is incorrect.');
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByTestId('org-title')).toHaveText('Acme Consulting');
});

test('a replaced invite link stops working', async ({ page }) => {
  await page.goto('/#/join/not-a-real-token');
  await expect(page.getByTestId('join-invalid')).toContainText('Ask your admin for the current one');
});

import { expect, test } from '@playwright/test';

// M3a: a brand-new organization sets itself up and staffs its first project, end to end: roles,
// a department with a manager, a skill, an employee who claims it, a project that needs it, a
// proposal on the canvas and its approval. Plus the project lifecycle on the demo.

const PASSWORD = 'correct horse battery';

test('a new org sets up a department, skills and a project, then staffs it', async ({ page, browser }) => {
  page.on('dialog', (d) => void d.accept());
  const stamp = Date.now();

  await page.goto('/#/signup');
  await page.getByLabel('Organization name').fill('Nimbus Labs');
  await page.getByLabel('Your name').fill('Iris Admin');
  await page.getByLabel('Work email').fill(`iris.${stamp}@nimbus.example`);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Create organization' }).click();
  await expect(page.getByTestId('projects-title')).toBeVisible();

  // Organization: Iris also runs projects and a department; one team role.
  await page.getByRole('navigation', { name: 'Screens' }).getByRole('link', { name: 'Organization' }).click();
  const iris = page.getByTestId('member-Iris Admin');
  await iris.getByLabel('Project manager').check();
  await expect(page.getByTestId('live-region')).toHaveText('Roles updated for Iris Admin.');
  await iris.getByLabel('Department manager').check();
  await expect(iris.getByLabel('Department manager')).toBeChecked();
  await page.getByLabel('New team role').fill('Backend Developer');
  await page.getByRole('button', { name: 'Add' }).click();
  await expect(page.getByTestId('team-role-Backend Developer')).toBeVisible();
  const link = await page.getByTestId('invite-link').inputValue();

  // Departments: Engineering, managed by Iris.
  await page.getByRole('link', { name: 'Departments' }).click();
  await page.getByLabel('New department').fill('Engineering');
  await page.getByRole('button', { name: 'Add department' }).click();
  const eng = page.getByTestId('dept-Engineering');
  await eng.getByLabel('Manager of Engineering').selectOption({ label: 'Iris Admin' });
  await expect(page.getByTestId('live-region')).toHaveText('Manager of Engineering updated.');
  // The saved value, not just the toast: the select must still show Iris after the refetch.
  await expect(eng.getByLabel('Manager of Engineering')).toHaveValue(/.+/);
  await page.reload();
  await expect(page.getByTestId('dept-Engineering').getByLabel('Manager of Engineering')).not.toHaveValue('');

  // Skills: a category and a skill.
  await page.getByRole('link', { name: 'Skills' }).click();
  await page.getByLabel('New category').fill('Languages');
  await page.getByRole('button', { name: 'Add category' }).click();
  await expect(page.getByTestId('category-Languages')).toBeVisible();
  await page.getByLabel('New skill').fill('TypeScript');
  await page.getByLabel('Category', { exact: true }).selectOption({ label: 'Languages' });
  await page.getByRole('button', { name: 'Add skill' }).click();
  await expect(page.getByTestId('skill-TypeScript')).toContainText('by Iris Admin');

  // Lena joins, Iris adds her to Engineering, Lena claims TypeScript.
  const other = await browser.newContext();
  const lena = await other.newPage();
  await lena.goto(link);
  await lena.getByLabel('Your name').fill('Lena Dev');
  await lena.getByLabel('Work email').fill(`lena.${stamp}@nimbus.example`);
  await lena.getByLabel('Password').fill(PASSWORD);
  await lena.getByRole('button', { name: 'Join Nimbus Labs' }).click();
  await expect(lena.getByTestId('projects-title')).toBeVisible();

  await page.getByRole('link', { name: 'Departments' }).click();
  await page.reload();
  await page
    .getByTestId('dept-Engineering')
    .getByLabel('Add someone to Engineering')
    .selectOption({ label: 'Lena Dev' });
  await expect(
    page.getByTestId('dept-Engineering').getByRole('button', { name: 'Remove Lena Dev from Engineering' }),
  ).toBeVisible();

  await lena.goto(link.replace(/#\/join\/.*/, '#/skills'));
  await lena.getByLabel('Skill to add').selectOption({ label: 'TypeScript' });
  await lena.getByLabel('Level', { exact: true }).selectOption('4');
  await lena.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(lena.getByTestId('my-skill-TypeScript')).toBeVisible();
  await other.close();

  // Projects: Iris creates Apollo needing one backend developer who knows TypeScript.
  await page.getByRole('navigation', { name: 'Screens' }).getByRole('link', { name: 'Projects' }).click();
  await page.getByRole('button', { name: 'New project' }).click();
  const form = page.getByTestId('project-form');
  await form.getByLabel('Name', { exact: true }).fill('Apollo');
  await form.getByLabel('Start', { exact: true }).fill('2030-01-07');
  await form.getByLabel('Deadline', { exact: true }).fill('2030-06-28');
  await form.getByLabel('Add a team role').selectOption({ label: 'Backend Developer' });
  await form.getByLabel('TypeScript').check();
  await form.getByRole('button', { name: 'Create project' }).click();
  const apollo = page.getByTestId('project-Apollo');
  await expect(apollo).toContainText('0/1 slots');

  // Staff it on the canvas, approve as Lena's manager (Iris), and the slot is active.
  await apollo.getByRole('link', { name: 'Staff' }).click();
  await expect(page.getByTestId('goal')).toHaveText('Staff Apollo: 1 slot open, TypeScript not covered');
  await page.getByTestId('candidate-Lena Dev').getByRole('button', { name: 'Add to slot' }).click();
  await page.getByRole('menuitem', { name: 'Backend Developer 1' }).click();
  await page
    .getByTestId('propose-popover')
    .getByRole('button', { name: /Propose/ })
    .click();
  await expect(page.getByTestId('slot-Backend Developer-1')).toHaveAttribute('data-state', 'pending');
  await page.getByRole('navigation', { name: 'Screens' }).getByRole('link', { name: 'Approvals' }).click();
  await page.getByTestId('approval-Lena Dev').getByRole('button', { name: 'Approve Lena Dev for Apollo' }).click();
  await expect(page.getByTestId('approved-banner')).toContainText('Lena Dev added to Apollo.');

  // Lifecycle: move it forward; once in progress it can no longer be deleted.
  await page.getByRole('navigation', { name: 'Screens' }).getByRole('link', { name: 'Projects' }).click();
  await expect(apollo).toContainText('1/1 slots');
  await apollo.getByLabel('Move Apollo to').selectOption({ label: 'In progress' });
  await expect(apollo).toContainText('In progress');
  await expect(apollo.getByRole('button', { name: 'Delete' })).toHaveCount(0);
});

test('demo: closing a project ends started work and frees people', async ({ page }) => {
  page.on('dialog', (d) => void d.accept());
  await page.goto('/');
  await expect(page.getByTestId('goal')).toBeVisible();
  await page.getByRole('navigation', { name: 'Screens' }).getByRole('link', { name: 'Projects' }).click();
  const orion = page.getByTestId('project-Orion');
  await orion.getByLabel('Move Orion to').selectOption({ label: 'Closed' });
  await expect(page.getByTestId('live-region')).toHaveText('Orion is now closed. 2 assignments ended, 0 rejected.');
  await expect(orion).toContainText('Closed');
  await expect(orion.getByRole('button', { name: 'Edit' })).toHaveCount(0);

  // Kai's 4 h on Orion are gone: his Atlas proposal no longer conflicts.
  await page.getByTestId('project-Atlas').getByRole('link', { name: 'Staff' }).click();
  await expect(page.getByTestId('slot-QA Engineer-1')).toHaveAttribute('data-state', 'pending');
});

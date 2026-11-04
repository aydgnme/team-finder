import { expect, test, type Page } from '@playwright/test';

// M4b: a skill suggestion from the upgrade job (Project-11) and evidence on a skill (Skill-03).
// Demo seed: Ana has one suggestion (React, from Atlas) and worked on Helios.

async function persona(page: Page, label: string) {
  await page.getByLabel('Viewing as').selectOption({ label });
  await expect(page.getByTestId('live-region')).toContainText('Now viewing as');
}

test('Ana follows a suggestion from her inbox and backs a skill with evidence', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('goal')).toBeVisible();
  await persona(page, 'Ana Silva (Backend Developer)');
  await expect(page.getByTestId('unread-badge')).toHaveText('1 unread');

  await page.getByRole('navigation', { name: 'Screens' }).getByRole('link', { name: /Inbox/ }).click();
  const note = page.getByTestId('notification').filter({ hasText: 'Your work on Atlas uses React' });
  await note.getByRole('link', { name: 'Open my skills' }).click();

  const suggestion = page.getByTestId('suggestion-React');
  await expect(suggestion).toContainText('from Atlas');
  await suggestion.getByLabel('Level in React').selectOption('2');
  await suggestion.getByRole('button', { name: 'Add React' }).click();
  await expect(page.getByTestId('live-region')).toHaveText('React added; waiting for validation.');
  await expect(page.getByTestId('suggested-skills')).toHaveCount(0);
  await expect(page.getByTestId('my-skill-React')).toContainText('Pending validation');

  // Evidence on Node.js: a certification with a link, then a past project.
  const node = page.getByTestId('my-skill-Node.js');
  await node.getByRole('button', { name: 'Add evidence' }).click();
  await node.getByLabel('Title').fill('OpenJS Node.js Application Developer');
  await node.getByLabel('Link (optional)').fill('https://openjsf.org/certification');
  await node.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(page.getByTestId('live-region')).toHaveText('OpenJS Node.js Application Developer added to Node.js.');
  await expect(node.getByRole('link', { name: 'OpenJS Node.js Application Developer' })).toHaveAttribute(
    'href',
    'https://openjsf.org/certification',
  );

  await node.getByRole('button', { name: 'Add evidence' }).click();
  await node.getByLabel('Kind of evidence').selectOption({ label: 'Past project' });
  await node.getByLabel('Project').selectOption({ label: 'Helios' });
  await node.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(node.getByRole('list', { name: 'Evidence for Node.js' })).toContainText('Helios');

  await node.getByRole('button', { name: 'Remove Helios from Node.js' }).click();
  await expect(node.getByRole('list', { name: 'Evidence for Node.js' })).not.toContainText('Helios');
});

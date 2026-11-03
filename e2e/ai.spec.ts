import { expect, test } from '@playwright/test';

// AI-01 with the fake provider (playwright.config sets LLM_PROVIDER=fake): the request becomes a
// checked draft at the suggested start; the verdict line and the commit button take it from there.

test('AI draft: "a backend dev, two weeks later" lands Tom in the draft and the verdict says why', async ({ page }) => {
  const logs: string[] = [];
  page.on('console', (m) => logs.push(m.text()));
  await page.goto('/');
  await expect(page.getByTestId('goal')).toHaveText('Staff Atlas: 2 slots open, AWS not covered');

  const panel = page.getByTestId('ai-panel');
  await panel.getByLabel('Describe the team you need').fill('A backend dev, two weeks later');
  await panel.getByLabel('Describe the team you need').press('Enter');

  await expect(panel.getByTestId('ai-item-Tom Becker')).toContainText('✓ fits at 8 h/day');
  await expect(page.getByTestId('goal')).toHaveText(
    'Atlas: Draft vs current: start +2 wk → coverage 83% → 100%, +0 overbooked days, 1 slot open',
  );
  await expect(page.getByTestId('start-scrubber')).toHaveAttribute('aria-valuetext', /2 wk later$/);
  await expect(page.getByTestId('slot-Backend Developer-2')).toHaveAttribute('data-state', 'draft');
  await expect(page.getByTestId('live-region')).toHaveText(/AI draft: 1 added to the draft\. Start moved to .+\./);
  expect(logs.some((l) => l.startsWith('[AI draft] raw model output'))).toBe(true);

  // Same engine checks as a manual draft: dragging back to the current start overbooks Tom.
  await page.getByTestId('start-scrubber').focus();
  await page.keyboard.press('Home');
  await expect(page.getByTestId('goal')).toContainText('+14 overbooked days');
  await page.keyboard.press('PageUp');
  await page.keyboard.press('PageUp');

  await page.getByRole('button', { name: 'Move start and send 1 proposal' }).click();
  await expect(page.getByTestId('live-region')).toHaveText(/1 proposal sent\.$/);
  await expect(page.getByTestId('slot-Backend Developer-2')).toContainText('Tom Becker');
});

test('AI draft: slot limits and failures are explained, manual staffing keeps working', async ({ page }) => {
  await page.goto('/');
  const panel = page.getByTestId('ai-panel');
  const input = panel.getByLabel('Describe the team you need');

  await input.fill('2 backend devs and a QA');
  await panel.getByRole('button', { name: 'Draft team' }).click();
  await expect(panel.getByTestId('ai-item-Mira Chen')).toContainText('✕ not added: no open slot');
  await expect(panel.getByTestId('ai-item-Jo Park')).toContainText('✕ not added: no open slot');
  await expect(panel.getByTestId('ai-item-Tom Becker')).toContainText('⚠ overbooked from');

  await input.fill('a backend dev [refuse]');
  await panel.getByRole('button', { name: 'Draft team' }).click();
  await expect(panel.getByTestId('ai-error')).toContainText(
    'The AI assistant is unavailable: the model declined this request.',
  );
  await expect(page.getByTestId('candidate-Mira Chen')).toBeVisible();
});

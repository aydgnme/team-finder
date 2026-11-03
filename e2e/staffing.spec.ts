import { expect, test, type Page } from '@playwright/test';

// The M1 journey (docs/design.md, Phase 2 "Journey"): land on Atlas as the PM, propose, switch to the
// department manager, approve, see the slot turn active; a conflicting approval shows the exact reason.

async function landOnAtlas(page: Page) {
  await page.goto('/');
  await expect(page.getByTestId('goal')).toHaveText('Staff Atlas: 2 slots open, AWS not covered');
}

test('keyboard: propose, switch to the dept manager, approve, slot becomes active', async ({ page }) => {
  await landOnAtlas(page);

  // "Add to slot" is the keyboard path: Enter opens the menu, Enter picks the first open slot,
  // the popover is prefilled (6 h/day: Mira has 2 h on Orion), and Enter confirms.
  await page.getByTestId('candidate-Mira Chen').getByRole('button', { name: 'Add to slot' }).focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('menuitem', { name: 'Backend Developer 2' })).toBeFocused();
  await page.keyboard.press('Enter');
  const popover = page.getByTestId('propose-popover');
  await expect(popover.getByLabel('Hours/day')).toBeFocused();
  await expect(popover.getByLabel('Hours/day')).toHaveValue('6');
  await expect(popover.getByTestId('propose-check')).toContainText('Fits');
  await page.keyboard.press('Enter');

  const slot = page.getByTestId('slot-Backend Developer-2');
  await expect(slot).toHaveAttribute('data-state', 'pending');
  await expect(slot).toContainText('Mira Chen');
  await expect(page.getByTestId('live-region')).toHaveText('Mira Chen proposed for Backend Developer. Coverage 100%.');
  await expect(page.getByTestId('goal')).toHaveText('Staff Atlas: 1 slot open, all skills covered');

  // Coach-mark: switch persona to the department manager.
  await page.getByTestId('coach-switch').getByRole('button', { name: 'Switch to Dana' }).click();
  await expect(page.getByRole('heading', { name: "Proposals for Dana's department" })).toBeVisible();
  await expect(page.getByLabel('Viewing as')).toHaveValue(/.+/);

  await page.getByTestId('approval-Mira Chen').getByRole('button', { name: 'Approve Mira Chen for Atlas' }).click();
  await expect(page.getByTestId('approved-banner')).toContainText('Mira Chen added to Atlas.');
  await expect(page.getByTestId('approval-Mira Chen')).toHaveCount(0);

  // Kai's proposal would overbook him: the server re-checks inside the transaction and says why.
  await page
    .getByTestId('approval-Kai Nakamura')
    .getByRole('button', { name: 'Approve Kai Nakamura for Atlas' })
    .click();
  await expect(page.getByTestId('approval-error')).toHaveText(
    /^Would exceed 8 h\/day on \d{4}-\d{2}-\d{2}: 4 h already booked, 6 h requested\. The most you can request from \d{4}-\d{2}-\d{2} is 4 h\/day\.$/,
  );

  await page.getByRole('link', { name: 'View the Atlas canvas' }).click();
  await expect(slot).toHaveAttribute('data-state', 'active');
  await expect(slot).toContainText('Mira Chen');
  await expect(page.getByTestId('slot-QA Engineer-1')).toHaveAttribute('data-state', 'conflict');
});

test('drag: a rolling-off candidate drops into an open slot with their start date prefilled', async ({ page }) => {
  await landOnAtlas(page);
  const card = page.getByTestId('candidate-Tom Becker');
  const slot = page.getByTestId('slot-Backend Developer-2');
  await card.scrollIntoViewIfNeeded();
  const from = (await card.boundingBox())!;
  const to = (await slot.boundingBox())!;

  await page.mouse.move(from.x + 30, from.y + 15);
  await page.mouse.down();
  await page.mouse.move(from.x + 40, from.y + 25, { steps: 4 });
  await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 12 });
  await expect(slot).toContainText('Fits: up to 8 h/day');
  await page.mouse.up();

  const popover = page.getByTestId('propose-popover');
  await expect(popover).toBeVisible();
  // Prefilled with the date Tom rolls off Borealis, not the project start.
  const start = await popover.getByLabel('Start').inputValue();
  const card2 = await page.getByTestId('candidate-Tom Becker').textContent();
  expect(card2).toContain('available from');
  await expect(popover.getByLabel('Hours/day')).toHaveValue('8');
  expect(start).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  await page.keyboard.press('Enter');

  await expect(slot).toHaveAttribute('data-state', 'pending');
  await expect(slot).toContainText('Tom Becker');
});

test('Esc closes the popover and returns focus to the card', async ({ page }) => {
  await landOnAtlas(page);
  const add = page.getByTestId('candidate-Jo Park').getByRole('button', { name: 'Add to slot' });
  await add.click();
  await page.getByRole('menuitem', { name: 'Backend Developer 2' }).click();
  await expect(page.getByTestId('propose-popover')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('propose-popover')).toHaveCount(0);
  await expect(add).toBeFocused();
});

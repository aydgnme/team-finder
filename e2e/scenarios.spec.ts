import { expect, test, type Page } from '@playwright/test';

// The M1.5 journey (docs/plans/m1.5-staffing-decisions.md): scrub the start two weeks later, Tom
// rolls off Borealis and becomes available, add him to the draft, watch the verdict flip, share a
// read-only snapshot, commit everything in one transaction. Dates are relative to today (the
// seed is), so assertions use the verdict's relative wording, never calendar dates.

async function landOnAtlas(page: Page) {
  await page.goto('/');
  await expect(page.getByTestId('goal')).toHaveText('Staff Atlas: 2 slots open, AWS not covered');
}

async function addTomToDraft(page: Page) {
  await page.getByTestId('candidate-Tom Becker').getByRole('button', { name: 'Add to slot' }).click();
  await page.getByRole('menuitem', { name: 'Backend Developer 2' }).click();
  const popover = page.getByTestId('propose-popover');
  await expect(popover.getByLabel('Start')).toHaveCount(0);
  await popover.getByLabel('Hours/day').fill('8');
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('slot-Backend Developer-2')).toHaveAttribute('data-state', 'draft');
}

test('keyboard scrub: Tom becomes available, the verdict flips, commit sends it all at once', async ({ page }) => {
  await landOnAtlas(page);
  await expect(page.getByTestId('coach-scrub')).toBeVisible();
  const tom = page.getByTestId('candidate-Tom Becker');
  await expect(tom).toHaveAttribute('data-availability', 'rollingOff');

  // PageUp = one week. Availability follows the slider live, before the re-rank arrives.
  const scrubber = page.getByTestId('start-scrubber');
  await scrubber.focus();
  await page.keyboard.press('PageUp');
  await page.keyboard.press('PageUp');
  await expect(scrubber).toHaveAttribute('aria-valuetext', /2 wk later$/);
  await expect(tom).toHaveAttribute('data-availability', 'available');
  await expect(page.getByTestId('coach-scrub')).toHaveCount(0);
  await expect(page.getByText(/^ranked for /)).toBeVisible();

  await addTomToDraft(page);
  const goal = page.getByTestId('goal');
  await expect(goal).toHaveText(
    'Atlas: Draft vs current: start +2 wk → coverage 83% → 100%, +0 overbooked days, 1 slot open',
  );

  // Back to the current start: Tom is still on Borealis for two weeks.
  await scrubber.focus();
  await page.keyboard.press('Home');
  await expect(goal).toHaveText(
    'Atlas: Draft vs current: same start → coverage 83% → 100%, +14 overbooked days, 1 slot open',
  );
  await expect(page.getByTestId('slot-Backend Developer-2')).toHaveAttribute('data-state', 'draftConflict');
  await expect(page.getByTestId('live-region')).toHaveText(/\+14 overbooked days/);

  await page.keyboard.press('PageUp');
  await page.keyboard.press('PageUp');
  await expect(goal).toContainText('+0 overbooked days');

  await page.getByRole('button', { name: 'Move start and send 1 proposal' }).click();
  await expect(page.getByTestId('live-region')).toHaveText(/^Atlas now starts .+\. 1 proposal sent\.$/);
  await expect(goal).toHaveText('Staff Atlas: 1 slot open, all skills covered');
  await expect(page.getByTestId('slot-Backend Developer-2')).toHaveAttribute('data-state', 'pending');
  await expect(page.getByTestId('slot-Backend Developer-2')).toContainText('Tom Becker');
  // The committed draft is the new baseline: Tom starts free, so the scrubber starts over.
  await expect(page.getByRole('button', { name: 'Fork to compare' })).toBeVisible();
});

test('share: a read-only snapshot opens in a fresh browser without a session', async ({ page, browser }) => {
  await landOnAtlas(page);
  const scrubber = page.getByTestId('start-scrubber');
  await scrubber.focus();
  await page.keyboard.press('PageUp');
  await page.keyboard.press('PageUp');
  await addTomToDraft(page);

  await page.getByRole('button', { name: 'Share' }).click();
  const link = page.getByTestId('share-link');
  await expect(link).toHaveValue(/#\/s\/[A-Za-z0-9_-]{22}$/);
  const url = await link.inputValue();

  const fresh = await browser.newContext();
  const other = await fresh.newPage();
  await other.goto(url);
  await expect(other.getByTestId('snapshot-header')).toHaveText(/Snapshot · .+ · read-only/);
  await expect(other.getByTestId('snapshot-verdict')).toHaveText(
    'Atlas: Draft vs current: start +2 wk → coverage 83% → 100%, +0 overbooked days, 1 slot open',
  );
  await expect(other.getByTestId('snapshot-slot-Backend Developer-2')).toContainText('Tom Becker');
  await expect(other.getByTestId('snapshot-slot-Backend Developer-2')).toContainText('Draft');

  await other.goto('/#/s/not-a-real-snapshot');
  await expect(other.getByTestId('snapshot-missing')).toContainText('This snapshot has expired');
  await expect(other.getByRole('link', { name: 'Try the live demo' })).toBeVisible();
  await fresh.close();

  // Discarding drops the draft; nothing was sent.
  await page.getByRole('button', { name: 'Discard draft' }).click();
  await expect(page.getByTestId('goal')).toHaveText('Staff Atlas: 2 slots open, AWS not covered');
});

test('start over gives a fresh sandbox: earlier changes are gone', async ({ page }) => {
  await landOnAtlas(page);
  await page.getByTestId('candidate-Mira Chen').getByRole('button', { name: 'Add to slot' }).click();
  await page.getByRole('menuitem', { name: 'Backend Developer 2' }).click();
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('goal')).toHaveText('Staff Atlas: 1 slot open, all skills covered');

  await page.getByRole('button', { name: 'Start over' }).click();
  await expect(page.getByTestId('goal')).toHaveText('Staff Atlas: 2 slots open, AWS not covered');
  await expect(page.getByTestId('slot-Backend Developer-2')).toHaveAttribute('data-state', 'empty');
});

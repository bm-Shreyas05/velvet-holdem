import { type Page, expect, test } from '@playwright/test';
import { centreBrightness } from './png.ts';

interface Hook {
  snapshot(): { handNumber: number; seats: { stack: number }[]; gameOver: boolean; humanFinish: unknown };
  aiMode(): string;
}

/** Collects uncaught exceptions and console errors so every test can assert a clean run. */
function trackErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(`console: ${m.text()}`);
  });
  return errors;
}

async function noHorizontalScroll(page: Page): Promise<void> {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow, 'page must not scroll sideways').toBeLessThanOrEqual(1);
}

async function startGame(page: Page, options: { longNames?: boolean } = {}): Promise<void> {
  await page.getByRole('button', { name: /New game/ }).click();
  if (options.longNames) {
    // 24 wide letters (the maximum) push every name plate to its CSS width cap in any font, so
    // layout checks do not depend on which fonts the machine happens to have. Names must differ.
    const inputs = await page.locator('#setup-name, input[id^="opp-name-"]').all();
    for (const [i, input] of inputs.entries()) await input.fill('W'.repeat(23) + 'ABCDEFGH'[i]);
  }
  await page.getByRole('button', { name: 'Deal me in' }).click();
  await expect(page.locator('.action-bar')).toBeVisible();
}

test('menu loads with the play-money notice and no errors', async ({ page }) => {
  const errors = trackErrors(page);
  await page.goto('./');
  await expect(page.getByRole('heading', { name: 'Velvet' })).toBeVisible();
  await expect(page.getByText('Play money only.')).toBeVisible();
  await noHorizontalScroll(page);
  await page.getByRole('button', { name: 'How to play' }).click();
  await expect(page.getByRole('heading', { name: 'Play money and privacy' })).toBeVisible();
  expect(errors).toEqual([]);
});

test('your own cards are rendered face up and every seat is on screen', async ({ page, isMobile }) => {
  await page.goto('./');
  await startGame(page, { longNames: true });
  const stage = page.locator('.stage');
  const orientationBefore = await stage.getAttribute('class');
  // Once it is your turn, the deal and the flip are over (and the action bar has grown).
  await expect(page.locator('.act--passive')).toBeEnabled({ timeout: 45_000 });
  expect(await stage.getAttribute('class'), 'the table layout must not flip when your turn starts').toBe(orientationBefore);
  if (isMobile) expect(orientationBefore).toContain('stage--portrait');
  const area = (await page.locator('.table-area').boundingBox())!;
  for (const plate of await page.locator('.seat-plate').all()) {
    const b = (await plate.boundingBox())!;
    expect(
      b.x >= area.x - 1 && b.x + b.width <= area.x + area.width + 1 && b.y >= area.y - 1 && b.y + b.height <= area.y + area.height + 1,
      `seat plate ${JSON.stringify(b)} inside ${JSON.stringify(area)}`,
    ).toBe(true);
  }
  const hero = page.locator('.card--hero');
  await expect(hero).toHaveCount(2);
  await expect
    .poll(() => hero.evaluateAll((els) => els.flatMap((e) => e.getAnimations({ subtree: true })).filter((a) => a.playState === 'running').length))
    .toBe(0);
  for (const card of await hero.all()) {
    await expect(card).toHaveAttribute('data-up', 'true');
    // Faces are near-white and backs dark red, so this catches an engine painting the back over
    // the face even though the page state is correct (seen in WebKit before the flip fix).
    expect(centreBrightness(await card.screenshot()), 'hole card must show its face').toBeGreaterThan(150);
  }
});

test('plays several hands against the AI with chips conserved', async ({ page }) => {
  test.setTimeout(180_000);
  const errors = trackErrors(page);
  // #dev exposes read-only snapshots (window.__velvet) for these checks; play is otherwise normal.
  await page.goto('./#dev');
  await startGame(page);
  await noHorizontalScroll(page);

  const probe = () =>
    page.evaluate(() => {
      const v = (window as unknown as { __velvet: Hook }).__velvet;
      const s = v.snapshot();
      // Read in one synchronous call, so "between hands" and the stacks always agree.
      const between = !!document.querySelector('.next-hand');
      return { hand: s.handNumber, between, chips: s.seats.reduce((a, x) => a + x.stack, 0), over: s.gameOver || !!s.humanFinish, ai: v.aiMode() };
    });
  const first = await probe();
  expect(first.ai, 'the AI must run in a Web Worker').toBe('worker');

  // Check when free, otherwise fold: the human never risks busting, so hands keep coming.
  const passive = page.locator('.act--passive');
  const fold = page.locator('.act--fold');
  const next = page.locator('.next-hand');
  const target = first.hand + 2;
  let total: number | null = null;
  let conservationChecks = 0;
  const deadline = Date.now() + 140_000;
  while (Date.now() < deadline) {
    const state = await probe();
    if (state.over || state.hand >= target) break;
    // Auto-deal is on by default, so any button may vanish before the click lands; a missed
    // click is harmless and the loop simply looks again.
    const tap = (target: typeof next) => target.click({ timeout: 2_000 }).catch(() => undefined);
    if (state.between) {
      total ??= state.chips;
      expect(state.chips, 'total chips between hands').toBe(total);
      conservationChecks++;
      await tap(next);
    } else if ((await passive.isVisible()) && (await passive.isEnabled())) {
      const label = (await passive.textContent()) ?? '';
      await tap(/^Check/.test(label) || !(await fold.isVisible()) ? passive : fold);
    } else {
      await page.waitForTimeout(150);
    }
  }
  const last = await probe();
  expect(last.over || last.hand >= target, `reached hand ${target} (at hand ${last.hand})`).toBe(true);
  expect(conservationChecks, 'chip totals checked between hands').toBeGreaterThan(0);
  expect(errors).toEqual([]);
});

test('a game in progress survives a reload', async ({ page }) => {
  await page.goto('./');
  await startGame(page);
  await page.reload();
  const cont = page.getByRole('button', { name: /Continue/ });
  await expect(cont).toBeVisible();
  await cont.click();
  await expect(page.locator('.action-bar')).toBeVisible();
});

test('installable and playable offline', async ({ page, context, browserName, isMobile }) => {
  // Service-worker support in Playwright's Firefox/WebKit builds is incomplete; Chromium covers it.
  test.skip(browserName !== 'chromium' || isMobile, 'service worker is checked in desktop Chromium');
  const errors = trackErrors(page);
  const manifest = await (await page.request.get('manifest.webmanifest')).json();
  expect(manifest.start_url).toBe('./');
  expect(manifest.icons.map((i: { sizes: string }) => i.sizes)).toEqual(expect.arrayContaining(['192x192', '512x512']));
  for (const icon of manifest.icons) expect((await page.request.get(icon.src)).ok()).toBe(true);

  await page.goto('./?sw'); // on localhost the worker registers only when asked
  await expect.poll(() => page.evaluate(() => !!navigator.serviceWorker.controller), { timeout: 15_000 }).toBe(true);
  await context.setOffline(true);
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Velvet' })).toBeVisible();
  await startGame(page);
  await context.setOffline(false);
  expect(errors).toEqual([]);
});

/** Checks when free, calls small bets, folds otherwise — until the current hand is over. */
async function playOutHand(page: Page): Promise<void> {
  const passive = page.locator('.act--passive');
  const fold = page.locator('.act--fold');
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    if (await page.locator('.next-hand').isVisible()) return;
    if ((await passive.isVisible()) && (await passive.isEnabled())) {
      const label = (await passive.textContent()) ?? '';
      const target = /^Check/.test(label) || /^Call [0-9]{1,2}\b/.test(label) || !(await fold.isVisible()) ? passive : fold;
      await target.click({ timeout: 2_000 }).catch(() => undefined);
    } else await page.waitForTimeout(150);
  }
  throw new Error('the hand did not finish');
}

test('a finished hand can be replayed step by step and reviewed by the coach', async ({ page }) => {
  test.setTimeout(150_000);
  const errors = trackErrors(page);
  await page.goto('./');
  await startGame(page);
  await playOutHand(page);
  await page.getByRole('button', { name: 'Hand history (H)' }).click();
  await page.locator('.history-row').first().click();
  await page.getByRole('button', { name: 'Review with coach' }).click();
  const replay = page.locator('.sheet--replay');
  await expect(replay.locator('.review-summary')).not.toBeEmpty({ timeout: 30_000 });
  await expect(replay.locator('.replay-counter')).toHaveText(/^Step 1 of \d+$/);
  await replay.getByRole('button', { name: 'Next step' }).click();
  await expect(replay.locator('.replay-counter')).toHaveText(/^Step 2 of \d+$/);
  await replay.getByRole('button', { name: 'End of the hand' }).click();
  await expect(replay.locator('.replay-caption')).toContainText('hand over');
  expect(await replay.locator('.log-entry').count()).toBeGreaterThan(3);
  expect(errors).toEqual([]);
});

test('coach hints suggest a move on your turn when switched on', async ({ page }) => {
  await page.goto('./');
  await page.getByRole('button', { name: 'Settings' }).click();
  await page.getByText('Coach hints on my turn').click();
  await page.keyboard.press('Escape');
  await startGame(page);
  await expect(page.locator('.act--passive')).toBeEnabled({ timeout: 45_000 });
  await expect(page.locator('.bar-hint')).toContainText(/^Coach: .+ · your equity ≈ \d+%$/, { timeout: 15_000 });
});

test('cash game: cashing out mid-hand waits for the hand, then shows the session result', async ({ page }) => {
  test.setTimeout(150_000);
  const errors = trackErrors(page);
  await page.goto('./');
  await page.getByRole('button', { name: /New game/ }).click();
  await page.getByRole('radio', { name: 'Cash game' }).click();
  await page.getByRole('button', { name: 'Deal me in' }).click();
  await expect(page.getByText(/^Cash game · buy-in/)).toBeVisible();
  await expect(page.locator('.act--passive')).toBeEnabled({ timeout: 45_000 });
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Cash out' }).click();
  await expect(page.getByText('Cashing out after this hand')).toBeVisible();
  await playOutHand(page).catch(() => undefined); // the session ends as this hand finishes
  await expect(page.getByRole('button', { name: 'New session' })).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('.summary-list')).toContainText('Hands played');
  await page.getByRole('button', { name: 'Main menu' }).click();
  await expect(page.getByRole('button', { name: /^Continue/ })).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('daily challenge: today’s table starts from the menu and is marked as the daily', async ({ page }) => {
  await page.goto('./');
  await page.getByRole('button', { name: /Daily challenge/ }).click();
  await expect(page.locator('.info-daily')).toHaveText(/^Daily \d{4}-\d{2}-\d{2}$/);
  await expect(page.locator('.action-bar')).toBeVisible();
});

test('saves can be exported to a file and imported back', async ({ page }, info) => {
  test.skip(info.project.name !== 'chromium' && info.project.name !== 'webkit', 'file round trip checked on desktop engines');
  await page.goto('./');
  await page.getByRole('button', { name: 'Settings' }).click();
  await page.getByRole('radio', { name: 'Navy' }).click();
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Export saves' }).click()]);
  const file = await download.path();
  expect(download.suggestedFilename()).toMatch(/^velvet-saves-\d{4}-\d{2}-\d{2}\.json$/);
  // Change the setting, then restore the backup: the import replaces it.
  await page.getByRole('radio', { name: 'Claret' }).first().click();
  await page.locator('input[type=file]').setInputFiles(file);
  await page.getByRole('button', { name: 'Replace and reload' }).click();
  await page.waitForLoadState('load');
  await page.getByRole('button', { name: 'Settings' }).click();
  await expect(page.getByRole('radio', { name: 'Navy' })).toHaveAttribute('aria-checked', 'true');
});

test('achievements: the first hand is celebrated and listed', async ({ page }) => {
  test.setTimeout(150_000);
  await page.goto('./');
  await startGame(page);
  await playOutHand(page);
  await expect(page.getByText(/Achievement: Shuffle up and deal/)).toBeVisible({ timeout: 10_000 });
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Leave table' }).click();
  await page.getByRole('button', { name: 'Achievements' }).click();
  await expect(page.getByText(/^\d+ of \d+ earned/)).toBeVisible();
  await expect(page.locator('.achievement.is-earned', { hasText: 'Shuffle up and deal' })).toBeVisible();
});

test('opponents remember you: a new game starts with what they learned in the last one', async ({ page }) => {
  test.setTimeout(150_000);
  await page.goto('./#dev');
  await startGame(page);
  await playOutHand(page);
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Leave table' }).click();
  await page.getByRole('button', { name: /New game/ }).click();
  await page.getByRole('button', { name: 'Deal me in' }).click();
  await page.getByRole('button', { name: 'Start new game' }).click();
  await expect(page.locator('.action-bar')).toBeVisible();
  const known = await page.evaluate(() => {
    const s = (window as unknown as { __velvet: { session(): { statsBook: Record<string, { hands: number }> } } }).__velvet.session();
    return s.statsBook.human?.hands ?? 0;
  });
  expect(known, 'hands the opponents already know about').toBeGreaterThan(0);
});

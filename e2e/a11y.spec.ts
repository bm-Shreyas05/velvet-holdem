import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, test } from '@playwright/test';

/**
 * Automated accessibility checks (axe-core, WCAG 2.1 A/AA rules) on every main screen and sheet,
 * in light and dark themes. Automated rules catch a large share of real problems (names, roles,
 * contrast, focus), not all of them, so this complements rather than replaces a screen-reader pass.
 */
async function audit(page: Page, label: string): Promise<void> {
  const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
  const problems = results.violations.map(
    (v) =>
      `${label}: ${v.id} (${v.impact}) — ${v.help} — ${v.nodes
        .map((n) => n.target.join(' '))
        .slice(0, 3)
        .join(' | ')}`,
  );
  expect(problems, problems.join('\n')).toEqual([]);
}

for (const scheme of ['light', 'dark'] as const) {
  test.describe(`${scheme} theme`, () => {
    test.use({ colorScheme: scheme });

    test(`accessibility: menu, setup and sheets (${scheme})`, async ({ page }, info) => {
      test.skip(info.project.name !== 'chromium', 'rules are engine-independent; checked once');
      await page.goto('./');
      await expect(page.getByRole('heading', { name: 'Velvet' })).toBeVisible();
      await page.waitForTimeout(800); // let the opening animation settle (it affects contrast)
      await audit(page, 'menu');
      for (const name of ['Statistics', 'Hand history', 'Achievements', 'How to play', 'Settings']) {
        await page.getByRole('button', { name, exact: true }).click();
        await expect(page.locator('.sheet')).toBeVisible();
        await page.waitForTimeout(300);
        await audit(page, name);
        await page.keyboard.press('Escape');
        await expect(page.locator('.sheet')).toHaveCount(0);
      }
      await page.getByRole('button', { name: /New game/ }).click();
      await audit(page, 'setup (tournament)');
      await page.getByRole('radio', { name: 'Cash game' }).click();
      await audit(page, 'setup (cash)');
    });

    test(`accessibility: the table on your turn (${scheme})`, async ({ page }, info) => {
      test.skip(info.project.name !== 'chromium', 'rules are engine-independent; checked once');
      await page.goto('./');
      await page.getByRole('button', { name: /New game/ }).click();
      await page.getByRole('button', { name: 'Deal me in' }).click();
      await expect(page.locator('.act--passive')).toBeEnabled({ timeout: 45_000 });
      await page.waitForTimeout(600);
      await audit(page, 'table');
      await page.keyboard.press('Escape');
      await expect(page.locator('.sheet')).toBeVisible();
      await page.waitForTimeout(300);
      await audit(page, 'pause menu');
    });
  });
}

test('accessibility: hand history, replay and coach review', async ({ page }, info) => {
  test.skip(info.project.name !== 'chromium', 'rules are engine-independent; checked once');
  test.setTimeout(240_000);
  await page.goto('./');
  await page.getByRole('button', { name: /New game/ }).click();
  await page.getByRole('button', { name: 'Deal me in' }).click();
  const passive = page.locator('.act--passive');
  const fold = page.locator('.act--fold');
  const deadline = Date.now() + 150_000;
  while (Date.now() < deadline && !(await page.locator('.next-hand').isVisible())) {
    if ((await passive.isVisible()) && (await passive.isEnabled())) {
      const label = (await passive.textContent()) ?? '';
      await (/^Check/.test(label) || !(await fold.isVisible()) ? passive : fold).click({ timeout: 2_000 }).catch(() => undefined);
    } else await page.waitForTimeout(150);
  }
  await page.getByRole('button', { name: 'Hand history (H)' }).click();
  await page.locator('.history-row').first().click();
  await audit(page, 'hand detail');
  await page.getByRole('button', { name: 'Review with coach' }).click();
  await expect(page.locator('.sheet--replay .review-summary')).not.toBeEmpty({ timeout: 30_000 });
  await page.waitForTimeout(400);
  await audit(page, 'replay and coach');
});

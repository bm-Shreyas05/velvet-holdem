import { type Page, expect, test } from '@playwright/test';

/**
 * Play with friends, end to end in the real interface: a host and a friend in two tabs of one
 * browser. Developer mode's `net=local` swaps the WebRTC transport for a BroadcastChannel, so the
 * test exercises every screen and message without depending on public relays.
 */
interface Hook {
  snapshot(): { handNumber: number; humanSeat: number; view: { seats: { seat: number; holeCards: number[] | null; revealed: boolean }[] } | null } | null;
  online(): string | null;
}

const hook = (page: Page) => page.evaluate(() => (window as unknown as { __velvet?: Hook }).__velvet?.snapshot() ?? null);

function trackErrors(page: Page, label: string, into: string[]): void {
  page.on('pageerror', (e) => into.push(`${label} pageerror: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error') into.push(`${label} console: ${m.text()}`);
  });
}

/**
 * Acts whenever it is this page's turn: check when free, otherwise fold (or call small bets).
 * Uses the keyboard shortcuts: with two pages, one is in the background, where WebKit keeps
 * buttons animating and a click can wait for them to settle.
 */
async function actIfAsked(page: Page): Promise<void> {
  const passive = page.locator('.act--passive');
  const fold = page.locator('.act--fold');
  if ((await passive.isVisible()) && (await passive.isEnabled())) {
    const label = (await passive.textContent()) ?? '';
    await page.keyboard.press(/^Check/.test(label) || /^Call [0-9]{1,2}\b/.test(label) || !(await fold.isVisible()) ? 'c' : 'f');
  }
  if (await page.locator('.next-hand').isVisible()) await page.keyboard.press('Space');
}

test('play with friends: a host and a friend join one table, play hands and see only their own cards', async ({ context, isMobile }, info) => {
  test.skip(info.project.name !== 'chromium' && info.project.name !== 'webkit' && !isMobile, 'two tabs per engine is enough');
  test.setTimeout(300_000);
  const errors: string[] = [];
  const host = await context.newPage();
  const guest = await context.newPage();
  trackErrors(host, 'host', errors);
  trackErrors(guest, 'guest', errors);

  await host.goto('./#dev&net=local');
  await host.getByRole('button', { name: /Play with friends/ }).click();
  await host.locator('#friends-name').fill('Hal');
  await host.getByRole('button', { name: 'Create a table' }).click();
  await expect(host.getByRole('heading', { name: 'Your table' })).toBeVisible();
  const code = ((await host.locator('.lobby-code').textContent()) ?? '').replace('-', '');
  expect(code).toMatch(/^[A-Z2-9]{8}$/);
  await expect(host.locator('#invite-link')).toHaveValue(new RegExp(`#join=${code}$`));

  // The friend opens the invite link (here with the developer flags kept).
  await guest.goto(`./#dev&net=local&join=${code}`);
  await expect(guest.getByRole('heading', { name: 'Play with friends' })).toBeVisible();
  await guest.locator('#friends-name').fill('Gia');
  await guest.getByRole('button', { name: 'Join', exact: true }).click();
  await expect(guest.locator('.lobby-status')).toHaveText(/Waiting for the host/);
  await expect(guest.locator('.lobby-players')).toContainText('Hal');
  await expect(host.locator('.lobby-players')).toContainText('Gia');

  await host.getByRole('radiogroup', { name: 'AI opponents' }).getByRole('radio', { name: '1', exact: true }).click();
  await host.getByRole('button', { name: 'Deal', exact: true }).click();
  await expect(host.locator('.action-bar')).toBeVisible();
  await expect(guest.locator('.action-bar')).toBeVisible({ timeout: 15_000 });
  await expect(guest.locator('.info-chip', { hasText: `Table ${code.slice(0, 4)}-${code.slice(4)}` })).toBeAttached(); // phones hide header chips

  // Each player sits at the bottom of their own screen.
  for (const [page, me] of [
    [host, '0'],
    [guest, '1'],
  ] as const) {
    await expect(page.locator('.seat--hero')).toHaveAttribute('data-seat', me);
    const lowest = await page
      .locator('.seat')
      .evaluateAll((els) => els.sort((a, b) => b.getBoundingClientRect().top - a.getBoundingClientRect().top)[0]?.getAttribute('data-seat'));
    expect(lowest).toBe(me);
  }

  // Play until the third hand starts, checking privacy on every turn.
  const deadline = Date.now() + 240_000;
  for (;;) {
    const [h, g] = await Promise.all([hook(host), hook(guest)]);
    for (const [snap, me] of [
      [h, 0],
      [g, 1],
    ] as const) {
      if (!snap?.view) continue;
      expect(snap.humanSeat).toBe(me);
      for (const s of snap.view.seats) if (s.seat !== me && s.holeCards && !s.revealed) throw new Error(`seat ${me} saw seat ${s.seat}'s cards`);
    }
    if ((h?.handNumber ?? 0) >= 3) break;
    if (Date.now() > deadline) throw new Error(`only reached hand ${h?.handNumber}`);
    await actIfAsked(host);
    await actIfAsked(guest);
    await host.waitForTimeout(100);
  }
  // Both screens show the same hand.
  await expect.poll(async () => (await hook(guest))?.handNumber, { timeout: 15_000 }).toBeGreaterThanOrEqual(3);

  // The friend leaves; the host is told and the game goes on.
  await guest.keyboard.press('Escape');
  await guest.getByRole('button', { name: 'Leave table' }).click();
  await expect(guest.getByRole('heading', { name: 'Velvet' })).toBeVisible();
  await expect(host.locator('.toast', { hasText: 'Gia left the table' })).toBeVisible({ timeout: 10_000 });
  expect(errors).toEqual([]);
});

test('play with friends: a wrong code is explained, and the host closing the table sends friends back', async ({ context }, info) => {
  test.skip(info.project.name !== 'chromium', 'checked once');
  const host = await context.newPage();
  const guest = await context.newPage();
  await guest.goto('./#dev&net=local');
  await guest.getByRole('button', { name: /Play with friends/ }).click();
  await guest.locator('#friends-name').fill('Gia');
  await guest.locator('#join-code').fill('not a code');
  await guest.getByRole('button', { name: 'Join', exact: true }).click();
  await expect(guest.locator('.form-error')).toHaveText(/not a table code/);

  await host.goto('./#dev&net=local');
  await host.getByRole('button', { name: /Play with friends/ }).click();
  await host.locator('#friends-name').fill('Hal');
  await host.getByRole('button', { name: 'Create a table' }).click();
  const code = ((await host.locator('.lobby-code').textContent()) ?? '').trim();
  await guest.locator('#join-code').fill(code.toLowerCase());
  await guest.getByRole('button', { name: 'Join', exact: true }).click();
  await expect(host.locator('.lobby-players')).toContainText('Gia');
  await host.getByRole('button', { name: 'Close table' }).click();
  await host.getByRole('button', { name: 'Close table' }).last().click(); // confirm
  await expect(guest.locator('.toast', { hasText: 'The host closed the table.' })).toBeVisible({ timeout: 10_000 });
  await expect(guest.getByRole('heading', { name: 'Play with friends' })).toBeVisible();
});

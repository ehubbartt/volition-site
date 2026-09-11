import { test, expect } from '@playwright/test';
import { mkdirSync } from 'node:fs';

// A BOARD DEALT EARLY GIVES NOTHING AWAY. The deck can be dealt the night before an
// announced start — that is the point of the start time — so until the clock reaches it
// the member page must show a countdown and no tiles, and must refuse claims. Getting
// this wrong hands whoever opens the page a list of the bosses to be standing at.
const SLUG = `sched-${Date.now().toString(36)}`;
test.describe.configure({ mode: 'serial', retries: 0 });

/** `datetime-local` wants the local wall clock, not an ISO instant. */
function localInput(d: Date): string {
	const pad = (n: number) => String(n).padStart(2, '0');
	return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

test('a board dealt before its start shows a countdown and no tiles', async ({ page }) => {
	test.setTimeout(180_000);
	mkdirSync('e2e-shots/scheduled', { recursive: true });

	await page.goto('/admin/connect4');
	await page.locator('input[name="name"]').fill(`Scheduled ${SLUG}`);
	await page.locator('input[name="slug"]').fill(SLUG);
	await page.locator('input[name="cols"]').fill('5');
	await page.locator('input[name="rows"]').fill('4');
	await page.getByRole('button', { name: 'Create' }).click();
	await expect(page).toHaveURL(new RegExp(`/admin/connect4/${SLUG}$`));

	await page.getByRole('button', { name: /Auto-fill/ }).click();
	await expect(page.locator('.ok').first()).toContainText('Tile pool saved', { timeout: 60_000 });

	// Seat the viewer so the member page is read as a player, not a spectator.
	const members = page.locator('.roster .member');
	for (const i of [0, 1]) await members.nth(i).locator('input').check();
	await page.getByRole('button', { name: '→ Red' }).click();
	await expect(page.locator('.roster .member .pill', { hasText: 'Red' })).toHaveCount(2);

	// ── deal now, open in two hours ────────────────────────────────────────────
	const opensAt = new Date(Date.now() + 2 * 3600_000);
	await page.locator('input[name="starts_at"]').fill(localInput(opensAt));
	await page.getByRole('button', { name: /Deal the deck now, open at the time above/ }).click();

	await expect(page.locator('.osrs-badge', { hasText: 'live' })).toBeVisible({ timeout: 60_000 });
	// The admin is told in as many words that it has not opened yet.
	await expect(page.locator('.osrs-badge.waiting')).toContainText('opens');
	await page.screenshot({ path: 'e2e-shots/scheduled/01-admin-waiting.png' });

	// ── what a member sees in the meantime ─────────────────────────────────────
	await page.goto(`/events/${SLUG}/connect4`);
	await expect(page.locator('.countdown')).toBeVisible({ timeout: 60_000 });
	await expect(page.locator('.countdown')).toContainText(/Opens in \d+h/);
	await expect(page.locator('.countdown')).toContainText(/don't count/);

	// The board is not merely hidden — there is nothing to hide.
	await expect(page.locator('.rail .tile')).toHaveCount(0);
	await expect(page.locator('.hole')).toHaveCount(0);
	await page.screenshot({ path: 'e2e-shots/scheduled/02-member-countdown.png' });

	// And the tiles are not in the payload either, which is the part that actually matters.
	const payload = await page.request.get(`/api/connect4/${SLUG}`);
	const body = await payload.text();
	expect(body, 'the board was dealt from a pool of real items').not.toMatch(/"item_name":\s*"[^"]/);

	// ── a claim sent anyway is refused, before it can reach the review queue ───
	const post = await page.request.post(`/events/${SLUG}/connect4?/submitClaim`, {
		multipart: { col: '0', quantity: '1' }
	});
	expect(await post.text()).toContain('opens at');

	await page.goto('/admin/connect4');
	const row = page.locator('tr', { hasText: `Scheduled ${SLUG}` });
	await row.getByRole('button', { name: 'Delete' }).click();
	await expect(row).toHaveCount(0, { timeout: 30_000 });
});

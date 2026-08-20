import { test, expect, type Page } from '@playwright/test';

// /admin/voice against the real staging database. The bug these cover: the bot tracks
// voice by Discord snowflake + Discord username, but the panel rendered only the RSN and
// searched only the rendered name — so a member an admin knows from Discord was
// unfindable, and the "Recent activity" tab (a global tail of the newest ticks) showed
// nothing for them, which reads as "their tracking is broken" when it is not.

async function waitForLeaderboard(page: Page) {
	await page.goto('/admin/voice');
	await expect(page).toHaveURL('/admin/voice');
	// "Users tracked" is 0 until /api/admin/voice lands; a real number proves the
	// round-trip rather than just that the shell rendered.
	const tracked = page.locator('.stat', { hasText: /users tracked/i }).first();
	await expect(tracked.locator('.num')).not.toHaveText('0', { timeout: 20_000 });
}

/** The first member whose RSN differs from their Discord name — the case that broke. */
async function memberWithBothNames(page: Page) {
	const row = page
		.locator('tbody tr')
		.filter({ has: page.locator('.handle') })
		.first();
	await expect(row).toBeVisible();
	return {
		rsn: (await row.locator('.name-btn').innerText()).trim(),
		discord: (await row.locator('.handle').innerText()).trim()
	};
}

test('the leaderboard finds a member by their Discord name, not just their RSN', async ({
	page
}) => {
	await waitForLeaderboard(page);
	const { rsn, discord } = await memberWithBothNames(page);
	expect(discord.toLowerCase()).not.toBe(rsn.toLowerCase());

	await page.getByPlaceholder(/search rsn, discord name or id/i).fill(discord);

	// The row is still there, still labelled by RSN — searching the Discord name is what
	// used to return nothing at all.
	await expect(page.locator('tbody tr .name-btn', { hasText: rsn })).toBeVisible();
	await expect(page.locator('tbody tr .empty')).toHaveCount(0);

	// And the RSN still works, so the fix widened the search rather than moving it.
	await page.getByPlaceholder(/search rsn, discord name or id/i).fill(rsn);
	await expect(page.locator('tbody tr .name-btn', { hasText: rsn })).toBeVisible();
});

test("a member's own activity log is reachable when the recent feed has nothing for them", async ({
	page
}) => {
	await waitForLeaderboard(page);
	const { rsn, discord } = await memberWithBothNames(page);

	await page.getByPlaceholder(/search rsn, discord name or id/i).fill(discord);
	await page.locator('tbody tr .name-btn', { hasText: rsn }).first().click();

	// Drill-down replaces the tab body: heading, rank out of the tracked population, and
	// the member's OWN ticks — none of which the global feed could answer.
	await expect(page.locator('.detail-head h2')).toHaveText(rsn);
	const rank = page.locator('.stat', { hasText: /rank of/i }).first();
	await expect(rank.locator('.num')).toHaveText(/^#\d/, { timeout: 20_000 });

	const allTime = page.locator('.stat', { hasText: /all-time/i }).first();
	await expect(allTime.locator('.lbl')).toContainText(/\d+ ticks/);
	await expect(page.locator('.activity li').first()).toBeVisible();

	// Back returns to the leaderboard with the search still applied.
	await page.getByRole('button', { name: /back/i }).click();
	await expect(page.locator('tbody tr .name-btn', { hasText: rsn })).toBeVisible();
});

test('the recent-activity tab searches Discord names too', async ({ page }) => {
	await waitForLeaderboard(page);
	await page.getByRole('button', { name: /recent activity/i }).click();

	const first = page.locator('.activity li').first();
	await expect(first).toBeVisible();
	const name = (await first.locator('.name-btn').innerText()).trim();

	await page.getByPlaceholder(/search rsn, discord name or id/i).fill(name);
	await expect(page.locator('.activity li .name-btn', { hasText: name }).first()).toBeVisible();

	// A member with no tick in the newest slice gets an explanation pointing at the
	// drill-down, not a bare "no activity" that reads as broken tracking.
	await page.getByPlaceholder(/search rsn, discord name or id/i).fill('zzz-no-such-member-zzz');
	await expect(page.getByText(/open them from the leaderboard for their full history/i)).toBeVisible();
});

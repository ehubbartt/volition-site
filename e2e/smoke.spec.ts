import { test, expect } from '@playwright/test';

// Signed in as the dev-login account (see e2e/auth.setup.ts) against whatever Supabase
// the shell points at. These assert the pages resolve REAL data, not just that they
// render: an empty-but-correct page is the exact failure mode a broken DB connection
// produces, and a render-only check sails straight past it.

test('home shows the signed-in dashboard with live data', async ({ page }) => {
	await page.goto('/');

	await expect(page.getByRole('heading', { name: /welcome back/i })).toBeVisible();

	// Stat tiles render '—' until /api/home resolves, so a number proves the round-trip.
	const members = page.locator('.stat', { hasText: /members/i }).first();
	await expect(members).toContainText(/\d/);

	await expect(page.getByRole('link', { name: /^events$/i })).toBeVisible();
});

test('/me resolves the profile behind its skeleton', async ({ page }) => {
	await page.goto('/me');

	// The guard redirects to / when the session didn't resolve — assert we stayed.
	await expect(page).toHaveURL('/me');

	// Skeletons clear only once /api/me lands.
	await expect(page.locator('.me-skeleton')).toHaveCount(0);
	await expect(page.getByRole('textbox', { name: /osrs rsn/i })).not.toBeEmpty();
	await expect(page.getByRole('button', { name: /^save$/i })).toBeVisible();
});

test('super-admin reaches the role-gated admin area', async ({ page }) => {
	// The deepest gate in the app: env-only SUPER_ADMIN_DISCORD_IDS, never grantable
	// from the UI. Reaching it proves dev-login grants no roles of its own but
	// resolves through the normal allow-list.
	await page.goto('/admin/config');

	await expect(page).toHaveURL('/admin/config');
	await expect(page.getByRole('heading', { name: /database/i })).toBeVisible();
	await expect(page.getByText(/bot_config/)).toBeVisible();
});

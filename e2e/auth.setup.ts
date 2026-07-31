import { test as setup, expect } from '@playwright/test';

const STATE = 'e2e/.auth/user.json';

// Runs once before every other project. Signs in through the local-only dev-login
// route (see $lib/server/devLogin.ts) and saves the session cookie, so tests start
// authenticated without paying for a sign-in each.
setup('sign in via dev-login', async ({ page }) => {
	const res = await page.goto('/auth/dev-login?next=/');

	// A deploy dead-code-eliminates the route to a 404, and a misconfigured local run
	// 500s on the DB lookup — say which, rather than failing later on a missing element.
	expect(
		res?.status(),
		'dev-login did not sign in: check DEV_LOGIN is set and a vs_users row exists for the configured Discord id'
	).toBeLessThan(400);
	await expect(page).toHaveURL('/');

	// The nav renders the username only when the layout resolved a real session, so this
	// asserts the cookie actually took — not just that the redirect happened.
	await expect(page.locator('header')).toContainText(/[a-z0-9]/i);
	await expect(page.getByRole('link', { name: /sign in with discord/i })).toHaveCount(0);

	await page.context().storageState({ path: STATE });
});

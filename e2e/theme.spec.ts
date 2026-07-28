import { test, expect } from '@playwright/test';

// A full round-trip through this repo's standard mutation pattern: a form action
// submitted by `use:enhance`, persisted server-side, and re-applied on the next SSR
// render. The theme picker is the cheapest example — it writes a cookie rather than a
// row — but the path it exercises (enhance → ?/action → cookie → hooks.server.ts →
// <html data-theme>) is the same one every mutating feature here uses.

const html = (page: import('@playwright/test').Page) => page.locator('html');

// The theme radios are styled `display: none` with the surrounding <label> as the
// visible control, which drops them out of the accessibility tree — getByRole('radio')
// cannot see them, and .check() cannot act on them. So click the label, which is what a
// user does anyway. (That styling is also why the picker is unreachable by keyboard and
// screen reader; a visually-hidden input would fix both. Not changed here.)
const themeOption = (page: import('@playwright/test').Page, name: RegExp) =>
	page.locator('.theme-option').filter({ hasText: name });

test('picking a theme persists across a reload', async ({ page }) => {
	await page.goto('/me');
	await expect(page.locator('.me-skeleton')).toHaveCount(0);

	const original = await html(page).getAttribute('data-theme');
	const target = original === 'ember' ? 'royal' : 'ember';
	const label = target === 'ember' ? /emberforge/i : /clan hall/i;

	await themeOption(page, label).click();

	// Applied optimistically on the client…
	await expect(html(page)).toHaveAttribute('data-theme', target);
	await expect(page.getByText(/theme saved/i)).toBeVisible();

	// …and survives a full reload, which only works if the action wrote the cookie and
	// hooks.server.ts read it back during SSR.
	await page.reload();
	await expect(html(page)).toHaveAttribute('data-theme', target);

	// Restore, so a test run doesn't quietly change how the site looks for this account.
	if (original) {
		const back =
			original === 'ember' ? /emberforge/i : original === 'royal' ? /clan hall/i : /old school/i;
		await themeOption(page, back).click();
		await expect(html(page)).toHaveAttribute('data-theme', original);
	}
});

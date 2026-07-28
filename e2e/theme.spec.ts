import { test, expect } from '@playwright/test';

// A full round-trip through this repo's standard mutation pattern: a form action
// submitted by `use:enhance`, persisted server-side, and re-applied on the next SSR
// render. The theme picker is the cheapest example — it writes a cookie rather than a
// row — but the path it exercises (enhance → ?/action → cookie → hooks.server.ts →
// <html data-theme>) is the same one every mutating feature here uses.

type Page = import('@playwright/test').Page;

const html = (page: Page) => page.locator('html');
const themeRadio = (page: Page, name: RegExp) => page.getByRole('radio', { name });

// The input is visually hidden (1px, clipped) with the label as the visible control, so
// it is focusable but not clickable — `.check()` would time out waiting for it to become
// visible. Select it the way a keyboard user does: focus, then Space. That also exercises
// the interaction that `display: none` used to make impossible.
async function pickTheme(page: Page, name: RegExp) {
	const radio = themeRadio(page, name);
	await radio.focus();
	await page.keyboard.press('Space');
	await expect(radio).toBeChecked();
}

test('the theme picker is reachable by role', async ({ page }) => {
	await page.goto('/me');
	await expect(page.locator('.me-skeleton')).toHaveCount(0);

	// Guards the accessibility fix: these inputs used to be `display: none`, which drops
	// them out of the accessibility tree — unreachable by keyboard and screen reader, and
	// invisible to role queries. If someone reverts that styling, this fails.
	await expect(themeRadio(page, /old school/i)).toBeAttached();
	await expect(themeRadio(page, /emberforge/i)).toBeAttached();
	await expect(themeRadio(page, /clan hall/i)).toBeAttached();

	// And focusable, which is the part `display: none` broke.
	await themeRadio(page, /old school/i).focus();
	await expect(themeRadio(page, /old school/i)).toBeFocused();
});

test('picking a theme persists across a reload', async ({ page }) => {
	await page.goto('/me');
	await expect(page.locator('.me-skeleton')).toHaveCount(0);

	const original = await html(page).getAttribute('data-theme');
	const target = original === 'ember' ? 'royal' : 'ember';
	const label = target === 'ember' ? /emberforge/i : /clan hall/i;

	await pickTheme(page, label);

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
		await pickTheme(page, back);
		await expect(html(page)).toHaveAttribute('data-theme', original);
	}
});

import { test, expect, type Page } from '@playwright/test';

// /admin/ranks/adjustments against the real staging database. The feature these cover:
// staff need a way to fix members the automated scoring can't score correctly — a group
// ironman who holds the Grandmaster combat-achievement tier without every task done, and
// a member with four Zenyte shards that predate the in-game collection log.
//
// The saves here run a LIVE rank re-check (WOM + TempleOSRS + WikiSync) for the member,
// which is slow and can degrade to a warning toast when a source is rate-limited. That's
// a legitimate outcome, not a failure — the assertions are about the adjustment landing
// and being visible, which is what the page is for.

const SAVE_TIMEOUT = 45_000;

async function openPanel(page: Page) {
	await page.goto('/admin/ranks/adjustments');
	await expect(page).toHaveURL('/admin/ranks/adjustments');
	await expect(page.getByRole('heading', { name: 'Ranks' })).toBeVisible();
}

/**
 * Select the first member in the picker who has a site account (grants need one).
 *
 * The click is retried: the picker renders server-side with the whole roster in it, so it
 * is visible and clickable well before the page hydrates and the button's handler exists.
 * A single click lands on a dead button and silently does nothing.
 */
async function pickFirstMember(page: Page): Promise<string> {
	const row = page
		.locator('.players .player')
		.filter({ hasNot: page.locator('.no-acct') })
		.first();
	await expect(row).toBeVisible({ timeout: 20_000 });
	const rsn = (await row.locator('.p-name').innerText()).trim();

	await expect(async () => {
		await row.click();
		await expect(page).toHaveURL(/[?&]rsn=/, { timeout: 2_000 });
	}).toPass({ timeout: 20_000 });

	await expect(page.locator('.who h2')).toHaveText(rsn, { timeout: 20_000 });
	return rsn;
}

/** Remove any adjustment left on the member, so the spec is re-runnable. */
async function cleanUp(page: Page, rsn: string) {
	await page.goto(`/admin/ranks/adjustments?rsn=${encodeURIComponent(rsn)}`);
	const remove = page.getByRole('button', { name: /remove adjustment/i });
	if (!(await remove.isVisible().catch(() => false))) return;

	// Same hydration race as the picker: the confirm dialog only exists once the handler is
	// attached, so a click that lands early does nothing and no toast ever arrives. Only
	// re-click while the button is still ENABLED — the handler disables it for the duration
	// of the request, and clearing runs a live rank re-check that can take a while, so a
	// blind retry would keep firing at a submit that is simply still in flight.
	await expect(async () => {
		if ((await remove.count()) === 0) return; // already cleared
		if (await remove.isEnabled()) {
			page.once('dialog', (d) => d.accept());
			await remove.click();
		}
		await expect(page.locator('.toast')).toBeVisible({ timeout: 10_000 });
	}).toPass({ timeout: SAVE_TIMEOUT, intervals: [1_000] });
}

test('a combat-achievement tier can be set by hand and shows up in the record', async ({ page }) => {
	await openPanel(page);
	const rsn = await pickFirstMember(page);

	try {
		// The group-ironman case: hold them at Grandmaster regardless of the task list.
		await page.getByLabel(/combat achievement tier/i).selectOption('grandmaster');
		await page.getByLabel(/reason/i).first().fill('E2E — GIM holds Grandmaster CA in game');
		await page.getByRole('button', { name: /save & re-score/i }).click();

		// Either outcome is a successful save; only the re-check can degrade.
		await expect(page.locator('.toast.good, .toast.warn')).toBeVisible({ timeout: SAVE_TIMEOUT });

		// The whole point of storing it: the adjustment is now on the record, in plain words.
		const record = page.locator('table').first();
		const row = record.locator('tr', { hasText: rsn }).first();
		await expect(row).toContainText(/CA tier Grandmaster/i);
		await expect(row).toContainText('E2E — GIM holds Grandmaster CA in game');
	} finally {
		await cleanUp(page, rsn);
	}
});

test('a reason is required before anything can be adjusted', async ({ page }) => {
	await openPanel(page);
	const rsn = await pickFirstMember(page);

	// An unexplained override is exactly what the record exists to prevent, so the reason
	// field is required and the browser blocks the submit before it ever reaches the server.
	const reason = page.getByLabel(/reason/i).first();
	await expect(reason).toHaveJSProperty('required', true);
	await page.getByLabel(/combat achievement tier/i).selectOption('master');
	await page.getByRole('button', { name: /save & re-score/i }).click();

	await expect(page.locator('.toast')).toHaveCount(0);
	// Still on the same member, nothing saved.
	await expect(page.locator('.who h2')).toHaveText(rsn);
});

test('an item grant asks for a count, because four shards is not one shard', async ({ page }) => {
	await openPanel(page);
	await pickFirstMember(page);

	// The Zenyte-shard entries are quantity checks (1st…4th shard), so a grant that could
	// only ever say "owned" would credit one of the four. The count input is the fix.
	// By role + exact string, NOT an anchored regex: the label wraps its input across source
	// lines, and Playwright normalizes whitespace for string matches but not regex ones, so
	// /^count$/ never matches the real "\n\t\t\tCount\n\t\t\t" text node.
	const qty = page.getByRole('spinbutton', { name: 'Count', exact: true });
	await expect(qty).toBeVisible();
	await expect(qty).toHaveValue('1');

	// The picker offers the WHOLE gear table, not just the items members may claim —
	// Zenyte shard is clog-trackable and so is NOT member-claimable.
	const options = page.locator('#gear-items option');
	await expect(options.filter({ hasText: /zenyte shard/i }).first()).toHaveCount(1);
});

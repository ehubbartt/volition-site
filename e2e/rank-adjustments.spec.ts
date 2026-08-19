import { test, expect, type Page } from '@playwright/test';

// Staff rank adjustments, edited in place on a member's profile, against the real staging
// database. The feature these cover: staff need a way to fix members the automated scoring
// can't score correctly — a group ironman who holds the Grandmaster combat-achievement tier
// without every task done, and a member with four Zenyte shards that predate the in-game
// collection log — and they do it where they read the numbers, not in a separate form.
//
// Saves run a LIVE rank re-check (WOM + TempleOSRS + WikiSync), which is slow and can
// degrade to a warning when a source is rate-limited. That's a legitimate outcome, not a
// failure: the assertions are about the adjustment landing and being visible.

const WHO = 'bajj'; // the dev-login member, so the profile always exists
const SAVE_TIMEOUT = 45_000;

async function openProfile(page: Page) {
	await page.goto(`/u/${WHO}`);
	await expect(page.locator('.rank-panel')).toBeVisible({ timeout: 30_000 });
	await expect(page.locator('.comps .comp').first()).toBeVisible();
}

/**
 * Open one editor. The click is retried: the panel renders server-side and is clickable
 * well before the page hydrates, so a single early click lands on a dead button.
 */
async function openEditor(page: Page, opener: ReturnType<Page['locator']>, form: string) {
	await expect(async () => {
		await opener.click();
		await expect(page.locator(form)).toBeVisible({ timeout: 2_000 });
	}).toPass({ timeout: 20_000 });
}

/** Remove any adjustment left on the member, so the spec is re-runnable. */
async function cleanUp(page: Page) {
	await page.goto(`/u/${WHO}`);
	const removeAll = page.locator('.adjusted-note button');
	if ((await removeAll.count()) === 0) return;
	await expect(async () => {
		if ((await removeAll.count()) === 0) return;
		if (await removeAll.isEnabled()) {
			page.once('dialog', (d) => d.accept());
			await removeAll.click();
		}
		await expect(removeAll).toHaveCount(0, { timeout: 10_000 });
	}).toPass({ timeout: SAVE_TIMEOUT, intervals: [1_000] });
}

test('a combat-achievement tier is set from the bar that shows it', async ({ page }) => {
	await openProfile(page);
	const caRow = page.locator('.comp').filter({ hasText: 'Combat achievements' }).first();

	try {
		// The group-ironman case: hold them at Grandmaster regardless of the task list.
		await openEditor(page, caRow.locator('.edit-btn'), 'form[action="?/adjust"]');
		await page.locator('form[action="?/adjust"] select').selectOption('grandmaster');
		await page
			.locator('form[action="?/adjust"] input[name="reason"]')
			.fill('E2E — GIM holds Grandmaster CA in game');
		await page.locator('form[action="?/adjust"] button[type="submit"]').click();

		// Either outcome is a successful save; only the live re-check can degrade.
		await expect(page.locator('.edit-msg.ok, .edit-msg.warn')).toBeVisible({ timeout: SAVE_TIMEOUT });

		// The adjustment is now on the panel itself, in plain words, and the bar it belongs
		// to is flagged — an admin re-reading this profile can see what was done and why.
		await expect(page.locator('.adjusted-note')).toContainText('E2E — GIM holds Grandmaster CA in game');
		await expect(caRow.locator('.edit-btn')).toHaveText(/adjusted/i);
	} finally {
		await cleanUp(page);
	}
});

test('one component editor does not wipe another component adjustment', async ({ page }) => {
	await openProfile(page);
	const caRow = page.locator('.comp').filter({ hasText: 'Combat achievements' }).first();
	const ehbRow = page.locator('.comp').filter({ hasText: 'Efficient hours bossed' }).first();

	try {
		await openEditor(page, caRow.locator('.edit-btn'), 'form[action="?/adjust"]');
		await page.locator('form[action="?/adjust"] select').selectOption('master');
		await page.locator('form[action="?/adjust"] input[name="reason"]').fill('E2E — first adjustment');
		await page.locator('form[action="?/adjust"] button[type="submit"]').click();
		await expect(page.locator('.edit-msg.ok, .edit-msg.warn')).toBeVisible({ timeout: SAVE_TIMEOUT });

		// THE REGRESSION each editor owns one field to avoid: a full upsert from the EHB
		// editor would blank the CA tier the admin set a moment ago, silently.
		await openEditor(page, ehbRow.locator('.edit-btn'), 'form[action="?/adjust"]');
		await page.locator('form[action="?/adjust"] input[name="value"]').fill('25');
		await page.locator('form[action="?/adjust"] button[type="submit"]').click();
		await expect(page.locator('.edit-msg.ok, .edit-msg.warn')).toBeVisible({ timeout: SAVE_TIMEOUT });

		await expect(caRow.locator('.edit-btn')).toHaveText(/adjusted/i);
		await expect(ehbRow.locator('.edit-btn')).toHaveText(/adjusted/i);
	} finally {
		await cleanUp(page);
	}
});

test('a gear tile grants the item it shows, with a count', async ({ page }) => {
	await openProfile(page);

	// Open any gear tile; the grant control lives in its modal, so the item an admin is
	// looking at is the item they credit — no separate picker to get wrong.
	await openEditor(page, page.locator('.gear-grid .gtile').first(), '.modal-admin');

	// The count is the point: the Zenyte shard entries are quantity checks (1st…4th), so a
	// control that could only say "owned" would credit one of the four.
	const qty = page.locator('.modal-grant input[name="quantity"]');
	await expect(qty).toBeVisible();
	await expect(qty).toHaveValue('1');
	// A grant without a stated reason is exactly what the record exists to prevent.
	await expect(page.locator('.modal-grant input[name="reason"]')).toHaveJSProperty('required', true);
});

test('members never see the editing controls', async ({ page }) => {
	// The affordances are driven by `adminEdit`, which the load only fills for admins. The
	// dev-login user IS an admin, so assert the wiring from the other end: a member's own
	// /me panel gets no adminEdit and so no edit buttons, on the same component markup.
	await page.goto('/me');
	// /me opens on the Profile tab; the rank panel lives behind the Rank one. Retried
	// because the tabs are inert until the page hydrates.
	await expect(async () => {
		await page.getByRole('button', { name: 'Rank', exact: true }).click();
		await expect(page.locator('.rank-panel')).toBeVisible({ timeout: 2_000 });
	}).toPass({ timeout: 30_000 });
	await expect(page.locator('.comps .comp').first()).toBeVisible();
	await expect(page.locator('.rank-panel .edit-btn')).toHaveCount(0);
	await expect(page.locator('.adjusted-note')).toHaveCount(0);
});

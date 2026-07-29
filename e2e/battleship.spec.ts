import { test, expect, type Page } from '@playwright/test';

// Drives a whole Battleship game through the ADMIN TESTER UI — create, seed, draft,
// place, battle, fire — then checks the player view redacts the enemy fleet.
//
// scripts/battleship-sim.mjs already proves the engine against the database; this
// proves the pages actually wire up to it, which a headless simulation cannot. Like the
// other specs it asserts real data (a fire report, a populated roster), not just that
// something rendered.
//
// It creates a `test` game and deletes it at the end, so it leaves staging as it found it.

const SLUG = `e2e-battleship-${Date.now().toString(36)}`;

async function expectNoError(page: Page) {
	const err = page.locator('.err');
	if (await err.count()) expect(await err.first().textContent()).toBeNull();
}

/**
 * Click a button whose handler only exists after hydration, and keep clicking until the
 * thing it toggles shows up. These admin pages are server-rendered and hydrate a moment
 * later, so a plain click can land on inert markup — Playwright retries assertions but
 * never re-clicks.
 */
async function clickUntil(page: Page, button: string | RegExp, expected: string) {
	const target = page.locator(expected);
	for (let attempt = 0; attempt < 12; attempt++) {
		await page.getByRole('button', { name: button }).first().click();
		try {
			await target.first().waitFor({ state: 'visible', timeout: 2_000 });
			return;
		} catch {
			// not hydrated yet — go round again
		}
	}
	throw new Error(`"${button}" never revealed ${expected}`);
}

test.describe.serial('Battleship', () => {
	test('an admin can create and run a whole game', async ({ page }) => {
		test.slow(); // a full draft is a lot of round-trips

		// ── create ───────────────────────────────────────────────────────────
		await page.goto('/admin/battleship');
		await expect(page.getByRole('heading', { name: 'Battleship', exact: true })).toBeVisible();

		await clickUntil(page, /new game/i, 'form.create');
		await page.locator('input[name="name"]').fill('E2E Battleship');
		await page.locator('input[name="slug"]').fill(SLUG);
		await page.locator('input[name="test"]').check();
		await page.getByRole('button', { name: /^create$/i }).click();

		await expect(page).toHaveURL(`/admin/battleship/${SLUG}`);
		await expect(page.getByRole('heading', { name: 'E2E Battleship' })).toBeVisible();
		await expect(page.locator('.pill', { hasText: /signups open/i })).toBeVisible();

		// ── signups ──────────────────────────────────────────────────────────
		await page.locator('input[name="count"]').fill('12');
		await page.getByRole('button', { name: /roster members/i }).click();
		await expect(page.getByText(/12 signed up/)).toBeVisible();

		// ── draft ────────────────────────────────────────────────────────────
		// The two captain selects are populated from the pool, so a real roster read
		// happened — an empty pool would leave them blank and the submit would fail.
		await expect(page.locator('select[name="captain1"] option')).not.toHaveCount(0);
		await page.getByRole('button', { name: /start the draft/i }).click();
		await expect(page.locator('.pill', { hasText: /drafting/i })).toBeVisible();
		await expectNoError(page);

		await page.getByRole('button', { name: /auto-draft the rest/i }).click();
		// Draining the pool moves the game straight into placement.
		await expect(page.locator('.pill', { hasText: /placing fleets/i })).toBeVisible();

		// Both sides drafted, everyone placed.
		const rosterItems = page.locator('.roster li');
		await expect(rosterItems).toHaveCount(12);

		// ── placement ────────────────────────────────────────────────────────
		await page.getByRole('button', { name: /auto-place fleet red/i }).click();
		await expectNoError(page);
		await page.getByRole('button', { name: /auto-place fleet blue/i }).click();
		await expectNoError(page);

		await page.getByRole('button', { name: /open the battle/i }).click();
		await expect(page.locator('.pill', { hasText: /^battle$/i })).toBeVisible();

		// Both boards render every square once the battle is on.
		const size = 8; // 6 a side → the 8x8 floor
		await expect(page.locator('.wrap').first().locator('.cell')).toHaveCount(size * size);

		// ── fire ─────────────────────────────────────────────────────────────
		await page.getByRole('button', { name: /\+broadside → fleet red/i }).click();
		await expect(page.locator('.bomb')).not.toHaveCount(0);

		// Aim at a square on the enemy board and fire. A 3x3 clamps to fit, so any
		// square is a legal click. Aiming is a client-side handler, so retry until the
		// page has hydrated and the readout confirms the anchor.
		const aimed = page.getByText(/aiming broadside at/i);
		for (let attempt = 0; attempt < 12; attempt++) {
			await page.locator('.board').nth(1).locator('.cell').first().click();
			try {
				await aimed.waitFor({ state: 'visible', timeout: 2_000 });
				break;
			} catch {
				// not hydrated yet
			}
		}
		await expect(aimed).toBeVisible();
		await page.getByRole('button', { name: /^fire$/i }).click();

		// The report is the proof the shot actually resolved server-side.
		await expect(page.locator('.ok')).toContainText(/hits?|already cratered|sank/i);

		// Craters are now on the enemy board — the shot reached the database.
		const craters = page.locator('.board').nth(1).locator('.cell.hit, .cell.miss');
		await expect(craters).not.toHaveCount(0);
	});

	test('the player view withholds the enemy fleet', async ({ page }) => {
		await page.goto(`/events/${SLUG}/battleship`);

		// Wait for the payload (the page paints skeletons first — see docs/PAGES.md).
		await expect(page.getByRole('heading', { name: 'E2E Battleship' })).toBeVisible();

		// The seeding admin is put in the game, so they get a side and two boards.
		const boards = page.locator('.board');
		await expect(boards).toHaveCount(2);

		// Own water shows hulls; the enemy board renders none, only craters. This is the
		// page-level half of the contract, and the half a browser can check.
		await expect(boards.nth(0).locator('.cell.ship')).not.toHaveCount(0);
		await expect(boards.nth(1).locator('.cell.ship')).toHaveCount(0);

		// The PAYLOAD-level contract (enemy `fleet` is null for a player) can't be
		// asserted here: dev-login only signs in a super-admin, and redactFor
		// deliberately hands admins both fleets so the tester can render them. That
		// contract is covered as a real non-admin player in scripts/battleship-sim.mjs
		// (step 10). What we can assert here is that the enemy summary — names, lengths,
		// sunk flags — is present without leaking positions to the rendered board.
		const payload = await page.evaluate(async (slug) => {
			const res = await fetch(`/api/battleship/${slug}`);
			return res.text();
		}, SLUG);
		const parsed = JSON.parse(payload);
		expect(parsed.game.viewerSide).not.toBeNull();
		for (const side of parsed.game.sides) {
			expect(Array.isArray(side.fleetSummary)).toBe(true);
			expect(side.fleetSummary.length).toBeGreaterThan(0);
		}
	});

	test.afterAll(async ({ browser }) => {
		// Clean up the test game so staging isn't littered with e2e runs.
		const page = await browser.newPage({ storageState: 'e2e/.auth/user.json' });
		await page.goto('/admin/battleship');
		const row = page.locator('.games li', { hasText: 'E2E Battleship' });
		if (await row.count()) {
			await row.first().getByRole('button', { name: /delete/i }).click();
			await expect(page.locator('.games li', { hasText: 'E2E Battleship' })).toHaveCount(0);
		}
		await page.close();
	});
});

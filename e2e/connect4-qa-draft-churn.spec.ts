import { test, expect, type Browser, type Page } from '@playwright/test';
import { buildLab, deleteLab, passAckGate, PROOF_B64, signInAs, type LabCast } from './c4-qa-lab';

// A STAGED SCREENSHOT AND A BOARD THAT KEEPS MOVING.
//
// The claim form's staged images are restored from IndexedDB by an effect that depends on
// the whole payload, not just the column. The board refetches whenever anything on it
// changes — which on a 600-cell board watched by two clans is constantly — so that effect
// re-runs while a player is still holding an unsubmitted screenshot, and ASSIGNS the
// IndexedDB contents over `staged`.
//
// Two consequences, one cosmetic and one not:
//   * every board update tears down and rebuilds the thumbnails (fresh object URLs);
//   * a paste that lands while that read is in flight is overwritten by it, so the
//     screenshot silently disappears and Submit greys out again.
//
//   npx playwright test e2e/connect4-qa-draft-churn.spec.ts

const SLUG = 'c4qa-churn';
test.describe.configure({ mode: 'serial', retries: 0 });

let cast: LabCast;
let victim: Page;
let mover: Page;

test.beforeAll(async ({ browser }: { browser: Browser }) => {
	cast = buildLab(SLUG);
	const fresh = async () => (await browser.newContext({ viewport: { width: 1280, height: 1000 } })).newPage();
	victim = await fresh();
	mover = await fresh();
	await signInAs(victim, cast.red[0].id);
	await signInAs(mover, cast.yellow[0].id);
});

test.afterAll(async () => {
	for (const p of [victim, mover]) await p?.context().close();
	deleteLab(SLUG);
});

async function openBoard(page: Page) {
	await page.goto(`/events/${SLUG}/connect4`, { waitUntil: 'domcontentloaded' });
	await expect(page.locator('.rail .tile').first()).toBeVisible({ timeout: 30_000 });
	await passAckGate(page);
}

/** Paste a screenshot into whatever column is open, with no preamble. */
async function paste(page: Page) {
	await page.evaluate((b64) => {
		const bin = atob(b64);
		const bytes = new Uint8Array(bin.length);
		for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
		const dt = new DataTransfer();
		dt.items.add(new File([bytes], 'drop.png', { type: 'image/png' }));
		window.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true }));
	}, PROOF_B64);
}

/** Make the board move: the other clan claims a column, which bumps the live token. */
async function moveTheBoard(page: Page, col: string, name: string) {
	await page.reload({ waitUntil: 'domcontentloaded' });
	await expect(page.locator('.rail .tile').first()).toBeVisible({ timeout: 30_000 });
	await page.getByRole('button', { name: `Column ${col}: ${name}` }).click();
	const form = page.locator('form.claim-form');
	await expect(form).toBeVisible({ timeout: 15_000 });
	await page.waitForTimeout(1200);
	await paste(page);
	await expect(form.locator('.thumb img')).toHaveCount(1, { timeout: 10_000 });
	await form.getByRole('button', { name: /Submit this drop/ }).click();
	await expect(page.getByText(/Sent for review/)).toBeVisible({ timeout: 60_000 });
}

test('a board update rebuilds the staged thumbnails from IndexedDB', async () => {
	test.setTimeout(180_000);
	await openBoard(victim);
	await openBoard(mover);

	// The player stages a screenshot for column A and has not submitted it.
	await victim.getByRole('button', { name: 'Column A: Bandos chestplate' }).click();
	await expect(victim.locator('form.claim-form')).toBeVisible({ timeout: 15_000 });
	await victim.waitForTimeout(1200);
	await paste(victim);
	const thumb = victim.locator('form.claim-form .thumb img');
	await expect(thumb).toHaveCount(1, { timeout: 10_000 });
	const before = await thumb.getAttribute('src');
	expect(before).toMatch(/^blob:/);

	// Somewhere else on the board, the other clan claims a tile.
	await moveTheBoard(mover, 'F', 'Scythe of vitur');

	// The victim's board refetches — and their staged thumbnail is replaced, not left
	// alone. A different blob URL means the image was round-tripped through IndexedDB
	// while they were still holding it.
	await expect(async () => {
		const now = await thumb.getAttribute('src');
		expect(now, 'the staged thumbnail was never rebuilt').not.toBe(before);
	}).toPass({ timeout: 30_000 });

	// It is still there, at least — the round trip won this time.
	await expect(thumb).toHaveCount(1);
});

test('pasting while the board is refetching can lose the screenshot', async () => {
	test.setTimeout(300_000);
	// Ten attempts at the window a real player hits by accident: paste at the moment a
	// board update is in flight. Any single loss is a loss — a player's screenshot
	// vanishing with nothing said is not an acceptable outcome at any rate.
	const losses: number[] = [];
	const tiles = [
		['E', 'Ancestral hat'],
		['E', 'Twisted bow'],
		['E', 'Kodai insignia'],
		['E', 'Elder maul'],
		['B', 'QA Mixology Points']
	] as const;

	for (let i = 0; i < tiles.length; i++) {
		// Reopen the victim's form on column A (its tile is whatever is on offer now).
		await victim.reload({ waitUntil: 'domcontentloaded' });
		await expect(victim.locator('.rail .tile').first()).toBeVisible({ timeout: 30_000 });
		await victim.getByRole('button', { name: /^Column A: / }).click();
		await expect(victim.locator('form.claim-form')).toBeVisible({ timeout: 15_000 });
		await victim.waitForTimeout(1500);
		// Clear anything left over so each attempt starts from nothing staged.
		const clear = victim.locator('form.claim-form').getByRole('button', { name: 'Clear' });
		if (await clear.count()) await clear.click();
		await expect(victim.locator('form.claim-form .thumb img')).toHaveCount(0);

		// Kick the board, then paste into the refetch window.
		const [col, name] = tiles[i];
		const move = moveTheBoard(mover, col, name).catch(() => {
			/* the mover is only rigging — a hiccup there is not a result */
		});
		await victim.waitForTimeout(600 + i * 250);
		await paste(victim);
		await move;

		await victim.waitForTimeout(4000);
		if ((await victim.locator('form.claim-form .thumb img').count()) === 0) losses.push(i);
	}

	expect(
		losses,
		`a pasted screenshot disappeared on attempt(s) ${losses.join(', ')} of ${tiles.length}`
	).toHaveLength(0);
});

import { test, expect, type Browser, type Page } from '@playwright/test';
import { buildLab, deleteLab, passAckGate, signInAs, stageProof, type LabCast } from './c4-qa-lab';

// QUANTITY TILES, THROUGH THE BROWSER.
//
// A "×N" tile is only claimed when one side has banked N. This is where the worst bug of
// the live event lived — a single screenshot finished a ×1000 tile — so every assertion
// here is made from what a player and an admin can actually SEE: the progress figures in
// the tile detail strip, the tile still sitting on the rail, and the holes on the board.
//
//   npx playwright test e2e/connect4-qa-quantity.spec.ts

const SLUG = 'c4qa-qty';
test.describe.configure({ mode: 'serial', retries: 0 });

let cast: LabCast;
let redA: Page; // Volition
let redB: Page;
let redC: Page;
let yellowA: Page; // IronClad
let admin: Page;

test.beforeAll(async ({ browser }: { browser: Browser }) => {
	cast = buildLab(SLUG);
	const fresh = async () => (await browser.newContext({ viewport: { width: 1280, height: 1000 } })).newPage();
	redA = await fresh();
	redB = await fresh();
	redC = await fresh();
	yellowA = await fresh();
	admin = await browser.newPage({ viewport: { width: 1500, height: 1000 } });
	await signInAs(redA, cast.red[0].id);
	await signInAs(redB, cast.red[1].id);
	await signInAs(redC, cast.red[2].id);
	await signInAs(yellowA, cast.yellow[0].id);
});

test.afterAll(async () => {
	for (const p of [redA, redB, redC, yellowA]) await p?.context().close();
	await admin?.close();
	deleteLab(SLUG);
});

/** Open the board and get past the first-visit evidence modal. */
async function openBoard(page: Page) {
	await page.goto(`/events/${SLUG}/connect4`, { waitUntil: 'domcontentloaded' });
	await expect(page.locator('.rail .tile').first()).toBeVisible({ timeout: 30_000 });
	await passAckGate(page);
}

/** Click a column's token on the rail and wait for its detail strip. */
async function openTile(page: Page, col: string, name: string) {
	const tile = page.getByRole('button', { name: `Column ${col}: ${name}` });
	await expect(tile, `column ${col} is not offering "${name}"`).toBeVisible({ timeout: 20_000 });
	await tile.click();
	const detail = page.locator('.tile-detail');
	await expect(detail).toContainText(name, { timeout: 15_000 });
	return detail;
}

/** The review queue, narrowed to this game — staging carries other events' claims too. */
async function openQueue(page: Page) {
	await page.goto('/admin/submissions', { waitUntil: 'domcontentloaded' });
	await page.locator('#approve-btn').waitFor({ timeout: 60_000 });
	await page.getByRole('button', { name: new RegExp(`^Connect Four QA lab \\(${SLUG}\\) \\(\\d+\\)$`) }).click();
	await expect(page.locator('article.card')).toContainText(`Connect Four QA lab (${SLUG})`, { timeout: 15_000 });
}

/** Tick the evidence checks, approve the claim showing, and wait for it to leave. */
async function approveCurrent(page: Page, label: string) {
	await expect(page.locator('#approve-btn'), 'approve was live before the checks').toBeDisabled();
	for (const box of await page.locator('.approve-checks input[type="checkbox"]').all()) await box.check();
	await expect(page.locator('#approve-btn')).toBeEnabled();
	await page.locator('#approve-btn').click();
	await expect(async () => {
		expect(await page.locator('article.card').filter({ hasText: label }).count()).toBe(0);
	}).toPass({ timeout: 60_000 });
}

/** Submit a pasted screenshot for the open column, covering `qty` of a ×N tile. */
async function submit(page: Page, qty?: number) {
	const form = page.locator('form.claim-form');
	await expect(form).toBeVisible({ timeout: 15_000 });
	await stageProof(page);
	if (qty != null) await form.locator('input[name="quantity"]').fill(String(qty));
	await form.getByRole('button', { name: /Submit this drop/ }).click();
}

test('a ×1000 tile shows its cost, and one screenshot covering 400 banks 400 — no piece', async () => {
	test.setTimeout(120_000);
	await openBoard(redA);

	// The rail says ×1000 before anything is clicked.
	const token = redA.getByRole('button', { name: 'Column C: QA Stardust Haul' });
	await expect(token.locator('.qty-badge')).toHaveText('×1000');

	const detail = await openTile(redA, 'C', 'QA Stardust Haul');
	await expect(detail).toContainText('first side to 1000 drops');
	await expect(detail).toContainText('Volition 0/1000');
	await expect(detail).toContainText('IronClad 0/1000');

	// The form asks how much this one screenshot covers.
	const qty = redA.locator('form.claim-form input[name="quantity"]');
	await expect(qty).toBeVisible();
	await expect(qty).toHaveAttribute('max', '1000');

	await submit(redA, 400);

	// The player is told where they stand — not a bare "sent".
	await expect(redA.getByText('Sent for review —')).toBeVisible({ timeout: 60_000 });
	await expect(redA.locator('.claim-panel, .tile-detail').locator('..')).toContainText('400 of 1000');

	// NOTHING landed on the board, and the column is still offering the same tile.
	await expect(redA.locator('.hole.filled')).toHaveCount(0);
	await expect(redA.getByRole('button', { name: 'Column C: QA Stardust Haul' })).toBeVisible();
	await expect(redA.locator('.awaiting li')).toHaveCount(0);

	// And the bank is visible to everyone, reopened from a clean load.
	await redA.reload({ waitUntil: 'domcontentloaded' });
	const again = await openTile(redA, 'C', 'QA Stardust Haul');
	await expect(again).toContainText('Volition 400/1000');
	await expect(again).toContainText('IronClad 0/1000');
});

test('approving that proof advances nothing further — it was banked at submit time', async () => {
	test.setTimeout(120_000);
	await openQueue(admin);
	// The queue says how much this one proof covers.
	await expect(admin.locator('article.card')).toContainText('QA Stardust Haul');
	await expect(admin.locator('article.card')).toContainText(/covers 400 of 1000/);
	await approveCurrent(admin, 'QA Stardust Haul');

	// Still 400, still no piece: approval confirms a piece, it does not credit again.
	await redA.reload({ waitUntil: 'domcontentloaded' });
	const detail = await openTile(redA, 'C', 'QA Stardust Haul');
	await expect(detail).toContainText('Volition 400/1000');
	await expect(redA.locator('.hole.filled')).toHaveCount(0);
});

test('banks accumulate per SIDE: the opposing clan runs its own race', async () => {
	test.setTimeout(180_000);

	await openBoard(redB);
	await openTile(redB, 'C', 'QA Stardust Haul');
	await submit(redB, 500);
	await expect(redB.getByText('900 of 1000')).toBeVisible({ timeout: 60_000 });
	await expect(redB.locator('.hole.filled')).toHaveCount(0);

	await openBoard(yellowA);
	const yd = await openTile(yellowA, 'C', 'QA Stardust Haul');
	// The other clan sees Volition's progress but starts from zero themselves.
	await expect(yd).toContainText('Volition 900/1000');
	await expect(yd).toContainText('IronClad 0/1000');
	await submit(yellowA, 600);
	await expect(yellowA.getByText('600 of 1000')).toBeVisible({ timeout: 60_000 });

	// 900 + 600 is 1500, and NOBODY has the tile: contributions do not pool across sides.
	await expect(yellowA.locator('.hole.filled')).toHaveCount(0);
	await yellowA.reload({ waitUntil: 'domcontentloaded' });
	const yd2 = await openTile(yellowA, 'C', 'QA Stardust Haul');
	await expect(yd2).toContainText('Volition 900/1000');
	await expect(yd2).toContainText('IronClad 600/1000');
});

test('overshooting the threshold lands the piece exactly once, for the side that got there', async () => {
	test.setTimeout(180_000);

	await openBoard(redC);
	await openTile(redC, 'C', 'QA Stardust Haul');
	// 900 banked, 100 needed — this screenshot claims 400 of them.
	await submit(redC, 400);
	await expect(redC.getByText('Sent for review')).toBeVisible({ timeout: 60_000 });
	// Not the progress line: this one finished the tile.
	await expect(redC.getByText(/of 1000 for your side/)).toHaveCount(0);

	// Exactly one piece, in column C, for Volition, and the column has moved on.
	await expect(redC.locator('.hole.filled')).toHaveCount(1, { timeout: 30_000 });
	await expect(redC.getByRole('button', { name: /^C1 — Volition/ })).toBeVisible();
	await expect(redC.getByRole('button', { name: 'Column C: Tyrannical ring' })).toBeVisible();
	await expect(redC.locator('.awaiting li')).toHaveCount(1);

	// No double credit anywhere: exactly one cell in column C is filled.
	const cPieces = await redC.locator('.hole.filled').evaluateAll((els) =>
		els.map((e) => e.getAttribute('aria-label') ?? '').filter((l) => /^C\d/.test(l))
	);
	expect(cPieces, `column C pieces: ${cPieces.join(' | ')}`).toHaveLength(1);
});

test('a ×5 tile completes for whoever REACHES 5, not whoever contributed most', async () => {
	test.setTimeout(180_000);

	await openBoard(redA);
	await openTile(redA, 'B', 'QA Mixology Points');
	await submit(redA, 2);
	await expect(redA.getByText('2 of 5')).toBeVisible({ timeout: 60_000 });

	await openBoard(yellowA);
	const yd = await openTile(yellowA, 'B', 'QA Mixology Points');
	await expect(yd).toContainText('Volition 2/5');
	await submit(yellowA, 5);
	await expect(yellowA.getByText('Sent for review')).toBeVisible({ timeout: 60_000 });

	// IronClad took the cell; Volition's 2 bought nothing on this tile.
	await expect(yellowA.getByRole('button', { name: /^B1 — IronClad/ })).toBeVisible({ timeout: 30_000 });
	await expect(yellowA.getByRole('button', { name: 'Column B: QA Wintertodt Kits' })).toBeVisible();
});

test('a completed tile is off the board, and a stale resubmit lands on the CURRENT tile', async () => {
	test.setTimeout(120_000);

	// There is no UI route back to a completed tile: column B has moved on to the ×3
	// behind it, and the ×5 is gone from the rail entirely.
	await redA.reload({ waitUntil: 'domcontentloaded' });
	await expect(redA.getByRole('button', { name: 'Column B: QA Wintertodt Kits' })).toBeVisible({
		timeout: 30_000
	});
	await expect(redA.getByRole('button', { name: 'Column B: QA Mixology Points' })).toHaveCount(0);

	// A stale "send a better screenshot" post — resubmit=1 from a player who no longer
	// holds anything in that column. It must not be filed against whatever the column
	// happens to be offering now: the proof was taken for a different objective.
	const res = await redA.request.post(`/events/${SLUG}/connect4?/submitClaim`, {
		headers: { 'x-sveltekit-action': 'true' },
		multipart: {
			col: '1',
			resubmit: '1',
			quantity: '5',
			proof: { name: 'drop.png', mimeType: 'image/png', buffer: Buffer.from([0x89, 0x50, 0x4e, 0x47]) }
		}
	});
	expect(res.status()).toBeLessThan(500);
	expect(
		await res.text(),
		'a resubmit with nothing held silently became a fresh claim on the column'
	).toContain('no longer waiting on you');
});

test('an ADMIN credit decides a ×N tile outright — the one path that skips the gate', async () => {
	test.setTimeout(120_000);
	await admin.goto(`/admin/connect4/${SLUG}`, { waitUntil: 'domcontentloaded' });
	// Column B now offers the ×3 tile behind the one IronClad just took.
	await admin.getByRole('button', { name: 'Column B: QA Wintertodt Kits' }).click();
	await admin.getByRole('button', { name: /Volition/ }).first().click();
	await expect(admin.getByRole('button', { name: 'Column B: Dragon boots' })).toBeVisible({ timeout: 60_000 });
});

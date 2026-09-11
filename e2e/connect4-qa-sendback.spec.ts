import { test, expect, type Browser, type Page } from '@playwright/test';
import { buildLab, deleteLab, passAckGate, pasteProof, signInAs, type LabCast } from './c4-qa-lab';

// "ASK AGAIN" — THE SEND-BACK, FROM ALL FOUR CHAIRS.
//
// A partial rejection hands the evidence back without taking the tile away: the piece
// stays pending, the submission goes to `rejected`, and the player is asked for a better
// screenshot. Three surfaces have to agree about that, and none of them had ever been
// clicked in a browser:
//
//   the submitter  — a notice naming the tile they ACTUALLY hold (the column has moved
//                    on), the admin's note, and a button that resubmits from the notice;
//   everyone else  — an ordinary pending claim, with no hint the evidence was questioned;
//   the admin      — the game page's "Waiting on a better screenshot" panel.
//
//   npx playwright test e2e/connect4-qa-sendback.spec.ts

const SLUG = 'c4qa-back';
const NOTE = 'Chat box is cropped — send one with the in-game clock visible.';
test.describe.configure({ mode: 'serial', retries: 0 });

let cast: LabCast;
let holder: Page; // Volition 1 — the player who gets sent back
let mate: Page; // Volition 2 — same side, must learn nothing
let rival: Page; // IronClad 1 — other side, must learn nothing
let admin: Page;
/** Places that printed a raw "col,row" where the rest of the board prints "A1". */
const labelDefects: string[] = [];

test.beforeAll(async ({ browser }: { browser: Browser }) => {
	cast = buildLab(SLUG);
	const fresh = async () => (await browser.newContext({ viewport: { width: 1280, height: 1000 } })).newPage();
	holder = await fresh();
	mate = await fresh();
	rival = await fresh();
	admin = await browser.newPage({ viewport: { width: 1500, height: 1000 } });
	await signInAs(holder, cast.red[0].id);
	await signInAs(mate, cast.red[1].id);
	await signInAs(rival, cast.yellow[0].id);
});

test.afterAll(async () => {
	for (const p of [holder, mate, rival]) await p?.context().close();
	await admin?.close();
	deleteLab(SLUG);
});

async function openBoard(page: Page) {
	await page.goto(`/events/${SLUG}/connect4`, { waitUntil: 'domcontentloaded' });
	await expect(page.locator('.rail .tile').first()).toBeVisible({ timeout: 30_000 });
	await passAckGate(page);
}

async function claim(page: Page, col: string, name: string) {
	const tile = page.getByRole('button', { name: `Column ${col}: ${name}` });
	await expect(tile, `column ${col} is not offering "${name}"`).toBeVisible({ timeout: 20_000 });
	await tile.click();
	const form = page.locator('form.claim-form');
	await expect(form).toBeVisible({ timeout: 15_000 });
	await pasteProof(page);
	await expect(form.locator('.thumb img')).toHaveCount(1, { timeout: 10_000 });
	await form.getByRole('button', { name: /Submit this drop/ }).click();
	await expect(page.getByText('Sent for review')).toBeVisible({ timeout: 60_000 });
}

async function openQueue(page: Page) {
	await page.goto('/admin/submissions', { waitUntil: 'domcontentloaded' });
	await page.locator('#approve-btn').waitFor({ timeout: 60_000 });
	await page.getByRole('button', { name: new RegExp(`^Connect Four QA lab \\(${SLUG}\\) \\(\\d+\\)$`) }).click();
	await expect(page.locator('article.card')).toContainText(`Connect Four QA lab (${SLUG})`, { timeout: 15_000 });
}

/** Walk the queue to the claim for `label`, however many other rows are in front of it. */
async function goToClaim(page: Page, label: string) {
	for (let i = 0; i < 12; i++) {
		if (await page.locator('article.card').filter({ hasText: label }).count()) return;
		await page.getByRole('button', { name: /Skip/ }).click();
		await page.waitForTimeout(250);
	}
	throw new Error(`no claim for "${label}" in the queue`);
}

test('two Volition players stack in column A, and IronClad takes column E', async () => {
	test.setTimeout(180_000);
	await openBoard(holder);
	await claim(holder, 'A', 'Bandos chestplate');
	// The column has already moved on — that is what makes the send-back notice necessary.
	await expect(holder.getByRole('button', { name: 'Column A: Armadyl crossbow' })).toBeVisible({
		timeout: 30_000
	});

	await openBoard(mate);
	await claim(mate, 'A', 'Armadyl crossbow');

	await openBoard(rival);
	await claim(rival, 'E', 'Ancestral hat');

	await expect(rival.locator('.awaiting li')).toHaveCount(3, { timeout: 30_000 });
});

test('the admin sends the first claim back with a note — the piece stays put', async () => {
	test.setTimeout(180_000);
	await openQueue(admin);
	await goToClaim(admin, 'Bandos chestplate');
	await admin.locator('textarea').first().fill(NOTE);
	await admin.getByRole('button', { name: /Ask again/ }).click();
	await expect(async () => {
		expect(await admin.locator('article.card').filter({ hasText: 'Bandos chestplate' }).count()).toBe(0);
	}).toPass({ timeout: 60_000 });

	// The piece is still standing, and still theirs.
	await holder.reload({ waitUntil: 'domcontentloaded' });
	await expect(holder.getByRole('button', { name: /^A1 — Volition, Bandos chestplate/ })).toBeVisible({
		timeout: 30_000
	});
});

test('the submitter is told, and the notice names the tile they HOLD, not the column', async () => {
	test.setTimeout(120_000);
	const mine = holder.locator('.awaiting li.mine');
	await expect(mine).toHaveCount(1, { timeout: 30_000 });
	await expect(mine).toContainText('An admin needs a better screenshot');
	await expect(mine).toContainText(NOTE);
	// The tile they hold — NOT "Armadyl crossbow", which is what column A offers now.
	await expect(mine).toContainText('Bandos chestplate');
	await expect(mine).not.toContainText('Armadyl crossbow');
	await expect(mine.getByRole('button', { name: 'Send a better screenshot' })).toBeVisible();
	// The waiting room should name cells the way the rest of the board does — "A1", the
	// label the log, the board and the admin's panel all use — not the raw "0,0" id.
	// Recorded rather than asserted here so one label defect does not stop the rest of
	// the send-back journey being exercised; the last test in the file asserts on it.
	const seen = (await mine.textContent()) ?? '';
	if (!seen.includes('A1')) labelDefects.push(`waiting room: "${seen.trim().split('\n')[0].trim()}"`);
});

test('nobody else sees any of it — not their own side, not the other clan', async () => {
	test.setTimeout(120_000);
	for (const [who, page] of [['same side', mate], ['other clan', rival]] as const) {
		await page.reload({ waitUntil: 'domcontentloaded' });
		const list = page.locator('.awaiting li');
		await expect(list.first(), who).toBeVisible({ timeout: 30_000 });
		// The claim IS listed — the waiting room is public — but only as an ordinary one.
		await expect(page.locator('.awaiting')).toContainText('Bandos chestplate');
		await expect(page.locator('.awaiting li.mine'), `${who} sees a send-back`).toHaveCount(0);
		await expect(page.locator('.awaiting'), `${who} sees the note`).not.toContainText(NOTE);
		await expect(
			page.getByRole('button', { name: 'Send a better screenshot' }),
			`${who} can resubmit for someone else`
		).toHaveCount(0);
	}
	// And the note is not merely hidden by the markup — it is not in the payload either.
	const raw = await rival.request.get(`/api/connect4/${SLUG}`);
	expect(await raw.text(), 'the note leaks over the api').not.toContain('Chat box is cropped');
});

test("the admin's own game page lists it under Waiting on a better screenshot", async () => {
	test.setTimeout(120_000);
	await admin.goto(`/admin/connect4/${SLUG}`, { waitUntil: 'domcontentloaded' });
	const panel = admin.locator('section').filter({ hasText: /Waiting on a better screenshot/ }).first();
	await expect(panel).toBeVisible({ timeout: 30_000 });
	await expect(panel.locator('.osrs-titlebar')).toContainText('Waiting on a better screenshot — 1');
	const row = panel.locator('.sent-back li').first();
	await expect(row).toContainText('A1');
	await expect(row).toContainText('Bandos chestplate');
	await expect(row).toContainText(cast.red[0].rsn);
	await expect(row).toContainText(NOTE);
	await expect(row).toContainText(/sent back/);
});

test('the resubmit button reopens the claim they hold and posts a better screenshot', async () => {
	test.setTimeout(180_000);
	await holder.locator('.awaiting li.mine').getByRole('button', { name: 'Send a better screenshot' }).click();

	// The form is now for the HELD tile, not the column's current offer.
	const form = holder.locator('form.claim-form');
	await expect(form).toBeVisible({ timeout: 15_000 });
	await expect(form.locator('.redo-head')).toContainText('Bandos chestplate');
	const head = (await form.locator('.redo-head').textContent()) ?? '';
	if (!head.includes('A1')) labelDefects.push(`resubmit notice: "${head.trim()}"`);
	await expect(holder.locator('.tile-detail')).toContainText('Bandos chestplate');
	await expect(holder.locator('.tile-detail')).not.toContainText('Armadyl crossbow');

	await pasteProof(holder);
	await expect(form.locator('.thumb img')).toHaveCount(1, { timeout: 10_000 });
	await form.getByRole('button', { name: /Submit this drop/ }).click();
	await expect(holder.getByText('Sent for review')).toBeVisible({ timeout: 60_000 });

	// The send-back state clears — it is waiting on a reviewer again, not on the player.
	await holder.reload({ waitUntil: 'domcontentloaded' });
	await expect(holder.locator('.awaiting li.mine')).toHaveCount(0, { timeout: 30_000 });
	// Still exactly one piece in column A for this player: a resubmission re-points, it
	// does not claim a second cell.
	await expect(holder.locator('.hole.filled')).toHaveCount(3);

	// And the admin's waiting panel empties.
	await admin.goto(`/admin/connect4/${SLUG}`, { waitUntil: 'domcontentloaded' });
	await expect(admin.locator('.osrs-titlebar', { hasText: 'Waiting on a better screenshot' })).toHaveCount(0, {
		timeout: 30_000
	});
});

test('the better screenshot reaches the queue and approving confirms the right cell', async () => {
	test.setTimeout(180_000);
	await openQueue(admin);
	await goToClaim(admin, 'Bandos chestplate');
	await expect(admin.locator('article.card')).toContainText('column A');
	for (const box of await admin.locator('.approve-checks input[type="checkbox"]').all()) await box.check();
	await admin.locator('#approve-btn').click();
	await expect(async () => {
		expect(await admin.locator('article.card').filter({ hasText: 'Bandos chestplate' }).count()).toBe(0);
	}).toPass({ timeout: 60_000 });

	await holder.reload({ waitUntil: 'domcontentloaded' });
	// A1 is confirmed — it has left the waiting room but is still on the board.
	await expect(holder.getByRole('button', { name: /^A1 — Volition, Bandos chestplate/ })).toBeVisible({
		timeout: 30_000
	});
	await expect(holder.locator('.awaiting')).not.toContainText('Bandos chestplate');
});

test('a SECOND claim in a column you already hold pending places its own piece', async () => {
	test.setTimeout(180_000);
	// `mate` holds A2 (Armadyl crossbow), still unreviewed. They now get the drop for
	// what column A offers NEXT and submit for the same column — an ordinary thing to
	// happen when the review queue is behind.
	await mate.reload({ waitUntil: 'domcontentloaded' });
	const before = await mate.locator('.hole.filled').count();
	await claim(mate, 'A', 'Zamorakian spear');
	await mate.reload({ waitUntil: 'domcontentloaded' });
	await expect(mate.locator('.hole.filled')).toHaveCount(before + 1, { timeout: 30_000 });
	await expect(mate.getByRole('button', { name: /^A3 — Volition, Zamorakian spear/ })).toBeVisible();
});

test('the waiting room and the resubmit notice name cells the way the board does', async () => {
	// Collected by the tests above, so a label defect does not cut the journey short.
	expect(
		labelDefects,
		'these surfaces printed a raw cell id instead of its A1-style label'
	).toEqual([]);
});

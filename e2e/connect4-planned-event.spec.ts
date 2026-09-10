// THE EVENT, end to end, on the board it will actually run: the checked-in planned
// tile list loaded in one click, a real 40×15 / 600-cell game, members submitting
// proof, and an admin approving, asking again, and rejecting outright.
//
// Everything here goes through the UI. The engine has its own drills; what this
// covers is the parts a person touches on the night — which is where the last two
// bugs (an import that silently did nothing, a false "superseded" warning) lived.
import { test, expect, type Page } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// One journey through one game, so the tests are a chain: serial, and NO retries.
// A retry restarts the worker, which re-imports this module and mints a fresh SLUG —
// the retried test then drives a game that was never created and fails on an empty
// board, burying whatever actually broke.
test.describe.configure({ mode: 'serial', retries: 0 });

const SHOTS = 'e2e-shots/planned-event';
const SLUG = `pe-${Date.now().toString(36)}`;
const PLANNED_TILES = 244;
const CELLS = 600;
const COLS = 40;

let admin: Page;
let member: Page;
let viewerName = '';
let claimed = '';
const pageErrors: string[] = [];
let shotNo = 0;

// A submission needs a file; any real PNG will do — the reviewer looks at it, the
// test only cares that it rides through the form and comes back out of the queue.
const PROOF = join(SHOTS, 'proof.png');

test.beforeAll(async ({ browser }) => {
	mkdirSync(SHOTS, { recursive: true });
	writeFileSync(
		PROOF,
		Buffer.from(
			'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
			'base64'
		)
	);
	admin = await browser.newPage({ viewport: { width: 1500, height: 950 } });
	member = await browser.newPage({ viewport: { width: 1500, height: 950 } });
	admin.on('pageerror', (e) => pageErrors.push(`admin: ${e.message}`));
	member.on('pageerror', (e) => pageErrors.push(`member: ${e.message}`));
});

test.afterAll(async () => {
	await admin?.close();
	await member?.close();
});

async function shot(page: Page, name: string) {
	shotNo++;
	const file = join(SHOTS, `${String(shotNo).padStart(2, '0')}-${name}.png`);
	await page.screenshot({ path: file });
	console.log(`  📸 ${file}`);
}

/** Clear the evidence gate, which only shows for a member seated on a side. */
async function dismissAck(page: Page): Promise<void> {
	const modal = page.getByRole('dialog', { name: /Before you start/i });
	if (!(await modal.isVisible().catch(() => false))) return;
	for (const box of await modal.locator('input[type="checkbox"]').all()) await box.check();
	await modal.getByRole('button', { name: /Confirm/ }).click();
	await expect(modal).toBeHidden();
}

/** Open the member board fresh (the wiki icons hang here, so never wait for `load`). */
async function openBoard(page: Page): Promise<void> {
	await page.goto(`/events/${SLUG}/connect4`, { waitUntil: 'domcontentloaded' });
	await page.locator('.hole').first().waitFor({ timeout: 30_000 });
	await dismissAck(page);
}

/** Submit proof for the tile above `col`, saying it covers `covers` drops. */
async function submitClaim(page: Page, col: number, covers = 1): Promise<string> {
	const tile = page.locator('.rail .tile').nth(col);
	await tile.click();
	const form = page.locator('form.claim-form');
	await form.waitFor({ state: 'visible', timeout: 10_000 }).catch(async () => {
		await tile.click(); // clicking the selected tile deselects it
		await form.waitFor({ state: 'visible', timeout: 10_000 });
	});
	const name = (await page.locator('.tile-detail').innerText()).split('\n')[0];
	await page.locator('form.claim-form input[name="proof"]').setInputFiles(PROOF);
	const qty = form.locator('input[name="quantity"]');
	if (await qty.count()) await qty.fill(String(covers));
	await form.getByRole('button', { name: /Submit this drop/ }).click();
	await expect(page.getByText('Sent for review')).toBeVisible({ timeout: 30_000 });
	return name;
}

/** The review queue, on the oldest pending claim. Every call here expects one. */
async function openQueue(): Promise<void> {
	await admin.goto('/admin/submissions', { waitUntil: 'domcontentloaded' });
	await admin.locator('#approve-btn').waitFor({ timeout: 30_000 });
}

test('an admin builds the real board from the planned list', async () => {
	test.setTimeout(180_000);
	await admin.goto('/admin/connect4');
	await admin.locator('input[name="name"]').fill(`Planned event ${SLUG}`);
	await admin.locator('input[name="slug"]').fill(SLUG);
	// No cols/rows touched: the point is that the default already fits the plan.
	await expect(admin.locator('input[name="cols"]')).toHaveValue('40');
	await expect(admin.locator('input[name="rows"]')).toHaveValue('15');
	await admin.getByRole('button', { name: 'Create' }).click();
	await expect(admin).toHaveURL(new RegExp(`/admin/connect4/${SLUG}$`));

	const load = admin.getByRole('button', { name: /Load the planned board/ });
	await load.scrollIntoViewIfNeeded();
	await expect(load).toContainText(`${PLANNED_TILES} tiles filling ${CELLS} cells`);
	await load.click();
	await expect(admin.locator('.ok').first()).toContainText(
		`Imported ${PLANNED_TILES} tiles filling ${CELLS} cells`,
		{ timeout: 60_000 }
	);
	await expect(admin.getByText(`${CELLS} / ${CELLS} chosen`).first()).toBeVisible();
	await shot(admin, 'planned-loaded');
});

test('the planned tiles keep their drop counts and copies', async () => {
	// A "×N drops" tile that imported as a single-drop tile would quietly change the
	// event, so check the knobs the plan set rather than just the cell count.
	const multi = admin.locator('.cand', { hasText: 'Any Elegant Clothing Piece' }).first();
	await multi.scrollIntoViewIfNeeded();
	await expect(multi.locator('input').nth(1)).toHaveValue('5'); // 5 drops needed
	const copied = admin.locator('.cand', { hasText: 'Any Kourend Scarf' }).first();
	await expect(copied.locator('input').nth(2)).toHaveValue('2'); // 2 board cells
});

test('both clans seat and the game starts on 600 cells', async () => {
	test.setTimeout(120_000);
	const members = admin.locator('.roster .member');

	// The signed-in account has to be ON a side, or the board offers it nothing to
	// submit — the claim form only renders for a seated viewer. The header shows the
	// same name the roster lists (rsn, falling back to the Discord name).
	viewerName = (await admin.locator('.user-name').first().innerText()).trim();
	const mine = members.filter({ hasText: viewerName }).first();
	await expect(mine, `the signed-in account "${viewerName}" is not on the roster`).toHaveCount(1);
	await mine.locator('input').check();

	// …plus one more for Red, from whoever is not already ticked.
	const others = members.filter({ hasNot: admin.locator('input:checked') });
	await others.nth(0).locator('input').check();
	await admin.getByRole('button', { name: '→ Red' }).click();
	await expect(admin.locator('.roster .member .pill', { hasText: 'Red' })).toHaveCount(2);

	const unseated = members.filter({ hasNot: admin.locator('.pill') });
	for (const i of [0, 1]) await unseated.nth(i).locator('input').check();
	await admin.getByRole('button', { name: '→ Yellow' }).click();
	await expect(admin.locator('.roster .member .pill', { hasText: 'Yellow' })).toHaveCount(2);

	await admin.getByRole('button', { name: 'Deal the deck and start' }).click();
	await expect(admin.locator('.osrs-badge').first()).toHaveText('live', { timeout: 60_000 });
	await expect(admin.locator('.hole')).toHaveCount(CELLS);
	await expect(admin.locator('.rail .tile')).toHaveCount(COLS);
	await shot(admin, 'live-board');
});

test('a member submits proof and it lands as pending, not as a credit', async () => {
	test.setTimeout(120_000);
	await openBoard(member);
	await expect(member.locator('.hole')).toHaveCount(CELLS);
	await expect(member.locator('.board-panel .osrs-titlebar')).toContainText(`0 / ${CELLS} claimed`);
	// Seating is proved by the claim form appearing once a tile is selected, which is
	// what submitClaim does below — the standing hint here is simply "pick a column".

	// The rail names the tile as "A — <item>"; the awaiting row lists the item alone.
	const name = await submitClaim(member, 0);
	claimed = name.split('—').pop()!.trim();
	console.log(`  · claimed column A: ${name}`);
	await shot(member, 'member-submitted');

	// Provisional: the piece is on the board immediately, so submission order settles
	// the tile, but the header still counts it as unclaimed until an admin confirms.
	await openBoard(member);
	await expect(member.locator('.awaiting li')).toHaveCount(1);
	// The panel says what the section is; the row says which tile, who, and when.
	await expect(member.getByText('Waiting on an admin — 1')).toBeVisible();
	await expect(member.locator('.awaiting li').first()).toContainText(claimed);
	await expect(member.locator('.awaiting li').first()).toContainText(viewerName);
	await expect(member.locator('.awaiting li.mine')).toHaveCount(0); // nothing to redo yet
	await shot(member, 'awaiting-row');
});

test('the review queue shows when the tile went up, and gates approval on it', async () => {
	test.setTimeout(120_000);
	await openQueue();
	await expect(admin.locator('.tile-window')).toContainText('This tile went up at');
	// The timing box starts unticked and the approve button is dead until it is ticked.
	await expect(admin.locator('#approve-btn')).toBeDisabled();
	await expect(admin.locator('.tile-warn')).toHaveCount(0); // nobody superseded it
	await shot(admin, 'review-gated');

	await admin.getByText('In-game drop time is after the tile went up').click();
	await expect(admin.locator('#approve-btn')).toBeEnabled();
	await shot(admin, 'review-ready');

	await admin.locator('#approve-btn').click();
	await admin.waitForTimeout(2000);

	await openBoard(member);
	await expect(member.locator('.board-panel .osrs-titlebar')).toContainText(`1 / ${CELLS} claimed`, {
		timeout: 30_000
	});
	await expect(member.locator('.awaiting li')).toHaveCount(0);
	await shot(member, 'approved-on-board');
});

test('"ask again" keeps the tile and prompts the member for a better shot', async () => {
	test.setTimeout(120_000);
	await openBoard(member);
	await submitClaim(member, 1);

	await openQueue();
	await admin.getByText('In-game drop time is after the tile went up').click();
	await admin.getByRole('button', { name: /Ask again/ }).click();
	await admin.waitForTimeout(2000);
	await shot(admin, 'asked-again');

	await openBoard(member);
	// The claim is still theirs — the piece stays put, and the board says to resend.
	await expect(member.locator('.awaiting li.mine')).toHaveCount(1);
	await expect(member.locator('.awaiting .redo')).toContainText('needs a better screenshot');
	await expect(member.locator('.awaiting .redo')).toContainText('You still hold this tile');
	await shot(member, 'member-asked-again');
});

test('"reject & free tile" takes the piece off and returns the tile to play', async () => {
	test.setTimeout(120_000);
	// A fresh claim to reject — the partial rejection above settled the last one, so
	// the queue is empty by design at this point.
	await openBoard(member);
	await submitClaim(member, 2);
	// Count from a RELOADED board: the piece is placed server-side on submit, but the
	// open page only shows it after its next poll, so counting here would read stale.
	await openBoard(member);
	const before = await member.locator('.hole.filled').count();
	expect(before, 'expected three pieces standing: approved, asked-again, and the new one').toBe(3);

	await openQueue();
	await admin.getByText('In-game drop time is after the tile went up').click();
	await admin.getByRole('button', { name: /Reject & free tile/ }).click();
	await admin.waitForTimeout(2000);
	await shot(admin, 'rejected-full');

	await openBoard(member);
	await expect(member.locator('.hole.filled')).toHaveCount(before - 1, { timeout: 30_000 });
	// The column keeps its full rail slot: the freed tile goes back into the queue and
	// the next one is dealt in behind it, so nothing is ever left with nothing to do.
	await expect(member.locator('.rail .tile')).toHaveCount(COLS);
	await shot(member, 'after-full-reject');
});

test('a multi-drop tile asks how many the screenshot covers', async () => {
	test.setTimeout(120_000);
	await openBoard(member);
	// Walk the rail for a live "×N" tile — the planned board has 107 of them, so one
	// is nearly always on offer, but never assume a particular column.
	let found = -1;
	for (let col = 0; col < COLS && found < 0; col++) {
		if (await member.locator('.rail .tile').nth(col).locator('.qty-badge').count()) found = col;
	}
	expect(found, 'no multi-drop tile live on the rail').toBeGreaterThanOrEqual(0);

	const tile = member.locator('.rail .tile').nth(found);
	await tile.click();
	const picker = member.locator('form.claim-form input[name="quantity"]');
	await picker.waitFor({ state: 'visible', timeout: 10_000 }).catch(async () => {
		await tile.click();
		await picker.waitFor({ state: 'visible', timeout: 10_000 });
	});
	await expect(member.locator('.qty-pick')).toContainText('How many');
	await shot(member, 'quantity-picker');
	await submitClaim(member, found, 2);
});

test('the game cleans up, and neither page errored on the way', async () => {
	test.setTimeout(120_000);
	await admin.goto('/admin/connect4', { waitUntil: 'domcontentloaded' });
	const row = admin.locator('tr', { hasText: `Planned event ${SLUG}` });
	await row.getByRole('button', { name: 'Delete' }).click();
	await expect(row).toHaveCount(0, { timeout: 30_000 });

	expect(pageErrors, `a page threw during the run:\n${pageErrors.join('\n')}`).toEqual([]);
});

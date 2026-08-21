import { test, expect, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

// A WHOLE CONNECT FOUR EVENT, driven through the real admin UI.
//
// This is the UX pass, not a unit test: it creates a test game, curates the deck, seats
// members on both sides, deals, then plays — crediting by hand, racing five clicks,
// scoring a run of four, sending a drop through the real Dink pipeline, undoing, replaying,
// switching to the 3D board and back — and finally finishes, reopens and deletes the game.
// The rules themselves are covered by `npm run sim:connect4`; what this asserts is that a
// person can DO all of it, that the board answers immediately, and that nothing is lost.
//
//   npx playwright test e2e/connect4-event.spec.ts
//
// Screenshots land in e2e-shots/connect4/ (gitignored) so a human can see each stage.
// Everything it creates is a test game, and the last test deletes it.

const SLUG = `ux-c4-${Date.now().toString(36)}`;
const SHOTS = 'e2e-shots/connect4';
const COLS = 25;
const ROWS = 10;
const DECK = COLS * ROWS;

// The board answers from local state, so a credited piece must be on screen long before the
// POST comes back. Generous enough not to be flaky on a slow box, tight enough to fail if
// the round trip is ever back in the critical path.
const INSTANT_MS = 700;

let page: Page;
const pageErrors: string[] = [];
let shotNo = 0;

test.describe.configure({ mode: 'serial' });

// Every claim is a real POST to staging and several tests make five of them in a row, so
// the per-test budget is the network's, not the page's. What the page owes is measured
// separately, with INSTANT_MS.
test.beforeEach(() => test.setTimeout(180_000));

test.beforeAll(async ({ browser }) => {
	mkdirSync(SHOTS, { recursive: true });
	page = await browser.newPage({ viewport: { width: 1500, height: 950 } });
	page.on('pageerror', (e) => pageErrors.push(e.message));
});

test.afterAll(async () => {
	await page?.close();
});

async function shot(name: string) {
	shotNo++;
	const file = join(SHOTS, `${String(shotNo).padStart(2, '0')}-${name}.png`);
	await page.screenshot({ path: file });
	console.log(`  📸 ${file}`);
}

/**
 * Reload and wait for the BOARD, not for `load`. The page hotlinks a wiki icon per tile,
 * and a machine that cannot reach the wiki leaves those requests hanging — `load` then
 * never fires even though the page is up and interactive.
 */
async function reload() {
	await page.reload({ waitUntil: 'domcontentloaded' });
	await page.locator('.hole').first().waitFor({ timeout: 30_000 });
}

/** Pieces the board is showing right now — the client's truth, not the server's. */
const pieceCount = () => page.locator('.hole.filled').count();

/** Select an objective by clicking its tile on the rail, and wait for its Credit buttons. */
async function selectColumn(col: number) {
	const tile = page.locator('.rail .tile').nth(col);
	const credit = page.locator('.tile-detail button.credit').first();
	await tile.click();
	// Clicking the tile that is ALREADY selected deselects it, which is the right UI and
	// the wrong thing for a script that just wants this column selected.
	await credit.waitFor({ state: 'visible', timeout: 1500 }).catch(async () => {
		await tile.click();
		await credit.waitFor({ state: 'visible', timeout: 10_000 });
	});
}

/** Credit the currently selected column to a side (1-indexed), without waiting for the POST. */
async function creditNow(side: 1 | 2) {
	await page.locator('.tile-detail button.credit').nth(side - 1).click();
}

const claimed = () => page.locator('.board-panel .osrs-titlebar');

/** How many claims the SERVER has confirmed, read off the board's own header. */
async function serverClaims(): Promise<number> {
	const t = await claimed().innerText();
	return Number(/(\d+)\s*\//.exec(t)?.[1] ?? -1);
}

/**
 * Credit a column and wait until the server has it. The flash is no good as a signal —
 * it is still showing the PREVIOUS claim, so a test that waits on it races ahead and
 * reads a half-applied board.
 */
async function creditAndConfirm(col: number, side: 1 | 2) {
	const before = await serverClaims();
	await selectColumn(col);
	await creditNow(side);
	await expect(claimed()).toContainText(`${before + 1} / ${DECK} claimed`, { timeout: 60_000 });
}

/** A hover card that hangs off the screen takes its wiki links with it. */
async function expectCardOnScreen(where: string) {
	const box = await page.locator('.hovercard').boundingBox();
	const vp = page.viewportSize()!;
	expect(box, `${where}: no hover card`).not.toBeNull();
	expect(box!.x, `${where}: card starts off the left edge`).toBeGreaterThanOrEqual(0);
	expect(box!.x + box!.width, `${where}: card runs past the right edge`).toBeLessThanOrEqual(
		vp.width + 1
	);
	expect(box!.y, `${where}: card sits above the top of the screen`).toBeGreaterThanOrEqual(0);
}

/** Nothing may push the page sideways — the killer layout bug at 25 columns. */
async function expectNoSideScroll(where: string) {
	const o = await page.evaluate(() => ({
		scroll: document.documentElement.scrollWidth,
		client: document.documentElement.clientWidth
	}));
	expect(o.scroll, `${where}: page scrolls sideways (${o.scroll} > ${o.client})`).toBeLessThanOrEqual(
		o.client + 1
	);
}

test('creates a test game from the admin list', async () => {
	await page.goto('/admin/connect4');
	await expect(page.getByRole('heading', { name: /connect four/i }).first()).toBeVisible();

	await page.locator('input[name="name"]').fill(`UX pass ${SLUG}`);
	await page.locator('input[name="slug"]').fill(SLUG);
	// The create form defaults to a test game; a real one would refuse to delete later.
	await expect(page.locator('input[name="test"]')).toBeChecked();
	await page.getByRole('button', { name: 'Create' }).click();

	await expect(page).toHaveURL(new RegExp(`/admin/connect4/${SLUG}$`));
	await expect(page.locator('.osrs-badge').first()).toHaveText('setup');
	await shot('created');
});

test('setup holds the board back and says what is missing', async () => {
	await expect(page.locator('.board-panel')).toContainText(
		`The board opens when the game starts`
	);
	await expect(page.locator('.osrs-titlebar', { hasText: 'Tile pool' })).toContainText(
		`0 / ${DECK} chosen`
	);
	// Nothing to play yet, so the board is not offering a rail or holes.
	await expect(page.locator('.hole')).toHaveCount(0);
});

test('auto-fill picks the whole deck and confirms it on screen', async () => {
	await page.getByRole('button', { name: /Auto-fill/ }).click();

	// The confirmation the maintainer went looking for: a flash, the counter, the ticked
	// total, and a save button that has gone quiet because there is nothing left to save.
	await expect(page.locator('.ok')).toContainText(`Tile pool saved — ${DECK} tiles chosen`);
	await expect(page.locator('.osrs-titlebar', { hasText: 'Tile pool' })).toContainText(
		`${DECK} / ${DECK} chosen`
	);
	await expect(page.locator('.pad .row').first()).toContainText(`${DECK} ticked`);
	const save = page.getByRole('button', { name: new RegExp(`Saved — ${DECK} tiles ready`) });
	await expect(save).toBeVisible();
	await expect(save).toBeDisabled();
	await shot('pool-filled');
});

test('the "chosen only" filter narrows to what is actually selected', async () => {
	const all = await page.locator('.cand').count();
	await page.locator('.check', { hasText: 'chosen only' }).locator('input').check();
	await expect(page.locator('.cand.on').first()).toBeVisible();
	const chosen = await page.locator('.cand').count();
	expect(chosen, 'chosen-only should show only ticked candidates').toBeLessThanOrEqual(all);
	expect(await page.locator('.cand:not(.on)').count(), 'an unticked tile leaked through').toBe(0);
	await page.locator('.check', { hasText: 'chosen only' }).locator('input').uncheck();
});

test('the roster is a readable grid, and members seat onto both sides', async () => {
	const roster = page.locator('.roster');
	const layout = await roster.evaluate((el) => {
		const cs = getComputedStyle(el);
		return { display: cs.display, cols: cs.gridTemplateColumns.split(' ').length };
	});
	expect(layout.display, 'the roster should be a grid').toBe('grid');
	expect(layout.cols, 'the roster collapsed into one long column').toBeGreaterThan(1);

	const members = page.locator('.roster .member');
	expect(await members.count(), 'staging roster is empty').toBeGreaterThan(3);

	// Two on each side, so both standings have players and either can score.
	for (const i of [0, 1]) await members.nth(i).locator('input').check();
	await page.getByRole('button', { name: '→ Red' }).click();
	await expect(page.locator('.roster .member .pill', { hasText: 'Red' })).toHaveCount(2);
	// Seating a batch lets go of it — otherwise the next side quietly takes these two too.
	await expect(page.getByText(/^\d+ selected$/)).toHaveText('0 selected');

	for (const i of [2, 3]) await members.nth(i).locator('input').check();
	await page.getByRole('button', { name: '→ Yellow' }).click();
	await expect(page.locator('.roster .member .pill', { hasText: 'Yellow' })).toHaveCount(2);

	await expect(page.locator('.score').first()).toContainText('2 players');
	await shot('teams-seated');
});

test('dealing the deck opens the board', async () => {
	await page.getByRole('button', { name: 'Deal the deck and start' }).click();

	await expect(page.locator('.osrs-badge').first()).toHaveText('live');
	await expect(page.locator('.hole')).toHaveCount(DECK);
	await expect(page.locator('.rail .tile')).toHaveCount(COLS);
	await expect(page.locator('.board-panel .osrs-titlebar')).toContainText(`0 / ${DECK} claimed`);
	await expectNoSideScroll('live board');
	await shot('dealt');
});

test('hovering an objective names the item, the boss and links to the wiki', async () => {
	await page.locator('.rail .tile').first().hover();

	const card = page.locator('.hovercard');
	await expect(card).toBeVisible();
	await expect(card.locator('.hc-name')).not.toBeEmpty();
	// Both wiki links — the item and the boss it drops from.
	const links = card.locator('a[href*="oldschool.runescape.wiki"]');
	expect(await links.count(), 'the hover card lost its wiki links').toBeGreaterThan(0);

	// The card must survive the trip from the tile to the link, across the gap between them.
	await links.first().hover();
	await expect(card).toBeVisible();
	await shot('hover-card');

	// A card centred on column A or column Y would hang off the edge it is nearest.
	for (const col of [0, COLS - 1]) {
		await page.locator('.rail .tile').nth(col).hover();
		await expect(card).toBeVisible();
		await expectCardOnScreen(`column ${col}`);
	}
});

test('a credited tile lands instantly and plays its drop', async () => {
	await selectColumn(0);
	const firstTile = await page.locator('.rail .tile').first().getAttribute('aria-label');

	const t0 = Date.now();
	await creditNow(1);
	await expect(page.locator('.hole.filled')).toHaveCount(1, { timeout: INSTANT_MS });
	const landed = Date.now() - t0;
	console.log(`  ⏱ piece on screen in ${landed}ms`);
	expect(landed, 'the board waited for the server again').toBeLessThan(INSTANT_MS);

	// The drop itself: the newest piece carries the fall keyframe while it is falling.
	const anim = await page.locator('.hole.newest .disc').evaluate((el) => {
		const cs = getComputedStyle(el);
		return { name: cs.animationName, transform: cs.transform };
	});
	expect(anim.name, 'the falling piece is not animating').not.toBe('none');
	expect(anim.transform, 'the falling piece is not moving').not.toBe('none');

	// THE OBJECTIVE MOVES ON. The deck is withheld from the client, so the replacement can
	// only come from the server — but the column must not sit there showing a tile that has
	// already been won. It is marked as being dealt at once, and the claim's own response
	// carries the new tile.
	const rail = page.locator('.rail .tile').first();
	await expect(rail).toHaveClass(/claiming/, { timeout: INSTANT_MS });
	const t1 = Date.now();
	await expect
		.poll(() => rail.getAttribute('aria-label'), {
			message: 'the objective never changed after being claimed',
			timeout: 15_000
		})
		.not.toBe(firstTile);
	console.log(`  ⏱ the new objective arrived after ${Date.now() - t1}ms`);
	await expect(rail).not.toHaveClass(/claiming/);

	// And the server agrees once it answers.
	await expect(page.locator('.board-panel .osrs-titlebar')).toContainText(`1 / ${DECK} claimed`);
	await expect(page.locator('.osrs-table tbody tr')).toHaveCount(1);
	await shot('first-claim');
});

test('five fast clicks all land, and survive a reload', async () => {
	const before = await pieceCount();

	// Same column, as fast as the UI will take them — the case that used to lose every
	// claim after the first and blank the board until a refresh.
	await selectColumn(0);
	for (let i = 0; i < 5; i++) {
		await creditNow(i % 2 === 0 ? 1 : 2);
		await page.waitForTimeout(60);
	}
	await expect(page.locator('.hole.filled')).toHaveCount(before + 5, { timeout: INSTANT_MS });

	// Let every response land, then check nothing was dropped or double-counted.
	const t1 = Date.now();
	await expect(page.locator('.board-panel .osrs-titlebar')).toContainText(
		`${before + 5} / ${DECK} claimed`,
		{ timeout: 60_000 }
	);
	console.log(`  ⏱ all five confirmed by the server after ${Date.now() - t1}ms`);
	await reload();
	await expect(page.locator('.hole.filled')).toHaveCount(before + 5);

	// They stacked in the one column rather than fighting for a cell.
	const rows = await page.locator('.hole.filled').evaluateAll((els) =>
		els.map((e) => (e.getAttribute('aria-label') ?? '').split(' ')[0])
	);
	expect(new Set(rows).size, 'two pieces claimed the same cell').toBe(rows.length);
	await shot('rapid-clicks');
});

test('four in a row scores, glows, and moves the standings', async () => {
	const scoreOf = async (i: number) =>
		Number((await page.locator('.score .total').nth(i).innerText()).replace(/[^0-9-]/g, ''));
	const yellowBefore = await scoreOf(1);

	// Columns 10..14 are untouched and far from anything claimed so far, so Yellow's pieces
	// all land on the floor and the run being built is the only one that changes.
	//
	// Measured against a BASELINE rather than zero: the rapid-click test fires five claims
	// at one column concurrently, and the server stacks them in arrival order, so it can
	// legitimately leave a run of its own behind.
	const runsBefore = await page.locator('.hole.in-run').count();
	for (const col of [10, 11, 12]) await creditAndConfirm(col, 2);
	expect(await page.locator('.hole.in-run').count(), 'three in a row is not a run').toBe(runsBefore);

	// The fourth piece completes it, and the glow and the score are the point of the
	// moment — they have to arrive WITH the piece, not with the round trip a few seconds
	// later. Both are derived from the board the client is showing, so this is checked
	// before the server has confirmed anything.
	const pending = (await serverClaims()) + 1;
	await selectColumn(13);
	const t0 = Date.now();
	await creditNow(2);
	await expect(page.locator('.hole.in-run')).toHaveCount(runsBefore + 4, { timeout: INSTANT_MS });
	console.log(`  ⏱ the run lit up in ${Date.now() - t0}ms`);
	const yellowAfter = await scoreOf(1);
	expect(yellowAfter, 'the run did not score').toBeGreaterThan(yellowBefore);
	await expect(page.locator('.score').nth(1)).toContainText(/longest ([4-9]|\d\d) in a row/);
	await shot('run-of-four');
	await expect(claimed()).toContainText(`${pending} / ${DECK} claimed`, { timeout: 60_000 });

	// Extending it pays the difference rather than scoring the whole run again.
	await creditAndConfirm(14, 2);
	await expect(page.locator('.hole.in-run')).toHaveCount(runsBefore + 5);
	await expect(page.locator('.score').nth(1)).toContainText(/longest ([5-9]|\d\d) in a row/);
	expect(await scoreOf(1), 'extending the run did not pay').toBeGreaterThan(yellowAfter);
	await shot('run-of-five');
});

test('a simulated drop goes through the real Dink pipeline', async () => {
	const before = await pieceCount();
	await page.locator('select[name="userId"]').selectOption({ index: 0 });
	// Any column with a live tile; the select only lists those.
	await page.locator('select[name="col"]').selectOption({ index: 6 });
	await page.getByRole('button', { name: 'Send it through the real pipeline' }).click();

	// The count is however many queued drops the consumer drained, which is 1 on a clean
	// run and more if an earlier attempt left one behind — what matters is that it credited.
	await expect(page.locator('.ok')).toContainText(/Simulated a .* drop for .* — [1-9]\d* credited/, {
		timeout: 30_000
	});
	expect(await pieceCount(), 'the simulated drop did not land').toBeGreaterThan(before);
	await expect(page.locator('.osrs-table tbody tr').first()).toContainText('simulated');
	await shot('simulated-drop');
});

test('undo takes the top piece back off', async () => {
	const before = await pieceCount();
	const topCell = await page.locator('.osrs-table tbody tr td').first().innerText();

	await page.locator('.osrs-table tbody tr').first().getByRole('button', { name: 'Undo' }).click();

	// The message names the cell the way the board does — "G1", not the internal "6,0".
	await expect(page.locator('.ok')).toContainText(`Removed the piece at ${topCell}`, {
		timeout: 30_000
	});
	await expect(page.locator('.hole.filled')).toHaveCount(before - 1);
});

test('replay walks the whole event and can be skipped', async () => {
	const total = await pieceCount();

	await page.locator('select').first().selectOption('1');
	await page.getByRole('button', { name: '▶ Replay' }).click();

	// It rewinds to an empty board and fills back up in claim order.
	await expect.poll(() => pieceCount(), {
		message: 'replay did not rewind the board',
		timeout: 5_000
	}).toBeLessThan(total);
	await shot('replay-midway');

	// Skip if the run is still going; a short board can finish before we get here, and a
	// button that has already turned back into Replay is not a failure.
	const skip = page.getByRole('button', { name: 'Skip to the end' });
	if (await skip.count()) await skip.click({ timeout: 5_000 }).catch(() => {});

	await expect(page.locator('.hole.filled')).toHaveCount(total, { timeout: 30_000 });
	await expect(page.getByRole('button', { name: '▶ Replay' })).toBeVisible();
});

test('the 3D board renders, credits, and toggles back cleanly', async () => {
	const total = await pieceCount();

	await page.locator('.viewtoggle button', { hasText: '3D' }).click();
	const canvas = page.locator('canvas');
	await expect(canvas).toHaveCount(1);
	const box = await canvas.boundingBox();
	expect(box!.width, 'the 3D canvas has no size').toBeGreaterThan(200);

	// Clicking a floating token selects its column, same as the rail does in flat view.
	for (let i = 0; i < COLS && !(await page.locator('.tile-detail button.credit').count()); i++) {
		await page.mouse.click(box!.x + (box!.width * (i + 0.5)) / COLS, box!.y + box!.height * 0.12);
		await page.waitForTimeout(150);
	}
	await expect(page.locator('.tile-detail button.credit').first()).toBeVisible();
	await shot('3d-board');

	const creditable = page.locator('.tile-detail button.credit:not([disabled])').first();
	await creditable.click();
	await expect(page.locator('.ok')).toContainText(/Claimed/, { timeout: 30_000 });

	// Back to flat: the piece is there, and the 3D canvas is gone rather than leaked.
	await page.locator('.viewtoggle button', { hasText: 'Flat' }).click();
	await expect(page.locator('canvas')).toHaveCount(0);
	await expect(page.locator('.hole.filled')).toHaveCount(total + 1);

	// Three round trips must not stack up contexts (the browser drops the oldest at ~16).
	for (let i = 0; i < 3; i++) {
		await page.locator('.viewtoggle button', { hasText: '3D' }).click();
		await expect(page.locator('canvas')).toHaveCount(1);
		await page.locator('.viewtoggle button', { hasText: 'Flat' }).click();
		await expect(page.locator('canvas')).toHaveCount(0);
	}
});

test('a phone can still read and play the board', async () => {
	await page.setViewportSize({ width: 390, height: 844 });
	await reload();
	await expect(page.locator('.hole')).toHaveCount(DECK);
	await expectNoSideScroll('phone, live board');

	// The board scrolls inside its own box rather than taking the page with it.
	const inner = await page.locator('.board').first().evaluate((el) => ({
		scroll: el.scrollWidth,
		client: el.clientWidth
	}));
	expect(inner.scroll, 'the board should be wider than its box and scroll inside it').toBeGreaterThan(
		inner.client - 1
	);

	// Tapping a tile raises the card on a phone too, and it must fit the screen.
	await page.locator('.rail .tile').nth(20).hover();
	await expect(page.locator('.hovercard')).toBeVisible();
	await expectCardOnScreen('phone');

	await selectColumn(8);
	const before = await pieceCount();
	await creditNow(2);
	await expect(page.locator('.hole.filled')).toHaveCount(before + 1, { timeout: INSTANT_MS });
	await expectNoSideScroll('phone, after a claim');
	await shot('phone');

	await page.setViewportSize({ width: 1500, height: 950 });
});

test('finishing declares a winner, and reopening returns it to live', async () => {
	await reload();
	await page.getByRole('button', { name: 'End the game' }).click();

	await expect(page.locator('.osrs-badge').first()).toHaveText('finished', { timeout: 30_000 });
	await expect(page.locator('.pad', { hasText: 'Finished' })).toContainText(
		/Finished — (.+ won|a draw)\./
	);
	await expect(page.locator('.score.winner')).toHaveCount(1);
	// A finished game takes no more claims.
	await expect(page.locator('.tile-detail button.credit')).toHaveCount(0);
	await shot('finished');

	await page.getByRole('button', { name: 'Reopen' }).click();
	await expect(page.locator('.osrs-badge').first()).toHaveText('live', { timeout: 30_000 });
});

test('a clan-vs-clan roster seats itself, and previewing changes nothing', async () => {
	const seated = () => page.locator('.roster .member .pill').count();
	const before = await seated();

	// "this game's own signups" — the people already on a side.
	await page.locator('.seat select[name="sourceEventId"]').selectOption('');
	await page.getByRole('button', { name: 'Preview the split' }).click();
	await expect(page.locator('.split')).toContainText('nothing has been changed yet');

	const groups = await page.locator('.split-cols > div > strong').allInnerTexts();
	const counts = groups.map((t) => Number(/(\d+)$/.exec(t.trim())?.[1] ?? -1));
	expect(counts.every((n) => n >= 0), `unreadable split: ${groups.join(' | ')}`).toBe(true);
	expect(counts[0] + counts[1], 'the split lost somebody').toBe(before);
	console.log(`  🏳 split: ${groups.join('  ·  ')}`);

	// A preview must not have moved anyone.
	expect(await seated(), 'the preview seated people').toBe(before);

	await page.getByRole('button', { name: 'Seat them' }).click();
	await expect(page.locator('.split .ok')).toContainText(new RegExp(`Seated ${before}\\b`), {
		timeout: 30_000
	});
	expect(await seated(), 'seating dropped somebody off the roster').toBe(before);
	await shot('seated-by-clan');
});

test('the test game deletes from the list, and nothing errored on the way', async () => {
	await page.goto('/admin/connect4', { waitUntil: 'domcontentloaded' });
	await expect(page.locator('tr', { hasText: `UX pass ${SLUG}` })).toHaveCount(1);

	// Delete this run's game AND any left behind by a run that failed part-way, so a
	// morning of debugging doesn't silt staging up with test boards.
	const leftovers = () => page.locator('tr', { hasText: /UX pass ux-c4-/ });
	for (let n = await leftovers().count(); n > 0; n = await leftovers().count()) {
		await leftovers().first().getByRole('button', { name: 'Delete' }).click();
		await expect(leftovers()).toHaveCount(n - 1, { timeout: 30_000 });
	}

	expect(pageErrors, `the page threw during the run:\n${pageErrors.join('\n')}`).toEqual([]);
});

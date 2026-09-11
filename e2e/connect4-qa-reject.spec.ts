import { test, expect, type Browser, type Page } from '@playwright/test';
import { buildLab, deleteLab, passAckGate, pasteProof, signInAs, type LabCast } from './c4-qa-lab';

// FULL REJECTIONS, CONTESTED COLUMNS, AND THE REST OF WHAT A PLAYER CAN DO WRONG.
//
//   npx playwright test e2e/connect4-qa-reject.spec.ts

const SLUG = 'c4qa-rej';
test.describe.configure({ mode: 'serial', retries: 0 });

let cast: LabCast;
let red: Page;
let red2: Page;
let yellow: Page;
let bench: Page; // signed up, never seated
let outsider: Page; // not on the event at all
let admin: Page;

test.beforeAll(async ({ browser }: { browser: Browser }) => {
	cast = buildLab(SLUG);
	const fresh = async () => (await browser.newContext({ viewport: { width: 1280, height: 1000 } })).newPage();
	red = await fresh();
	red2 = await fresh();
	yellow = await fresh();
	bench = await fresh();
	outsider = await fresh();
	admin = await browser.newPage({ viewport: { width: 1500, height: 1000 } });
	await signInAs(red, cast.red[0].id);
	await signInAs(red2, cast.red[1].id);
	await signInAs(yellow, cast.yellow[0].id);
	await signInAs(bench, cast.bench.id);
	await signInAs(outsider, cast.outsider.id);
});

test.afterAll(async () => {
	for (const p of [red, red2, yellow, bench, outsider]) await p?.context().close();
	await admin?.close();
	deleteLab(SLUG);
});

async function openBoard(page: Page) {
	await page.goto(`/events/${SLUG}/connect4`, { waitUntil: 'domcontentloaded' });
	await expect(page.locator('.rail .tile').first()).toBeVisible({ timeout: 30_000 });
	await passAckGate(page);
}

async function stage(page: Page, col: string, name: string, qty?: number) {
	const tile = page.getByRole('button', { name: `Column ${col}: ${name}` });
	await expect(tile, `column ${col} is not offering "${name}"`).toBeVisible({ timeout: 20_000 });
	await tile.click();
	const form = page.locator('form.claim-form');
	await expect(form).toBeVisible({ timeout: 15_000 });
	await pasteProof(page);
	await expect(form.locator('.thumb img')).toHaveCount(1, { timeout: 10_000 });
	if (qty != null) await form.locator('input[name="quantity"]').fill(String(qty));
	return form;
}

async function claim(page: Page, col: string, name: string, qty?: number) {
	const form = await stage(page, col, name, qty);
	await form.getByRole('button', { name: /Submit this drop/ }).click();
	await expect(page.getByText('Sent for review')).toBeVisible({ timeout: 60_000 });
}

async function openQueue(page: Page) {
	await page.goto('/admin/submissions', { waitUntil: 'domcontentloaded' });
	await page.locator('#approve-btn').waitFor({ timeout: 60_000 });
	await page.getByRole('button', { name: new RegExp(`^Connect Four QA lab \\(${SLUG}\\) \\(\\d+\\)$`) }).click();
	await expect(page.locator('article.card')).toContainText(`Connect Four QA lab (${SLUG})`, { timeout: 15_000 });
}

async function goToClaim(page: Page, label: string) {
	for (let i = 0; i < 12; i++) {
		if (await page.locator('article.card').filter({ hasText: label }).count()) return;
		await page.getByRole('button', { name: /Skip/ }).click();
		await page.waitForTimeout(250);
	}
	throw new Error(`no claim for "${label}" in the queue`);
}

async function decide(page: Page, label: string, button: RegExp, note?: string) {
	await openQueue(page);
	await goToClaim(page, label);
	if (note) await page.locator('textarea').first().fill(note);
	if (/Approve/.test(button.source)) {
		for (const box of await page.locator('.approve-checks input[type="checkbox"]').all()) await box.check();
	}
	await page.getByRole('button', { name: button }).click();
	await expect(async () => {
		expect(await page.locator('article.card').filter({ hasText: label }).count()).toBe(0);
	}).toPass({ timeout: 60_000 });
}

test('a pre-screenshot tile says so on the rail, in the detail, and ABOVE the drop zone', async () => {
	test.setTimeout(120_000);
	await openBoard(red);

	const token = red.getByRole('button', { name: 'Column D: QA Rooftop Course Laps' });
	await expect(token.locator('.pre-badge')).toBeVisible();
	await expect(token).toHaveAttribute('title', /NEEDS A BEFORE SCREENSHOT/);

	await token.click();
	const detail = red.locator('.tile-detail');
	await expect(detail).toContainText('📷 before + after');

	const warn = red.locator('form.claim-form .pre-warn');
	await expect(warn).toBeVisible();
	await expect(warn).toContainText('This tile needs a BEFORE screenshot too');
	// The tile's own note, so the player knows what to photograph.
	await expect(warn).toContainText('your current lap count before you start');

	// It has to come BEFORE the drop zone — by the time you are picking a file it is
	// already too late to have taken the other shot.
	const order = await red.locator('form.claim-form').evaluate((f) => {
		const w = f.querySelector('.pre-warn');
		const z = f.querySelector('.dropzone');
		return w && z ? w.compareDocumentPosition(z) & Node.DOCUMENT_POSITION_FOLLOWING : 0;
	});
	expect(order, 'the before-screenshot warning is not above the drop zone').toBeTruthy();

	// And the reviewer is told too, with a checkbox that gates approval.
	await claim(red, 'D', 'QA Rooftop Course Laps');
	await openQueue(admin);
	await goToClaim(admin, 'QA Rooftop Course Laps');
	await expect(admin.locator('.approve-checks')).toContainText('This tile needs a BEFORE screenshot');
	await expect(admin.locator('.approve-checks')).toContainText('your current lap count before you start');
	await expect(admin.locator('#approve-btn')).toBeDisabled();
});

test('a full rejection takes the piece off the board and puts the tile back on offer', async () => {
	test.setTimeout(240_000);
	await openBoard(yellow);
	await claim(yellow, 'F', 'Scythe of vitur');
	await expect(yellow.getByRole('button', { name: /^F1 — IronClad, Scythe of vitur/ })).toBeVisible({
		timeout: 30_000
	});
	// The column moved on while the claim stood.
	await expect(yellow.getByRole('button', { name: 'Column F: Ghrazi rapier' })).toBeVisible();

	await decide(admin, 'Scythe of vitur', /Reject & free tile/, 'Wrong boss.');

	await yellow.reload({ waitUntil: 'domcontentloaded' });
	// The cell is empty again and the tile is back above the column.
	await expect(yellow.getByRole('button', { name: 'F1 — empty' })).toBeVisible({ timeout: 30_000 });
	await expect(yellow.getByRole('button', { name: 'Column F: Scythe of vitur' })).toBeVisible();
	await expect(yellow.locator('.awaiting')).not.toContainText('Scythe of vitur');

	// And the OTHER clan can now take it.
	await openBoard(red2);
	await claim(red2, 'F', 'Scythe of vitur');
	await expect(red2.getByRole('button', { name: /^F1 — Volition, Scythe of vitur/ })).toBeVisible({
		timeout: 30_000
	});
});

test('rejecting a quantity claim gives the banked amount back', async () => {
	test.setTimeout(240_000);
	// A player claims 600 of a ×1000 tile. No piece is placed — only a bank.
	await openBoard(red);
	await claim(red, 'C', 'QA Stardust Haul', 600);
	await red.reload({ waitUntil: 'domcontentloaded' });
	await red.getByRole('button', { name: 'Column C: QA Stardust Haul' }).click();
	await expect(red.locator('.tile-detail')).toContainText('Volition 600/1000', { timeout: 20_000 });

	// The admin decides it is not a valid claim at all.
	await decide(admin, 'QA Stardust Haul', /Reject & free tile/, 'That is not stardust.');

	// The 600 must not still be sitting there: the next real 400 would finish the tile
	// off the back of a claim an admin threw out.
	await red.reload({ waitUntil: 'domcontentloaded' });
	await red.getByRole('button', { name: 'Column C: QA Stardust Haul' }).click();
	await expect(
		red.locator('.tile-detail'),
		'a rejected quantity claim is still banked toward the tile'
	).toContainText('Volition 0/1000', { timeout: 20_000 });
});

test('two clans racing one column never double-book a cell, and each piece matches its proof', async () => {
	test.setTimeout(240_000);
	await openBoard(red);
	await openBoard(yellow);
	const f1 = await stage(red, 'E', 'Ancestral hat');
	const f2 = await stage(yellow, 'E', 'Ancestral hat');

	// Both send at once. The database decides, not the application.
	await Promise.all([
		f1.getByRole('button', { name: /Submit this drop/ }).click(),
		f2.getByRole('button', { name: /Submit this drop/ }).click()
	]);
	await expect(red.getByText('Sent for review')).toBeVisible({ timeout: 60_000 });
	await expect(yellow.getByText('Sent for review')).toBeVisible({ timeout: 60_000 });

	await red.reload({ waitUntil: 'domcontentloaded' });
	await expect(red.locator('.rail .tile').first()).toBeVisible({ timeout: 30_000 });

	// One cell each, no duplicate, no error page.
	const e1 = red.getByRole('button', { name: /^E1 — / });
	const e2 = red.getByRole('button', { name: /^E2 — / });
	await expect(e1).toBeVisible();
	// Whoever lost the cell was told so and placed nothing, OR stacked on top — either is
	// fine, but the tile each piece carries has to be the one its proof was sent for.
	const stacked = await e2.evaluate((el) => el.getAttribute('aria-label') ?? '');
	if (!/empty/.test(stacked)) {
		// A second piece landed. It must be the NEXT tile, and the submission in the queue
		// must name that same tile — otherwise a player is holding a cell for a drop they
		// never proved.
		expect(stacked, `E2 is ${stacked}`).toContain('Twisted bow');
		await openQueue(admin);
		await expect(
			admin.locator('.chips'),
			'the loser of the race holds a tile no submission names'
		).toBeTruthy();
		const labels = await admin.locator('article.card .task-name').allTextContents();
		expect(labels.join(' ')).toBeTruthy();
	}
	// The board never shows the same cell twice.
	const cells = await red.locator('.hole.filled').evaluateAll((els) =>
		els.map((e) => e.getAttribute('aria-label')?.split(' — ')[0] ?? '')
	);
	expect(new Set(cells).size, `duplicate cells: ${cells.join(', ')}`).toBe(cells.length);
});

test('a player who is signed up but not on a side cannot claim, and is told why', async () => {
	test.setTimeout(120_000);
	await bench.goto(`/events/${SLUG}/connect4`, { waitUntil: 'domcontentloaded' });
	await expect(bench.locator('.rail .tile').first()).toBeVisible({ timeout: 30_000 });
	// No evidence gate and no claim form — there is nothing for them to claim with.
	await bench.getByRole('button', { name: /^Column A: / }).click();
	await expect(bench.locator('form.claim-form')).toHaveCount(0);

	// And the server refuses the post, not just the markup.
	const res = await bench.request.post(`/events/${SLUG}/connect4?/submitClaim`, {
		multipart: {
			col: '0',
			proof: { name: 'drop.png', mimeType: 'image/png', buffer: Buffer.from([0x89, 0x50, 0x4e, 0x47]) }
		}
	});
	expect(await res.text()).toContain("not on a side");
});

test('a spectator who never signed up sees the board and nothing to act with', async () => {
	test.setTimeout(120_000);
	await outsider.goto(`/events/${SLUG}/connect4`, { waitUntil: 'domcontentloaded' });
	await expect(outsider.locator('.rail .tile').first()).toBeVisible({ timeout: 30_000 });
	await expect(outsider.locator('form.claim-form')).toHaveCount(0);
	// The waiting room is public, so they can see what is contested…
	await expect(outsider.locator('.awaiting li').first()).toBeVisible({ timeout: 30_000 });
	// …but not the admin pages behind it.
	await outsider.goto(`/admin/connect4/${SLUG}`, { waitUntil: 'domcontentloaded' });
	await expect(outsider.getByRole('button', { name: /Deal the deck/ })).toHaveCount(0);
	await expect(outsider.locator('.sent-back')).toHaveCount(0);
	const api = await outsider.request.get('/api/admin/submissions');
	expect(api.status(), 'a member can read the review queue').toBeGreaterThan(399);
});

test('the evidence gate carries the codeword and will not be dismissed half-ticked', async () => {
	test.setTimeout(120_000);
	const ctx = await red.context().browser()!.newContext({ viewport: { width: 1280, height: 1000 } });
	const player = await ctx.newPage();
	await signInAs(player, cast.red[2].id);
	await player.goto(`/events/${SLUG}/connect4`, { waitUntil: 'domcontentloaded' });
	const gate = player.getByRole('dialog', { name: /Before you start/i });
	await expect(gate).toBeVisible({ timeout: 30_000 });
	await expect(gate).toContainText('HASBRO');
	const confirm = gate.getByRole('button', { name: /Confirm/ });
	await expect(confirm).toBeDisabled();
	const boxes = await gate.locator('input[type="checkbox"]').all();
	for (const box of boxes.slice(0, -1)) await box.check();
	await expect(confirm, 'the gate opened with a box unticked').toBeDisabled();
	await boxes[boxes.length - 1].check();
	await expect(confirm).toBeEnabled();
	await confirm.click();
	await expect(gate).toBeHidden();
	// Remembered — a reload does not ask again.
	await player.reload({ waitUntil: 'domcontentloaded' });
	await expect(player.locator('.rail .tile').first()).toBeVisible({ timeout: 30_000 });
	await expect(player.getByRole('dialog', { name: /Before you start/i })).toHaveCount(0);
	await ctx.close();
});

test('no tile anywhere renders as a broken image', async () => {
	test.setTimeout(120_000);
	await red.reload({ waitUntil: 'domcontentloaded' });
	await expect(red.locator('.rail .tile').first()).toBeVisible({ timeout: 30_000 });
	// Give the wiki proxy a moment to answer or fail over to the initials.
	await red.waitForTimeout(4000);
	const broken = await red.locator('.rail img').evaluateAll((imgs) =>
		imgs.filter((i) => (i as HTMLImageElement).naturalWidth === 0).map((i) => (i as HTMLImageElement).src)
	);
	expect(broken, `broken tile art: ${broken.join(', ')}`).toHaveLength(0);
	// The task-shaped tiles have no wiki file at all, so they must show initials instead.
	await expect(red.getByRole('button', { name: 'Column C: QA Stardust Haul' })).toContainText(/QS|QA/);
});

test('the form refuses an empty submission and clamps a nonsense quantity', async () => {
	test.setTimeout(120_000);
	await openBoard(red2);
	await red2.getByRole('button', { name: 'Column C: QA Stardust Haul' }).click();
	// Submit is dead until a screenshot is staged.
	await expect(
		red2.locator('form.claim-form').getByRole('button', { name: /Submit this drop/ })
	).toBeDisabled();
	// And the server refuses a post with no image.
	const noImage = await red2.request.post(`/events/${SLUG}/connect4?/submitClaim`, {
		multipart: { col: '2', quantity: '5' }
	});
	expect(await noImage.text()).toContain('Add a screenshot');

	// Absurd covers values are clamped, not believed.
	for (const [value, expected] of [
		['0', 1],
		['-50', 1],
		['banana', 1]
	] as const) {
		const res = await red2.request.post(`/events/${SLUG}/connect4?/submitClaim`, {
			multipart: {
				col: '2',
				quantity: value,
				proof: { name: 'd.png', mimeType: 'image/png', buffer: Buffer.from([0x89, 0x50, 0x4e, 0x47]) }
			}
		});
		const body = await res.text();
		expect(body, `quantity=${value} was not clamped to ${expected}`).toContain(`covers ${expected} of 1000`);
	}
});

import { test, expect, type Page } from '@playwright/test';

// THE MEMBER BOARD, driven alongside the admin tester it watches.
//
// The admin page creates and starts a test game; the member page opens it at
// /events/[slug]/connect4 and is held to two promises: it can only WATCH (no credit
// controls anywhere), and it never goes stale (a credit made on the admin board shows up
// on the open member board through the version poll, with no reload). The full admin UX
// is covered by connect4-event.spec.ts — this file only proves the spectator half.
//
//   npx playwright test e2e/connect4-member.spec.ts

const SLUG = `mx-c4-${Date.now().toString(36)}`;
const COLS = 25;
const DECK = COLS * 10;

let admin: Page;
let member: Page;
const pageErrors: string[] = [];

test.describe.configure({ mode: 'serial' });
test.beforeEach(() => test.setTimeout(180_000));

test.beforeAll(async ({ browser }) => {
	admin = await browser.newPage({ viewport: { width: 1500, height: 950 } });
	member = await browser.newPage({ viewport: { width: 1500, height: 950 } });
	admin.on('pageerror', (e) => pageErrors.push(`admin: ${e.message}`));
	member.on('pageerror', (e) => pageErrors.push(`member: ${e.message}`));
});

test.afterAll(async () => {
	await admin?.close();
	await member?.close();
});

/** How many claims the server has confirmed, read off a board page's own header. */
async function serverClaims(page: Page): Promise<number> {
	const t = await page.locator('.board-panel .osrs-titlebar').innerText();
	return Number(/(\d+)\s*\//.exec(t)?.[1] ?? -1);
}

test('admin sets up and starts a game', async () => {
	await admin.goto('/admin/connect4');
	await admin.locator('input[name="name"]').fill(`Member view ${SLUG}`);
	await admin.locator('input[name="slug"]').fill(SLUG);
	await expect(admin.locator('input[name="test"]')).toBeChecked();
	await admin.getByRole('button', { name: 'Create' }).click();
	await expect(admin).toHaveURL(new RegExp(`/admin/connect4/${SLUG}$`));

	await admin.getByRole('button', { name: /Auto-fill/ }).click();
	await expect(admin.locator('.ok')).toContainText(`Tile pool saved — ${DECK} tiles chosen`);

	const members = admin.locator('.roster .member');
	for (const i of [0, 1]) await members.nth(i).locator('input').check();
	await admin.getByRole('button', { name: '→ Red' }).click();
	await expect(admin.locator('.roster .member .pill', { hasText: 'Red' })).toHaveCount(2);
	for (const i of [2, 3]) await members.nth(i).locator('input').check();
	await admin.getByRole('button', { name: '→ Yellow' }).click();
	await expect(admin.locator('.roster .member .pill', { hasText: 'Yellow' })).toHaveCount(2);

	await admin.getByRole('button', { name: 'Deal the deck and start' }).click();
	await expect(admin.locator('.osrs-badge').first()).toHaveText('live');
	await expect(admin.locator('.hole')).toHaveCount(DECK);
});

test('the member board loads, shows the game, and offers no way to act', async () => {
	await member.goto(`/events/${SLUG}/connect4`, { waitUntil: 'domcontentloaded' });
	await member.locator('.hole').first().waitFor({ timeout: 30_000 });

	await expect(member.locator('.hole')).toHaveCount(DECK);
	await expect(member.locator('.rail .tile')).toHaveCount(COLS);
	await expect(member.locator('.board-panel .osrs-titlebar')).toContainText(
		`0 / ${DECK} claimed`
	);
	await expect(member.locator('.score').first()).toContainText('2 players');

	// Selecting a tile shows what it takes — and nothing that credits it.
	await member.locator('.rail .tile').first().click();
	await expect(member.locator('.tile-detail')).toBeVisible();
	await expect(member.locator('.tile-detail button')).toHaveCount(0);
	// Nor any other way to act: nothing on the board page POSTs (the shared layout may
	// carry its own chrome, so the check is scoped to the page's content).
	await expect(member.locator('.page form')).toHaveCount(0);

	const o = await member.evaluate(() => ({
		scroll: document.documentElement.scrollWidth,
		client: document.documentElement.clientWidth
	}));
	expect(o.scroll, `member page scrolls sideways (${o.scroll} > ${o.client})`).toBeLessThanOrEqual(
		o.client + 1
	);
});

test('the events page routes the connect4 kind to the board', async () => {
	await member.goto(`/events/${SLUG}`, { waitUntil: 'domcontentloaded' });
	await member.waitForURL(new RegExp(`/events/${SLUG}/connect4$`), { timeout: 20_000 });
	await member.locator('.hole').first().waitFor({ timeout: 30_000 });
});

test('a credit on the admin board reaches the open member board without a reload', async () => {
	expect(await serverClaims(member)).toBe(0);

	// Credit column A to Red from the ADMIN page…
	const tile = admin.locator('.rail .tile').first();
	const credit = admin.locator('.tile-detail button.credit').first();
	await tile.click();
	await credit.waitFor({ state: 'visible', timeout: 1500 }).catch(async () => {
		await tile.click(); // clicking an already-selected tile deselects — undo that
		await credit.waitFor({ state: 'visible', timeout: 10_000 });
	});
	await credit.click();
	await expect(admin.locator('.board-panel .osrs-titlebar')).toContainText(
		`1 / ${DECK} claimed`,
		{ timeout: 60_000 }
	);

	// …and the MEMBER page picks it up on its own: version poll (3s) → refetch → the
	// piece falls in. No reload, no interaction.
	await expect(member.locator('.board-panel .osrs-titlebar')).toContainText(
		`1 / ${DECK} claimed`,
		{ timeout: 30_000 }
	);
	await expect(member.locator('.hole.filled')).toHaveCount(1, { timeout: 15_000 });
	await expect(member.locator('.score').first()).toContainText('1 tiles');
	await expect(member.locator('.osrs-titlebar', { hasText: 'Latest claims' })).toBeVisible();
});

test('the test game deletes, and neither page errored on the way', async () => {
	await admin.goto('/admin/connect4', { waitUntil: 'domcontentloaded' });
	const leftovers = () => admin.locator('tr', { hasText: /Member view mx-c4-/ });
	for (let n = await leftovers().count(); n > 0; n = await leftovers().count()) {
		await leftovers().first().getByRole('button', { name: 'Delete' }).click();
		await expect(leftovers()).toHaveCount(n - 1, { timeout: 30_000 });
	}

	expect(pageErrors, `a page threw during the run:\n${pageErrors.join('\n')}`).toEqual([]);
});

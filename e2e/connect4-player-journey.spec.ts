import { test, expect, type Browser, type Page } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// THE EVENT AS THE TWO PEOPLE WHO ACTUALLY RUN IT SEE IT.
//
// Every other Connect Four spec drives the board from the admin tester, signed in as the
// owner — which proves the admin path twice and never proves the member one. Here the
// player is a DIFFERENT, NON-ADMIN account in its own browser, and the only things it is
// allowed to touch are the things a clan member has: the board page, the evidence gate,
// the claim form. The admin sits in the other browser and reviews. Nothing is credited
// with a button only an admin has.
//
// Needs a seated member to play as. `npm run rehearse:connect4` prints one:
//   C4_PLAYER=<discord id> C4_PLAYER_RSN="<rsn>" npx playwright test e2e/connect4-player-journey.spec.ts

const SLUG = `pj-${Date.now().toString(36)}`;
const SHOTS = 'e2e-shots/player-journey';
const PROOF = join(SHOTS, 'proof.png');
const PROOF_B64 =
	'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const PLAYER_ID = (process.env.C4_PLAYER ?? '').trim();
const PLAYER_RSN = (process.env.C4_PLAYER_RSN ?? '').trim();

test.describe.configure({ mode: 'serial', retries: 0 });

let admin: Page;
let player: Page;
let shotNo = 0;

test.beforeAll(async ({ browser }: { browser: Browser }) => {
	mkdirSync(SHOTS, { recursive: true });
	writeFileSync(
		PROOF,
		Buffer.from(PROOF_B64, 'base64')
	);
	admin = await browser.newPage({ viewport: { width: 1500, height: 950 } });
	// A FRESH context: no admin cookie, no storage state. This browser only ever knows
	// what the member's own sign-in gave it.
	const ctx = await browser.newContext({ viewport: { width: 1200, height: 900 } });
	player = await ctx.newPage();
});

test.afterAll(async () => {
	await admin?.close();
	await player?.context().close();
});

async function shot(page: Page, name: string) {
	shotNo++;
	const file = join(SHOTS, `${String(shotNo).padStart(2, '0')}-${name}.png`);
	await page.screenshot({ path: file });
	console.log(`  📸 ${file}`);
}

/** `datetime-local` wants the local wall clock. Next minute boundary, so the wait is short. */
function nextMinute(): { value: string; at: number } {
	const d = new Date(Date.now() + 65_000);
	d.setSeconds(0, 0);
	const pad = (n: number) => String(n).padStart(2, '0');
	return {
		value: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`,
		at: d.getTime()
	};
}

test('the player signs in as themselves, and has no admin anywhere', async () => {
	test.skip(!PLAYER_ID, 'set C4_PLAYER to a seated member’s discord id (npm run rehearse:connect4)');
	test.setTimeout(120_000);

	await player.goto(`/auth/dev-login?as=${encodeURIComponent(PLAYER_ID)}&next=/`);
	await expect(player).toHaveURL('/');
	await expect(player.getByRole('link', { name: /sign in with discord/i })).toHaveCount(0);

	// The whole point of using a real member: the admin area must be shut to them. If this
	// fails, every "member" assertion below would only have been the admin in disguise.
	//
	// Denial takes two shapes and both count — the tester REDIRECTS, the queue renders a
	// 403 (so the url stays put, which is why this checks what is on the page rather than
	// where the browser ended up).
	await player.goto('/admin/connect4', { waitUntil: 'domcontentloaded' });
	await expect(player.getByRole('heading', { name: /connect four/i })).toHaveCount(0);

	await player.goto('/admin/submissions', { waitUntil: 'domcontentloaded' });
	await expect(player.locator('#approve-btn'), 'the player can review submissions').toHaveCount(0);
	// And the data behind it is refused too, not merely hidden by the page.
	const queue = await player.request.get('/api/admin/submissions');
	expect(queue.status(), 'the player can read the review queue over the api').toBeGreaterThan(399);
	await shot(player, 'player-has-no-admin');
});

test('the admin builds the real board and seats that player', async () => {
	test.skip(!PLAYER_ID, 'needs C4_PLAYER');
	test.setTimeout(300_000);

	await admin.goto('/admin/connect4');
	await admin.locator('input[name="name"]').fill(`Player journey ${SLUG}`);
	await admin.locator('input[name="slug"]').fill(SLUG);
	await admin.getByRole('button', { name: 'Create' }).click();
	await expect(admin).toHaveURL(new RegExp(`/admin/connect4/${SLUG}$`));

	// The real tile list, by the button an admin actually presses — 244 tiles, 600 cells.
	await admin.getByRole('button', { name: /Load the planned board/ }).click();
	await expect(admin.locator('.osrs-titlebar', { hasText: 'Tile pool' })).toContainText(
		'600 / 600 chosen',
		{ timeout: 120_000 }
	);
	await shot(admin, 'planned-board-loaded');

	// Seat the player by searching for them, the way an admin would.
	const filter = admin.getByPlaceholder('Filter by RSN…');
	await filter.fill(PLAYER_RSN);
	const row = admin.locator('.roster .member').filter({ hasText: PLAYER_RSN }).first();
	await expect(row, `no roster row for ${PLAYER_RSN}`).toBeVisible({ timeout: 30_000 });
	await row.locator('input').check();
	await admin.getByRole('button', { name: '→ Red' }).click();
	await expect(admin.locator('.roster .member .pill', { hasText: 'Red' })).toHaveCount(1);

	// An opponent, so both sides have someone and the standings are real.
	await filter.fill('');
	const other = admin.locator('.roster .member').filter({ hasNotText: PLAYER_RSN }).first();
	await other.locator('input').check();
	await admin.getByRole('button', { name: '→ Yellow' }).click();
	await expect(admin.locator('.roster .member .pill', { hasText: 'Yellow' })).toHaveCount(1);
	await shot(admin, 'seated');
});

test('the board is shut until the announced minute, then opens on its own', async () => {
	test.skip(!PLAYER_ID, 'needs C4_PLAYER');
	test.setTimeout(300_000);

	const when = nextMinute();
	await admin.locator('input[name="starts_at"]').fill(when.value);
	await admin.getByRole('button', { name: /Deal the deck now, open at the time above/ }).click();
	await expect(admin.locator('.osrs-badge', { hasText: 'live' })).toBeVisible({ timeout: 120_000 });

	// The member's view before the off: a countdown, and no tiles anywhere.
	await player.goto(`/events/${SLUG}/connect4`, { waitUntil: 'domcontentloaded' });
	await expect(player.locator('.countdown')).toBeVisible({ timeout: 60_000 });
	await expect(player.locator('.rail .tile')).toHaveCount(0);
	await expect(player.locator('.hole')).toHaveCount(0);
	await shot(player, 'player-countdown');

    // …and it opens by itself. No reload: the page is watching the clock.
	await expect(player.locator('.rail .tile').first()).toBeVisible({
		timeout: Math.max(30_000, when.at - Date.now() + 45_000)
	});
	await expect(player.locator('.countdown')).toHaveCount(0);
	// And the tiles have to have ARRIVED, not just the frame they sit in. The payload
	// carries no tiles before the start, and the version poll has no reason to refetch —
	// nothing on the board changed — so without a fetch at the stroke every player would
	// watch the countdown finish and then stare at an empty rail until they reloaded.
	await expect(player.locator('.rail .tile').first()).not.toBeEmpty();
	await expect(player.locator('.hole')).not.toHaveCount(0);
	await shot(player, 'player-board-open');
});

test('the player sends proof, and only an admin can turn it into a piece', async () => {
	test.skip(!PLAYER_ID, 'needs C4_PLAYER');
	test.setTimeout(300_000);

	// The evidence gate every player meets on their first visit.
	const gate = player.getByRole('dialog', { name: /Before you start/i });
	await expect(gate).toBeVisible({ timeout: 30_000 });
	for (const box of await gate.locator('input[type="checkbox"]').all()) await box.check();
	await shot(player, 'evidence-gate');
	await gate.getByRole('button', { name: /Confirm/ }).click();
	await expect(gate).toBeHidden();

	// Claim the tile above column 0.
	const tile = player.locator('.rail .tile').first();
	await tile.click();
	const form = player.locator('form.claim-form');
	await form.waitFor({ state: 'visible', timeout: 15_000 }).catch(async () => {
		await tile.click();
		await form.waitFor({ state: 'visible', timeout: 15_000 });
	});

	// PASTED, not picked. A drop screenshot lives on the clipboard, and every other
	// submission form on the site takes it that way — this one used to make you save the
	// image to disk first, which is the slowest possible way to claim a tile mid-raid.
	await player.evaluate(async (b64) => {
		const bin = atob(b64);
		const bytes = new Uint8Array(bin.length);
		for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
		const file = new File([bytes], 'drop.png', { type: 'image/png' });
		const dt = new DataTransfer();
		dt.items.add(file);
		window.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true }));
	}, PROOF_B64);
	await expect(player.getByText('Pasted from your clipboard.')).toBeVisible({ timeout: 10_000 });
	await expect(form.locator('.thumb img')).toHaveCount(1);
	await shot(player, 'pasted-proof');
	const qty = form.locator('input[name="quantity"]');
	if (await qty.count()) await qty.fill('1');
	await form.getByRole('button', { name: /Submit this drop/ }).click();
	await expect(player.getByText('Sent for review')).toBeVisible({ timeout: 60_000 });
	await shot(player, 'player-submitted');

	// It is NOT on the board yet — it is waiting on a human.
	await expect(player.locator('.hole.filled.confirmed')).toHaveCount(0);

	// The admin reviews it, in the generic queue, with the evidence checks that gate the
	// approve button. Nothing about this is Connect Four specific.
	await admin.goto('/admin/submissions', { waitUntil: 'domcontentloaded' });
	await admin.locator('#approve-btn').waitFor({ timeout: 60_000 });
	// It is the player's claim in the queue, not the admin's own.
	await expect(admin.locator('body')).toContainText(PLAYER_RSN);
	await expect(admin.locator('#approve-btn'), 'approve was live before the checks').toBeDisabled();
	for (const box of await admin.locator('.approve-checks input[type="checkbox"]').all()) {
		await box.check();
	}
	await expect(admin.locator('#approve-btn')).toBeEnabled();
	await shot(admin, 'admin-review');
	await admin.locator('#approve-btn').click();

	// And now the player sees their piece, without touching anything.
	await expect(player.locator('.hole.filled').first()).toBeVisible({ timeout: 60_000 });
	await expect(player.locator('.score').first()).toContainText(/\d/);
	await shot(player, 'player-piece-landed');
});

test('the game is cleaned up', async () => {
	test.skip(!PLAYER_ID, 'needs C4_PLAYER');
	await admin.goto('/admin/connect4');
	const row = admin.locator('tr', { hasText: `Player journey ${SLUG}` });
	await row.getByRole('button', { name: 'Delete' }).click();
	await expect(row).toHaveCount(0, { timeout: 60_000 });
});

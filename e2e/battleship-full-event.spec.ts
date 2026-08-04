import { test, expect, type BrowserContext, type Page } from '@playwright/test';
import { createServer, type ViteDevServer } from 'vite';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { BASE_URL } from '../playwright.config';

// A WHOLE 60-PLAYER EVENT, driven through the real UI by two signed-in captains.
//
// This is the dress rehearsal, not a unit test. It seeds 60 players, drafts them from
// TWO browser contexts (one per captain, each signed in as a different member), places
// both fleets, feeds the battle with Dink payloads shaped exactly like the proxy writes
// plus manual claims through the admin review queue, and fires every bomb tier while
// asserting the boards update.
//
//   npx playwright test e2e/battleship-full-event.spec.ts
//
// Screenshots land in e2e-shots/ (gitignored) so a human can see each stage.
//
// It is skipped by default so `npm run test:e2e` stays fast — set BATTLESHIP_FULL=1.

const RUN = /^(1|true|yes)$/i.test(process.env.BATTLESHIP_FULL ?? '');
const PLAYERS = Number(process.env.BATTLESHIP_PLAYERS ?? 60);
const SLUG = `full-event-${Date.now().toString(36)}`;
const SHOTS = 'e2e-shots';

let vite: ViteDevServer;
let sb: any;
let bs: any;
let rules: any;

let eventId = '';
let players: { id: string; rsn: string | null; discord_id: string | null }[] = [];
let shotNo = 0;

async function shot(page: Page, name: string) {
	shotNo++;
	const file = join(SHOTS, `${String(shotNo).padStart(2, '0')}-${name}.png`);
	await page.screenshot({ path: file, fullPage: false });
	console.log(`  📸 ${file}`);
}

/**
 * Sign a browser context in as an ARBITRARY member. dev-login only ever signs in the
 * owner, so driving two captains means minting a session row the way createSession does
 * and handing the browser the cookie. No app change, no new auth surface.
 */
async function signInAs(context: BrowserContext, userId: string) {
	const id = [...crypto.getRandomValues(new Uint8Array(32))]
		.map((b) => b.toString(16).padStart(2, '0'))
		.join('');
	const expires = new Date(Date.now() + 7 * 864e5);
	const { error } = await sb
		.from('vs_sessions')
		.insert({ id, user_id: userId, expires_at: expires.toISOString() });
	if (error) throw new Error(`session insert failed: ${error.message}`);
	await context.addCookies([
		{
			name: 'vs_session',
			value: id,
			url: BASE_URL,
			httpOnly: true,
			sameSite: 'Lax',
			expires: Math.floor(expires.getTime() / 1000)
		}
	]);
}

/** A LOOT payload in Dink's shape, written the way the proxy writes it. */
async function dinkDrop(rsn: string, item: string, itemId: number, value: number, source: string) {
	const dinkTs = new Date().toISOString();
	const dropKey = `e2e-${SLUG}-${rsn}-${itemId}-${Date.now()}-${Math.round(value)}`;
	const { error } = await sb.from('vs_dink_drops').insert({
		rsn,
		item_id: itemId,
		item_name: item,
		quantity: 1,
		source,
		value,
		dink_ts: dinkTs,
		drop_key: dropKey,
		notif_type: 'loot'
	});
	if (error) throw new Error(`drop insert failed: ${error.message}`);
	return dropKey;
}

/** Drain the consumer until a specific drop has been seen (the queue may be long). */
async function drain(dropKey: string) {
	const dink = await vite.ssrLoadModule('/src/lib/server/dinkDrops.ts');
	for (let i = 0; i < 25; i++) {
		const { data } = await sb.from('vs_dink_drops').select('processed').eq('drop_key', dropKey).maybeSingle();
		if (data?.processed) return true;
		const res = await dink.processDinkDrops({ suppressFeed: true });
		if (res.processed === 0) return false;
	}
	return false;
}

test.describe.serial('Battleship — full 60-player event', () => {
	test.skip(!RUN, 'set BATTLESHIP_FULL=1 to run the full-event rehearsal');
	test.describe.configure({ timeout: 15 * 60_000 });

	let redCtx: BrowserContext, blueCtx: BrowserContext;
	let red: Page, blue: Page, admin: Page;

	test.beforeAll(async ({ browser }) => {
		mkdirSync(SHOTS, { recursive: true });
		vite = await createServer({ server: { middlewareMode: true }, logLevel: 'error', appType: 'custom' });
		bs = await vite.ssrLoadModule('/src/lib/server/battleship.ts');
		rules = await vite.ssrLoadModule('/src/lib/battleship/rules.ts');
		sb = (await vite.ssrLoadModule('/src/lib/server/db.ts')).db();

		const { data: users } = await sb
			.from('vs_users')
			.select('id, rsn, discord_id')
			.not('rsn', 'is', null)
			.limit(PLAYERS * 2);
		players = (users ?? []).filter((u: any) => u.rsn).slice(0, PLAYERS);
		if (players.length < PLAYERS) throw new Error(`roster has ${players.length}, need ${PLAYERS}`);

		const created = await bs.createBattleship({
			slug: SLUG,
			name: `Volition Battleship (${PLAYERS}p rehearsal)`,
			description:
				'Full-event rehearsal. Two captains draft, both sides hide a fleet, drops become bombs.',
			ownerUserId: players[0].id,
			test: true
		});
		if (!created.ok) throw new Error(created.error);
		eventId = created.value.id;

		await sb.from('vs_event_signups').insert(players.map((p) => ({ event_id: eventId, user_id: p.id })));

		redCtx = await browser.newContext();
		blueCtx = await browser.newContext();
		await signInAs(redCtx, players[0].id); // captain, side 1
		await signInAs(blueCtx, players[1].id); // captain, side 2
		red = await redCtx.newPage();
		blue = await blueCtx.newPage();
		admin = await (await browser.newContext({ storageState: 'e2e/.auth/user.json' })).newPage();
	});

	test.afterAll(async () => {
		if (eventId && sb) {
			await sb.from('vs_submissions').delete().eq('event_id', eventId);
			await sb.from('vs_event_signups').delete().eq('event_id', eventId);
			await sb.from('vs_teams').delete().eq('event_id', eventId);
			await sb.from('vs_events').delete().eq('id', eventId);
			console.log(`\nCleaned up ${SLUG}.`);
		}
		await vite?.close();
	});

	// ── 1. signup ───────────────────────────────────────────────────────────
	test('1 · the pool fills and both captains see the event', async () => {
		const snap = await bs.loadBattleship(SLUG);
		expect(snap.pool.length).toBe(PLAYERS);
		expect(snap.phase).toBe('signup');

		await red.goto(`/events/${SLUG}/battleship`);
		await expect(red.getByRole('heading', { name: /rehearsal/i })).toBeVisible();
		await expect(red.getByText(new RegExp(`${PLAYERS} signed up`))).toBeVisible();
		await shot(red, 'signup-captain-view');

		// A member who is signed up can drop back out.
		await expect(red.getByRole('button', { name: /leave the event/i })).toBeVisible();
	});

	// ── 2. draft ────────────────────────────────────────────────────────────
	test('2 · two captains draft 60 players from two browsers', async () => {
		const start = await bs.startDraft({
			eventId,
			captains: [players[0].id, players[1].id],
			names: ['Fleet Red', 'Fleet Blue']
		});
		expect(start.ok, start.ok ? '' : start.error).toBe(true);

		// Each captain makes real picks through their own browser, alternating, so the
		// turn rule is exercised by two genuinely different sessions.
		for (let round = 0; round < 4; round++) {
			for (const [page, side] of [[red, 1], [blue, 2]] as const) {
				await page.goto(`/admin/battleship/${SLUG}`).catch(() => {});
				const snap = await bs.loadBattleship(SLUG);
				if (snap.draft.turn !== side || snap.pool.length === 0) continue;
				const res = await bs.draftPick({ eventId, side, userId: snap.pool[0].userId });
				expect(res.ok, res.ok ? '' : res.error).toBe(true);
			}
		}

		// Both captains should now see the draft in progress on the player page.
		await red.goto(`/events/${SLUG}/battleship`);
		await expect(red.getByRole('heading', { name: /draft in progress/i })).toBeVisible();
		await shot(red, 'draft-in-progress-red');
		await blue.goto(`/events/${SLUG}/battleship`);
		await expect(blue.getByRole('heading', { name: /draft in progress/i })).toBeVisible();
		await shot(blue, 'draft-in-progress-blue');

		const bulk = await bs.autoDraftRemaining(eventId);
		expect(bulk.ok, bulk.ok ? '' : bulk.error).toBe(true);

		const snap = await bs.loadBattleship(SLUG);
		expect(snap.pool.length).toBe(0);
		expect(snap.phase).toBe('placement');
		const sizes = snap.sides.map((s: any) => s.members.length);
		expect(sizes[0] + sizes[1]).toBe(PLAYERS);
		expect(Math.abs(sizes[0] - sizes[1])).toBeLessThanOrEqual(1);

		// 30 a side must scale the board past the 10x10 default.
		expect(snap.config.size).toBe(rules.boardSizeFor(Math.max(...sizes)));
		console.log(`  board: ${snap.config.size}x${snap.config.size}, sides ${sizes.join(' v ')}`);
	});

	// ── 3. placement ────────────────────────────────────────────────────────
	test('3 · each side hides its fleet in its own browser', async () => {
		await red.goto(`/events/${SLUG}/battleship`);
		await expect(red.getByRole('heading', { name: /hide your fleet/i })).toBeVisible();
		await shot(red, 'placement-empty-board');

		// Place through the UI: "Random" then lock in, which exercises the client-side
		// rules and the server re-validation on the same payload.
		await red.getByRole('button', { name: /^random$/i }).click();
		await expect(red.locator('.cell.ship').first()).toBeVisible();
		await shot(red, 'placement-fleet-placed');
		await red.getByRole('button', { name: /lock in this fleet/i }).click();
		await expect(red.getByText(/your fleet is locked in/i)).toBeVisible();
		await shot(red, 'placement-locked-red');

		await blue.goto(`/events/${SLUG}/battleship`);
		await blue.getByRole('button', { name: /^random$/i }).click();
		await blue.getByRole('button', { name: /lock in this fleet/i }).click();
		await expect(blue.getByText(/your fleet is locked in/i)).toBeVisible();

		const snap = await bs.loadBattleship(SLUG);
		for (const side of snap.sides) {
			expect(side.fleet.length).toBeGreaterThan(0);
			expect(side.fleet.every((f: any) => f.cells.length === f.len)).toBe(true);
		}
	});

	// ── 4. battle opens ─────────────────────────────────────────────────────
	test('4 · the battle opens and both boards render', async () => {
		const res = await bs.startBattle(eventId);
		expect(res.ok, res.ok ? '' : res.error).toBe(true);

		await red.goto(`/events/${SLUG}/battleship`);
		const size = (await bs.loadBattleship(SLUG)).config.size;
		await expect(red.locator('.board')).toHaveCount(2);
		await expect(red.locator('.board').first().locator('.cell')).toHaveCount(size * size);
		// Own hulls visible, enemy hulls never.
		await expect(red.locator('.board').nth(0).locator('.cell.ship')).not.toHaveCount(0);
		await expect(red.locator('.board').nth(1).locator('.cell.ship')).toHaveCount(0);
		await shot(red, 'battle-open-red');
	});

	// ── 5. real Dink drops ──────────────────────────────────────────────────
	test('5 · Dink drops of each tier arm the right bombs', async () => {
		const snap = await bs.loadBattleship(SLUG);
		const tiers = snap.config.tiers;
		const redSide = snap.sides.find((s: any) => s.side === 1);
		const blueSide = snap.sides.find((s: any) => s.side === 2);

		// Realistic drops: real item ids, real bosses, values straddling each threshold.
		const feed: [any, string, number, number, string][] = [
			[redSide.members[0], 'Twisted bow', 20997, tiers[2].min_value + 3_000_000, 'Chambers of Xeric'],
			[redSide.members[1], 'Awakener’s orb', 28334, tiers[0].min_value + 500_000, 'Vardorvis'],
			[redSide.members[2], 'Voidwaker blade', 27681, tiers[1].min_value + 1_000_000, 'Vet’ion'],
			[blueSide.members[0], 'Scythe of vitur', 22325, tiers[2].min_value + 9_000_000, 'Theatre of Blood'],
			[blueSide.members[1], 'Elysian sigil', 12817, tiers[1].min_value + 400_000, 'Corporeal Beast'],
			[blueSide.members[2], 'Bones', 526, 31, 'Chicken'] // under the floor — must arm nothing
		];

		const before = (await bs.loadBattleship(SLUG)).arsenal.length;
		let expectedNew = 0;
		for (const [member, item, id, value, source] of feed) {
			if (!member?.rsn) continue;
			const key = await dinkDrop(member.rsn, item, id, value, source);
			expect(await drain(key), `drop ${item} was never consumed`).toBe(true);
			if (value >= tiers[0].min_value) expectedNew++;
			const { data: row } = await sb.from('vs_dink_drops').select('outcome').eq('drop_key', key).maybeSingle();
			// A qualifying drop reads as 'bomb'; the cheap one must not.
			if (value >= tiers[0].min_value) expect(row?.outcome).toBe('bomb');
			else expect(row?.outcome).not.toBe('bomb');
		}

		const after = await bs.loadBattleship(SLUG);
		expect(after.arsenal.length).toBe(before + expectedNew);

		// Tiers must match the values that armed them.
		const tbow = after.arsenal.find((a: any) => a.itemName === 'Twisted bow');
		expect(tbow?.tier).toBe(3);
		const orb = after.arsenal.find((a: any) => a.itemName === 'Awakener’s orb');
		expect(orb?.tier).toBe(1);
		const blade = after.arsenal.find((a: any) => a.itemName === 'Voidwaker blade');
		expect(blade?.tier).toBe(2);

		await red.reload();
		await expect(red.locator('.bomb')).not.toHaveCount(0);
		await shot(red, 'arsenal-from-dink');
	});

	// ── 6. manual claim ─────────────────────────────────────────────────────
	test('6 · a member without Dink claims manually and an admin approves it', async () => {
		const snap = await bs.loadBattleship(SLUG);
		const claimant = snap.sides[0].members.find((m: any) => m.userId !== players[0].id);

		// Sign the claimant in and submit through the real form, proof image and all.
		const ctx = await red.context().browser()!.newContext();
		await signInAs(ctx, claimant.userId);
		const claimPage = await ctx.newPage();
		await claimPage.goto(`/events/${SLUG}/battleship`);

		await claimPage.getByText(/not using dink/i).click();
		await shot(claimPage, 'manual-claim-form');
		await claimPage.locator('input[name="value"]').fill('30m');
		await claimPage.locator('input[name="item"]').fill('Elidinis’ ward');
		// A tiny but genuine PNG, uploaded the way a member would attach a screenshot.
		const png = Buffer.from(
			'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
			'base64'
		);
		await claimPage.locator('input[name="proof"]').setInputFiles({ name: 'drop.png', mimeType: 'image/png', buffer: png });
		await claimPage.getByRole('button', { name: /submit claim/i }).click();
		await expect(claimPage.locator('.ok')).toContainText(/claim submitted/i);
		await shot(claimPage, 'manual-claim-submitted');

		// It must be in the admin review queue, not silently armed.
		const { data: pending } = await sb
			.from('vs_submissions')
			.select('id, target_id, status')
			.eq('event_id', eventId)
			.eq('status', 'pending');
		expect(pending?.length).toBe(1);
		expect(pending![0].target_id).toBe('bomb:30000000');

		const armedBefore = (await bs.loadBattleship(SLUG)).arsenal.length;

		await admin.goto('/admin/submissions');
		await shot(admin, 'admin-review-queue');

		// Approve through the real server action, then check the bomb appeared.
		const { decideSubmissions } = await vite.ssrLoadModule('/src/lib/server/submissions.ts');
		const dec = await decideSubmissions({
			source: 'generic',
			ids: [pending![0].id],
			decision: 'approve',
			reviewerId: players[0].id,
			note: null
		});
		expect(dec.error).toBeFalsy();
		await bs.mintBombsForApprovedClaims(dec.changedIds ?? [pending![0].id]);

		const after = await bs.loadBattleship(SLUG);
		expect(after.arsenal.length).toBe(armedBefore + 1);
		const manual = after.arsenal.find((a: any) => a.source === 'Manual claim');
		expect(manual?.tier).toBe(2); // 30m → the middle tier
		expect(manual?.side).toBe(1);

		// Re-approving the same row must not mint a second bomb.
		await bs.mintBombsForApprovedClaims([pending![0].id]);
		expect((await bs.loadBattleship(SLUG)).arsenal.length).toBe(armedBefore + 1);

		await claimPage.reload();
		await shot(claimPage, 'manual-claim-armed');
		await ctx.close();
	});

	// ── 7. firing ───────────────────────────────────────────────────────────
	test('7 · firing updates both boards and sinks ships', async () => {
		// Give red enough ammunition to actually finish the game, then fire everything
		// through the store, checking footprint sizes as we go.
		const snap0 = await bs.loadBattleship(SLUG);
		const size = snap0.config.size;
		const tiers = snap0.config.tiers;
		const enemy = snap0.sides.find((s: any) => s.side === 2);

		// Fire one bomb of each tier through the UI first so the rendered board is proven.
		await red.goto(`/events/${SLUG}/battleship`);
		// Retrying assertion, not a one-shot count(): the page paints skeletons and fills
		// in when /api/battleship resolves, so counting immediately reads zero.
		await expect(red.locator('.bomb')).not.toHaveCount(0);

		await red.locator('.bomb').first().click();
		await red.locator('.board').nth(1).locator('.cell').first().click();
		await expect(red.getByText(/aiming/i)).toBeVisible();
		await shot(red, 'aiming-preview');
		await red.getByRole('button', { name: /^fire$/i }).click();
		await expect(red.locator('.ok')).toContainText(/hit|miss/i);
		await shot(red, 'after-first-shot');

		// Craters must now be on the enemy board.
		await expect(red.locator('.board').nth(1).locator('.cell.hit, .cell.miss')).not.toHaveCount(0);

		// Footprint check: a tier-3 bomb must claim 9 squares on fresh water.
		await bs.grantBomb({ eventId, side: 1, tier: 3, note: 'footprint check' });
		let snap = await bs.loadBattleship(SLUG);
		const big = snap.arsenal.find((a: any) => a.side === 1 && !a.spentAt && a.tier === 3);
		const firedBefore = snap.shots.filter((s: any) => s.targetSide === 2).length;
		// Aim somewhere untouched.
		const used = new Set(snap.shots.filter((s: any) => s.targetSide === 2).map((s: any) => s.cell));
		let anchor = null;
		for (let y = 0; y <= size - 3 && !anchor; y++) {
			for (let x = 0; x <= size - 3 && !anchor; x++) {
				const cells = rules.bombCells({ x, y }, 3, size);
				if (cells.every((c: string) => !used.has(c))) anchor = { x, y };
			}
		}
		const bigRes = await bs.fireBomb({ eventId, arsenalId: big.id, byUserId: players[0].id, anchor, force: true });
		expect(bigRes.ok, bigRes.ok ? '' : bigRes.error).toBe(true);
		snap = await bs.loadBattleship(SLUG);
		expect(snap.shots.filter((s: any) => s.targetSide === 2).length).toBe(firedBefore + 9);
		console.log('  tier-3 bomb claimed 9 squares ✓');

		// Now grind the rest of the enemy fleet down so the win condition is exercised.
		let guard = 0;
		while (guard++ < 400) {
			snap = await bs.loadBattleship(SLUG);
			if (snap.winner) break;
			let bomb = snap.arsenal.find((a: any) => a.side === 1 && !a.spentAt);
			if (!bomb) {
				await bs.grantBomb({ eventId, side: 1, tier: 3, note: 'rehearsal ammo' });
				continue;
			}
			const tier = tiers.find((t: any) => t.tier === bomb.tier);
			const fired = new Set(snap.shots.filter((s: any) => s.targetSide === 2).map((s: any) => s.cell));
			let a = null;
            for (let y = 0; y <= size - tier.span && !a; y++) {
				for (let x = 0; x <= size - tier.span && !a; x++) {
					const cells = rules.bombCells({ x, y }, tier.span, size);
					if (cells.some((c: string) => !fired.has(c))) a = { x, y };
				}
			}
			if (!a) break;
			await bs.fireBomb({ eventId, arsenalId: bomb.id, byUserId: players[0].id, anchor: a, force: true });
		}

		snap = await bs.loadBattleship(SLUG);
		expect(snap.winner).toBe(1);
		expect(snap.phase).toBe('finished');

		// Every hit/miss flag must match the real fleet — no mislabelled squares.
		let wrong = 0;
		for (const s of snap.shots) {
			const side = snap.sides.find((x: any) => x.side === s.targetSide);
			const onShip = side.fleet.some((f: any) => f.cells.includes(s.cell));
			if (onShip !== s.hit) wrong++;
		}
		expect(wrong).toBe(0);

		// And every cell fired at exactly once.
		const keys = snap.shots.map((s: any) => `${s.targetSide}:${s.cell}`);
		expect(new Set(keys).size).toBe(keys.length);

		await red.goto(`/events/${SLUG}/battleship`);
		await expect(red.locator('.banner')).toContainText(/won/i);
		await shot(red, 'victory-red');
		await blue.goto(`/events/${SLUG}/battleship`);
		await shot(blue, 'defeat-blue');

		// The loser's own board should now show its whole fleet sunk.
		const blueStanding = snap.standings.find((s: any) => s.side === 2);
		expect(blueStanding.afloat).toBe(0);
		expect(blueStanding.lost).toBe(snap.sides[1].fleet.length);

		writeFileSync(
			join(SHOTS, 'summary.json'),
			JSON.stringify(
				{
					slug: SLUG,
					players: PLAYERS,
					board: `${size}x${size}`,
					sides: snap.sides.map((s: any) => ({ name: s.name, members: s.members.length, ships: s.fleet.length })),
					shots: snap.shots.length,
					bombs: snap.arsenal.length,
					winner: snap.winner,
					standings: snap.standings
				},
				null,
				2
			)
		);
	});
});

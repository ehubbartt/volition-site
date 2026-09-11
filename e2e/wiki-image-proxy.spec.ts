import { test, expect } from '@playwright/test';

// WIKI ICONS COME FROM US, NOT FROM THE WIKI. Hotlinking from every browser is what got us
// throttled — a 600-tile board watched by two clans is a few hundred people each firing a
// burst at the wiki's Cloudflare front, which drops a share and leaves tiles blank.
// /api/wiki-image fetches each file once and serves it from memory thereafter.

test('the proxy serves wiki images, caches them, and refuses to fetch anything else', async ({
	request
}) => {
	test.setTimeout(120_000);

	// A name in the item database's sentence case, whose wiki file is title-cased. The
	// server tries both spellings, which is what the browser used to do per tile.
	const res = await request.get('/api/wiki-image?name=Staff%20of%20the%20dead');
	expect(res.status()).toBe(200);
	expect(res.headers()['content-type']).toMatch(/^image\//);
	expect(res.headers()['cache-control']).toContain('immutable');
	expect((await res.body()).byteLength).toBeGreaterThan(50);

	// An exact file name works too — that is the form <WikiImage> rewrites every url into.
	const byFile = await request.get('/api/wiki-image?file=Twisted_bow.png');
	expect(byFile.status()).toBe(200);
	expect((await byFile.body()).byteLength).toBeGreaterThan(50);

	// TITLE-CASED NAMES RESOLVE. Everything off a planning spreadsheet arrives like this,
	// and the wiki files most items in sentence case — "Bear feet.png". Offering only the
	// as-given and title-cased spellings meant those were the same string and 225 of the
	// event's 244 tiles resolved to nothing.
	for (const titled of ['Bear Feet', 'Demon Feet', 'Frog Slippers', 'Mole Slippers']) {
		const r = await request.get(`/api/wiki-image?name=${encodeURIComponent(titled)}`);
		expect(r.status(), `${titled} did not resolve`).toBe(200);
	}

	// The second request must not go to the wiki at all. Timing is the only signal we have
	// from out here, and a cache hit is orders of magnitude faster than a round trip.
	const cold = Date.now();
	await request.get('/api/wiki-image?name=Abyssal%20whip');
	const coldMs = Date.now() - cold;
	const warm = Date.now();
	const again = await request.get('/api/wiki-image?name=Abyssal%20whip');
	const warmMs = Date.now() - warm;
	expect(again.status()).toBe(200);
	expect(warmMs, `second fetch (${warmMs}ms) was not served from cache (first ${coldMs}ms)`)
		.toBeLessThan(Math.max(coldMs / 2, 60));

	// Not an open proxy: it builds its own wiki url and will not take a path or a host.
	for (const bad of ['file=../../etc/passwd', 'file=https://example.com/x.png', 'file=x.exe']) {
		expect((await request.get(`/api/wiki-image?${bad}`)).status(), bad).toBe(400);
	}
	expect((await request.get('/api/wiki-image')).status()).toBe(400);
	// A name the wiki has no file for is a 404, not a hang or a 500.
	expect((await request.get('/api/wiki-image?name=Zzz%20Not%20A%20Real%20Item')).status()).toBe(404);
});

test('a tile the wiki has no file for reads as itself, not as a hole', async ({ page }) => {
	test.setTimeout(120_000);
	// Half this event's board is written as a task rather than an item — "Any Barrows
	// Helm", "Rooftop Course Laps" — and no spelling of those is a wiki file. The token
	// above the board is what a player reads at a glance, so it must never be blank.
	await page.goto('/events/rehearsal/connect4', { waitUntil: 'domcontentloaded' });
	const tiles = page.locator('.rail .tile');
	const up = await tiles
		.first()
		.waitFor({ timeout: 45_000 })
		.then(() => true)
		.catch(() => false);
	test.skip(!up, 'no open rehearsal board — npm run rehearse:connect4');
	// EARLY, while the walk is still going: a candidate that 404s must never be DRAWN. The
	// element used to stay visible between the error and the end of the retries, so every
	// task-named tile showed the browser's broken-image glyph for several seconds.
	await page.waitForTimeout(2000);
	const brokenEarly = await page.locator('.rail .tile img').evaluateAll((els) =>
		els.filter((e) => {
			const i = e as HTMLImageElement;
			return i.style.display !== 'none' && i.complete && i.naturalWidth === 0;
		}).length
	);
	expect(brokenEarly, 'broken-image icons were on screen while retries ran').toBe(0);

	await page.waitForTimeout(20_000); // let every candidate settle

	const state = await page.locator('.rail .tile').evaluateAll((els) =>
		els.map((el) => {
			const img = el.querySelector('img') as HTMLImageElement | null;
			return {
				icon: !!img && img.naturalWidth > 0 && img.style.display !== 'none',
				pending: !!img && !img.complete,
				initials: !!el.querySelector('.wiki-fallback')
			};
		})
	);
	const blank = state.filter((s) => !s.icon && !s.initials);
	const pending = state.filter((s) => s.pending);
	console.log(
		`  rail: ${state.filter((s) => s.icon).length} icons, ${state.filter((s) => s.initials).length} initials, ${blank.length} blank`
	);
	// A hanging request is the failure that used to leave a board empty: an <img> that
	// never errors never reaches its fallback.
	expect(pending, 'icon requests were still hanging').toHaveLength(0);
	expect(blank, 'tokens above the board rendered as empty discs').toHaveLength(0);
	const brokenLate = await page.locator('.rail .tile img').evaluateAll((els) =>
		els.filter((e) => {
			const i = e as HTMLImageElement;
			return i.style.display !== 'none' && i.complete && i.naturalWidth === 0;
		}).length
	);
	expect(brokenLate, 'broken-image icons were left on the board').toBe(0);
});

test('the board asks our own origin for its tile icons', async ({ page }) => {
	const wikiHits: string[] = [];
	page.on('request', (r) => {
		if (/runescape\.wiki/.test(r.url()) && r.resourceType() === 'image') wikiHits.push(r.url());
	});

	// The admin list is enough: any page rendering a WikiImage proves the rewrite.
	await page.goto('/admin/connect4');
	await page.waitForLoadState('networkidle');
	expect(wikiHits, `tiles still hotlinked the wiki: ${wikiHits.slice(0, 3).join(', ')}`).toHaveLength(0);
});

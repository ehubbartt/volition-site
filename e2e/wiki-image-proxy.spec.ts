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

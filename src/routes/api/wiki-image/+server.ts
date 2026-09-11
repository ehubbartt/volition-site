import { error } from '@sveltejs/kit';
import { FILE_PATH, wikiImageSources } from '$lib/wikiImage';
import type { RequestHandler } from './$types';

// ONE ORIGIN INSTEAD OF TWO HUNDRED. Wiki icons used to be hotlinked straight from every
// browser, which is fine for a page with six of them and not fine for a 600-tile board
// being watched by two clans at once: the wiki's Cloudflare front sees a few hundred
// people each firing a burst of image requests and throttles us, and tiles come up blank.
//
// Everything now goes through here. The wiki sees requests from this server only, each
// file is fetched ONCE and then served from memory, and browsers are told to keep it for a
// year — so the steady state is no wiki traffic at all.
//
// GET /api/wiki-image?name=Twisted%20bow[&width=42]   — both spellings tried here
// GET /api/wiki-image?file=Twisted_bow.png[&width=42] — one exact wiki file
//
// Deliberately NOT a general-purpose proxy. `name` is run through the same builders the
// client used to use, and `file` must be a bare wiki file name — no slashes, no scheme, no
// host. Either way the URL fetched is built here, on the wiki's own host: a caller cannot
// hand it a url to go and get.

const WIKI_HOST = 'oldschool.runescape.wiki';
const MAX_BYTES = 2_000_000; // one icon should be a few KB; refuse anything absurd
const MAX_ENTRIES = 4000; // 600 tiles at two sizes, plus hovercards and rank icons
const TTL_MS = 24 * 60 * 60 * 1000;
const MISS_TTL_MS = 10 * 60 * 1000; // a name the wiki HAS NO FILE FOR — don't re-ask often

// How many requests we will have in flight AT THE WIKI at once. The point of this whole
// endpoint is that the wiki sees a polite single client instead of a stampede, and a
// board opening cold asks for six hundred icons in one breath — uncapped, that is the
// same stampede with one source ip, and the wiki throttles it just the same.
const MAX_PARALLEL = 10;
// …and how long a fetch will QUEUE for one of those slots before giving up. A board asks
// for forty icons at once and each can try three spellings, so without a cap the last one
// in line waits behind a hundred others — the browser sees a request that never settles,
// which is worse than a quick "not now" it can retry: an <img> that is still pending shows
// nothing and never reaches its fallback.
const MAX_QUEUE_MS = 4000;
let active = 0;
const waiting: (() => void)[] = [];
async function slot<T>(fn: () => Promise<T>): Promise<T | 'busy'> {
	if (active >= MAX_PARALLEL) {
		const got = await new Promise<boolean>((go) => {
			const t = setTimeout(() => {
				const i = waiting.indexOf(release);
				if (i >= 0) waiting.splice(i, 1);
				go(false);
			}, MAX_QUEUE_MS);
			const release = () => {
				clearTimeout(t);
				go(true);
			};
			waiting.push(release);
		});
		if (!got) return 'busy';
	}
	active++;
	try {
		return await fn();
	} finally {
		active--;
		waiting.shift()?.();
	}
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type Hit = { body: ArrayBuffer; type: string; at: number };
const cache = new Map<string, Hit>();
const misses = new Map<string, number>();
// One in-flight fetch per key: 240 people opening the board at once must produce ONE
// request to the wiki, not 240 that all miss the cache together.
const inflight = new Map<string, Promise<Outcome>>();

function remember(key: string, hit: Hit): void {
	cache.set(key, hit);
	// Insertion-ordered map, so the oldest key is the first one out.
	while (cache.size > MAX_ENTRIES) {
		const oldest = cache.keys().next().value;
		if (oldest === undefined) break;
		cache.delete(oldest);
	}
}

/**
 * 'missing' — the wiki genuinely has no such file, so stop asking.
 * 'throttled' — it has it and would not give it to us this second, so ask again later and
 *   NEVER remember this as an answer. Conflating the two is what left a whole board blank:
 *   one burst got rate-limited and every tile in it was written off for ten minutes.
 */
type Outcome = Hit | 'missing' | 'throttled';

async function fetchOne(url: string): Promise<Outcome> {
	// A stray redirect off the wiki is not followed to somewhere else's server.
	const res = await slot(() =>
		fetch(url, {
			headers: {
				// The wiki asks that automated consumers identify themselves.
				'user-agent': 'volition-site (clan event board; contact via oldschool.runescape.wiki)',
				accept: 'image/avif,image/webp,image/png,image/*;q=0.8'
			}
		}).catch(() => null)
	);
	// Our own queue was full, or there was no response at all. Neither is an answer about
	// whether the file exists, so both mean "ask again".
	if (res === 'busy' || !res) return 'throttled';
	if (res.status === 429 || res.status >= 500) return 'throttled';
	if (!res.ok) return 'missing';
	if (new URL(res.url).hostname !== WIKI_HOST) return 'missing';

	const len = Number(res.headers.get('content-length') ?? 0);
	if (len > MAX_BYTES) return 'missing';
	const buf = await res.arrayBuffer();
	if (!buf.byteLength || buf.byteLength > MAX_BYTES) return 'missing';

	const type = res.headers.get('content-type') ?? 'image/png';
	if (!type.startsWith('image/')) return 'missing';
	return { body: buf, type, at: Date.now() };
}

/** A bare wiki file name: no path separators, no scheme, and an image extension. */
const SAFE_FILE = /^[A-Za-z0-9_%()'.,+-]{1,180}\.(png|jpg|jpeg|gif|webp)$/i;

export const GET: RequestHandler = async ({ url, setHeaders }) => {
	const name = (url.searchParams.get('name') ?? '').trim();
	const file = (url.searchParams.get('file') ?? '').trim();
	if (!name && !file) throw error(400, 'name or file required');
	if (name && name.length > 200) throw error(400, 'name too long');
	if (file && !SAFE_FILE.test(file)) throw error(400, 'not a wiki file name');
	const width = Math.min(512, Math.max(0, Number(url.searchParams.get('width')) || 0));
	const key = `${file || name}@${width}`;

	const missedAt = misses.get(key);
	if (missedAt && Date.now() - missedAt < MISS_TTL_MS) throw error(404, 'No such wiki image');

	const cached = cache.get(key);
	if (cached && Date.now() - cached.at < TTL_MS) {
		setHeaders({ 'cache-control': 'public, max-age=31536000, immutable', 'content-type': cached.type });
		return new Response(cached.body);
	}

	let job = inflight.get(key);
	if (!job) {
		job = (async () => {
			// Both spellings, because wiki file names are case-sensitive past the first
			// letter and our item names come out of the item database in sentence case.
			// Resolving that HERE means the browser no longer walks candidates per tile.
			const bases = file ? [`${FILE_PATH}${file}`] : wikiImageSources(name);
			let throttled = false;
			// Three tries with a widening gap. A throttle clears in seconds, and a tile that
			// waits two seconds for its icon is worth far more than one that gives up.
			for (let attempt = 0; attempt < 3; attempt++) {
				if (attempt) await sleep(400 * attempt * attempt + Math.random() * 250);
				throttled = false;
				for (const base of bases) {
					const withWidth = width ? `${base}${base.includes('?') ? '&' : '?'}width=${width}` : base;
					const got = await fetchOne(withWidth);
					if (got === 'throttled') throttled = true;
					else if (got !== 'missing') return got;
				}
				// Every spelling came back "no such file" — asking again will not change that.
				if (!throttled) return 'missing' as const;
			}
			return 'throttled' as const;
		})().finally(() => inflight.delete(key));
		inflight.set(key, job);
	}

	const hit = await job;
	if (hit === 'throttled') {
		// NOT remembered: the wiki has this file and will hand it over shortly. A short
		// `retry-after` lets the browser come back for it on its own.
		setHeaders({ 'cache-control': 'no-store', 'retry-after': '5' });
		throw error(503, 'The wiki is rate-limiting us — try again in a moment');
	}
	if (hit === 'missing') {
		misses.set(key, Date.now());
		throw error(404, 'No such wiki image');
	}
	remember(key, hit);
	// Immutable: a wiki file behind a given name effectively never changes, and if one
	// does, the worst case is a stale icon until the browser's cache turns over.
	setHeaders({ 'cache-control': 'public, max-age=31536000, immutable', 'content-type': hit.type });
	return new Response(hit.body);
};

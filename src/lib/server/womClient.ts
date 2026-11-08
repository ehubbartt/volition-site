// SERVER-ONLY paced WiseOldMan client for the rank pipeline.
//
// WOM allows 20 requests a minute per IP without an API key (100 with one) and answers
// anything over that with 429. The rank code used to fire WOM calls unpaced through
// getJson, which turns a 429 into "no data" — so a mass update or a run of admin re-checks
// quietly scored members with total level 0 / EHB 0 and SAVED it. This client:
//   - spaces every call made through it to stay under the limit (one queue per process),
//   - on a 429 waits out the reset WOM reports (bounded) and retries once,
//   - and reports 'error' for anything transient, so callers can refuse to save rather
//     than score zeros. A 404 is 'missing' (WOM has never tracked that name).
// Set WOM_API_KEY to raise the limit (free key from the WOM team); it's sent as x-api-key.

import { env } from '$env/dynamic/private';
import { serverFetch, type JsonOutcome } from './http';

export const WOM_BASE = 'https://api.wiseoldman.net/v2';

const MAX_RETRY_WAIT_MS = 20_000; // don't hold a request open for a whole minute
const TIMEOUT_MS = 15_000;

function perMinute(): number {
	return env.WOM_API_KEY ? 90 : 18; // a little under WOM's 100 / 20, for other traffic
}

// One FIFO queue per process: each call reserves the next slot `gap` ms after the last.
let nextSlot = 0;
async function takeSlot(): Promise<void> {
	const gap = Math.ceil(60_000 / perMinute());
	const now = Date.now();
	const at = Math.max(now, nextSlot);
	nextSlot = at + gap;
	if (at > now) await new Promise((r) => setTimeout(r, at - now));
}

function headers(): Record<string, string> {
	const h: Record<string, string> = { 'User-Agent': 'Volition-Site', Accept: 'application/json' };
	if (env.WOM_API_KEY) h['x-api-key'] = env.WOM_API_KEY;
	return h;
}

// Seconds until WOM's window resets, from Retry-After or RateLimit-Reset.
function resetWaitMs(res: Response): number {
	const s = Number(res.headers.get('retry-after') ?? res.headers.get('ratelimit-reset'));
	return Number.isFinite(s) && s > 0 ? s * 1000 : 10_000;
}

export async function womGet<T>(path: string): Promise<JsonOutcome<T>> {
	for (let attempt = 0; attempt < 2; attempt++) {
		await takeSlot();
		let res: Response;
		try {
			res = await serverFetch(`${WOM_BASE}${path}`, { headers: headers() }, TIMEOUT_MS);
		} catch {
			return { status: 'error' };
		}
		if (res.status === 404) return { status: 'missing' };
		if (res.status === 429 && attempt === 0) {
			const wait = resetWaitMs(res);
			if (wait > MAX_RETRY_WAIT_MS) return { status: 'error' };
			// Push the whole queue back too: everyone behind us would hit the same wall.
			nextSlot = Math.max(nextSlot, Date.now() + wait);
			continue;
		}
		if (!res.ok) return { status: 'error' };
		try {
			return { status: 'ok', data: (await res.json()) as T };
		} catch {
			return { status: 'error' };
		}
	}
	return { status: 'error' };
}

// Fire-and-forget POST (ask WOM to refresh a player), paced like everything else.
export async function womPost(path: string): Promise<void> {
	await takeSlot();
	try {
		await serverFetch(`${WOM_BASE}${path}`, { method: 'POST', headers: headers() }, TIMEOUT_MS);
	} catch {
		// best-effort
	}
}

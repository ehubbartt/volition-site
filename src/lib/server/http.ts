// SERVER-ONLY fetch helpers with a real timeout. Node's global `fetch` has NO
// default timeout, so a hung upstream (WOM, Temple, a Discord webhook) can pin a
// request open indefinitely — which is how a stalled external call blocks a page
// load or a form action here. These wrap fetch with an AbortController deadline and
// the shared Volition User-Agent, and are best-effort: getJson returns null on any
// failure (matching the "degrade, don't throw" style across the external clients).

const DEFAULT_TIMEOUT_MS = 15000;
const UA = { 'User-Agent': 'Volition-Site', Accept: 'application/json' } as const;

// fetch with an abort-on-timeout deadline. Throws on network error / timeout like
// fetch does; callers that want fail-open behaviour should use getJson/postJson.
export async function serverFetch(
	url: string,
	init: RequestInit = {},
	timeoutMs = DEFAULT_TIMEOUT_MS
): Promise<Response> {
	const ctrl = new AbortController();
	const t = setTimeout(() => ctrl.abort(), timeoutMs);
	try {
		return await fetch(url, { ...init, signal: ctrl.signal });
	} finally {
		clearTimeout(t);
	}
}

// GET + parse JSON, returning null on any non-OK / network / timeout / parse error.
export async function getJson<T = unknown>(url: string, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<T | null> {
	try {
		const res = await serverFetch(url, { headers: UA }, timeoutMs);
		if (!res.ok) return null;
		return (await res.json()) as T;
	} catch {
		return null;
	}
}

// Like getJson, but distinguishes a definitive "no record for this key" (HTTP 404) from a
// transient failure (network / timeout / 429 / 5xx / parse). Callers that must NOT treat
// "the source is down" the same as "this player isn't tracked" use this — e.g. rank scoring,
// where a real outage has to skip the save, but a genuinely-unsynced player should still be
// scored (and saved) on the data that does exist. A 200 that simply lacks the player's data
// is still `ok` here; the caller decides whether an empty body means "missing".
export type JsonOutcome<T> =
	| { status: 'ok'; data: T }
	| { status: 'missing' } // upstream answered but has no record for this key (404)
	| { status: 'error' }; // transient: network / timeout / non-404 non-OK / parse

export async function getJsonOutcome<T = unknown>(
	url: string,
	timeoutMs = DEFAULT_TIMEOUT_MS
): Promise<JsonOutcome<T>> {
	try {
		const res = await serverFetch(url, { headers: UA }, timeoutMs);
		if (res.status === 404) return { status: 'missing' };
		if (!res.ok) return { status: 'error' };
		return { status: 'ok', data: (await res.json()) as T };
	} catch {
		return { status: 'error' };
	}
}

// POST a JSON body, best-effort. Returns true if the upstream answered 2xx. Used for
// fire-and-forget Discord webhooks so a slow egress can't hang the request.
export async function postJson(
	url: string,
	body: unknown,
	timeoutMs = DEFAULT_TIMEOUT_MS
): Promise<boolean> {
	try {
		const res = await serverFetch(
			url,
			{ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) },
			timeoutMs
		);
		return res.ok;
	} catch {
		return false;
	}
}

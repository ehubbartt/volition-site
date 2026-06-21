import { Discord, UnexpectedResponseError, ArcticFetchError } from 'arctic';
import { env as privateEnv } from '$env/dynamic/private';
import { env as publicEnv } from '$env/dynamic/public';

let _discord: Discord | null = null;

// Thrown when a Discord OAuth call fails because Discord is unreachable/limiting us
// rather than because the user did something wrong — primarily the per-IP Cloudflare
// rate-limit (429) that hits Fly's SHARED egress IP, but also a 5xx or a Fly→Discord
// `fetch failed`. All of these mean "try again shortly", so the callback degrades to a
// friendly retry page + an ops alert instead of a raw 400/500. `status` is the HTTP
// status (0 = network/egress failure); `retryAfter` is the Retry-After header in
// seconds when known.
export class DiscordRateLimitError extends Error {
	readonly stage: 'token' | 'userinfo';
	readonly status: number;
	readonly retryAfter: number | null;
	constructor(stage: 'token' | 'userinfo', status: number, retryAfter: number | null) {
		super(`Discord ${stage} unavailable (status ${status})`);
		this.name = 'DiscordRateLimitError';
		this.stage = stage;
		this.status = status;
		this.retryAfter = retryAfter;
	}
}

function parseRetryAfter(value: string | null): number | null {
	if (!value) return null;
	const n = Number(value);
	return Number.isFinite(n) ? n : null;
}

// Classify a thrown OAuth failure: returns a DiscordRateLimitError when it's an outage
// we should retry (429/5xx/egress), else null for a GENUINE auth error (e.g. arctic's
// OAuth2RequestError invalid_grant) that the caller should keep treating as a 400.
// `arctic` throws UnexpectedResponseError (with .status) for any non-200/400/401 token
// response — 429 is the rate-limit case — and ArcticFetchError when the fetch itself
// fails (network/egress). fetchDiscordUser throws DiscordRateLimitError directly.
export function asDiscordOutage(
	e: unknown,
	stage: 'token' | 'userinfo'
): DiscordRateLimitError | null {
	if (e instanceof DiscordRateLimitError) return e;
	if (e instanceof UnexpectedResponseError) return new DiscordRateLimitError(stage, e.status, null);
	if (e instanceof ArcticFetchError) return new DiscordRateLimitError(stage, 0, null);
	return null;
}

export function discord(): Discord {
	if (_discord) return _discord;

	const clientId = privateEnv.DISCORD_CLIENT_ID;
	const clientSecret = privateEnv.DISCORD_CLIENT_SECRET;
	const siteUrl = publicEnv.PUBLIC_SITE_URL;

	if (!clientId || !clientSecret || !siteUrl) {
		throw new Error(
			'DISCORD_CLIENT_ID, DISCORD_CLIENT_SECRET, and PUBLIC_SITE_URL must be set'
		);
	}

	_discord = new Discord(clientId, clientSecret, `${siteUrl}/auth/discord/callback`);
	return _discord;
}

export interface DiscordUser {
	id: string;
	username: string;
	global_name: string | null;
	avatar: string | null;
}

export async function fetchDiscordUser(accessToken: string): Promise<DiscordUser> {
	let res: Response;
	try {
		res = await fetch('https://discord.com/api/v10/users/@me', {
			headers: { Authorization: `Bearer ${accessToken}` }
		});
	} catch {
		// The fetch itself failed (Fly→Discord egress/network) — treat as a retryable outage.
		throw new DiscordRateLimitError('userinfo', 0, null);
	}

	// 429 = Discord/Cloudflare rate-limiting our (shared) egress IP. Surface it as a
	// retryable outage carrying Retry-After, not a generic error.
	if (res.status === 429) {
		throw new DiscordRateLimitError('userinfo', 429, parseRetryAfter(res.headers.get('retry-after')));
	}
	if (!res.ok) {
		throw new Error(`Discord /users/@me failed: ${res.status}`);
	}

	return (await res.json()) as DiscordUser;
}

import { redirect, error } from '@sveltejs/kit';
import {
	discord,
	fetchDiscordUser,
	asDiscordOutage,
	type DiscordUser,
	type DiscordRateLimitError
} from '$lib/server/discord';
import { db } from '$lib/server/db';
import { createSession } from '$lib/server/auth';
import { postOpsAlert } from '$lib/server/opsAlert';
import type { RequestHandler } from './$types';

// Discord 429'd us (shared-egress-IP ban) or was unreachable — NOT the user's fault.
// Alert the team and send the user to a friendly retry page instead of a raw error.
function discordOutage(rl: DiscordRateLimitError): never {
	const status = rl.status === 0 ? 'a network/egress failure' : `HTTP ${rl.status}`;
	const retry = rl.retryAfter != null ? ` (retry-after ${rl.retryAfter}s)` : '';
	console.error(`[oauth] degraded stage=${rl.stage} status=${rl.status}${retry}`);
	postOpsAlert({
		title: '⚠️ Discord sign-in degraded',
		detail: `OAuth ${rl.stage} call returned ${status}${retry}. Members may be unable to sign in — likely the shared-egress-IP rate limit.`,
		fields: [
			{ name: 'Stage', value: rl.stage },
			{ name: 'Status', value: String(rl.status) },
			...(rl.retryAfter != null ? [{ name: 'Retry-After', value: `${rl.retryAfter}s` }] : [])
		]
	});
	throw redirect(302, '/login-busy');
}

export const GET: RequestHandler = async ({ url, cookies, locals }) => {
	const code = url.searchParams.get('code');
	const state = url.searchParams.get('state');
	const storedState = cookies.get('vs_oauth_state');

	// Temporary diagnostics: which host the callback ran on + whether the state
	// cookie actually arrived. A present state param but missing cookie means the
	// cookie was set on a different host (cross-domain) or got dropped.
	console.log(
		`[oauth] callback host=${url.host} hasStateCookie=${!!storedState} hasStateParam=${!!state} hasCode=${!!code} match=${!!state && state === storedState}`
	);

	cookies.delete('vs_oauth_state', { path: '/' });

	if (!code || !state || !storedState || state !== storedState) {
		// No valid one-time state cookie. This is almost always a stale/replayed
		// callback (Back button or a refresh after the cookie was already consumed,
		// or a tab Safari restored), not a real login — so don't show a 400. Send
		// already-signed-in users onward; everyone else back to start to retry.
		throw redirect(302, locals.user ? '/events' : '/');
	}

	let tokens;
	try {
		tokens = await discord().validateAuthorizationCode(code, null);
	} catch (e) {
		// Surface the REAL reason. arctic throws OAuth2RequestError (with .code like
		// invalid_client / invalid_grant) when Discord rejects the exchange; a Fly→Discord
		// network/egress failure throws a TypeError ("fetch failed") with a .cause instead.
		const err = e as { code?: string; description?: string; message?: string; cause?: unknown };
		console.error(
			`[oauth] token exchange FAILED code=${err.code ?? 'n/a'} desc=${err.description ?? 'n/a'} msg=${err.message ?? String(e)} cause=${err.cause ? String(err.cause) : 'n/a'}`
		);
		// A 429/5xx/egress outage is retryable and not the user's fault → degrade gracefully.
		const rl = asDiscordOutage(e, 'token');
		if (rl) discordOutage(rl);
		throw error(400, 'Failed to validate Discord authorization code');
	}

	let discordUser: DiscordUser;
	try {
		discordUser = await fetchDiscordUser(tokens.accessToken());
	} catch (e) {
		// /users/@me can 429 the same way the token exchange can — handle it identically
		// instead of letting it bubble to a raw 500.
		const rl = asDiscordOutage(e, 'userinfo');
		if (rl) discordOutage(rl);
		throw e;
	}
	const displayName = discordUser.global_name ?? discordUser.username;

	const supabase = db();

	const { data: existing } = await supabase
		.from('vs_users')
		.select('id, rsn, clan_allegiance, account_type')
		.eq('discord_id', discordUser.id)
		.maybeSingle();

	let userId: string;
	let needsOnboarding: boolean;

	if (existing) {
		userId = existing.id;
		needsOnboarding = !existing.rsn || !existing.clan_allegiance || !existing.account_type;

		await supabase
			.from('vs_users')
			.update({ discord_username: displayName })
			.eq('id', userId);
	} else {
		const { data: created, error: insertError } = await supabase
			.from('vs_users')
			.insert({
				discord_id: discordUser.id,
				discord_username: displayName
			})
			.select('id')
			.single();

		if (insertError || !created) {
			throw error(500, `Failed to create user: ${insertError?.message ?? 'unknown'}`);
		}

		userId = created.id;
		needsOnboarding = true;
	}

	await createSession(userId, cookies);

	throw redirect(302, needsOnboarding ? '/onboarding' : '/events');
};

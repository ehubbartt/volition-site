import { redirect, error } from '@sveltejs/kit';
import { discord, fetchDiscordUser } from '$lib/server/discord';
import { db } from '$lib/server/db';
import { createSession } from '$lib/server/auth';
import type { RequestHandler } from './$types';

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
		throw error(400, 'Failed to validate Discord authorization code');
	}

	const discordUser = await fetchDiscordUser(tokens.accessToken());
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

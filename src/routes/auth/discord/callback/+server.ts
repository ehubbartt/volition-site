import { redirect, error } from '@sveltejs/kit';
import { discord, fetchDiscordUser } from '$lib/server/discord';
import { db } from '$lib/server/db';
import { createSession } from '$lib/server/auth';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ url, cookies }) => {
	const code = url.searchParams.get('code');
	const state = url.searchParams.get('state');
	const storedState = cookies.get('vs_oauth_state');

	cookies.delete('vs_oauth_state', { path: '/' });

	if (!code || !state || !storedState || state !== storedState) {
		throw error(400, 'Invalid OAuth state');
	}

	let tokens;
	try {
		tokens = await discord().validateAuthorizationCode(code, null);
	} catch {
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

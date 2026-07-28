import { error, redirect } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { createSession } from '$lib/server/auth';
import { devLoginEnabled, devLoginDiscordId } from '$lib/server/devLogin';
import type { RequestHandler } from './$types';

// GET /auth/dev-login?next=/me — local visual-testing shortcut. Signs in as the owner
// account (see $lib/server/devLogin.ts for the gating and why this grants no roles of
// its own). GET on purpose: the preview harness drives it as a plain navigation, and
// there is nothing to protect — the route only answers on a local dev server with
// DEV_LOGIN set. Every deploy dead-code-eliminates the body to the 404 below.
export const GET: RequestHandler = async ({ url, cookies }) => {
	if (!devLoginEnabled()) throw error(404, 'Not found');

	const discordId = devLoginDiscordId();
	if (!discordId) {
		throw error(
			500,
			'dev-login: no account to sign in as — set DEV_LOGIN_DISCORD_ID or SUPER_ADMIN_DISCORD_IDS'
		);
	}

	// Look up ONLY; never create. If the id has no row, the local DB is pointed
	// somewhere unexpected and silently minting a user would hide that.
	const { data: user, error: dbError } = await db()
		.from('vs_users')
		.select('id, discord_id, discord_username')
		.eq('discord_id', discordId)
		.maybeSingle();

	if (dbError) throw error(500, `dev-login: ${dbError.message}`);
	if (!user) throw error(404, `dev-login: no vs_users row for discord_id ${discordId}`);

	await createSession(user.id, cookies);
	console.log(`[dev-login] signed in as ${user.discord_username} (${user.discord_id})`);

	// Same-origin absolute paths only — no scheme/host, so this can't open-redirect.
	const next = url.searchParams.get('next');
	const dest = next && next.startsWith('/') && !next.startsWith('//') ? next : '/';
	throw redirect(302, dest);
};

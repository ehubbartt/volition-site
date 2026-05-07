import { Discord } from 'arctic';
import { env as privateEnv } from '$env/dynamic/private';
import { env as publicEnv } from '$env/dynamic/public';

let _discord: Discord | null = null;

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
	const res = await fetch('https://discord.com/api/v10/users/@me', {
		headers: { Authorization: `Bearer ${accessToken}` }
	});

	if (!res.ok) {
		throw new Error(`Discord /users/@me failed: ${res.status}`);
	}

	return (await res.json()) as DiscordUser;
}

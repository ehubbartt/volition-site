// Per-user Dink config tokens — the SITE half of the system the Discord bot owns
// (volition-discord-bot: db/dinkTokens.js + /dink, /dink-revoke). A token is a
// personal secret that goes in the player's Dink "Dynamic Config URL" as
// `${PROXY_BASE_URL}/config/<token>`. The dink-proxy validates incoming tokens
// against the union of the dink_tokens table (this) and its legacy VALID_TOKENS
// secret, so a token minted here works without any Cloudflare API call.
//
// Tokens are keyed by Discord id (matching the bot, so a user has ONE active token
// whether they got it from /dink or from the site). Revoking sets revoked_at; the
// proxy stops honouring it within its token-cache TTL. Rotating = revoke + mint.

import { db } from '$lib/server/db';
import { env } from '$env/dynamic/private';

export interface DinkTokenRow {
	token: string;
	discord_id: string;
	created_at: string | null;
	revoked_at: string | null;
}

// 24 random bytes as hex (48 chars) — matches the bot's crypto.randomBytes(24).
function mintTokenString(): string {
	const arr = new Uint8Array(24);
	crypto.getRandomValues(arr);
	return Array.from(arr, (b) => b.toString(16).padStart(2, '0')).join('');
}

// The proxy base URL the config link is built from (e.g. https://dink-proxy.<acct>.workers.dev).
export function proxyBaseUrl(): string | null {
	return env.PROXY_BASE_URL?.replace(/\/+$/, '') || null;
}

export function configUrlFor(token: string): string | null {
	const base = proxyBaseUrl();
	return base ? `${base}/config/${token}` : null;
}

// The user's current (non-revoked) token, if any.
export async function getActiveToken(discordId: string): Promise<string | null> {
	const { data } = await db()
		.from('dink_tokens')
		.select('token')
		.eq('discord_id', discordId)
		.is('revoked_at', null)
		.limit(1)
		.maybeSingle();
	return (data as { token: string } | null)?.token ?? null;
}

// Return the user's active token, minting one if they don't have one. Mirrors the
// bot's getOrCreateToken so the two never fight over which token is "the" one.
export async function getOrCreateToken(
	discordId: string
): Promise<{ token: string; created: boolean }> {
	const existing = await getActiveToken(discordId);
	if (existing) return { token: existing, created: false };

	const token = mintTokenString();
	const { error } = await db().from('dink_tokens').insert({ token, discord_id: discordId });
	if (error) throw new Error(`mint dink token: ${error.message}`);
	return { token, created: true };
}

// Revoke every active token for a user (admin "take it away", or clan-leave parity).
export async function revokeTokensFor(discordId: string): Promise<void> {
	const { error } = await db()
		.from('dink_tokens')
		.update({ revoked_at: new Date().toISOString() })
		.eq('discord_id', discordId)
		.is('revoked_at', null);
	if (error) throw new Error(`revoke dink token: ${error.message}`);
}

// Rotate: revoke the user's current token and mint a fresh one. Used when a link
// leaks — the old URL stops working within the proxy's token-cache TTL. The
// multi-server flag rides along so rotating never silently flips a member back to
// the min-value-1 config.
export async function rotateToken(discordId: string): Promise<string> {
	const multi = await getMultiServer(discordId);
	await revokeTokensFor(discordId);
	const token = mintTokenString();
	const { error } = await db()
		.from('dink_tokens')
		.insert({ token, discord_id: discordId, multi_server: multi });
	if (error) throw new Error(`rotate dink token: ${error.message}`);
	return token;
}

// ── Multi-server mode ────────────────────────────────────────────────────────
// Members who use Dink with OTHER Discord servers can't take the standard config
// (its minLootValue of 1 makes their other webhooks fire on every drop). The flag
// lives on the token row — the proxy already reads dink_tokens to validate, so it
// picks the config variant in the same query: multi_server tokens get a HIGH
// minLootValue and rely on the tracked-item allowlist instead.

export async function getMultiServer(discordId: string): Promise<boolean> {
	const { data } = await db()
		.from('dink_tokens')
		.select('multi_server')
		.eq('discord_id', discordId)
		.is('revoked_at', null)
		.limit(1)
		.maybeSingle();
	return (data as { multi_server: boolean | null } | null)?.multi_server === true;
}

export async function setMultiServer(discordId: string, value: boolean): Promise<void> {
	const { error } = await db()
		.from('dink_tokens')
		.update({ multi_server: value })
		.eq('discord_id', discordId)
		.is('revoked_at', null);
	if (error) throw new Error(`set dink multi-server: ${error.message}`);
}

// All active tokens with their owner's RSN (for the admin revoke list).
export async function listActiveTokens(): Promise<
	{ discord_id: string; rsn: string | null; created_at: string | null }[]
> {
	const { data: toks } = await db()
		.from('dink_tokens')
		.select('discord_id, created_at')
		.is('revoked_at', null)
		.order('created_at', { ascending: false });
	const rows = (toks ?? []) as { discord_id: string; created_at: string | null }[];
	if (rows.length === 0) return [];

	const ids = [...new Set(rows.map((r) => r.discord_id))];
	const { data: users } = await db().from('vs_users').select('discord_id, rsn').in('discord_id', ids);
	const rsnById = new Map<string, string | null>();
	for (const u of (users ?? []) as { discord_id: string; rsn: string | null }[]) {
		rsnById.set(u.discord_id, u.rsn);
	}
	return rows.map((r) => ({
		discord_id: r.discord_id,
		rsn: rsnById.get(r.discord_id) ?? null,
		created_at: r.created_at
	}));
}

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
	const { mode, forwardClan } = await getDelivery(discordId);
	await revokeTokensFor(discordId);
	const token = mintTokenString();
	const { error } = await db().from('dink_tokens').insert({
		token,
		discord_id: discordId,
		mode,
		forward_clan: forwardClan,
		multi_server: mode === 'multi_server'
	});
	if (error) throw new Error(`rotate dink token: ${error.message}`);
	return token;
}

// ── Delivery modes ───────────────────────────────────────────────────────────
// See db/scripts/dink_modes_and_relays.sql for what each one means and why. `mode`
// is the authority; the legacy `multi_server` boolean is kept in sync so the proxy's
// existing path and the Discord bot keep working through a rollout.

export type DinkMode = 'standard' | 'multi_server' | 'relay';

export const DINK_MODES: DinkMode[] = ['standard', 'multi_server', 'relay'];

export const isDinkMode = (v: unknown): v is DinkMode =>
	typeof v === 'string' && (DINK_MODES as string[]).includes(v);

/** How a member's Dink is wired: the threshold strategy, and who we post for them. */
export interface DinkDelivery {
	mode: DinkMode;
	/** False for a visiting clan's player: tracked for events, never in our feed. */
	forwardClan: boolean;
}

export async function getDelivery(discordId: string): Promise<DinkDelivery> {
	const { data } = await db()
		.from('dink_tokens')
		.select('mode, forward_clan, multi_server')
		.eq('discord_id', discordId)
		.is('revoked_at', null)
		.limit(1)
		.maybeSingle();
	const row = data as {
		mode: string | null;
		forward_clan: boolean | null;
		multi_server: boolean | null;
	} | null;
	return {
		// A row written before the mode column existed still knows one thing about itself.
		mode: row && isDinkMode(row.mode) ? row.mode : row?.multi_server === true ? 'multi_server' : 'standard',
		forwardClan: row?.forward_clan !== false
	};
}

export async function setDelivery(discordId: string, d: DinkDelivery): Promise<void> {
	const { error } = await db()
		.from('dink_tokens')
		.update({
			mode: d.mode,
			forward_clan: d.forwardClan,
			multi_server: d.mode === 'multi_server'
		})
		.eq('discord_id', discordId)
		.is('revoked_at', null);
	if (error) throw new Error(`set dink delivery: ${error.message}`);
}

// ── Relay destinations ───────────────────────────────────────────────────────
// A member's own Discord webhooks, which the proxy posts to on their behalf so they
// can keep the low threshold without their other servers seeing every 1gp drop.

export const RELAY_TYPES = ['LOOT', 'COLLECTION', 'PET', 'DEATH'] as const;
export type RelayType = (typeof RELAY_TYPES)[number];

export interface DinkRelay {
	id: string;
	label: string | null;
	/** Masked for display — the full URL never leaves the server. */
	urlMasked: string;
	minValue: number;
	types: RelayType[];
	enabled: boolean;
}

/**
 * A Discord webhook and nothing else. This is an SSRF guard as much as a typo check:
 * the proxy will POST whatever is stored here, so "is this a Discord webhook" has to
 * be answered before it lands in the table (which enforces the same shape again).
 */
const DISCORD_WEBHOOK_RE =
	/^https:\/\/(canary\.|ptb\.)?discord(app)?\.com\/api\/webhooks\/[0-9]+\/[A-Za-z0-9_-]+$/;

export const isDiscordWebhook = (url: string): boolean => DISCORD_WEBHOOK_RE.test(url.trim());

/** Enough to recognise which destination this is, never enough to post to it. */
function maskWebhook(url: string): string {
	const m = /\/api\/webhooks\/([0-9]+)\//.exec(url);
	return m ? `…/webhooks/${m[1]}/••••••••` : '…/webhooks/••••••••';
}

const normalizeTypes = (raw: unknown): RelayType[] => {
	const list = Array.isArray(raw) ? raw : [];
	const picked = RELAY_TYPES.filter((t) => list.includes(t));
	// A destination that accepts nothing would silently never fire; default it to loot.
	return picked.length ? picked : ['LOOT'];
};

export async function listRelays(discordId: string): Promise<DinkRelay[]> {
	const { data } = await db()
		.from('vs_dink_relays')
		.select('id, label, url, min_value, types, enabled')
		.eq('discord_id', discordId)
		.order('created_at', { ascending: true });
	return ((data ?? []) as {
		id: string;
		label: string | null;
		url: string;
		min_value: number | string;
		types: string[] | null;
		enabled: boolean;
	}[]).map((r) => ({
		id: r.id,
		label: r.label,
		urlMasked: maskWebhook(r.url),
		minValue: Number(r.min_value) || 0,
		types: normalizeTypes(r.types),
		enabled: r.enabled
	}));
}

export async function addRelay(
	discordId: string,
	input: { url: string; label?: string | null; minValue?: number; types?: string[] }
): Promise<{ ok: true } | { ok: false; error: string }> {
	const url = input.url.trim();
	if (!url) return { ok: false, error: 'Paste the webhook URL' };
	if (!isDiscordWebhook(url)) {
		return {
			ok: false,
			error:
				'That is not a Discord webhook URL. It should look like ' +
				'https://discord.com/api/webhooks/<id>/<token> — copy it from the channel’s ' +
				'Edit Channel → Integrations → Webhooks screen.'
		};
	}
	const minValue = Math.max(0, Math.round(Number(input.minValue) || 0));
	const { error } = await db().from('vs_dink_relays').insert({
		discord_id: discordId,
		label: (input.label ?? '').trim() || null,
		url,
		min_value: minValue,
		types: normalizeTypes(input.types)
	});
	if (error) {
		// 23505 = the (discord_id, url) unique index.
		if (error.code === '23505') return { ok: false, error: 'That webhook is already registered' };
		return { ok: false, error: error.message };
	}
	return { ok: true };
}

export async function updateRelay(
	discordId: string,
	id: string,
	patch: { minValue?: number; types?: string[]; enabled?: boolean; label?: string | null }
): Promise<void> {
	const row: Record<string, unknown> = {};
	if (patch.minValue != null) row.min_value = Math.max(0, Math.round(Number(patch.minValue) || 0));
	if (patch.types) row.types = normalizeTypes(patch.types);
	if (patch.enabled != null) row.enabled = patch.enabled;
	if (patch.label !== undefined) row.label = (patch.label ?? '').trim() || null;
	if (!Object.keys(row).length) return;
	const { error } = await db()
		.from('vs_dink_relays')
		.update(row)
		.eq('discord_id', discordId)
		.eq('id', id);
	if (error) throw new Error(`update dink relay: ${error.message}`);
}

export async function removeRelay(discordId: string, id: string): Promise<void> {
	const { error } = await db()
		.from('vs_dink_relays')
		.delete()
		.eq('discord_id', discordId)
		.eq('id', id);
	if (error) throw new Error(`remove dink relay: ${error.message}`);
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

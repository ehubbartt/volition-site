import { db } from './db';
import { isClanMember } from './clan';
import { grantUserPack } from './gamba';
import { nextWeeklyResetIso } from '$lib/tasks';

// The free WEEKLY pack: a clan member can claim ONE copy of the admin-flagged pack
// each week (resets Monday 00:00 UTC), mirroring the daily loot crate. The flagged
// pack is `vs_card_packs.weekly_free=true` (single-winner, set in /admin/cards); the
// per-user claim time is `vs_users.weekly_pack_claimed_at`.

export interface WeeklyFreePack {
	id: string;
	name: string;
	front_url: string | null;
	back_url: string | null;
}

// The pack currently flagged as the weekly freebie (newest wins if >1 somehow), or null.
export async function getWeeklyFreePack(): Promise<WeeklyFreePack | null> {
	const { data } = await db()
		.from('vs_card_packs')
		.select('id, name, front_url, back_url')
		.eq('weekly_free', true)
		.order('created_at', { ascending: false })
		.limit(1)
		.maybeSingle();
	return (data as WeeklyFreePack | null) ?? null;
}

// Start of the current claim week = the most recent Monday 00:00 UTC (the next reset
// minus 7 days). A claim_at at/after this means "already claimed this week".
export function weekStartIso(): string {
	return new Date(new Date(nextWeeklyResetIso()).getTime() - 7 * 86_400_000).toISOString();
}

export function claimedThisWeek(claimedAt: string | null | undefined): boolean {
	return !!claimedAt && new Date(claimedAt).getTime() >= new Date(weekStartIso()).getTime();
}

export async function getWeeklyClaimAt(userId: string): Promise<string | null> {
	const { data } = await db()
		.from('vs_users')
		.select('weekly_pack_claimed_at')
		.eq('id', userId)
		.maybeSingle();
	return (data?.weekly_pack_claimed_at as string | null) ?? null;
}

type ClaimResult =
	| { ok: true; packName: string }
	| { ok: false; reason: 'none' | 'not_member' | 'already' | 'error' };

// Claim this week's free pack. Gated to clan members; idempotent + race-safe: the
// claim time is flipped atomically (only the request that updates a not-yet-claimed
// row proceeds to grant), so concurrent submits can't double-grant.
export async function claimWeeklyPack(user: {
	id: string;
	discord_id: string;
	rsn: string | null;
}): Promise<ClaimResult> {
	try {
		const pack = await getWeeklyFreePack();
		if (!pack) return { ok: false, reason: 'none' };
		if (!(await isClanMember(user))) return { ok: false, reason: 'not_member' };

		const weekStart = weekStartIso();
		// Atomic claim: succeed only if not already claimed since this week's start.
		const { count, error: claimErr } = await db()
			.from('vs_users')
			.update({ weekly_pack_claimed_at: new Date().toISOString() }, { count: 'exact' })
			.eq('id', user.id)
			.or(`weekly_pack_claimed_at.is.null,weekly_pack_claimed_at.lt.${weekStart}`);
		if (claimErr) return { ok: false, reason: 'error' };
		if (!count) return { ok: false, reason: 'already' };

		const granted = await grantUserPack(user.id, pack.id, 1);
		if (!granted) {
			// Roll the claim back so they can retry (no pack was given).
			await db().from('vs_users').update({ weekly_pack_claimed_at: null }).eq('id', user.id);
			return { ok: false, reason: 'error' };
		}
		return { ok: true, packName: pack.name };
	} catch (e) {
		console.error('[weekly-pack] claim failed:', e instanceof Error ? e.message : e);
		return { ok: false, reason: 'error' };
	}
}

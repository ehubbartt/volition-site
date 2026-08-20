import { redirect, error, fail } from '@sveltejs/kit';
import { db, fetchAllFiltered } from '$lib/server/db';
import { rsnExactPattern } from '$lib/server/users';
import { isAdmin } from '$lib/server/auth';
import {
	listRankOverrides,
	getRankOverride,
	saveRankOverride,
	clearRankOverride,
	hasEffect,
	CA_TIERS
} from '$lib/server/rankOverrides';
import { listGearGrants, revokeGearGrant } from '$lib/server/rankClaims';
import { checkAndSaveRank } from '$lib/server/rankCheck';
import { RANK_ORDER, RANK_LABEL } from '$lib/ranks';
import type { Actions, PageServerLoad } from './$types';

// THE RECORD of every manual rank adjustment and gear grant — what's been set by hand,
// for whom, why, and by when. Editing happens on the member's own profile (/u/[rsn]),
// where an admin clicks the score bar, rank badge or gear tile they want to change; this
// page is the clan-wide view over the result, and links through to each profile.
//
// The ONE exception is the form below. Overrides are keyed by RSN so that clan-roster
// members with no site account can be adjusted too — but those members have no /u profile
// to click on, so this is the only place they can be reached. Everyone with an account is
// edited on their profile.
//
// See docs/RANKS.md. Every write here is a POST under /admin/**, so hooks.server.ts
// records it in vs_audit_log with the full payload automatically.

interface RosterOnlyPlayer {
	rsn: string;
	discord_id: string | null;
	adjusted: boolean;
}

const norm = (rsn: string) => rsn.trim().toLowerCase().replace(/[\s_]+/g, ' ');

// Clan-roster members with NO site account — the only members without a profile page to
// edit on, and so the only ones this page still carries a form for.
async function readRosterOnly(adjustedRsns: Set<string>): Promise<RosterOnlyPlayer[]> {
	const [{ data: siteRows }, { data: rosterRows }] = await Promise.all([
		fetchAllFiltered<{ rsn: string | null }>((f, t) => db().from('vs_users').select('rsn').range(f, t)),
		fetchAllFiltered<{ rsn: string | null; discord_id: string | null }>((f, t) =>
			db().from('players').select('rsn, discord_id').range(f, t)
		)
	]);

	const seen = new Set(siteRows.filter((u) => u.rsn).map((u) => norm(u.rsn!)));
	const out: RosterOnlyPlayer[] = [];
	for (const p of rosterRows) {
		if (!p.rsn) continue;
		const key = norm(p.rsn);
		if (seen.has(key)) continue;
		seen.add(key);
		out.push({ rsn: p.rsn, discord_id: p.discord_id, adjusted: adjustedRsns.has(p.rsn.toLowerCase()) });
	}
	return out.sort((a, b) => a.rsn.localeCompare(b.rsn));
}

export const load: PageServerLoad = async ({ locals, url }) => {
	if (!locals.user) throw redirect(303, '/');
	if (!isAdmin(locals.user)) throw error(403, 'Not allowed');

	const [overrides, grants] = await Promise.all([listRankOverrides(), listGearGrants()]);
	const adjustedRsns = new Set(overrides.filter(hasEffect).map((o) => o.rsn));
	const rosterOnly = await readRosterOnly(adjustedRsns);

	// ?rsn= selects a profile-less roster member to adjust with the fallback form.
	const wanted = url.searchParams.get('rsn');
	const selected = wanted ? (rosterOnly.find((p) => norm(p.rsn) === norm(wanted)) ?? null) : null;
	const selectedOverride = selected ? await getRankOverride(selected.rsn) : null;

	return {
		overrides,
		grants,
		rosterOnly,
		selected,
		selectedOverride,
		caTiers: CA_TIERS,
		rankOptions: RANK_ORDER.map((r) => ({ value: r as string, label: RANK_LABEL[r] }))
	};
};

// Re-score a member by RSN so the change takes effect now rather than on the next sweep.
//
// The site account is looked up FIRST and only falls back to a null id: scoring someone
// who has an account as though they didn't would cache a breakdown missing their TCG
// progress and their approved gear claims, quietly under-ranking them. A genuinely
// roster-only member scores by RSN alone, the way the mass update does.
async function rescoreByRsn(rsn: string, discordId: string | null): Promise<string | null> {
	const { data: users } = await db()
		.from('vs_users')
		.select('id, discord_id, account_type')
		.ilike('rsn', rsnExactPattern(rsn))
		.limit(1);
	const account = users?.[0] as { id: string; discord_id: string | null; account_type: string | null } | undefined;

	const res = await checkAndSaveRank({
		userId: account?.id ?? null,
		rsn,
		discordId: account?.discord_id ?? discordId,
		accountType: account?.account_type ?? null
	});
	if (!res.ok) return `Saved, but the rank re-check failed — ${res.error} It'll apply on the next check.`;
	if (res.outcome.skippedSave) {
		return 'Saved, but the rank was not re-applied: TempleOSRS or WikiSync errored transiently, so scoring was skipped to avoid a wrong demotion. Re-check shortly.';
	}
	if (!res.outcome.saved) {
		return res.outcome.saveReason === 'no_player'
			? `Saved, and they now score as ${res.outcome.rank} — but no clan player record was found to write the rank to.`
			: `Saved, and they now score as ${res.outcome.rank} — but writing the clan rank failed.`;
	}
	return null;
}

export const actions: Actions = {
	// Adjust a roster member who has no site profile to edit on.
	saveOverride: async ({ locals, request }) => {
		if (!locals.user || !isAdmin(locals.user)) throw error(403, 'Not allowed');
		const form = await request.formData();
		const rsn = (form.get('rsn') ?? '').toString();
		const discordId = (form.get('discord_id') ?? '').toString() || null;
		if (!rsn.trim()) return fail(400, { saveError: 'Pick a player.' });

		const num = (key: string) => {
			const raw = (form.get(key) ?? '').toString().trim();
			if (!raw) return 0;
			const n = Number(raw);
			return Number.isFinite(n) ? n : 0;
		};
		const optInt = (key: string) => {
			const raw = (form.get(key) ?? '').toString().trim();
			if (!raw) return null;
			const n = Number(raw);
			return Number.isFinite(n) ? Math.round(n) : null;
		};

		const res = await saveRankOverride(
			{
				rsn,
				userId: null,
				discordId,
				rankOverride: (form.get('rank_override') ?? '').toString() || null,
				caTierOverride: (form.get('ca_tier_override') ?? '').toString() || null,
				gearPointsBonus: num('gear_points_bonus'),
				ehbBonus: num('ehb_bonus'),
				clogBonus: num('clog_bonus'),
				monthsBonus: num('months_bonus'),
				totalLevelOverride: optInt('total_level_override'),
				reason: (form.get('reason') ?? '').toString()
			},
			locals.user.id
		);
		if (!res.ok) return fail(400, { saveError: res.error });

		return { saveOk: true, rsn, warning: await rescoreByRsn(rsn, discordId) };
	},

	// Remove one member's adjustments from the record. Works for anyone on it — a member
	// with a profile can also be cleared from theirs.
	clearOverride: async ({ locals, request }) => {
		if (!locals.user || !isAdmin(locals.user)) throw error(403, 'Not allowed');
		const form = await request.formData();
		const rsn = (form.get('rsn') ?? '').toString();
		const discordId = (form.get('discord_id') ?? '').toString() || null;
		if (!rsn) return fail(400, { saveError: 'Missing player.' });

		const res = await clearRankOverride(rsn);
		if (!res.ok) return fail(500, { saveError: res.error ?? 'Could not remove the adjustment.' });
		return { clearOk: true, rsn, warning: await rescoreByRsn(rsn, discordId) };
	},

	// Take a granted item back. Left here as well as on the profile so the record is
	// actionable on its own — a wrong grant shouldn't need a detour to undo.
	revokeGrant: async ({ locals, request }) => {
		if (!locals.user || !isAdmin(locals.user)) throw error(403, 'Not allowed');
		const form = await request.formData();
		const id = Math.floor(Number(form.get('id')));
		if (!Number.isFinite(id)) return fail(400, { grantError: 'Unknown grant.' });

		const res = await revokeGearGrant(id);
		if (!res.ok) return fail(500, { grantError: res.error ?? 'Could not revoke the grant.' });

		const rsn = (form.get('rsn') ?? '').toString();
		return { revokeOk: true, rsn, warning: rsn ? await rescoreByRsn(rsn, null) : null };
	}
};

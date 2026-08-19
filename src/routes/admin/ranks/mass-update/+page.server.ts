import { redirect, error, fail } from '@sveltejs/kit';
import { selectAll } from '$lib/server/db';
import { isAdmin } from '$lib/server/auth';
import { checkAndSaveRank } from '$lib/server/rankCheck';
import { getRankOverridesByRsn } from '$lib/server/rankOverrides';
import { fetchClanRoster } from '$lib/server/rankData';
import { microCached } from '$lib/server/microCache';
import type { Actions, PageServerLoad } from './$types';

// Mass rank update — run the same "Check my rank" (checkAndSaveRank) over EVERY site member,
// slowly, until all ranks + signature ranks are up to date. Resumable and auto-chaining, the
// same shape as the rank-sim refresh: each request processes a batch of the members not yet
// re-checked THIS pass; the page keeps submitting until none remain. Each check hits WOM +
// TempleOSRS + WikiSync, so a per-player delay keeps us within WOM's rate budget.

const BATCH = 5; // members re-checked per request
const PER_PLAYER_DELAY_MS = 3000; // spacing between players (WOM ~20 req/min)
const ROSTER_TTL_MS = 10 * 60_000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Member {
	// vs_users.id, or null for a clan-roster member with no linked site account (scored by
	// RSN — checkAndSaveRank's claim + TCG reads no-op on a null id).
	id: string | null;
	rsn: string;
	discord_id: string | null;
	account_type: string | null;
}

// OSRS treats space/underscore as equal — normalize before matching a roster rsn to a
// site rsn (mirrors homeData.normRsn / users.rsnExactPattern).
const normRsn = (rsn: string | null | undefined) => (rsn ?? '').trim().replace(/_/g, ' ').toLowerCase();

// The whole clan we re-check: every site member (vs_users) UNION every clan-roster member
// (players) who never linked a site account. The home rank breakdown counts the full
// `players` roster, so scoring only site users left roster-only members stranded on their
// old bot rank (and always shaded "no Temple", since they had no vs_rank_sim row). Roster-only
// members are scored by RSN with a null id + null account_type — WOM carries no account type,
// so they get main-rate EHB (a GIM's EHB may read a touch high; acceptable for a backfill).
async function readMembers(): Promise<Member[]> {
	const [siteRows, rosterRows] = await Promise.all([
		selectAll<{ id: string; rsn: string; discord_id: string | null; account_type: string | null }>(
			'vs_users',
			'id, rsn, discord_id, account_type'
		),
		selectAll<{ rsn: string; discord_id: string | null }>('players', 'rsn, discord_id')
	]);

	const site: Member[] = siteRows.filter((r) => r.rsn && r.rsn.trim().length > 0);

	// Identities already covered by a site account — match on discord_id first, then rsn.
	const coveredDiscord = new Set(site.map((m) => m.discord_id).filter(Boolean) as string[]);
	const coveredRsn = new Set(site.map((m) => normRsn(m.rsn)));

	const rosterOnly: Member[] = [];
	const seen = new Set<string>(); // de-dupe roster rows among themselves (by normalized rsn)
	for (const p of rosterRows) {
		if (!p.rsn || !p.rsn.trim()) continue;
		const key = normRsn(p.rsn);
		if (coveredRsn.has(key)) continue;
		if (p.discord_id && coveredDiscord.has(p.discord_id)) continue;
		if (seen.has(key)) continue;
		seen.add(key);
		rosterOnly.push({ id: null, rsn: p.rsn, discord_id: p.discord_id, account_type: null });
	}

	return [...site, ...rosterOnly];
}

// One WOM group call per ROSTER_TTL_MS, shared across batches (and with the rank-sim). Throw
// inside so an empty/failed roster is never cached. Passed into checkAndSaveRank so it doesn't
// re-fetch the whole clan once per member.
async function getRosterCached() {
	return microCached('wom:roster', ROSTER_TTL_MS, async () => {
		const r = await fetchClanRoster();
		if (Object.keys(r).length === 0) throw new Error('empty roster');
		return r;
	}).catch(() => null);
}

// Latest vs_rank_sim.fetched_at per lowercased rsn — used to tell who's already been
// re-checked this pass (their timestamp moves past the run's `since`).
async function readFetchedAt(): Promise<Map<string, string>> {
	const rows = await selectAll<{ rsn: string; fetched_at: string | null }>('vs_rank_sim', 'rsn, fetched_at');
	const m = new Map<string, string>();
	for (const r of rows) {
		if (!r.rsn) continue;
		const key = r.rsn.toLowerCase();
		const prev = m.get(key);
		if (!prev || (r.fetched_at && r.fetched_at > prev)) m.set(key, r.fetched_at ?? '');
	}
	return m;
}

export const load: PageServerLoad = async ({ locals }) => {
	if (!locals.user) throw redirect(303, '/');
	if (!isAdmin(locals.user)) throw error(403, 'Not allowed');
	const members = await readMembers();
	return { total: members.length };
};

export const actions: Actions = {
	// Re-check the next batch of members not yet processed this pass. The page stamps a
	// `since` when the run starts and resubmits until `remaining` hits 0.
	run: async ({ locals, request }) => {
		if (!locals.user || !isAdmin(locals.user)) throw error(403, 'Not allowed');

		const form = await request.formData();
		const since = (form.get('since') ?? '').toString();

		const roster = await getRosterCached();
		if (!roster) {
			// retryable tells the page to back off and try the same batch rather than aborting.
			return fail(502, { runError: 'WOM clan roster unavailable (likely rate-limited).', retryable: true });
		}

		// One lookup of the staff adjustments for the whole batch, rather than a query per
		// member inside checkAndSaveRank (see rankOverrides.ts).
		const [members, fetchedAt, overrides] = await Promise.all([
			readMembers(),
			readFetchedAt(),
			getRankOverridesByRsn()
		]);

		// Pending this pass: members whose last check predates the run start (never-checked
		// sorts as '' → always pending). A member re-checked in an earlier batch has a fresh
		// timestamp > since and drops out.
		const pending = since
			? members.filter((m) => (fetchedAt.get(m.rsn.toLowerCase()) ?? '') < since)
			: members.slice();

		// Stalest first so the oldest data updates soonest.
		const worklist = pending
			.sort((a, b) => {
				const fa = fetchedAt.get(a.rsn.toLowerCase()) ?? '';
				const fb = fetchedAt.get(b.rsn.toLowerCase()) ?? '';
				return fa < fb ? -1 : fa > fb ? 1 : 0;
			})
			.slice(0, BATCH);

		let processed = 0;
		let saved = 0;
		let skipped = 0; // scored but not persisted — a stats source errored transiently
		let failed = 0;
		const errors: string[] = [];
		for (const m of worklist) {
			const res = await checkAndSaveRank(
				{ userId: m.id, rsn: m.rsn, discordId: m.discord_id, accountType: m.account_type },
				{ roster, overrides }
			);
			processed++;
			if (res.ok) {
				if (res.outcome.saved) saved++;
				else if (res.outcome.skippedSave) skipped++;
			} else {
				failed++;
				if (errors.length < 5) errors.push(`${m.rsn}: ${res.error}`);
			}
			if (processed < worklist.length) await sleep(PER_PLAYER_DELAY_MS);
		}

		return {
			runOk: true,
			processed,
			saved,
			skipped,
			failed,
			errors,
			total: members.length,
			// >0 tells the page to keep sweeping.
			remaining: since ? Math.max(0, pending.length - processed) : 0
		};
	}
};

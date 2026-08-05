import { redirect, error, fail } from '@sveltejs/kit';
import { selectAll } from '$lib/server/db';
import { isAdmin } from '$lib/server/auth';
import { checkAndSaveRank } from '$lib/server/rankCheck';
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
	id: string;
	rsn: string;
	discord_id: string | null;
	account_type: string | null;
}

// Every site member with an RSN — the population we re-check.
async function readMembers(): Promise<Member[]> {
	const rows = await selectAll<Member>('vs_users', 'id, rsn, discord_id, account_type');
	return rows.filter((r) => r.rsn && r.rsn.trim().length > 0);
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

		const [members, fetchedAt] = await Promise.all([readMembers(), readFetchedAt()]);

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
		let failed = 0;
		const errors: string[] = [];
		for (const m of worklist) {
			const res = await checkAndSaveRank(
				{ userId: m.id, rsn: m.rsn, discordId: m.discord_id, accountType: m.account_type },
				{ roster }
			);
			processed++;
			if (res.ok) {
				if (res.outcome.saved) saved++;
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
			failed,
			errors,
			total: members.length,
			// >0 tells the page to keep sweeping.
			remaining: since ? Math.max(0, pending.length - processed) : 0
		};
	}
};

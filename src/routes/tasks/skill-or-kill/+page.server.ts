import { redirect, error } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { isCardTester } from '$lib/server/auth';
import { fetchCompetition, metricKind, metricLabel } from '$lib/server/wom';
import type { PageServerLoad } from './$types';

const TOP_N = 10;

interface SokEventRow {
	id: string | number;
	title: string | null;
	type: 'sotw' | 'botw';
	ends_at: string | null;
	wom_competition_id: number | string | null;
}

export const load: PageServerLoad = async ({ locals }) => {
	if (!locals.user) throw redirect(303, '/');
	if (!locals.user.rsn || !locals.user.clan_allegiance || !locals.user.account_type) {
		throw redirect(303, '/onboarding');
	}
	if (!isCardTester(locals.user)) throw error(403, 'Not allowed');

	const { data: events } = await db()
		.from('events')
		.select('id, title, type, ends_at, wom_competition_id')
		.eq('status', 'active')
		.in('type', ['sotw', 'botw'])
		.order('created_at', { ascending: false });

	const rows = ((events ?? []) as SokEventRow[]).filter((e) => e.wom_competition_id != null);

	// Fetch each competition's live standings from WOM in parallel.
	const competitions = await Promise.all(
		rows.map(async (e) => {
			const comp = await fetchCompetition(e.wom_competition_id as number | string);
			const metric = comp?.metric ?? '';
			const kind = metric ? metricKind(metric) : e.type === 'sotw' ? 'skill' : 'boss';

			const participants = (comp?.participations ?? [])
				.map((p) => ({ rsn: p.player.displayName, gained: p.progress.gained }))
				.sort((a, b) => b.gained - a.gained)
				.slice(0, TOP_N)
				.map((p) => ({
					rsn: p.rsn,
					display:
						kind === 'skill' ? `${p.gained.toLocaleString()} XP` : `${p.gained.toLocaleString()} KC`
				}));

			return {
				womId: e.wom_competition_id as number | string,
				title: comp?.title ?? e.title ?? 'Competition',
				label: metric ? metricLabel(metric) : (e.title ?? 'Competition'),
				kind,
				endsAt: comp?.endsAt ?? e.ends_at ?? null,
				womUrl: `https://wiseoldman.net/competitions/${e.wom_competition_id}`,
				participants,
				reachable: !!comp
			};
		})
	);

	// Skills first (mirrors the bot's SoK embed ordering).
	competitions.sort((a, b) => (a.kind === b.kind ? 0 : a.kind === 'skill' ? -1 : 1));

	return { competitions };
};

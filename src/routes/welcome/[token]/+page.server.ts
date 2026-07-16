import { redirect, fail } from '@sveltejs/kit';
import { isAdmin } from '$lib/server/auth';
import {
	loadOnboarding,
	completeStep,
	gotoStep,
	verifyRsn,
	ensurePlayerRow,
	postIntroToDiscord,
	grantOnboardingRewards,
	type OnboardingSession
} from '$lib/server/onboarding';
import { getOrCreateToken, configUrlFor } from '$lib/server/dinkTokens';
import { getRankConfig } from '$lib/server/rankConfig';
import { fetchPlayerRankInputs } from '$lib/server/rankData';
import { scorePlayer } from '$lib/server/rankScoring';
import { setPlayerRank } from '$lib/server/playerStats';
import { sendBotMessage } from '$lib/server/botBridge';
import { db } from '$lib/server/db';
import { rsnExactPattern, isRsnTaken } from '$lib/server/users';
import { CLAN_OPTIONS, isValidClan } from '$lib/clans';
import { ACCOUNT_TYPES, isValidAccountType } from '$lib/accountTypes';
import type { Actions, PageServerLoad } from './$types';

// Site-owned onboarding (Version B). The bot DMs a /welcome/<token> link; this route
// validates it, binds the session to the signed-in member, and drives the step flow.
// Everything is additive + reachable only via a minted token — the live Discord join
// path is untouched.

export const load: PageServerLoad = async ({ params, locals }) => {
	const token = params.token;
	// Not signed in → send through Discord OAuth and come straight back to this link.
	if (!locals.user) {
		throw redirect(302, `/auth/discord/login?next=${encodeURIComponent(`/welcome/${token}`)}`);
	}

	const res = await loadOnboarding(token, locals.user);
	if (!res.ok) {
		return { invalid: res.reason, user: publicUser(locals.user) };
	}
	const session = res.session;

	// Dink step needs the member's config URL; mint/read it lazily so the step can show it.
	let dinkConfigUrl: string | null = null;
	if (session.steps.includes('dink')) {
		try {
			const { token: dinkToken } = await getOrCreateToken(locals.user.discord_id);
			dinkConfigUrl = configUrlFor(dinkToken);
		} catch {
			dinkConfigUrl = null;
		}
	}

	return {
		invalid: null as string | null,
		user: publicUser(locals.user),
		isAdmin: isAdmin(locals.user),
		session,
		clanOptions: CLAN_OPTIONS,
		accountTypes: ACCOUNT_TYPES,
		dinkConfigUrl
	};
};

function publicUser(u: NonNullable<App.Locals['user']>) {
	return {
		discord_username: u.discord_username,
		rsn: u.rsn,
		clan_allegiance: u.clan_allegiance,
		account_type: u.account_type
	};
}

// Reject an action if the token/user don't line up (mirrors the load guard).
async function requireSession(
	token: string,
	locals: App.Locals
): Promise<{ session: OnboardingSession } | { fail: ReturnType<typeof fail> }> {
	if (!locals.user) return { fail: fail(401, { error: 'Not signed in.' }) };
	const res = await loadOnboarding(token, locals.user);
	if (!res.ok) return { fail: fail(403, { error: `Onboarding link ${res.reason.replace('_', ' ')}.` }) };
	return { session: res.session };
}

export const actions: Actions = {
	// Generic "I've done this step" advance (welcome, temple, join, next…).
	advance: async ({ params, locals, request }) => {
		const guard = await requireSession(params.token, locals);
		if ('fail' in guard) return guard.fail;
		const step = ((await request.formData()).get('step') ?? guard.session.currentStep).toString();
		const res = await completeStep(params.token, locals.user!, step as OnboardingSession['currentStep']);
		return res.ok ? { advanced: true } : fail(400, { error: 'Could not advance.' });
	},

	// Rail navigation / Back — jump to an already-reached step without completing.
	goto: async ({ params, locals, request }) => {
		const guard = await requireSession(params.token, locals);
		if ('fail' in guard) return guard.fail;
		const step = (await request.formData()).get('step')?.toString() ?? '';
		await gotoStep(params.token, locals.user!, step as OnboardingSession['currentStep']);
		return { moved: true };
	},

	// Version B verify: RSN → WiseOldMan gate (2000+ total & 150+ EHB). Admins may
	// force past a below-requirements result (mirrors Discord force-verify).
	verify: async ({ params, locals, request }) => {
		const guard = await requireSession(params.token, locals);
		if ('fail' in guard) return guard.fail;
		const form = await request.formData();
		const rsn = (form.get('rsn') ?? '').toString().trim();
		const force = form.get('force') === 'true' && isAdmin(locals.user);
		if (!rsn) return fail(400, { verifyError: 'Enter your RSN.' });
		if (rsn.length > 12) return fail(400, { verifyError: 'RSN must be 12 characters or fewer.' });

		// Guard against claiming an RSN another member already holds.
		if (await isRsnTaken(rsn, locals.user!.id)) {
			return fail(400, { verifyError: 'That RSN is already linked to another member.' });
		}

		const result = await verifyRsn(rsn);
		if (result.reason === 'not_found') {
			return fail(404, { verifyError: `No WiseOldMan profile found for "${rsn}". Check the spelling.`, verify: result });
		}
		if (!result.meets && !force) {
			// Surface the numbers + let an admin force it.
			return fail(422, { verifyError: 'Below the join requirement (2000+ total & 150+ EHB).', verify: result });
		}

		// Passed (or forced): persist RSN on the profile, ensure a players row, tell the
		// bot to grant the verified role + set nickname, and advance.
		await db().from('vs_users').update({ rsn: result.rsn }).eq('id', locals.user!.id);
		await ensurePlayerRow(locals.user!.discord_id, result.rsn, result.womId);
		await sendBotMessage('onboard_verified', {
			discord_id: locals.user!.discord_id,
			rsn: result.rsn,
			username: locals.user!.discord_username
		});
		await completeStep(params.token, locals.user!, 'verify', {
			rsn: result.rsn,
			totalLevel: result.totalLevel,
			ehb: result.ehb,
			forced: force && !result.meets
		});
		return { verified: true, verify: result };
	},

	// Version B profile: clan allegiance + account type (rsn was set at verify).
	saveProfile: async ({ params, locals, request }) => {
		const guard = await requireSession(params.token, locals);
		if ('fail' in guard) return guard.fail;
		const form = await request.formData();
		const clan = (form.get('clan_allegiance') ?? '').toString();
		const account = (form.get('account_type') ?? '').toString();
		if (!isValidClan(clan)) return fail(400, { profileError: 'Pick your clan allegiance.' });
		if (!isValidAccountType(account)) return fail(400, { profileError: 'Pick your account type.' });
		await db()
			.from('vs_users')
			.update({ clan_allegiance: clan, account_type: account })
			.eq('id', locals.user!.id);
		await completeStep(params.token, locals.user!, 'profile');
		return { profileSaved: true };
	},

	// Introduction (5 fields) → posted to Discord via the bot bridge.
	submitIntro: async ({ params, locals, request }) => {
		const guard = await requireSession(params.token, locals);
		if ('fail' in guard) return guard.fail;
		const form = await request.formData();
		const fields = {
			basic_info: (form.get('basic_info') ?? '').toString().trim(),
			stats_info: (form.get('stats_info') ?? '').toString().trim(),
			clan_history: (form.get('clan_history') ?? '').toString().trim(),
			goals_interests: (form.get('goals_interests') ?? '').toString().trim(),
			additional_info: (form.get('additional_info') ?? '').toString().trim()
		};
		if (!fields.basic_info || !fields.stats_info || !fields.clan_history) {
			return fail(400, { introError: 'Please fill in at least the first three fields.' });
		}
		const posted = await postIntroToDiscord(locals.user!, fields);
		await completeStep(params.token, locals.user!, 'intro', { intro: fields, introPosted: posted });
		return { introSubmitted: true, introPosted: posted };
	},

	// Check-my-rank, lean version of the /me action: fetch → score → cache → mirror rank.
	checkRank: async ({ params, locals }) => {
		const guard = await requireSession(params.token, locals);
		if ('fail' in guard) return guard.fail;
		const rsn = locals.user!.rsn;
		if (!rsn) return fail(400, { rankError: 'Verify your RSN first.' });
		try {
			const [config, inputs] = await Promise.all([getRankConfig(), fetchPlayerRankInputs(rsn, undefined, [])]);
			const { rank } = scorePlayer(inputs, config);
			const { data: existing } = await db()
				.from('vs_rank_sim')
				.select('rsn')
				.ilike('rsn', rsnExactPattern(rsn))
				.order('fetched_at', { ascending: false })
				.limit(1);
			await db().from('vs_rank_sim').upsert(
				{
					rsn: existing?.[0]?.rsn ?? rsn,
					wom_id: inputs.womId,
					ehb: inputs.ehb,
					total_level: inputs.totalLevel,
					gear_points: inputs.gearPoints,
					clog_finished: inputs.clogFinished,
					clog_available: inputs.clogAvailable,
					months_in_clan: Math.round(inputs.monthsInClan * 100) / 100,
					ca_points: inputs.caPoints,
					temple_available: inputs.templeAvailable,
					wikisync_available: inputs.wikisyncAvailable,
					ca_tier: inputs.caTier,
					gear_detail: inputs.gearDetail,
					ca_detail: inputs.caDetail,
					fetched_at: new Date().toISOString()
				},
				{ onConflict: 'rsn' }
			);
			// Only mirror rank when both gated sources responded (avoid a degraded demote).
			let saved = false;
			if (inputs.templeAvailable && inputs.wikisyncAvailable) {
				const w = await setPlayerRank(locals.user!.discord_id, rsn, rank);
				saved = w.ok;
			}
			await completeStep(params.token, locals.user!, 'rank', { rank, rankSaved: saved });
			return { rankOk: true, rank, rankSaved: saved };
		} catch (e) {
			return fail(500, { rankError: e instanceof Error ? e.message : 'Rank check failed.' });
		}
	},

	// Dink: ensure a token exists (its URL is shown on the step), then advance.
	completeDink: async ({ params, locals }) => {
		const guard = await requireSession(params.token, locals);
		if ('fail' in guard) return guard.fail;
		try {
			await getOrCreateToken(locals.user!.discord_id);
		} catch {
			/* non-fatal — the URL just won't be available */
		}
		await completeStep(params.token, locals.user!, 'dink');
		return { dinkDone: true };
	},

	// Welcome rewards: a free loot-crate VP roll + a white welcome pack.
	claimRewards: async ({ params, locals }) => {
		const guard = await requireSession(params.token, locals);
		if ('fail' in guard) return guard.fail;
		const outcome = await grantOnboardingRewards(locals.user!);
		await completeStep(params.token, locals.user!, 'rewards', {
			rewardCrate: outcome.crate?.label ?? null,
			rewardCrateVp: outcome.crate?.kind === 'vp' ? outcome.crate.amount : 0,
			rewardWhitePack: outcome.whitePack
		});
		return { rewarded: true, crate: outcome.crate, whitePack: outcome.whitePack };
	}
};

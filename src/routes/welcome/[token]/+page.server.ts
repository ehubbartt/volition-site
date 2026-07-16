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
	whitePackId,
	onboardingCrateReel,
	notifyReadyToJoin,
	mergeOnboardingData,
	type OnboardingSession
} from '$lib/server/onboarding';
import { openOwnedPackFor } from '$lib/server/gambaPage';
import { loadRankBreakdown } from '$lib/server/meData';
import { getOrCreateToken, configUrlFor, getMultiServer, setMultiServer } from '$lib/server/dinkTokens';
import { getRankConfig } from '$lib/server/rankConfig';
import { fetchPlayerRankInputs } from '$lib/server/rankData';
import { scorePlayer } from '$lib/server/rankScoring';
import { setPlayerRank } from '$lib/server/playerStats';
import { sendBotMessage } from '$lib/server/botBridge';
import { db } from '$lib/server/db';
import { rsnExactPattern, isRsnTaken } from '$lib/server/users';
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

	// Reached the join step → prompt the origin (join-ticket) channel once so an admin
	// can invite them in-game (fires at most once; guarded on the token's data blob).
	if (session.currentStep === 'join') {
		await notifyReadyToJoin(token, locals.user, session.data);
	}

	// Crate reel (filler cells for the spinning reveal) — only needed if rewards is a step.
	const crateReel = session.steps.includes('rewards') ? await onboardingCrateReel() : [];

	// Dink step needs the member's config URL + multi-server flag; read them lazily.
	let dinkConfigUrl: string | null = null;
	let dinkMulti = false;
	if (session.steps.includes('dink')) {
		try {
			const { token: dinkToken } = await getOrCreateToken(locals.user.discord_id);
			dinkConfigUrl = configUrlFor(dinkToken);
			dinkMulti = await getMultiServer(locals.user.discord_id);
		} catch {
			dinkConfigUrl = null;
		}
	}

	return {
		invalid: null as string | null,
		user: publicUser(locals.user),
		isAdmin: isAdmin(locals.user),
		session,
		accountTypes: ACCOUNT_TYPES,
		dinkConfigUrl,
		dinkMulti,
		crateReel
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
		// bot to grant the verified role + set nickname. Do NOT complete the step here —
		// the UI shows a "you qualify" affirmation first, and its Continue button advances.
		await db().from('vs_users').update({ rsn: result.rsn }).eq('id', locals.user!.id);
		await ensurePlayerRow(locals.user!.discord_id, result.rsn, result.womId);
		await sendBotMessage('onboard_verified', {
			discord_id: locals.user!.discord_id,
			rsn: result.rsn,
			username: locals.user!.discord_username
		});
		return { verified: true, verify: result };
	},

	// Version B profile: account type only. Clan allegiance is auto-set to Volition
	// (everyone joining through this flow is Volition — one less thing to ask).
	saveProfile: async ({ params, locals, request }) => {
		const guard = await requireSession(params.token, locals);
		if ('fail' in guard) return guard.fail;
		const account = ((await request.formData()).get('account_type') ?? '').toString();
		if (!isValidAccountType(account)) return fail(400, { profileError: 'Pick your account type.' });
		await db()
			.from('vs_users')
			.update({ clan_allegiance: 'volition', account_type: account })
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
		// Don't auto-advance — show the "posted" confirmation (and whether it reached
		// Discord) first; the Continue button advances.
		await mergeOnboardingData(params.token, { intro: fields, introPosted: posted });
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
			// Don't complete the step — the UI reveals the rank + breakdown first, then
			// Continue advances. loadRankBreakdown re-reads the row we just cached and returns
			// the per-component breakdown + next-rank progress, so the step can EXPLAIN the rank.
			const { breakdown } = await loadRankBreakdown(rsn);
			return {
				rankOk: true,
				rank,
				rankSaved: saved,
				breakdown: breakdown
					? {
							composite: breakdown.composite,
							nextRank: breakdown.nextRank,
							nextRankProgress: breakdown.nextRankProgress,
							components: breakdown.components.map((c) => ({
								key: c.key,
								label: c.label,
								normalized: c.normalized,
								raw: c.raw,
								cap: c.cap
							}))
						}
					: null
			};
		} catch (e) {
			return fail(500, { rankError: e instanceof Error ? e.message : 'Rank check failed.' });
		}
	},

	// Dink multi-server toggle (member uses Dink with another Discord too) — reuses the
	// same dink_tokens flag the /dink-check page sets. Does not advance the step.
	setMultiServer: async ({ params, locals, request }) => {
		const guard = await requireSession(params.token, locals);
		if ('fail' in guard) return guard.fail;
		const value = (await request.formData()).get('multi') === 'true';
		try {
			await setMultiServer(locals.user!.discord_id, value);
		} catch (e) {
			return fail(500, { dinkError: e instanceof Error ? e.message : 'Could not save.' });
		}
		return { multiSaved: true, multi: value };
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

	// Welcome rewards: grant a free loot-crate VP roll + a white welcome pack. Does NOT
	// complete the step — the member opens the crate + rips the pack in-flow first, then
	// the Continue button advances. Returns the pack id so the opener can rip it.
	claimRewards: async ({ params, locals }) => {
		const guard = await requireSession(params.token, locals);
		if ('fail' in guard) return guard.fail;
		const outcome = await grantOnboardingRewards(locals.user!);
		const packId = await whitePackId();
		return { rewarded: true, crate: outcome.crate, whitePack: outcome.whitePack, whitePackId: packId };
	},

	// Rip the granted white pack open IN-FLOW — same logic as the gamba openOwned action
	// (consume + roll + reveal), so the 3D PackOpener animates the pull right here.
	openWhitePack: async ({ params, locals, request }) => {
		const guard = await requireSession(params.token, locals);
		if ('fail' in guard) return guard.fail;
		const packId = ((await request.formData()).get('pack_id') ?? '').toString() || (await whitePackId());
		if (!packId) return fail(400, { openError: 'No welcome pack to open.' });
		const res = await openOwnedPackFor(locals.user!, packId);
		if (!res.ok) return fail(400, { openError: res.error });
		return { packOpened: true, opened: res.opened, pack: res.pack };
	}
};

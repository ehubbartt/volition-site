import { fail, redirect } from '@sveltejs/kit';
import { z } from 'zod';
import { db } from '$lib/server/db';
import { isValidClan } from '$lib/clans';
import { isValidAccountType } from '$lib/accountTypes';
import { isRsnTaken } from '$lib/server/users';
import { submitGearClaim } from '$lib/server/rankClaims';
import { checkAndSaveRank } from '$lib/server/rankCheck';
import { THEME_COOKIE, isTheme } from '$lib/themes';
import type { Actions } from './$types';

// ACTIONS ONLY — this page has no server load. Its data comes from /api/me
// (built in $lib/server/meData.ts) via the universal load in +page.ts, so
// navigating to /me never waits on the server.

const RSN_REGEX = /^[A-Za-z0-9 _-]{1,12}$/;

const profileSchema = z.object({
	rsn: z
		.string()
		.trim()
		.regex(RSN_REGEX, 'RSN must be 1-12 chars (letters, numbers, space, _ or -)'),
	clan_allegiance: z.string().refine(isValidClan, 'Pick a clan'),
	account_type: z.string().refine(isValidAccountType, 'Pick your account type')
});

// Per-user cooldown for the "Check my rank" action — it hits three external APIs
// (WOM + TempleOSRS + WikiSync), so cap it to once per minute per user. In-memory is
// fine: a single adapter-node process, and a missed cooldown across a restart is harmless.
const lastRankCheck = new Map<string, number>();
const RANK_CHECK_COOLDOWN_MS = 60_000;

export const actions: Actions = {
	// Persist the site-theme choice as a year-long cookie. Cookie (not DB) on purpose:
	// hooks.server.ts must know the theme before rendering ANY page (SSR sets
	// <html data-theme> with no flash), and a cookie is the only store available that
	// early without a per-request DB read. See $lib/themes.
	saveTheme: async ({ locals, request, cookies }) => {
		if (!locals.user) throw redirect(303, '/');
		const theme = ((await request.formData()).get('theme') ?? '').toString();
		if (!isTheme(theme)) return fail(400, { themeError: 'Unknown theme.' });
		cookies.set(THEME_COOKIE, theme, {
			path: '/',
			maxAge: 60 * 60 * 24 * 365,
			httpOnly: true,
			sameSite: 'lax'
		});
		return { themeSaved: true };
	},

	// Fetch the signed-in player's live data, compute their composite rank with the
	// current rank_scoring config, and write players.rank (the bot mirrors it to Discord).
	checkRank: async ({ locals }) => {
		if (!locals.user) throw redirect(303, '/');
		const rsn = locals.user.rsn;
		if (!rsn) return fail(400, { rankError: 'Set your RSN on your profile first.' });

		const last = lastRankCheck.get(locals.user.id) ?? 0;
		const wait = RANK_CHECK_COOLDOWN_MS - (Date.now() - last);
		if (wait > 0) {
			return fail(429, { rankError: `Please wait ${Math.ceil(wait / 1000)}s before checking again.` });
		}
		lastRankCheck.set(locals.user.id, Date.now());

		// Shared with the admin single-player re-check (see $lib/server/rankCheck.ts): fetch
		// live inputs + approved gear claims, cache the breakdown in vs_rank_sim, and persist
		// players.rank when both stats sources responded. The page load re-runs after this
		// action and rebuilds the Rank tab from that row — one rendering path.
		const result = await checkAndSaveRank({
			userId: locals.user.id,
			rsn,
			discordId: locals.user.discord_id,
			accountType: locals.user.account_type
		});
		if (!result.ok) {
			lastRankCheck.delete(locals.user.id); // let them retry a transient failure now
			return fail(500, { rankError: `${result.error} Screenshot this and ping an admin.` });
		}

		const o = result.outcome;
		if (o.skippedSave) {
			return {
				rankOk: true,
				rankSaved: false,
				rankNote:
					'Computed from partial data — a stats source (Temple/WikiSync) was unavailable, so your clan rank was not updated to avoid an inaccurate change. Try again shortly.'
			};
		}
		return {
			rankOk: true,
			rankSaved: o.saved,
			// Only a genuine, SAVED climb celebrates (rankedUp compares RANK_ORDER positions).
			rankUp: o.rankedUp && o.prevRank ? { from: o.prevRank, to: o.rank } : null,
			rankNote: o.saved
				? null
				: o.saveReason === 'no_player'
					? 'Computed from your latest data, but no clan player record was found to save your rank to yet.'
					: 'Your breakdown was updated, but saving your clan rank failed — try again later.'
		};
	},

	// Claim an untrackable gear item for rank scoring (GE-bought / combined outside the
	// collection log) with proof screenshots. Admin-reviewed on /admin/rank-claims;
	// approved claims count on the member's next rank check.
	submitGearClaim: async ({ locals, request }) => {
		if (!locals.user) throw redirect(303, '/');
		const form = await request.formData();
		const itemName = (form.get('item_name') ?? '').toString().trim();
		const note = (form.get('note') ?? '').toString().trim() || null;
		const files = form.getAll('proof').filter((f): f is File => f instanceof File && f.size > 0);
		if (!itemName) return fail(400, { claimError: 'Pick the item you own.' });
		const res = await submitGearClaim(locals.user.id, itemName, files, note);
		if (!res.ok) {
			const msg =
				res.reason === 'unknown_item'
					? "That item isn't in the rank gear table."
					: res.reason === 'duplicate'
						? 'You already have a pending or approved claim for this item.'
						: res.reason === 'no_proof'
							? 'Attach at least one screenshot showing you own the item.'
							: (res.error ?? 'Could not save your claim. Try again shortly.');
			return fail(res.reason === 'error' || res.reason === 'upload_failed' ? 502 : 400, { claimError: msg });
		}
		return { claimOk: true };
	},

	// Named on purpose: SvelteKit forbids a `default` action alongside named ones
	// (every action POST to the page 500s otherwise — this is a runtime-only check).
	saveProfile: async ({ request, locals }) => {
		if (!locals.user) throw redirect(303, '/');

		const form = await request.formData();
		const parsed = profileSchema.safeParse({
			rsn: form.get('rsn'),
			clan_allegiance: form.get('clan_allegiance'),
			account_type: form.get('account_type')
		});

		if (!parsed.success) {
			return fail(400, {
				error: parsed.error.issues[0]?.message ?? 'Invalid input'
			});
		}

		const { rsn, clan_allegiance, account_type } = parsed.data;
		const supabase = db();

		if (await isRsnTaken(rsn, locals.user.id)) {
			return fail(409, { error: 'That RSN is already registered to another account' });
		}

		const { error } = await supabase
			.from('vs_users')
			.update({ rsn, clan_allegiance, account_type })
			.eq('id', locals.user.id);

		if (error) return fail(500, { error: error.message });

		return { success: true };
	}
};

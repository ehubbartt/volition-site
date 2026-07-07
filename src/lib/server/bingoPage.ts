import { db, fetchAllFiltered } from './db';
import { COLUMN_PALETTE } from '$lib/bingo/config';
import type { BingoTile } from '$lib/bingo/tiles';
import { getBingoState, getTileStatus } from '$lib/bingo/state';
import { loadEventBoard, type EventBoard } from './eventStructure';
import { maybeProcessDinkDrops } from './dinkDrops';
import { renderMarkdown } from '$lib/markdown';
import { isAdmin } from './auth';
import type { SessionUser } from './auth';
import { isClanMember } from './clan';

// Builds the /bingo/[slug] page payload for /api/bingo/[slug]. The page has NO
// server load — its universal load fires this fetch without awaiting, so
// navigation lands instantly on a tile-skeleton grid. Draft/preview redaction
// stays entirely server-side: redacted tiles leave here already scrubbed.

type SubmissionStatus = 'pending' | 'approved' | 'rejected';

interface CompletionRow {
	id: string;
	user_id: string;
	tile_id: string;
	proof_urls: string[] | null;
	proof_paths: string[] | null;
	submitted_at: string;
	status: SubmissionStatus;
	vs_users: {
		id: string;
		rsn: string | null;
		discord_username: string;
		clan_allegiance: string | null;
		account_type: string | null;
	};
	reviewer: {
		rsn: string | null;
		discord_username: string;
	} | null;
}


export async function fetchBingoEvent(slug: string) {
	const { data, error: qErr } = await db()
		.from('vs_events')
		.select('id, slug, name, kind, description, status, signup_opens_at, signup_closes_at, starts_at, ends_at, structure')
		.eq('slug', slug)
		.maybeSingle();
	if (qErr) throw new Error(qErr.message);
	return data;
}


export type BingoDetail = { kind: 'not_found' } | (Ok & { kind: 'ok' });
type Ok = Awaited<ReturnType<typeof buildOk>>;

export async function buildBingoDetail(user: SessionUser, slug: string): Promise<BingoDetail> {
	// Poll-on-read backstop: credit any pending Dink auto-tracked drops (throttled,
	// best-effort) so the board is current even if the cron processor lags.
	maybeProcessDinkDrops();

	// The event row and the caller's clan-membership check are independent.
	const [event, memberOfClan] = await Promise.all([
		fetchBingoEvent(slug),
		isClanMember(user.discord_id, user.rsn)
	]);
	if (!event) return { kind: 'not_found' };

	const admin = isAdmin(user);

	if (event.status === 'preview' && !admin) {
		return { kind: 'not_found' };
	}

	const ok = await buildOk(user, event, memberOfClan, admin);
	if (!ok) return { kind: 'not_found' }; // empty board (no tiles configured)
	return { kind: 'ok', ...ok };
}

async function buildOk(
	user: SessionUser,
	event: NonNullable<Awaited<ReturnType<typeof fetchBingoEvent>>>,
	memberOfClan: boolean,
	admin: boolean
) {
	// Kick off the whole completions history WITHOUT awaiting it — it's the slow,
	// unbounded read (grows with event activity), so it streams to the client while
	// the board renders immediately. The redacted draft/preview path never pays for
	// it, same as before.
	const redacted = event.status === 'draft' || (event.status === 'preview' && !admin);
	const completionsPromise = redacted
		? null
		: // Paginate: once an event passes 1000 tile submissions an un-paged read drops
			// the newest rows (oldest-first order) → an incomplete leaderboard.
			fetchAllFiltered((f, t) =>
				db()
					.from('vs_bingo_completions')
					.select(
						'id, user_id, tile_id, proof_urls, proof_paths, submitted_at, status, vs_users!user_id(id, rsn, discord_username, clan_allegiance, account_type), reviewer:vs_users!reviewed_by(rsn, discord_username)'
					)
					.eq('event_id', event.id)
					.order('submitted_at', { ascending: true })
					.range(f, t)
			);

	const board: EventBoard = await loadEventBoard(event);
	if (board.tiles.length === 0) return null; // no tiles configured yet
	const tileById = new Map(board.tiles.map((t) => [t.id, t]));

	// Derive the column model the board renders from (data-driven, any count/names).
	const BONUS_COLOR = '#ff981f';
	const mainTiers = board.structure.tiers.filter((t) => t.key !== 'bonus');
	const columns = mainTiers.map((t, i) => ({
		key: t.key,
		label: t.label,
		points: t.points,
		color: t.color ?? COLUMN_PALETTE[i % COLUMN_PALETTE.length]
	}));
	const bonusTier = board.structure.tiers.find((t) => t.key === 'bonus');
	const bonus = {
		label: bonusTier?.label || 'Bonus',
		points: bonusTier?.points ?? 5,
		color: bonusTier?.color ?? BONUS_COLOR
	};
	const colorByKey = new Map(columns.map((c) => [c.key, c.color]));
	const tileColor = (t: BingoTile): string =>
		t.tier === 'bonus' ? bonus.color : colorByKey.get(t.tier) ?? BONUS_COLOR;

	if (redacted) {
		const redactedTiles: BingoTile[] = board.tiles.map((t) => ({
			...t,
			name: 'nice try',
			details_html: null,
			color: tileColor(t)
		}));
		return {
			event: {
				name: event.name,
				description_html: renderMarkdown(event.description),
				status: event.status
			},
			running: false as const,
			archived: false as const,
			state: null,
			tiles: redactedTiles,
			columns,
			bonus,
			bonusEnabled: board.structure.bonusEnabled,
			isClanMember: memberOfClan,
			live: EMPTY_LIVE
		};
	}

	// A closed event becomes a read-only archive: the whole board is revealed
	// (force the state to 'ended' → every tile is 'past-locked', so names/details
	// are shown but no submissions are accepted), with the final leaderboard and
	// each player's own submissions kept visible to look back on.
	const archived = event.status === 'closed';
	const baseState = getBingoState((event.starts_at ?? event.signup_opens_at), new Date(), board.structure);
	const state = archived ? { ...baseState, status: 'ended' as const } : baseState;

	// Everything derived from the completions history (community lists, per-tile
	// counts, the caller's own submissions, the leaderboard). The whole payload
	// already streams to the client, so this is awaited here.
	const myUserId = user.id;
	const live: LiveData = await (async () => {
		const { data: completionsRaw, error: cErr } = (await completionsPromise) ?? {
			data: [],
			error: null
		};
		if (cErr) throw new Error(cErr.message);

		const completions = (completionsRaw ?? []) as unknown as CompletionRow[];

		const completionsByTile: LiveData['completionsByTile'] = {};
		const completionCountByTile: Record<string, number> = {};
		const mySubmissions: LiveData['mySubmissions'] = {};

		const scoredPairs = new Set<string>();
		const userPoints = new Map<string, LiveData['leaderboard'][number]>();

		for (const c of completions) {
			const tile = tileById.get(c.tile_id);
			if (!tile) continue;

			const proofUrls = c.proof_urls ?? [];
			const reviewerName = c.reviewer ? (c.reviewer.rsn ?? c.reviewer.discord_username) : null;

			// Community list + leaderboard only count approved submissions.
			if (c.status === 'approved') {
				const arr = completionsByTile[c.tile_id] ?? [];
				arr.push({
					id: c.id,
					user_id: c.user_id,
					rsn: c.vs_users.rsn,
					discord_username: c.vs_users.discord_username,
					account_type: c.vs_users.account_type,
					submitted_at: c.submitted_at,
					proof_urls: proofUrls,
					reviewed_by_name: reviewerName,
					isMe: c.user_id === myUserId
				});
				completionsByTile[c.tile_id] = arr;

				completionCountByTile[c.tile_id] = (completionCountByTile[c.tile_id] ?? 0) + 1;

				const pairKey = `${c.user_id}|${c.tile_id}`;
				const existing = userPoints.get(c.user_id) ?? {
					user_id: c.user_id,
					rsn: c.vs_users.rsn,
					discord_username: c.vs_users.discord_username,
					account_type: c.vs_users.account_type,
					points: 0,
					count: 0
				};
				if (!scoredPairs.has(pairKey)) {
					scoredPairs.add(pairKey);
					existing.points += tile.points;
					existing.count += 1;
				}
				userPoints.set(c.user_id, existing);
			}

			// Submitter always sees their own submissions, including pending + rejected ones.
			if (c.user_id === myUserId) {
				const mine = mySubmissions[c.tile_id] ?? [];
				mine.push({
					id: c.id,
					proof_urls: proofUrls,
					submitted_at: c.submitted_at,
					status: c.status,
					reviewed_by_name: reviewerName
				});
				mySubmissions[c.tile_id] = mine;
			}
		}

		const leaderboard = Array.from(userPoints.values()).sort((a, b) => {
			if (b.points !== a.points) return b.points - a.points;
			return b.count - a.count;
		});

		// Detailed community list (proofs + names) is admin-only while the event runs.
		// Once it's archived, the whole board is opened up so everyone can look back.
		// Regular users on a running event still get the count so the modal can show
		// "N completed".
		return {
			completionsByTile: admin || archived ? completionsByTile : {},
			completionCountByTile,
			mySubmissions,
			leaderboard
		};
	})().catch(() => EMPTY_LIVE);

	const tiles: BingoTile[] = board.tiles.map((t) => {
		const color = tileColor(t);
		if (getTileStatus(t, state) === 'blurred') {
			return { ...t, name: 'nice try', details_html: null, color };
		}
		const md = board.getDetails(t.id);
		return { ...t, details_html: md ? renderMarkdown(md) : null, color };
	});

	return {
		event: {
			id: event.id,
			slug: event.slug,
			name: event.name,
			description_html: renderMarkdown(event.description),
			status: event.status,
			start_at: (event.starts_at ?? event.signup_opens_at)
		},
		running: !archived,
		archived,
		state,
		tiles,
		columns,
		bonus,
		bonusEnabled: board.structure.bonusEnabled,
		isClanMember: memberOfClan,
		live
	};
}

// Completion-derived page data.
export type LiveData = {
	completionsByTile: Record<
		string,
		Array<{
			id: string;
			user_id: string;
			rsn: string | null;
			discord_username: string;
			account_type: string | null;
			submitted_at: string;
			proof_urls: string[];
			reviewed_by_name: string | null;
			isMe: boolean;
		}>
	>;
	completionCountByTile: Record<string, number>;
	mySubmissions: Record<
		string,
		Array<{
			id: string;
			proof_urls: string[];
			submitted_at: string;
			status: SubmissionStatus;
			reviewed_by_name: string | null;
		}>
	>;
	leaderboard: Array<{
		user_id: string;
		rsn: string | null;
		discord_username: string;
		account_type: string | null;
		points: number;
		count: number;
	}>;
};

const EMPTY_LIVE: LiveData = {
	completionsByTile: {},
	completionCountByTile: {},
	mySubmissions: {},
	leaderboard: []
};


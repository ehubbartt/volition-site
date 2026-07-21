// SERVER-ONLY: manual gear claims for rank scoring (vs_rank_item_claims,
// db/scripts/rank_item_claims.sql). Some gear-table items can't be proven by the
// Temple collection log — the obtain method registers no log slot (e.g. Oathplate
// crafted from shards), or upgraded variants combined outside the log — so members
// claim them with proof screenshots, admins
// review on /admin/rank-claims, and APPROVED claims merge into calculateGearPoints
// (rankScoring.ts) as if the item were in the member's log. Claims apply on the
// member's next "Check my rank" / the next admin rank-sim refresh — scoring reads
// them at fetch time, never retroactively rewrites cached rows.

import { db } from './db';
import { uploadProof } from './submissions';
import gearScoring from './rankScoring/gearScoring.json';

interface GearCheck {
	name: string | string[];
	quantity?: number;
}
interface GearEntry {
	name: string;
	tier: string;
	points: number;
	claimable?: boolean;
	items: GearCheck[];
}

export interface ClaimableGearItem {
	item: string; // the check item name members claim (matches Temple's clog naming)
	entry: string; // the gear-table set/entry it counts toward
	tier: string;
	points: number;
}

// Flatten the gear table into individual CHECK item names (OR-alternatives flattened,
// deduped), each tagged with its set/entry for display. `claimableOnly` restricts to
// entries flagged `claimable: true`.
function flattenGear(claimableOnly: boolean): ClaimableGearItem[] {
	const seen = new Set<string>();
	const out: ClaimableGearItem[] = [];
	for (const entry of (gearScoring as { gear: GearEntry[] }).gear) {
		if (claimableOnly && !entry.claimable) continue;
		for (const check of entry.items) {
			const names = Array.isArray(check.name) ? check.name : [check.name];
			for (const n of names) {
				const key = n.toLowerCase();
				if (seen.has(key)) continue;
				seen.add(key);
				out.push({ item: n, entry: entry.name, tier: entry.tier, points: entry.points });
			}
		}
	}
	out.sort((a, b) => a.item.localeCompare(b.item));
	return out;
}

// The manually-claimable set: ONLY gear-table entries flagged `claimable: true` — the items
// the Temple collection log can't prove (Oathplate helm/chest/legs, Radiant Oathplate, and
// Blood/Sanguine Torva). Every other gear item is clog-trackable and must NOT be manually
// submittable, so it's excluded. This is the single gate for BOTH the /me claim picker (via
// meData) and the submitGearClaim validation, so nothing else can be claimed.
let claimable: ClaimableGearItem[] | null = null;
export function claimableGearItems(): ClaimableGearItem[] {
	return (claimable ??= flattenGear(true));
}

// Display lookup over the FULL gear table (every check item, claimable or not), so the admin
// review queue can still resolve entry/tier/points for older claims of items that are no
// longer manually claimable.
let allGearByItem: Map<string, ClaimableGearItem> | null = null;
function gearItemMeta(name: string): ClaimableGearItem | undefined {
	allGearByItem ??= new Map(flattenGear(false).map((c) => [c.item.toLowerCase(), c]));
	return allGearByItem.get(name.toLowerCase());
}

export interface GearClaim {
	id: number;
	user_id: string;
	item_name: string;
	proof_urls: string[];
	note: string | null;
	status: 'pending' | 'approved' | 'rejected';
	review_note: string | null;
	submitted_at: string;
	reviewed_at: string | null;
}

const CLAIM_COLS = 'id, user_id, item_name, proof_urls, note, status, review_note, submitted_at, reviewed_at';

// The member's claims, newest first (drives the /me Rank tab list + duplicate guard).
export async function listGearClaims(userId: string): Promise<GearClaim[]> {
	const { data } = await db()
		.from('vs_rank_item_claims')
		.select(CLAIM_COLS)
		.eq('user_id', userId)
		.order('submitted_at', { ascending: false });
	return (data ?? []) as GearClaim[];
}

// APPROVED claim item names for one member — merged into calculateGearPoints.
export async function getApprovedGearNames(userId: string): Promise<string[]> {
	const { data } = await db()
		.from('vs_rank_item_claims')
		.select('item_name')
		.eq('user_id', userId)
		.eq('status', 'approved');
	return [...new Set(((data ?? []) as { item_name: string }[]).map((r) => r.item_name))];
}

// APPROVED claim names for the whole clan, keyed by lowercase RSN (the rank-sim
// refresh iterates WOM roster RSNs, not user ids).
export async function getApprovedGearNamesByRsn(): Promise<Map<string, string[]>> {
	const { data } = await db()
		.from('vs_rank_item_claims')
		// Disambiguate the embed: this table has TWO FKs to vs_users (user_id +
		// reviewed_by), so a bare vs_users(...) is ambiguous and PostgREST errors.
		.select('item_name, vs_users!user_id(rsn)')
		.eq('status', 'approved');
	const out = new Map<string, string[]>();
	// The vs_users embed is many-to-one — an object at runtime despite the array typing.
	for (const r of (data ?? []) as unknown as { item_name: string; vs_users: { rsn: string | null } | null }[]) {
		const rsn = r.vs_users?.rsn?.toLowerCase();
		if (!rsn) continue;
		const list = out.get(rsn) ?? [];
		if (!list.includes(r.item_name)) list.push(r.item_name);
		out.set(rsn, list);
	}
	return out;
}

export type SubmitClaimResult =
	| { ok: true }
	| { ok: false; reason: 'unknown_item' | 'duplicate' | 'no_proof' | 'upload_failed' | 'error'; error?: string };

// Member submits a claim: item must be in the gear table, not already pending or
// approved for them, and carry at least one proof screenshot. Re-claiming after a
// rejection is allowed (new row; the old rejection stays for the audit trail).
export async function submitGearClaim(
	userId: string,
	itemName: string,
	files: File[],
	note: string | null
): Promise<SubmitClaimResult> {
	const canonical = claimableGearItems().find((c) => c.item.toLowerCase() === itemName.toLowerCase());
	if (!canonical) return { ok: false, reason: 'unknown_item' };
	if (files.length === 0) return { ok: false, reason: 'no_proof' };

	const { data: existing } = await db()
		.from('vs_rank_item_claims')
		.select('id, status')
		.eq('user_id', userId)
		.ilike('item_name', canonical.item)
		.in('status', ['pending', 'approved'])
		.limit(1);
	if (existing?.length) return { ok: false, reason: 'duplicate' };

	// Proofs share the bingo bucket under a rank-claims prefix (uploadProof's eventId/
	// ownerKey/targetId are only path segments).
	const proofUrls: string[] = [];
	for (const file of files.slice(0, 4)) {
		const up = await uploadProof('rank-claims', userId, canonical.item.replace(/[^a-z0-9]+/gi, '-'), file);
		if ('error' in up) return { ok: false, reason: 'upload_failed', error: up.error };
		proofUrls.push(up.url);
	}

	const { error } = await db().from('vs_rank_item_claims').insert({
		user_id: userId,
		item_name: canonical.item, // canonical casing, so scoring's lowercase match always hits
		proof_urls: proofUrls,
		note: note || null
	});
	if (error) return { ok: false, reason: 'error', error: error.message };
	return { ok: true };
}

export interface PendingGearClaim extends GearClaim {
	rsn: string | null;
	discord_username: string | null;
	entry: string;
	tier: string;
	points: number;
}

// The admin review queue: pending first (oldest first), then recent decisions.
export async function listGearClaimsForReview(): Promise<{ pending: PendingGearClaim[]; decided: PendingGearClaim[] }> {
	const { data, error } = await db()
		.from('vs_rank_item_claims')
		// Disambiguate the embed: this table has TWO FKs to vs_users (user_id +
		// reviewed_by), so a bare vs_users(...) is ambiguous and PostgREST errors —
		// which silently emptied the admin review queue. Pin it to the submitter FK.
		.select(`${CLAIM_COLS}, vs_users!user_id(rsn, discord_username)`)
		.order('submitted_at', { ascending: false })
		.limit(200);
	if (error) console.error('[rank-claims] review queue query failed:', error.message);
	// Resolve display metadata over the FULL gear table (not just the claimable subset) so
	// older claims of now-unclaimable items still show their entry/tier/points.
	const rows = ((data ?? []) as unknown as (GearClaim & { vs_users: { rsn: string | null; discord_username: string | null } | null })[]).map(
		(r) => {
			const meta = gearItemMeta(r.item_name);
			return {
				...r,
				rsn: r.vs_users?.rsn ?? null,
				discord_username: r.vs_users?.discord_username ?? null,
				entry: meta?.entry ?? r.item_name,
				tier: meta?.tier ?? '?',
				points: meta?.points ?? 0
			};
		}
	);
	return {
		pending: rows.filter((r) => r.status === 'pending').sort((a, b) => a.submitted_at.localeCompare(b.submitted_at)),
		decided: rows.filter((r) => r.status !== 'pending')
	};
}

// Approve/reject a pending claim. Idempotent-ish: only pending rows transition.
export async function reviewGearClaim(
	id: number,
	approve: boolean,
	reviewerId: string,
	reviewNote: string | null
): Promise<{ ok: boolean; error?: string }> {
	const { error } = await db()
		.from('vs_rank_item_claims')
		.update({
			status: approve ? 'approved' : 'rejected',
			review_note: reviewNote || null,
			reviewed_by: reviewerId,
			reviewed_at: new Date().toISOString()
		})
		.eq('id', id)
		.eq('status', 'pending');
	return error ? { ok: false, error: error.message } : { ok: true };
}

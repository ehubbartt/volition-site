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
import { calculateGearPoints, type ManualGearItem } from './rankScoring';
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
	claimNote?: string;
	items: GearCheck[];
}

export interface ClaimableGearItem {
	item: string; // the check item name members claim (matches Temple's clog naming)
	entry: string; // the gear-table set/entry it counts toward
	tier: string;
	points: number;
	// Item-specific guidance shown in the claim modal when this item is selected
	// (e.g. Oathplate: include your shard collection-log count as proof of crafting).
	claimNote: string | null;
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
				out.push({ item: n, entry: entry.name, tier: entry.tier, points: entry.points, claimNote: entry.claimNote ?? null });
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

// EVERY gear-table check item. Members may only submit the `claimable: true` subset above,
// but an ADMIN may grant any of these outright from /admin/ranks/adjustments — for items
// that are trackable in principle yet unprovable in this member's case (drops that predate
// the in-game collection log, an account restored from a backup, …).
let allGear: ClaimableGearItem[] | null = null;
export function allGearItems(): ClaimableGearItem[] {
	return (allGear ??= flattenGear(false));
}

// Display lookup over the FULL gear table (every check item, claimable or not), so the admin
// review queue can still resolve entry/tier/points for older claims of items that are no
// longer manually claimable.
let allGearByItem: Map<string, ClaimableGearItem> | null = null;
function gearItemMeta(name: string): ClaimableGearItem | undefined {
	allGearByItem ??= new Map(allGearItems().map((c) => [c.item.toLowerCase(), c]));
	return allGearByItem.get(name.toLowerCase());
}

// The highest quantity any gear entry asks for of this item — the Zenyte shard entries top
// out at 4, so granting more than that buys nothing and the admin form says so.
export function maxUsefulQuantity(itemName: string): number {
	const key = itemName.toLowerCase();
	let max = 1;
	for (const entry of (gearScoring as { gear: GearEntry[] }).gear) {
		for (const check of entry.items) {
			const names = Array.isArray(check.name) ? check.name : [check.name];
			if (names.some((n) => n.toLowerCase() === key)) max = Math.max(max, check.quantity || 1);
		}
	}
	return max;
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
	/** 'member' = submitted through the /me claim modal; 'admin' = granted outright. */
	source: 'member' | 'admin';
	/** How many of the item are credited — admin grants may exceed 1 (four Zenyte shards). */
	quantity: number;
}

const CLAIM_COLS =
	'id, user_id, item_name, proof_urls, note, status, review_note, submitted_at, reviewed_at, source, quantity';

// The member's claims, newest first (drives the /me Rank tab list + duplicate guard).
export async function listGearClaims(userId: string): Promise<GearClaim[]> {
	const { data } = await db()
		.from('vs_rank_item_claims')
		.select(CLAIM_COLS)
		.eq('user_id', userId)
		.order('submitted_at', { ascending: false });
	return (data ?? []) as GearClaim[];
}

// Collapse rows into one credit per item, keeping the LARGEST count — two grants of the
// same item describe the same shards, so they must not stack into a bigger number than
// either one claimed.
function mergeCounts(rows: { item_name: string; quantity?: number | null }[]): ManualGearItem[] {
	const best = new Map<string, ManualGearItem>();
	for (const r of rows) {
		const key = r.item_name.toLowerCase();
		const count = Math.max(1, Math.floor(r.quantity ?? 1));
		const cur = best.get(key);
		if (!cur || count > (cur.count ?? 1)) best.set(key, { name: r.item_name, count });
	}
	return [...best.values()];
}

// APPROVED manual gear (member claims + admin grants) for one member — merged into
// calculateGearPoints.
export async function getApprovedGearItems(userId: string | null): Promise<ManualGearItem[]> {
	// A roster member with no site account (mass-update scores them by RSN) has no claims.
	if (!userId) return [];
	const { data } = await db()
		.from('vs_rank_item_claims')
		.select('item_name, quantity')
		.eq('user_id', userId)
		.eq('status', 'approved');
	return mergeCounts((data ?? []) as { item_name: string; quantity: number | null }[]);
}

// APPROVED manual gear for the whole clan, keyed by lowercase RSN (the rank-sim
// refresh iterates WOM roster RSNs, not user ids).
export async function getApprovedGearItemsByRsn(): Promise<Map<string, ManualGearItem[]>> {
	const { data } = await db()
		.from('vs_rank_item_claims')
		// Disambiguate the embed: this table has TWO FKs to vs_users (user_id +
		// reviewed_by), so a bare vs_users(...) is ambiguous and PostgREST errors.
		.select('item_name, quantity, vs_users!user_id(rsn)')
		.eq('status', 'approved');
	const grouped = new Map<string, { item_name: string; quantity: number | null }[]>();
	// The vs_users embed is many-to-one — an object at runtime despite the array typing.
	for (const r of (data ?? []) as unknown as {
		item_name: string;
		quantity: number | null;
		vs_users: { rsn: string | null } | null;
	}[]) {
		const rsn = r.vs_users?.rsn?.toLowerCase();
		if (!rsn) continue;
		const list = grouped.get(rsn) ?? [];
		list.push(r);
		grouped.set(rsn, list);
	}
	return new Map([...grouped].map(([rsn, rows]) => [rsn, mergeCounts(rows)]));
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
		note: note || null,
		source: 'member',
		quantity: 1
	});
	if (error) return { ok: false, reason: 'error', error: error.message };
	return { ok: true };
}

// --- Admin grants (the exception channel) -----------------------------------
// An admin credits a member with a gear item outright, over the WHOLE gear table rather
// than the `claimable: true` subset members may submit — for items that are trackable in
// principle but unprovable in this member's case (the four Zenyte shards dropped before
// the in-game collection log existed; an account whose log was lost). Written as an
// already-APPROVED row so it flows through the exact same scoring path as a reviewed
// claim, tagged source='admin' so the two never blur together.
//
// This is NOT a members-facing channel and must never become one: mass self-granting is
// the failure mode the review queue exists to prevent. /admin/ranks/adjustments is admin-
// gated, every write is captured in vs_audit_log, and each grant carries its reason.

export type GrantResult = { ok: true; id: number } | { ok: false; error: string };

export async function grantGearItem(
	userId: string,
	itemName: string,
	quantity: number,
	reason: string,
	adminId: string
): Promise<GrantResult> {
	const canonical = allGearItems().find((c) => c.item.toLowerCase() === itemName.trim().toLowerCase());
	if (!canonical) return { ok: false, error: `“${itemName}” is not an item in the gear table.` };
	if (!reason.trim()) return { ok: false, error: 'A reason is required — this is the record of why it was granted.' };

	// More than the largest quantity any entry asks for scores nothing extra; clamp so the
	// stored number matches what the member is actually being credited with.
	const qty = Math.min(Math.max(1, Math.floor(quantity || 1)), maxUsefulQuantity(canonical.item));

	// One live grant per item per member: re-granting replaces the count rather than
	// stacking a second row that mergeCounts would just collapse anyway.
	const { data: existing } = await db()
		.from('vs_rank_item_claims')
		.select('id')
		.eq('user_id', userId)
		.eq('source', 'admin')
		.ilike('item_name', canonical.item)
		.eq('status', 'approved')
		.limit(1);

	const row = {
		user_id: userId,
		item_name: canonical.item,
		proof_urls: [],
		note: reason.trim(),
		status: 'approved',
		source: 'admin',
		quantity: qty,
		review_note: reason.trim(),
		reviewed_by: adminId,
		reviewed_at: new Date().toISOString()
	};

	const q = existing?.length
		? db().from('vs_rank_item_claims').update(row).eq('id', existing[0].id).select('id').single()
		: db().from('vs_rank_item_claims').insert(row).select('id').single();
	const { data, error } = await q;
	if (error) return { ok: false, error: error.message };
	return { ok: true, id: (data as { id: number }).id };
}

// Take back an admin grant. Deleted rather than rejected: a grant was never a member
// submission, so there's no decision history worth keeping on the row — the audit log
// holds who granted it, who removed it, and when.
export async function revokeGearGrant(id: number): Promise<{ ok: boolean; error?: string }> {
	const { error } = await db().from('vs_rank_item_claims').delete().eq('id', id).eq('source', 'admin');
	return error ? { ok: false, error: error.message } : { ok: true };
}

export interface GearGrant extends GearClaim {
	rsn: string | null;
	discord_username: string | null;
	entry: string;
	points: number;
}

// What a grant of `qty` of one item actually buys, in gear-table terms. Scored rather than
// looked up, because a quantity grant can complete SEVERAL entries — four Zenyte shards
// finish all four shard entries, 800 points, where the item-name lookup alone would name
// only the first and report 200. Entries needing other items too stay partial and so are
// correctly left out.
function grantEffect(itemName: string, qty: number): { entry: string; points: number } {
	const scored = calculateGearPoints(null, [{ name: itemName, count: qty }]);
	if (scored.matchedItems.length === 0) {
		const meta = gearItemMeta(itemName);
		return { entry: meta?.entry ?? itemName, points: 0 };
	}
	return {
		entry: scored.matchedItems.map((m) => m.name).join(', '),
		points: scored.gearPoints
	};
}

// Every live admin grant, newest first — the "what have we credited by hand" list.
export async function listGearGrants(): Promise<GearGrant[]> {
	const { data, error } = await db()
		.from('vs_rank_item_claims')
		.select(`${CLAIM_COLS}, vs_users!user_id(rsn, discord_username)`)
		.eq('source', 'admin')
		.eq('status', 'approved')
		.order('reviewed_at', { ascending: false })
		.limit(300);
	if (error) console.error('[rank-claims] grant list query failed:', error.message);
	return ((data ?? []) as unknown as (GearClaim & {
		vs_users: { rsn: string | null; discord_username: string | null } | null;
	})[]).map((r) => ({
		...r,
		rsn: r.vs_users?.rsn ?? null,
		discord_username: r.vs_users?.discord_username ?? null,
		...grantEffect(r.item_name, r.quantity)
	}));
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
		// Member submissions only. Admin grants are already-approved rows written from
		// /admin/ranks/adjustments; they'd otherwise flood this queue's decided list with
		// entries nobody reviewed. They're listed on the adjustments page instead.
		.eq('source', 'member')
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

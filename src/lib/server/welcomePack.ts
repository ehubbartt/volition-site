import { db } from './db';
import { isClanMember } from './clan';
import { grantUserPack } from './gamba';

// Name (prefix, case-insensitive) of the pack new Volition members receive once.
const WELCOME_PACK_NAME = 'white';

// Grants the one-time welcome pack to a user the FIRST time they're verified as a
// Volition clan member — at signup OR whenever they later join the clan. Idempotent
// and race-safe: it atomically claims the user's `welcome_pack_granted` flag before
// granting, so concurrent loads can't double-grant. Best-effort — returns false and
// never throws, so it can't break the page/flow that calls it. Pass `knownMember`
// to skip the roster lookup when the caller already has it (e.g. the home load,
// which already reads the `players` roster).
export async function ensureWelcomePack(
	user: { id: string; discord_id: string; rsn: string | null; welcome_pack_granted: boolean },
	knownMember?: boolean
): Promise<boolean> {
	if (user.welcome_pack_granted) return false;
	try {
		const isMember = knownMember ?? (await isClanMember(user));
		if (!isMember) return false;

		// The welcome pack must exist. If it isn't set up yet, do nothing AND don't
		// claim the flag — so the user still gets it once the pack is created.
		const { data: pack } = await db()
			.from('vs_card_packs')
			.select('id')
			.ilike('name', `${WELCOME_PACK_NAME}%`)
			.order('created_at', { ascending: true })
			.limit(1)
			.maybeSingle();
		if (!pack) return false;

		// Atomically claim: only the request that flips false→true proceeds to grant.
		const { count } = await db()
			.from('vs_users')
			.update({ welcome_pack_granted: true }, { count: 'exact' })
			.eq('id', user.id)
			.eq('welcome_pack_granted', false);
		if (!count) return false; // already claimed (another request / already granted)

		const ok = await grantUserPack(user.id, pack.id, 1);
		if (!ok) {
			// Roll the claim back so they can still receive it on a later visit.
			await db().from('vs_users').update({ welcome_pack_granted: false }).eq('id', user.id);
			return false;
		}
		return true;
	} catch (e) {
		console.error('[welcome-pack] grant failed:', e instanceof Error ? e.message : e);
		return false;
	}
}

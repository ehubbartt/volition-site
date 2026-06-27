import { redirect, error } from '@sveltejs/kit';
import { isAdmin } from '$lib/server/auth';
import itemEhb from '$lib/server/data/itemEhb.json';
import type { ItemEhb } from '$lib/ehb';
import type { PageServerLoad } from './$types';

// EXPERIMENTAL drop-difficulty tool. Ships raw per-source drop data; the page
// computes EHB live from editable assumptions (raid purple rates, ToA invocation,
// Doom floor) so raid/Doom variants can be explored. EHB math + types live in
// $lib/ehb (shared with the personal collection-log bingo generator).
export const load: PageServerLoad = ({ locals }) => {
	if (!locals.user) throw redirect(303, '/');
	if (!isAdmin(locals.user)) throw error(403, 'Not allowed');
	return { items: itemEhb as ItemEhb[] };
};

export type { EhbMechanic, EhbSource, ItemEhb } from '$lib/ehb';

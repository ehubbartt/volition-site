import { redirect, error } from '@sveltejs/kit';
import { isAdmin } from '$lib/server/auth';
import itemEhb from '$lib/server/data/itemEhb.json';
import type { PageServerLoad } from './$types';

// EXPERIMENTAL drop-difficulty tool. Ships raw per-source drop data; the page
// computes EHB live from editable assumptions (raid purple rates, ToA invocation,
// Doom floor) so raid/Doom variants can be explored.
export const load: PageServerLoad = ({ locals }) => {
	if (!locals.user) throw redirect(303, '/');
	if (!isAdmin(locals.user)) throw error(403, 'Not allowed');
	return { items: itemEhb as ItemEhb[] };
};

export type EhbMechanic = 'kill' | 'cox' | 'tobn' | 'tobh' | 'toa' | 'doom';

export interface EhbSource {
	s: string; // source display name
	t: EhbMechanic;
	k?: number; // expected kills (kill) or expected purples = inverse table share (raids)
	r?: number; // kills/raids per hour
	rate?: string; // raw drop-rate string for display
	col?: 'cloth' | 'eye' | 'treads' | 'dom'; // doom floor-rate column
}

export interface ItemEhb {
	id: number;
	name: string;
	sources: EhbSource[];
}

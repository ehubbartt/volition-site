import { redirect, error } from '@sveltejs/kit';
import { isAdmin } from '$lib/server/auth';
import itemEhb from '$lib/server/data/itemEhb.json';
import type { PageServerLoad } from './$types';

// EXPERIMENTAL drop-difficulty tool. Ships the precomputed EHB-per-item dataset
// (~287 boss-droppable items) to the page for client-side lookup + target filtering.
export const load: PageServerLoad = ({ locals }) => {
	if (!locals.user) throw redirect(303, '/');
	if (!isAdmin(locals.user)) throw error(403, 'Not allowed');
	return { items: itemEhb as ItemEhb[] };
};

export interface ItemEhb {
	id: number;
	name: string;
	source: string;
	dropRate: string;
	expectedKills: number;
	ehbRate: number;
	ehbPerItem: number;
	approx: boolean;
}

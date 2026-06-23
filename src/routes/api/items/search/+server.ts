// GET /api/items/search?q=<text> — name→id autocomplete for the event builder's
// tracked-items editor. Searches a bundled, complete OSRS item id↔name dataset
// (server-only) and returns up to 25 matches, prefix matches first. Admin-gated.

import { json, error } from '@sveltejs/kit';
import { isAdmin } from '$lib/server/auth';
import itemsData from '$lib/server/data/osrsItems.json';
import type { RequestHandler } from './$types';

const ITEMS = itemsData as { id: number; name: string }[];

export const GET: RequestHandler = ({ url, locals }) => {
	if (!locals.user || !isAdmin(locals.user)) throw error(403, 'Not allowed');

	const q = (url.searchParams.get('q') ?? '').trim().toLowerCase();
	if (q.length < 2) return json([]);

	const starts: { id: number; name: string }[] = [];
	const contains: { id: number; name: string }[] = [];
	for (const it of ITEMS) {
		const n = it.name.toLowerCase();
		if (n.startsWith(q)) starts.push(it);
		else if (n.includes(q)) contains.push(it);
	}
	return json([...starts, ...contains].slice(0, 25));
};

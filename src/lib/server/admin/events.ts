import { error } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { markdownPreview } from '$lib/markdown';
import { listTemplates } from '$lib/server/eventStructure';

// Data for /admin/events (instant navigation): every event (personal boards
// excluded) plus the create form's pack names and structure templates.

export async function buildEvents() {
	const [eventsRes, packsRes] = await Promise.all([
		db()
			.from('vs_events')
			.select(
				'id, slug, name, kind, description, status, signup_opens_at, signup_closes_at, starts_at, ends_at, team_size, created_at'
			)
			.neq('kind', 'personal') // hide personal boards (one per user); shared events still show
			.order('created_at', { ascending: false }),
		// Pack names power the create form's reward <datalist>.
		db().from('vs_card_packs').select('name').order('name', { ascending: true })
	]);

	if (eventsRes.error) throw error(500, eventsRes.error.message);

	return {
		events: (eventsRes.data ?? []).map((ev) => ({
			...ev,
			description_preview: markdownPreview(ev.description, 200)
		})),
		packNames: (packsRes.data ?? []).map((p) => p.name as string),
		templates: listTemplates()
	};
}

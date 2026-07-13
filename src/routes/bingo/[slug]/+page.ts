import { redirect } from '@sveltejs/kit';
import type { PageLoad } from './$types';

// Bingo boards moved onto the unified event URL — one page per event slug,
// whatever its kind. Old /bingo/[slug] links (Discord embeds, bookmarks)
// keep working via this redirect.
export const load: PageLoad = ({ params }) => {
	redirect(301, `/events/${params.slug}`);
};

import { json, error } from '@sveltejs/kit';
import { buildBingoDetail } from '$lib/server/bingoPage';
import type { RequestHandler } from './$types';

// Data for the /bingo/[slug] board page. The page has NO server load — its
// universal load fires this fetch without awaiting it. Draft/preview redaction
// happens in the builder, so scrubbed tile names never leave the server.
export const GET: RequestHandler = async ({ locals, params }) => {
	if (!locals.user) throw error(401, 'Not signed in');
	const detail = await buildBingoDetail(locals.user, params.slug);
	return json(detail, { headers: { 'cache-control': 'no-store' } });
};

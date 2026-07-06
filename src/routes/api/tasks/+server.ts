import { json, error } from '@sveltejs/kit';
import { loadPlayerTasks } from '$lib/server/tasks';
import type { RequestHandler } from './$types';

// Data for the /tasks (To Do) page. The page has NO server load — its universal
// load fires this fetch without awaiting it, so navigating here is instant.
export const GET: RequestHandler = async ({ locals }) => {
	if (!locals.user) throw error(401, 'Not signed in');
	const tasks = await loadPlayerTasks(locals.user);
	return json({ tasks }, { headers: { 'cache-control': 'no-store' } });
};

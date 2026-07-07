import { db } from '$lib/server/db';

// Data for /admin/tasks (instant navigation): the weekly rotation POOL
// (templates) + the active task INSTANCES players submit to. Tasks are separate
// from full events (vs_events); see CLAUDE.md.

export async function buildTasks() {
	const sb = db();
	const [templatesRes, activeRes] = await Promise.all([
		sb
			.from('vs_tasks')
			.select('id, name, description, kind, vp_reward, pack_reward, in_rotation, created_at')
			.eq('is_template', true)
			.order('name', { ascending: true }),
		sb
			.from('vs_tasks')
			.select('id, name, description, kind, vp_reward, pack_reward, starts_at, ends_at, created_at')
			.eq('is_template', false)
			.eq('status', 'open')
			.order('created_at', { ascending: false })
	]);

	return {
		templates: templatesRes.data ?? [],
		active: activeRes.data ?? []
	};
}

<script lang="ts">
	// Shared sub-navigation for the "Events & Tasks" admin area. Events and Tasks
	// are separate routes; this bar links between them and highlights the active
	// one from the current URL (mirrors CardsTabs).
	import { page } from '$app/stores';

	type TabDef = { label: string; href: string; path: string };

	const TABS: TabDef[] = [
		{ label: 'Events', href: '/admin/events', path: '/admin/events' },
		{ label: 'Tasks', href: '/admin/tasks', path: '/admin/tasks' },
		{ label: 'Submissions', href: '/admin/submissions', path: '/admin/submissions' }
	];

	let path = $derived($page.url.pathname);
</script>

<h1 class="panel-title">Events &amp; Tasks</h1>
<nav class="tabs">
	{#each TABS as t (t.href)}
		<a class="tab" class:active={t.path === path} href={t.href}>{t.label}</a>
	{/each}
</nav>

<style>
	.panel-title {
		margin: 0 0 0.75rem;
	}

	.tabs {
		display: flex;
		flex-wrap: wrap;
		gap: 0.25rem;
		margin-bottom: 1.25rem;
		border-bottom: 1px solid var(--border);
	}

	.tab {
		display: inline-flex;
		align-items: center;
		gap: 0.4rem;
		padding: 0.55rem 1rem;
		border-bottom: 2px solid transparent;
		color: var(--muted);
		font-size: 1rem;
		text-decoration: none;
		transition: color 0.15s, border-color 0.15s;
	}

	.tab:hover {
		color: var(--text);
		text-decoration: none;
	}

	.tab.active {
		color: var(--accent);
		border-bottom-color: var(--accent);
	}
</style>

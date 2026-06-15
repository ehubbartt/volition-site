<script lang="ts">
	// Shared sub-navigation for the "Moderation" admin area. Bans & Warnings and the
	// Audit Log are separate routes; this bar links between them and highlights the
	// active one from the current URL (mirrors EventsTasksTabs).
	import { page } from '$app/stores';

	type TabDef = { label: string; href: string; path: string };

	const TABS: TabDef[] = [
		{ label: 'Bans & Warnings', href: '/admin/moderation', path: '/admin/moderation' },
		{ label: 'Audit Log', href: '/admin/audit', path: '/admin/audit' }
	];

	let path = $derived($page.url.pathname);
</script>

<h1 class="panel-title">Moderation</h1>
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

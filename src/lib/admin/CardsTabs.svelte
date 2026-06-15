<script lang="ts">
	// Shared sub-navigation for the card-game admin tools. Cards / Packs / Grant
	// are in-page tabs on /admin/cards (driven by ?tab=); the rest are their own
	// routes. Active state is computed from the current URL so every page that
	// renders this bar highlights the right tab.
	import { page } from '$app/stores';

	type TabDef = { label: string; href: string; path: string; sub?: string };

	const TABS: TabDef[] = [
		{ label: 'Cards', href: '/admin/cards', path: '/admin/cards', sub: 'cards' },
		{ label: 'Packs', href: '/admin/cards?tab=packs', path: '/admin/cards', sub: 'packs' },
		{ label: 'Grant', href: '/admin/cards?tab=grant', path: '/admin/cards', sub: 'grant' },
		{ label: 'Pack Tester', href: '/admin/pack-tester', path: '/admin/pack-tester' },
		{ label: 'Pack Simulator', href: '/admin/pack-sim', path: '/admin/pack-sim' },
		{ label: 'Pack Stats', href: '/admin/pack-stats', path: '/admin/pack-stats' }
	];

	let path = $derived($page.url.pathname);
	let sub = $derived($page.url.searchParams.get('tab') ?? 'cards');

	function isActive(t: TabDef): boolean {
		if (t.path !== path) return false;
		return t.sub ? t.sub === sub : true;
	}
</script>

<h1 class="panel-title">Cards &amp; Packs</h1>
<nav class="tabs">
	{#each TABS as t (t.href)}
		<a class="tab" class:active={isActive(t)} href={t.href}>{t.label}</a>
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

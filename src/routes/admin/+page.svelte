<script lang="ts">
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();

	type Tool = { href: string; title: string; desc: string; show: boolean };

	let tools = $derived<Tool[]>([
		{
			href: '/admin/events',
			title: 'Events & Tasks',
			desc: 'Manage events, the weekly task pool, and review pending submissions.',
			show: data.admin
		},
		{
			href: '/admin/cards',
			title: 'Cards & Packs',
			desc: data.cardTester
				? 'Author cards & packs, grant packs, and test/simulate opens.'
				: 'View cards & packs (read-only), grant packs, and test/simulate opens.',
			show: data.admin || data.cardTester
		},
		{
			href: '/admin/moderation',
			title: 'Moderation',
			desc: 'Bans, warnings, and the audit log of every admin action.',
			show: data.admin
		},
		{
			href: '/admin/stats',
			title: 'Clan Stats',
			desc: 'Members & economy stats, member wallets, and voice activity.',
			show: data.admin
		},
		{
			href: '/admin/crate-sim',
			title: 'Crate Simulator',
			desc: 'Bulk-simulate gamba crate opens — VP/GP generated, return ratio, and drop rates.',
			show: data.admin
		},
		{
			href: '/admin/guides',
			title: 'Guides',
			desc: 'Admin documentation: tile event, join process, bot commands.',
			show: data.admin
		},
		{
			href: '/admin/config',
			title: 'Database',
			desc: 'Bot config, any database table, and player card inventories. Super-admins only.',
			show: data.superAdmin
		},
		{
			href: '/admin/ehb',
			title: 'EHB Drop Tool 🧪',
			desc: 'Experimental: look up an item’s drop rate & EHB cost, or find drops matching an EHB target. (Temporary.)',
			show: data.admin
		}
	]);

	let visible = $derived(tools.filter((t) => t.show));
</script>

<svelte:head>
	<title>Admin · Volition</title>
</svelte:head>

<section>
	<h1>Admin</h1>
	<p class="muted">Tools and controls for managing the site.</p>

	<div class="tool-grid">
		{#each visible as tool (tool.href)}
			<a class="tool" href={tool.href}>
				<strong>{tool.title}</strong>
				<span class="muted">{tool.desc}</span>
			</a>
		{/each}
	</div>
</section>

<style>
	h1 {
		margin-bottom: 0.25rem;
	}

	.muted {
		color: var(--muted);
	}

	.tool-grid {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(15rem, 1fr));
		gap: 1rem;
		margin-top: 1.5rem;
	}

	.tool {
		display: flex;
		flex-direction: column;
		gap: 0.4rem;
		padding: 1.25rem;
		background: linear-gradient(180deg, rgba(58, 48, 36, 0.85), rgba(40, 32, 24, 0.85));
		border: 1px solid var(--border);
		border-radius: var(--radius);
		box-shadow: var(--shadow-card);
		text-decoration: none;
		color: var(--text);
		transition: border-color 0.15s, transform 0.15s, box-shadow 0.15s;
	}

	.tool:hover {
		border-color: var(--accent);
		transform: translateY(-2px);
		text-decoration: none;
	}

	.tool strong {
		font-family: 'rsbold', ui-sans-serif, Arial, sans-serif;
		font-size: 1.15rem;
		color: var(--accent);
		text-shadow: var(--ts);
	}

	.tool span {
		font-size: 0.9rem;
		line-height: 1.4;
	}
</style>

<script lang="ts">
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();

	type Tool = { href: string; title: string; desc: string; show: boolean };

	let tools = $derived<Tool[]>([
		{
			href: '/admin/events',
			title: 'Events',
			desc: 'Create and edit events — signups, dates, and status.',
			show: data.admin
		},
		{
			href: `/admin/bingo/${data.bingoSlug}/review`,
			title: 'Bingo review',
			desc: 'Approve or reject pending bingo submissions.',
			show: data.admin
		},
		{
			href: '/admin/cards',
			title: 'Cards & Packs',
			desc: 'Author the TCG card and pack catalog.',
			show: data.cardTester
		},
		{
			href: '/admin/pack-tester',
			title: 'Pack Tester',
			desc: 'Open any pack infinitely to test the 3D opener — nothing saved.',
			show: data.cardTester
		},
		{
			href: '/admin/pack-sim',
			title: 'Pack Simulator',
			desc: 'Bulk-open a pack thousands of times and see the drop-rate results.',
			show: data.cardTester
		},
		{
			href: '/admin/player-stats',
			title: 'Player Stats',
			desc: 'Per-player pack opens, VP spent, and collections across all players.',
			show: data.cardTester
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

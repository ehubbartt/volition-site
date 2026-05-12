<script lang="ts">
	import type { PageData } from './$types';
	import BoardMap from '$lib/board/BoardMap.svelte';
	import { getBoardTopology } from '$lib/board/topology';

	let { data }: { data: PageData } = $props();

	const topology = getBoardTopology();
</script>

<svelte:head>
	<title>{data.event.name} · Board · Volition</title>
</svelte:head>

<nav class="crumbs">
	<a href="/events/{data.event.slug}">← Back to {data.event.name}</a>
</nav>

<section class="hero">
	<div class="hero-head">
		<h1>{data.event.name} · Board</h1>
		<span class="badge {data.event.status}">{data.event.status}</span>
	</div>
	<p class="muted teaser">
		The board is sealed until the event begins. Tile contents will be revealed when your team
		reaches each section — for now, scroll and pan to see the shape of the climb.
	</p>
</section>

<BoardMap {topology} />

<style>
	.crumbs {
		margin-bottom: 0.75rem;
	}

	.crumbs a {
		color: rgba(255, 255, 255, 0.5);
		font-size: 0.95rem;
		text-decoration: none;
	}

	.crumbs a:hover {
		color: var(--accent);
	}

	.hero {
		margin-bottom: 1rem;
		padding: 1.1rem 1.4rem;
		background: linear-gradient(180deg, rgba(58, 48, 36, 0.7), rgba(40, 32, 24, 0.7));
		border: 1px solid var(--border);
		border-radius: var(--radius);
		box-shadow: var(--shadow-card);
	}

	.hero-head {
		display: flex;
		align-items: center;
		gap: 0.75rem;
		flex-wrap: wrap;
		margin-bottom: 0.4rem;
	}

	.hero h1 {
		margin: 0;
	}

	.teaser {
		max-width: 46rem;
		margin: 0;
	}

	.muted {
		color: var(--muted);
	}

	.badge {
		display: inline-block;
		padding: 0.1rem 0.55rem;
		font-size: 0.8rem;
		text-transform: uppercase;
		letter-spacing: 0.05em;
		border-radius: 3px;
		background: var(--surface-alt);
		border: 1px solid var(--border);
		color: var(--muted);
	}

	.badge.open {
		background: var(--accent-soft);
		border-color: var(--accent);
		color: var(--accent);
	}
</style>

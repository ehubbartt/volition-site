<script lang="ts">
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();
</script>

<svelte:head>
	<title>Events · Volition</title>
</svelte:head>

<section>
	<h1>Active events</h1>

	{#if data.events.length === 0}
		<p class="muted">No active events right now. Check back soon.</p>
	{:else}
		<ul class="events">
			{#each data.events as ev}
				<li>
					<a href={`/events/${ev.slug}`} class="event-card">
						<div class="event-name">{ev.name}</div>
						{#if ev.description_preview}
							<p class="muted">{ev.description_preview}</p>
						{/if}
						<div class="badge {ev.status}">{ev.status}</div>
					</a>
				</li>
			{/each}
		</ul>
	{/if}
</section>

<style>
	h1 {
		margin-bottom: 1.25rem;
	}

	.muted {
		color: var(--muted);
	}

	.events {
		list-style: none;
		padding: 0;
		margin: 0;
		display: grid;
		gap: 1rem;
		grid-template-columns: repeat(auto-fill, minmax(20rem, 1fr));
	}

	.event-card {
		display: block;
		padding: 1.25rem;
		background: linear-gradient(180deg, rgba(58, 48, 36, 0.85), rgba(40, 32, 24, 0.85));
		border: 1px solid var(--border);
		border-radius: var(--radius);
		text-decoration: none;
		color: inherit;
		box-shadow: var(--shadow-card);
		transition: border-color 0.15s, transform 0.15s, box-shadow 0.15s;
	}

	.event-card:hover {
		border-color: var(--accent);
		transform: translateY(-2px);
		box-shadow: 0 6px 20px rgba(0, 0, 0, 0.5), 0 0 0 1px rgba(255, 152, 31, 0.25);
		text-decoration: none;
	}

	.event-name {
		font-family: 'rsbold', ui-sans-serif, Arial, sans-serif;
		font-size: 1.2rem;
		color: var(--accent);
		text-shadow: 2px 2px #000;
		margin-bottom: 0.5rem;
	}

	.badge {
		display: inline-block;
		margin-top: 0.75rem;
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

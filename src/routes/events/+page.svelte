<script lang="ts">
	import type { PageData } from './$types';
	import { BINGO_EVENT_SLUG } from '$lib/bingo/config';

	let { data }: { data: PageData } = $props();

	function hrefFor(slug: string): string {
		return slug === BINGO_EVENT_SLUG ? `/bingo/${slug}` : `/events/${slug}`;
	}

	function fmtDate(iso: string | null): string | null {
		if (!iso) return null;
		try {
			return new Date(iso).toLocaleString(undefined, {
				month: 'short',
				day: 'numeric',
				hour: 'numeric',
				minute: '2-digit'
			});
		} catch {
			return iso;
		}
	}
</script>

<svelte:head>
	<title>Events · Volition</title>
</svelte:head>

{#snippet eventCard(ev: PageData['events'][number], past: boolean)}
	{@const isBingo = ev.slug === BINGO_EVENT_SLUG}
	{@const isDraft = ev.status === 'draft'}
	{@const isPreview = ev.status === 'preview'}
	<li>
		<a
			href={hrefFor(ev.slug)}
			class="event-card"
			class:bingo={isBingo}
			class:draft={isDraft}
			class:preview={isPreview}
			class:past
		>
			<div class="event-name">{ev.name}</div>
			{#if ev.description_preview}
				<p class="muted">{ev.description_preview}</p>
			{/if}
			{#if ev.status_line}
				<div class="status-line">
					<span class="label">{ev.status_line.label}</span>
					<span class="when">{fmtDate(ev.status_line.date)}</span>
				</div>
			{/if}
			<div
				class="badge"
				class:bingo={isBingo && !isDraft && !isPreview && !past}
				class:open={ev.status === 'open' && !isBingo}
				class:draft={isDraft}
				class:preview={isPreview}
			>
				{isDraft
					? 'Draft · admin only'
					: isPreview
						? 'Preview · admin only'
						: past
							? 'Closed'
							: isBingo
								? 'Bingo'
								: ev.status}
			</div>
		</a>
	</li>
{/snippet}

<section>
	<h1>Active events</h1>

	{#if data.events.length === 0}
		<p class="muted">No active events right now. Check back soon.</p>
	{:else}
		<ul class="events">
			{#each data.events as ev}
				{@render eventCard(ev, false)}
			{/each}
		</ul>
	{/if}
</section>

{#if data.pastEvents.length > 0}
	<section class="past-section">
		<h2>Past events</h2>
		<ul class="events">
			{#each data.pastEvents as ev}
				{@render eventCard(ev, true)}
			{/each}
		</ul>
	</section>
{/if}

<style>
	h1 {
		margin-bottom: 1.25rem;
	}

	.past-section {
		margin-top: 2.5rem;
	}

	.past-section h2 {
		margin-bottom: 1.25rem;
		color: var(--muted);
	}

	.event-card.past {
		opacity: 0.6;
		filter: saturate(0.7);
	}

	.event-card.past:hover {
		opacity: 1;
	}

	.event-card.past .event-name {
		color: var(--muted);
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

	.status-line {
		margin: 0.65rem 0 0;
		padding: 0.4rem 0.6rem;
		background: var(--surface-alt);
		border: 1px solid var(--border);
		border-radius: 3px;
		display: flex;
		align-items: baseline;
		justify-content: space-between;
		gap: 0.6rem;
		flex-wrap: wrap;
	}

	.status-line .label {
		font-family: var(--font-heading);
		font-size: 0.72rem;
		letter-spacing: 1px;
		text-transform: uppercase;
		color: var(--muted);
	}

	.status-line .when {
		font-size: 0.9rem;
		color: var(--yellow);
		font-family: var(--font-heading);
		text-shadow: var(--ts);
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

	.badge.bingo {
		background: var(--accent);
		border-color: var(--accent);
		color: #1a1208;
		text-shadow: none;
	}

	.event-card.bingo .event-name {
		color: var(--yellow);
	}

	.event-card.draft {
		border-style: dashed;
		opacity: 0.85;
	}

	.event-card.draft .event-name {
		color: var(--muted);
	}

	.badge.draft {
		background: transparent;
		border-color: var(--border-strong);
		border-style: dashed;
		color: var(--muted);
	}

	.event-card.preview {
		border-color: var(--accent);
		border-style: dashed;
	}

	.event-card.preview .event-name {
		color: var(--accent);
	}

	.badge.preview {
		background: var(--accent-soft);
		border-color: var(--accent);
		border-style: dashed;
		color: var(--accent);
	}
</style>

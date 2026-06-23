<script lang="ts">
	import type { PageData } from './$types';
	import { BINGO_EVENT_SLUG } from '$lib/bingo/config';
	import { isTaskEvent } from '$lib/events/simple';

	let { data }: { data: PageData } = $props();

	// Route by event kind: bingo + duo keep their bespoke pages; task events (open /
	// sequential) use the generic /event/[slug] page; anything else (legacy/custom)
	// falls back to the /events/[slug] detail page.
	function hrefFor(ev: { slug: string; kind?: string | null }): string {
		if (ev.slug === BINGO_EVENT_SLUG || ev.kind === 'bingo') return `/bingo/${ev.slug}`;
		if (isTaskEvent(ev.kind)) return `/event/${ev.slug}`;
		return `/events/${ev.slug}`;
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

{#snippet eventCard(ev: PageData['activeEvents'][number], section: 'active' | 'upcoming' | 'past')}
	{@const past = section === 'past'}
	{@const isBingo = ev.slug === BINGO_EVENT_SLUG}
	{@const isDraft = ev.status === 'draft'}
	{@const isPreview = ev.status === 'preview'}
	{@const isUpcoming = section === 'upcoming' && !isDraft && !isPreview}
	<li>
		<a
			href={hrefFor(ev)}
			class="event-card"
			class:bingo={isBingo}
			class:draft={isDraft}
			class:preview={isPreview}
			class:past
		>
			<div class="event-name">{ev.name}</div>
			{#if ev.description_preview}
				<p class="desc muted">{ev.description_preview}</p>
			{/if}
			<div class="event-foot">
				{#if ev.status_line}
					<div class="status-line">
						<span class="label">{ev.status_line.label}</span>
						{#if ev.status_line.date}
							<span class="when">{fmtDate(ev.status_line.date)}</span>
						{/if}
					</div>
				{/if}
				<div class="foot-tags">
					<div
						class="badge"
						class:bingo={isBingo && !isDraft && !isPreview && !past && !isUpcoming}
						class:open={ev.status === 'open' && !isBingo && !isUpcoming}
						class:upcoming={isUpcoming}
						class:draft={isDraft}
						class:preview={isPreview}
					>
						{isDraft
							? 'Draft · admin only'
							: isPreview
								? 'Preview · admin only'
								: past
									? 'Closed'
									: isUpcoming
										? 'Upcoming'
										: isBingo
											? 'Bingo'
											: ev.status}
					</div>
					{#if ev.signedUp && !past}
						<span class="signed">✓ Signed up</span>
					{/if}
				</div>
			</div>
		</a>
	</li>
{/snippet}

<section>
	<h1>Active events</h1>

	{#if data.activeEvents.length === 0}
		<p class="muted">No events need your attention right now.</p>
	{:else}
		<ul class="events">
			{#each data.activeEvents as ev (ev.id)}
				{@render eventCard(ev, 'active')}
			{/each}
		</ul>
	{/if}
</section>

{#if data.upcomingEvents.length > 0}
	<section class="upcoming-section">
		<h2>Upcoming events</h2>
		<ul class="events">
			{#each data.upcomingEvents as ev (ev.id)}
				{@render eventCard(ev, 'upcoming')}
			{/each}
		</ul>
	</section>
{/if}

{#if data.pastEvents.length > 0}
	<section class="past-section">
		<h2>Past events</h2>
		<ul class="events">
			{#each data.pastEvents as ev (ev.id)}
				{@render eventCard(ev, 'past')}
			{/each}
		</ul>
	</section>
{/if}

<style>
	h1 {
		margin-bottom: 1.25rem;
	}

	.upcoming-section {
		margin-top: 2.5rem;
	}

	.upcoming-section h2 {
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

	/* Each li is the grid cell; the card fills it so a whole row matches height. */
	.events li {
		display: flex;
	}

	.event-card {
		display: flex;
		flex-direction: column;
		width: 100%;
		min-height: 11rem;
		padding: 1.25rem;
		background-color: #4d4030;
		background-image: var(--stone-tile);
		background-repeat: repeat;
		border: 4px solid transparent;
		border-image: url('/osrs/border-tiny.png') 4 / 4px round;
		border-radius: 4px;
		text-decoration: none;
		color: inherit;
		transition: transform 0.15s, box-shadow 0.15s;
	}

	.event-card:hover {
		transform: translateY(-2px);
		box-shadow: 0 6px 20px rgba(0, 0, 0, 0.5), 0 0 0 2px rgba(255, 152, 31, 0.4);
		text-decoration: none;
	}

	.event-name {
		font-family: 'rsbold', ui-sans-serif, Arial, sans-serif;
		font-size: 1.2rem;
		color: var(--accent);
		text-shadow: 2px 2px #000;
		margin-bottom: 0.5rem;
	}

	/* Clamp the blurb to 2 lines so card height doesn't swing with text length. */
	.desc {
		margin: 0;
		font-size: 0.9rem;
		line-height: 1.4;
		display: -webkit-box;
		-webkit-box-orient: vertical;
		-webkit-line-clamp: 2;
		line-clamp: 2;
		overflow: hidden;
	}

	/* Footer (status + badge) pinned to the bottom so every card lines up. */
	.event-foot {
		margin-top: auto;
		padding-top: 0.75rem;
	}

	.status-line {
		margin: 0 0 0;
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

	.foot-tags {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		flex-wrap: wrap;
		margin-top: 0.75rem;
	}

	.foot-tags .badge {
		margin-top: 0;
	}

	.signed {
		padding: 0.1rem 0.5rem;
		font-size: 0.72rem;
		border-radius: 999px;
		background: var(--accent-soft);
		border: 1px solid var(--accent);
		color: var(--accent);
		font-family: ui-sans-serif, system-ui, Arial, sans-serif;
		white-space: nowrap;
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

	.badge.upcoming {
		background: transparent;
		border-color: var(--yellow);
		color: var(--yellow);
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

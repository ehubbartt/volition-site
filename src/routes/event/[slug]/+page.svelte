<script lang="ts">
	import type { PageData } from './$types';
	import EventTaskCard from '$lib/events/EventTaskCard.svelte';
	import { formatCountdown } from '$lib/tasks';

	let { data }: { data: PageData } = $props();

	let total = $derived(data.tasks.length);

	// Live countdown to the event's start (only while it's upcoming).
	let now = $state(Date.now());
	$effect(() => {
		if (!data.upcoming) return;
		const id = setInterval(() => (now = Date.now()), 1000);
		return () => clearInterval(id);
	});
	let opensInMs = $derived(
		data.event.starts_at ? new Date(data.event.starts_at).getTime() - now : 0
	);
</script>

<svelte:head>
	<title>{data.event.name} · Volition</title>
</svelte:head>

<section class="head">
	<a class="back" href="/events">← Events</a>
	<h1>{data.event.name}</h1>
	{#if data.event.status !== 'open'}
		<span class="status-pill">{data.event.status === 'closed' ? 'Ended' : data.event.status}</span>
	{/if}
</section>

{#if data.event.description_html}
	<div class="panel desc">{@html data.event.description_html}</div>
{/if}

{#if total > 0}
	<div class="progress">
		<span class="count">{data.completedCount}/{total}</span> tasks completed
		{#if data.event.sequential}<span class="seq-tag">· complete in order</span>{/if}
		<div class="bar"><div class="fill" style="width:{total ? (data.completedCount / total) * 100 : 0}%"></div></div>
	</div>
{/if}

{#if data.adminPreview}
	<p class="panel preview-note">
		👁️ <strong>Preview</strong> — this {data.event.status} event isn't visible to players yet. As an
		admin you can test submissions here; set it to <strong>open</strong> to launch.
	</p>
{:else if data.upcoming}
	<p class="panel preview-note">
		🕒 <strong>Upcoming</strong> — submissions
		{#if opensInMs > 0}
			open in <strong>{formatCountdown(opensInMs)}</strong>.
		{:else}
			are opening now — refresh the page to submit.
		{/if}
	</p>
{:else if !data.isClanMember}
	<p class="panel note">
		Only Volition clan members can submit. If you've recently joined, ping an admin to be added to the
		clan list.
	</p>
{:else if data.event.status !== 'open'}
	<p class="panel note">
		This event {data.event.status === 'closed' ? 'has ended' : 'is not open yet'} — submissions are
		closed.
	</p>
{/if}

{#if total === 0}
	<p class="panel note">No tasks have been added to this event yet. Check back soon.</p>
{:else}
	{#each data.tasks as task (task.id)}
		<EventTaskCard {task} canSubmit={data.canSubmit} />
	{/each}
{/if}

<style>
	.head {
		display: flex;
		align-items: baseline;
		gap: 1rem;
		flex-wrap: wrap;
		margin-bottom: 1rem;
	}
	.head h1 {
		font-family: var(--font-heading);
		font-size: 2rem;
		margin: 0;
		text-shadow: var(--ts);
	}
	.back {
		color: var(--muted);
		text-decoration: none;
		font-size: 0.9rem;
	}
	.back:hover {
		color: var(--accent);
	}
	.status-pill {
		text-transform: uppercase;
		font-family: var(--font-heading);
		font-size: 0.72rem;
		letter-spacing: 0.5px;
		padding: 0.1rem 0.5rem;
		border-radius: 3px;
		border: 1px solid var(--border);
		color: var(--muted);
	}
	.panel {
		background: linear-gradient(180deg, rgba(58, 48, 36, 0.6), rgba(40, 32, 24, 0.6));
		border: 1px solid var(--border);
		border-radius: var(--radius);
		box-shadow: var(--shadow-card);
		padding: 1.1rem 1.25rem;
		margin-bottom: 1rem;
	}
	.desc :global(p) {
		margin: 0 0 0.5rem;
	}
	.desc :global(:last-child) {
		margin-bottom: 0;
	}
	.desc :global(a) {
		color: var(--accent);
	}
	.note {
		color: var(--muted);
	}
	.preview-note {
		border-color: var(--accent);
		background: var(--accent-soft);
	}
	.progress {
		margin-bottom: 1.25rem;
		font-size: 0.9rem;
		color: var(--muted);
	}
	.progress .count {
		font-family: var(--font-heading);
		color: var(--accent);
		font-size: 1.05rem;
		text-shadow: var(--ts);
	}
	.seq-tag {
		color: var(--muted);
	}
	.bar {
		margin-top: 0.4rem;
		height: 0.5rem;
		background: var(--surface-alt);
		border: 1px solid var(--border);
		border-radius: 999px;
		overflow: hidden;
		max-width: 22rem;
	}
	.fill {
		height: 100%;
		background: var(--accent);
		border-radius: 999px;
		transition: width 0.3s ease-out;
	}
</style>

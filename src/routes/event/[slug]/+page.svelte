<script lang="ts">
	import type { PageData } from './$types';
	import { goto } from '$app/navigation';
	import EventTaskCard from '$lib/events/EventTaskCard.svelte';
	import Skeleton from '$lib/Skeleton.svelte';
	import { formatCountdown } from '$lib/tasks';

	let { data: pageData }: { data: PageData } = $props();

	// Streamed stale-while-revalidate payload (see +page.ts), shadowed under the
	// old `data` name. Cached redirect/not-found outcomes are never acted on —
	// only the fresh response decides those.
	type Detail = Extract<NonNullable<PageData['detail']['cached']>, { kind: 'ok' }>;
	const EMPTY_DETAIL = {
		kind: 'ok',
		event: {
			slug: '',
			name: '',
			kind: 'simple',
			sequential: false,
			description_html: '',
			status: 'open',
			starts_at: null,
			ends_at: null
		},
		tasks: [],
		completedCount: 0,
		isClanMember: false,
		adminPreview: false,
		upcoming: false,
		ended: false,
		canSubmit: false
	} as unknown as Detail;
	let loadedDetail = $state<Detail | null>(null);
	let notFound = $state(false);
	$effect(() => {
		const src = pageData.detail;
		let current = true;
		src.fresh.then((d) => {
			if (!current) return;
			if (!d || d.kind === 'not_found') {
				notFound = true;
				return;
			}
			if (d.kind === 'redirect') {
				goto(d.to, { replaceState: true });
				return;
			}
			notFound = false;
			loadedDetail = d;
		});
		return () => {
			current = false;
		};
	});
	// Cached fallback is SYNCHRONOUS so revisits (incl. back/forward) first-paint
	// with real content; a cached redirect/not-found is never acted on.
	const detail = $derived(
		loadedDetail ?? (pageData.detail.cached?.kind === 'ok' ? pageData.detail.cached : null)
	);
	const data = $derived(detail ?? EMPTY_DETAIL);
	const ready = $derived(detail !== null);

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

{#if notFound}
	<section class="head">
		<a class="back" href="/events">← Events</a>
		<h1>Event not found</h1>
	</section>
	<p class="muted">This event doesn't exist or isn't visible to you.</p>
{:else if !ready}
	<section class="head">
		<a class="back" href="/events">← Events</a>
		<Skeleton height="2.2rem" width="16rem" radius="6px" />
	</section>
	<div class="task-skeletons">
		{#each { length: 3 }, i (i)}
			<Skeleton height="7rem" radius="8px" />
		{/each}
	</div>
{:else}
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
{:else if data.ended}
	<p class="panel note">
		🏁 <strong>This event has ended</strong> — submissions are closed.
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

{/if}
<style>
	.task-skeletons {
		display: flex;
		flex-direction: column;
		gap: 0.8rem;
		margin-top: 1rem;
	}

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

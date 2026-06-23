<script lang="ts">
	import { invalidateAll } from '$app/navigation';
	import { onMount } from 'svelte';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();

	const working = $derived(data.drops.length > 0);

	// Poll the server every 10s so a drop shows up shortly after it happens — no manual
	// refresh needed while the player is killing something to test their setup.
	let refreshing = $state(false);
	onMount(() => {
		const t = setInterval(async () => {
			refreshing = true;
			try {
				await invalidateAll();
			} finally {
				refreshing = false;
			}
		}, 10_000);
		return () => clearInterval(t);
	});

	function fmtTime(iso: string): string {
		try {
			return new Date(iso).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit', second: '2-digit' });
		} catch {
			return iso;
		}
	}
</script>

<svelte:head><title>Test your Dink · Volition</title></svelte:head>

<section class="dc">
	<a class="back" href="/events">← Events</a>
	<h1>Test your Dink setup</h1>
	<p class="muted">
		This checks that drops from RuneLite are reaching the clan tracker for your account
		(<strong>{data.rsn}</strong>). Use it before an event to make sure auto-tracking will
		credit you — no screenshots needed.
	</p>

	<div class="status" class:good={working} class:wait={!working}>
		{#if working}
			<div class="status-icon">✓</div>
			<div>
				<h2>Dink is working!</h2>
				<p>We received {data.drops.length} drop{data.drops.length === 1 ? '' : 's'} from your account in the last {data.windowMinutes} minutes.</p>
			</div>
		{:else}
			<div class="status-icon">…</div>
			<div>
				<h2>Waiting for a drop</h2>
				<p>No drops received yet. Follow the steps below — this page refreshes itself every few seconds{#if refreshing} <span class="dot">●</span>{/if}.</p>
			</div>
		{/if}
	</div>

	<div class="card">
		<h3>How to test</h3>
		<ol>
			<li>Install <strong>RuneLite</strong> and enable the <strong>Dink</strong> plugin.</li>
			<li>
				Make sure your Dink <em>Primary webhook URL</em> is set to the clan proxy URL an admin gave you
				(it should be the only URL in that box).
			</li>
			<li>
				Log in to OSRS on <strong>{data.rsn}</strong> and get any easy drop —
				{#if data.selfTestReady}
					the <a href="/bingo/{data.selfTestSlug}">Dink Self-Test</a> tracks trivial items like
					<strong>Bones</strong>, <strong>Cowhide</strong>, <strong>Feathers</strong> or a
					<strong>Raw chicken</strong>. Go kill a few chickens or cows.
				{:else}
					kill something that's part of an active event's tracked items.
				{/if}
			</li>
			<li>Leave this page open — when the drop arrives it appears below within ~10 seconds.</li>
		</ol>
		{#if !data.selfTestReady}
			<p class="muted small">
				⚠ The self-test event isn't open right now. Ask an admin to enable it, or test during a live event.
			</p>
		{/if}
	</div>

	<div class="card">
		<h3>Recent drops <span class="muted small">(last {data.windowMinutes} min)</span></h3>
		{#if data.drops.length === 0}
			<p class="muted">Nothing yet.</p>
		{:else}
			<ul class="drops">
				{#each data.drops as d (d.id)}
					<li>
						<span class="item">{d.item_name ?? `#${d.item_id}`}{#if d.quantity > 1} ×{d.quantity}{/if}</span>
						{#if d.source}<span class="src muted">from {d.source}</span>{/if}
						{#if d.event_name}<span class="ev">{d.event_name}</span>{/if}
						<span class="time muted">{fmtTime(d.received_at)}</span>
					</li>
				{/each}
			</ul>
		{/if}
	</div>
</section>

<style>
	.dc { max-width: 720px; margin: 0 auto; padding: 1.5rem 1rem 4rem; }
	.back { color: var(--accent); text-decoration: none; font-size: 0.9rem; }
	h1 { margin: 0.3rem 0 0.4rem; }
	.muted { color: var(--muted); }
	.small { font-size: 0.85rem; }
	.status {
		display: flex; align-items: center; gap: 1rem;
		border: 1px solid var(--border); border-radius: var(--radius);
		padding: 1.1rem 1.2rem; margin: 1.1rem 0;
		background: linear-gradient(180deg, rgba(58, 48, 36, 0.85), rgba(40, 32, 24, 0.85));
	}
	.status.good { border-color: var(--success); }
	.status.wait { border-color: var(--yellow); }
	.status h2 { margin: 0 0 0.2rem; font-size: 1.1rem; }
	.status.good h2 { color: var(--success); }
	.status.wait h2 { color: var(--yellow); }
	.status p { margin: 0; }
	.status-icon { font-size: 2rem; line-height: 1; }
	.status.good .status-icon { color: var(--success); }
	.status.wait .status-icon { color: var(--yellow); }
	.dot { color: var(--success); animation: pulse 1s infinite; }
	@keyframes pulse { 0%, 100% { opacity: 0.3; } 50% { opacity: 1; } }
	.card {
		background: linear-gradient(180deg, rgba(58, 48, 36, 0.85), rgba(40, 32, 24, 0.85));
		border: 1px solid var(--border); border-radius: var(--radius);
		box-shadow: var(--shadow-card); padding: 1.1rem 1.2rem; margin-top: 1.1rem;
	}
	.card h3 { margin: 0 0 0.6rem; }
	.card ol { margin: 0; padding-left: 1.2rem; line-height: 1.6; }
	.card li { margin-bottom: 0.3rem; }
	a { color: var(--accent); }
	.drops { list-style: none; margin: 0; padding: 0; }
	.drops li {
		display: flex; align-items: baseline; gap: 0.6rem; flex-wrap: wrap;
		padding: 0.45rem 0; border-bottom: 1px solid var(--border);
	}
	.drops li:last-child { border-bottom: none; }
	.item { font-family: var(--font-heading); color: var(--accent); }
	.ev { font-size: 0.78rem; padding: 0.05rem 0.4rem; border-radius: 999px; border: 1px solid var(--border); }
	.time { margin-left: auto; font-size: 0.85rem; }
</style>

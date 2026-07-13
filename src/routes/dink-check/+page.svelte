<script lang="ts">
	import { invalidateAll } from '$app/navigation';
	import { enhance } from '$app/forms';
	import { onMount } from 'svelte';
	import BingoTile from '$lib/BingoTile.svelte';
	import { itemImageUrl } from '$lib/wikiImage';
	import type { PageData, ActionData } from './$types';

	let { data, form }: { data: PageData; form: ActionData } = $props();

	// "Reset test" stamps a cutoff (per browser) so the tile + list only count drops
	// after it — re-arms the test instantly without touching the tracking ledger.
	let resetAt = $state<string | null>(null);
	const RESET_KEY = 'dink-check-reset';
	function resetTest() {
		resetAt = new Date().toISOString();
		try {
			localStorage.setItem(RESET_KEY, resetAt);
		} catch {
			/* private mode etc. — reset just won't persist */
		}
	}

	const shownDrops = $derived(
		resetAt ? data.drops.filter((d) => d.received_at > resetAt!) : data.drops
	);
	const working = $derived(shownDrops.length > 0);
	// The test tile completes on a Bones drop — the one item every combat kill can supply.
	const bonesDone = $derived(
		shownDrops.some((d) => d.item_id === 526 || d.item_name?.toLowerCase() === 'bones')
	);

	// After a rotate the action returns the fresh URL; otherwise use the loaded one.
	const configUrl = $derived(form?.configUrl ?? data.configUrl);

	let copied = $state(false);
	async function copy() {
		if (!configUrl) return;
		try {
			await navigator.clipboard.writeText(configUrl);
			copied = true;
			setTimeout(() => (copied = false), 1500);
		} catch {
			copied = false;
		}
	}

	// Poll the server every 10s so a drop shows up shortly after it happens — no manual
	// refresh needed while the player is killing something to test their setup.
	let refreshing = $state(false);
	onMount(() => {
		try {
			resetAt = localStorage.getItem(RESET_KEY);
		} catch {
			/* ignore */
		}
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

	<div class="card url-card">
		<h3>Your personal Dink config URL</h3>
		<p class="muted small">
			Paste this into RuneLite → <strong>Dink</strong> plugin → <strong>Advanced Settings</strong> →
			<strong>Dynamic Config URL</strong>. It's tied to your account — <strong>don't share it</strong>.
			If it ever leaks, rotate it below and the old link stops working.
		</p>
		{#if configUrl}
			<div class="url-row">
				<code class="url">{configUrl}</code>
				<button type="button" class="copy" onclick={copy}>{copied ? '✓ Copied' : 'Copy'}</button>
			</div>
			<div class="url-actions">
				<form method="POST" action="?/rotate" use:enhance>
					<button type="submit" class="rotate">Rotate link</button>
				</form>
				<span class="muted small">Rotating revokes the current link and issues a new one.</span>
			</div>
		{:else}
			<p class="warn">
				⚠ The proxy URL isn't configured on the site yet (<code>PROXY_BASE_URL</code>), so your link can't
				be shown here. Use the Discord <strong>/dink</strong> command for now.
			</p>
		{/if}
		{#if form?.error}<p class="warn">{form.error}</p>{/if}
	</div>

	<div class="status" class:good={bonesDone} class:wait={!bonesDone}>
		<div class="quest-tile">
			<BingoTile
				image={itemImageUrl('Bones')}
				imageAlt="Bones"
				name="Bones"
				sub="any monster drops them"
				obtained={bonesDone}
				highlighted={bonesDone}
				title={bonesDone ? 'Tile complete!' : 'Kill anything that drops Bones'}
			/>
		</div>
		{#if bonesDone}
			<div>
				<h2>✓ Tile complete — Dink is working!</h2>
				<p>
					Your Bones made it all the way to the tracker. During events, your drops will credit
					your tiles exactly like this — no screenshots needed.
				</p>
				<button type="button" class="reset-btn" onclick={resetTest}>Reset test</button>
			</div>
		{:else}
			<div>
				<h2>Complete this tile</h2>
				<p>
					Kill <strong>anything that drops Bones</strong> — a chicken, cow, or goblin works.
					When the drop lands, the tile checks off like a real bingo tile. This page watches
					for it automatically{#if refreshing} <span class="dot">●</span>{/if}.
				</p>
				{#if working}
					<p class="muted small">
						We're already receiving your drops ({data.drops.length} in the last
						{data.windowMinutes} min) — grab those Bones to finish the tile.
					</p>
				{/if}
			</div>
		{/if}
	</div>

	<div class="card">
		<h3>How to set up &amp; test</h3>
		<p class="backup-note">
			<strong>Already use Dink with your own settings?</strong> Back them up first: type
			<code>::dinkexport</code> in the game chat — Dink copies your full current settings —
			and paste that somewhere safe. You can restore it any time, so guests joining us for
			an event can go right back to their own setup afterwards.
		</p>
		<ol>
			<li>Install <strong>RuneLite</strong> and enable the <strong>Dink</strong> plugin.</li>
			<li>
				<strong>Reset Dink's settings</strong> so old values don't linger under ours:
				<img
					class="guide-img"
					src="/dink-guide/reset.png"
					alt="Resetting the Dink plugin settings in RuneLite"
					loading="lazy"
				/>
			</li>
			<li>
				In Dink → Advanced Settings, set <strong>Import Policy</strong> to
				<strong>Overwrite Item Lists</strong> — this keeps your tracked-item list exactly in
				sync with ours as events come and go:
				<img
					class="guide-img"
					src="/dink-guide/overwrite.png"
					alt="Setting Dink's import policy to overwrite item lists"
					loading="lazy"
				/>
			</li>
			<li>
				Paste your personal config URL (above) into Dink → Advanced Settings →
				<strong>Dynamic Config URL</strong>. That's all the wiring it needs — the webhooks come from
				the config itself.
			</li>
			<li>
				Log in to OSRS on <strong>{data.rsn}</strong>, then complete the tile above: kill
				anything that drops <strong>Bones</strong>.
				{#if data.selfTestReady}
					No signup needed — opening this page armed the test for your account. If you set
					your config URL up a while ago, re-import your config first (see below).
				{:else}
					<span class="warn-inline">⚠ The self-test isn't enabled right now — ask an admin.</span>
				{/if}
			</li>
			<li>Leave this page open — the tile ticks within ~10 seconds of the drop.</li>
		</ol>

		<details class="guide">
			<summary>Not working? Re-import your config (takes 10 seconds)</summary>
			<p class="muted small">
				Dink only re-reads your config URL when RuneLite starts (or on login every few hours).
				To force it right now, toggle the <strong>Dink</strong> plugin off and back on in
				RuneLite's plugin list:
			</p>
			<img
				class="guide-img"
				src="/dink-guide/toggle-dink.gif"
				alt="Toggling the Dink plugin off and back on in RuneLite"
				loading="lazy"
			/>
			<p class="muted small">
				Then check your in-game chatbox for Dink's confirmation message — seeing it means the
				latest item list (including the test items) is loaded:
			</p>
			<img
				class="guide-img"
				src="/dink-guide/config-imported.png"
				alt="Dink chat message: Success: Updated config settings from import"
				loading="lazy"
			/>
		</details>
	</div>

	<div class="card">
		<h3>Recent drops <span class="muted small">(last {data.windowMinutes} min)</span></h3>
		{#if shownDrops.length === 0}
			<p class="muted">Nothing yet{resetAt ? ' since your last reset' : ''}.</p>
		{:else}
			<ul class="drops">
				{#each shownDrops as d (d.id)}
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
		display: flex; align-items: center; gap: 1.2rem; flex-wrap: wrap;
		padding: 1.1rem 1.2rem; margin: 1.1rem 0;
		background-color: var(--stone-fill);
		background-image: var(--stone-tile);
		background-repeat: repeat;
		border: 4px solid transparent;
		border-image: url('/osrs/border-tiny.png') 4 / 4px round;
		border-radius: 4px;
	}
	/* status colour accents shift the inner glow rather than the gold frame */
	.status.good { box-shadow: inset 0 0 0 2px var(--success); }
	.status.wait { box-shadow: inset 0 0 0 2px var(--yellow); }
	.status h2 { margin: 0 0 0.2rem; font-size: 1.1rem; }
	.status.good h2 { color: var(--success); }
	.status.wait h2 { color: var(--yellow); }
	.status p { margin: 0 0 0.35rem; }
	.status p:last-child { margin-bottom: 0; }
	/* The single quest tile: give the grid-item tile a fixed footprint. */
	.quest-tile { flex-shrink: 0; width: 8.5rem; display: grid; }
	.warn-inline { color: var(--yellow); }
	.reset-btn { margin-top: 0.6rem; padding: 0.3rem 0.8rem; min-height: 0; font-size: 0.85rem; }
	.guide { margin-top: 0.9rem; border-top: 1px solid var(--border); padding-top: 0.7rem; }
	.guide summary { cursor: pointer; color: var(--accent); font-size: 0.92rem; }
	.guide[open] summary { margin-bottom: 0.5rem; }
	.guide-img {
		display: block; max-width: 100%; margin: 0.4rem 0 0.8rem;
		border: 1px solid var(--border); border-radius: var(--radius);
	}
	.backup-note {
		margin: 0 0 0.9rem; padding: 0.6rem 0.8rem; font-size: 0.9rem;
		background: var(--accent-soft); border: 1px solid var(--accent);
		border-radius: var(--radius); color: var(--text);
	}
	.backup-note code { background: var(--surface-alt); padding: 0.05rem 0.35rem; border-radius: 3px; }
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
	.ev { font-size: 0.78rem; padding: 0.05rem 0.4rem; border-radius: 3px; border: 1px solid var(--border); }
	.time { margin-left: auto; font-size: 0.85rem; }
	.url-card .url-row { display: flex; gap: 0.5rem; align-items: stretch; margin: 0.6rem 0 0; flex-wrap: wrap; }
	.url { flex: 1; min-width: 14rem; padding: 0.5rem 0.7rem; background: var(--surface-alt); border: 1px solid var(--border); border-radius: var(--radius); overflow-x: auto; white-space: nowrap; font-size: 0.85rem; color: var(--text); }
	.copy { white-space: nowrap; }
	.url-actions { display: flex; align-items: center; gap: 0.7rem; margin-top: 0.6rem; flex-wrap: wrap; }
	.rotate { border-color: var(--yellow); color: var(--yellow); }
	.rotate:hover { background: var(--surface-alt); }
	.warn { color: var(--yellow); margin: 0.6rem 0 0; }
</style>

<script lang="ts">
	import { enhance } from '$app/forms';
	import type { PageData, ActionData } from './$types';

	let { data, form }: { data: PageData; form: ActionData } = $props();

	let eventId = $state(data.events[0]?.id ?? '');
	let rsn = $state(data.myRsn);
	let itemName = $state('');
	let itemId = $state<number | ''>('');
	let source = $state('');

	const selectedEvent = $derived(data.events.find((e) => e.id === eventId));
	const tracked = $derived(data.trackedByEvent[eventId] ?? []);

	function prefill(t: { tile_id: string; item_id: number | null; item_name: string; source_name: string | null }) {
		itemName = t.item_name;
		itemId = t.item_id ?? '';
		source = t.source_name ?? '';
	}
</script>

<svelte:head><title>Dink Drop Simulator · Admin</title></svelte:head>

<section class="dt">
	<a class="back" href="/admin/events">← Events</a>
	<h1>Dink Drop Simulator <span class="exp">admin test</span></h1>
	<p class="muted">
		Runs the exact match → identity → timing → credit logic for a hypothetical drop.
		<strong>Dry run</strong> writes nothing — use it against any event (incl. draft/preview).
		<strong>Simulate</strong> inserts a real <code>vs_dink_drops</code> row and runs the
		consumer end-to-end (use a <strong>preview</strong> event so it's admin-only, then view
		<code>/bingo/&lt;slug&gt;</code>). For crediting, the event needs a start time in the past and the
		tile's row released.
	</p>

	{#if form?.error}<p class="err">{form.error}</p>{/if}

	<form method="POST" use:enhance class="card">
		<label>
			<span>Event</span>
			<select name="event_id" bind:value={eventId}>
				{#each data.events as e}<option value={e.id}>{e.name} ({e.status}{e.starts_at ? '' : ', no start'})</option>{/each}
			</select>
		</label>

		{#if tracked.length}
			<div class="tracked">
				<span class="muted small">Tracked items on this event — click to prefill:</span>
				<div class="chips">
					{#each tracked as t}
						<button type="button" class="chip" onclick={() => prefill(t)}>
							{t.item_name}{#if t.item_id} #{t.item_id}{/if} → {t.tile_id}
						</button>
					{/each}
				</div>
			</div>
		{:else}
			<p class="muted small">⚠ This event has no tracked items — add some in the builder first.</p>
		{/if}

		<div class="row">
			<label><span>Player RSN</span><input name="rsn" bind:value={rsn} placeholder="RSN" /></label>
			<label><span>Item name</span><input name="item_name" bind:value={itemName} placeholder="e.g. Twisted bow" /></label>
			<label><span>Item id</span><input name="item_id" type="number" bind:value={itemId} placeholder="optional" /></label>
		</div>
		<div class="row">
			<label><span>Source (optional)</span><input name="source" bind:value={source} placeholder="e.g. Zulrah" /></label>
			<label><span>Drop time (received_at)</span><input name="received_at" type="datetime-local" /></label>
		</div>

		<div class="actions">
			<button type="submit" formaction="?/dryRun" class="primary">Dry run</button>
			<button type="submit" formaction="?/simulate" class="danger">Simulate (writes a drop)</button>
		</div>
	</form>

	{#if form?.verdict}
		{@const v = form.verdict}
		<div class="card result" class:good={v.wouldCredit} class:bad={!v.wouldCredit}>
			<h2>{v.wouldCredit ? '✓ Would credit' : '✗ Would not credit'}</h2>
			<ul>
				{#each v.reasons as r}<li>{r}</li>{/each}
			</ul>
			<div class="facts muted small">
				matched tile: <code>{v.tileId ?? '—'}</code> ·
				user resolved: {v.userResolved ? 'yes' : 'no'} ·
				tile open at drop time: {v.tileOpenAtDropTime === null ? 'n/a' : v.tileOpenAtDropTime ? 'yes' : 'no'} ·
				already credited: {v.alreadyCredited ? 'yes' : 'no'}
			</div>
			{#if form.mode === 'sim' && form.result}
				<p class="sim-result">
					Pipeline ran: processed <strong>{form.result.processed}</strong>, credited
					<strong>{form.result.credited}</strong>{#if form.result.error} · error: {form.result.error}{/if}.
					{#if selectedEvent}<a href="/bingo/{selectedEvent.slug}" target="_blank" rel="noreferrer">View board ↗</a>{/if}
				</p>
			{/if}
		</div>
	{/if}
</section>

<style>
	.dt { max-width: 820px; margin: 0 auto; padding: 1.5rem 1rem 4rem; }
	.back { color: var(--accent); text-decoration: none; font-size: 0.9rem; }
	h1 { margin: 0.3rem 0 0.4rem; }
	.exp { font-size: 0.7rem; text-transform: uppercase; letter-spacing: 0.06em; color: var(--bg); background: var(--accent); padding: 0.1rem 0.4rem; border-radius: var(--radius); vertical-align: middle; text-shadow: none; }
	.muted { color: var(--muted); }
	.small { font-size: 0.85rem; }
	.card {
		background: linear-gradient(180deg, rgba(58, 48, 36, 0.85), rgba(40, 32, 24, 0.85));
		border: 1px solid var(--border);
		border-radius: var(--radius);
		box-shadow: var(--shadow-card);
		padding: 1.1rem 1.2rem;
		margin-top: 1.1rem;
	}
	label { display: flex; flex-direction: column; gap: 0.25rem; font-size: 0.85rem; margin: 0.4rem 0; }
	label span { color: var(--muted); }
	.row { display: flex; gap: 0.6rem; flex-wrap: wrap; }
	.row label { flex: 1; min-width: 9rem; }
	.tracked { margin: 0.5rem 0; }
	.chips { display: flex; flex-wrap: wrap; gap: 0.4rem; margin-top: 0.3rem; }
	.chip { min-height: 0; padding: 0.25rem 0.55rem; font-size: 0.78rem; border-radius: var(--radius); }
	.actions { display: flex; gap: 0.6rem; margin-top: 0.8rem; }
	button.primary { border-color: var(--accent); font-family: var(--font-heading); }
	button.primary:hover { background: var(--accent-soft); }
	button.danger { border-color: var(--danger); color: var(--danger); }
	button.danger:hover { background: var(--danger-bg); border-color: var(--danger); }
	.result.good { border-color: var(--success); }
	.result.bad { border-color: var(--danger); }
	.result h2 { margin: 0 0 0.5rem; font-size: 1.05rem; }
	.result.good h2 { color: var(--success); }
	.result.bad h2 { color: var(--danger); }
	.result ul { margin: 0.2rem 0 0.6rem 1.1rem; padding: 0; }
	.facts { border-top: 1px solid var(--border); padding-top: 0.5rem; }
	.sim-result { margin: 0.6rem 0 0; }
	.err { color: var(--danger); background: var(--danger-bg); border: 1px solid var(--danger); padding: 0.5rem 0.8rem; border-radius: var(--radius); }
	code { background: var(--surface-alt); padding: 0.05rem 0.3rem; border-radius: 3px; }
	a { color: var(--accent); }
</style>

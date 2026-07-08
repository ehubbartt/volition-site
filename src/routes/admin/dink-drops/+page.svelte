<script lang="ts">
	import { enhance } from '$app/forms';
	import DinkTabs from '$lib/admin/DinkTabs.svelte';
	import { swrResource } from '$lib/swrResource.svelte';
	import type { PageData, ActionData } from './$types';

	let { data: pageData, form }: { data: PageData; form: ActionData } = $props();

	// Streamed payload (see +page.ts): revisits render the last-seen drops
	// instantly; first visits fill in as the fetch lands.
	const EMPTY_DINK_DROPS: NonNullable<PageData['dinkDrops']['cached']> = {
		filter: 'all',
		loadError: null,
		drops: []
	};
	const ddRes = swrResource(() => pageData.dinkDrops, EMPTY_DINK_DROPS);
	const data = $derived(ddRes.value);

	const OUTCOME_LABEL: Record<string, string> = {
		credited: '✓ credited',
		no_tile: 'no matching tile',
		no_user: 'RSN not a site user',
		timing: 'tile not open at drop time',
		duplicate: 'already credited',
		partial: 'counting toward collect-N',
		reverted: 'reverted by admin'
	};

	function fmtTime(iso: string): string {
		try {
			return new Date(iso).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
		} catch {
			return iso;
		}
	}
</script>

<svelte:head><title>Dink Drops · Admin</title></svelte:head>

<section class="dd">
	<DinkTabs />
	<p class="muted">
		Every drop the proxy matched to an active event, with the consumer's verdict. Use this to
		answer “why didn't I get credit?”. <strong>Reprocess</strong> re-runs a drop (e.g. after you add the
		tile); <strong>Un-credit</strong> reverses a wrong auto-credit.
	</p>

	{#if !ddRes.ready}
		<p class="muted">Loading…</p>
	{/if}

	<div class="filters">
		<a class="pill" class:active={data.filter === 'all'} href="?show=all">All</a>
		<a class="pill" class:active={data.filter === 'unmatched'} href="?show=unmatched">Didn't credit</a>
	</div>

	{#if form?.error}<p class="err">{form.error}</p>{/if}
	{#if form?.ok}<p class="ok">{form.msg}</p>{/if}
	{#if data.loadError}<p class="err">Load error: {data.loadError}</p>{/if}

	{#if data.drops.length === 0}
		<p class="muted">No drops{data.filter === 'unmatched' ? ' that failed to credit' : ''} yet.</p>
	{:else}
		<div class="rows">
			{#each data.drops as d (d.id)}
				<div class="drop" class:credited={d.outcome === 'credited'} class:pending={!d.outcome}>
					<div class="main">
						<span class="rsn">{d.rsn}</span>
						<span class="item">{d.item_name ?? `#${d.item_id}`}{#if d.quantity > 1} ×{d.quantity}{/if}</span>
						{#if d.notif_type !== 'loot'}<span class="tag">{d.notif_type}</span>{/if}
						{#if d.source}<span class="muted small">from {d.source}</span>{/if}
					</div>
					<div class="meta">
						{#if d.event_slug}<a href="/events/{d.event_slug}" target="_blank" rel="noreferrer">{d.event_name}</a>{:else}<span class="muted">no event</span>{/if}
						<span class="outcome out-{d.outcome ?? 'pending'}">{d.outcome ? OUTCOME_LABEL[d.outcome] ?? d.outcome : 'not processed yet'}</span>
						<span class="muted small">{fmtTime(d.received_at)}</span>
					</div>
					<div class="acts">
						{#if d.outcome === 'credited'}
							<form method="POST" action="?/uncredit" use:enhance>
								<input type="hidden" name="id" value={d.id} />
								<button type="submit" class="danger sm">Un-credit</button>
							</form>
						{:else}
							<form method="POST" action="?/reprocess" use:enhance>
								<input type="hidden" name="id" value={d.id} />
								<button type="submit" class="sm">Reprocess</button>
							</form>
						{/if}
					</div>
				</div>
			{/each}
		</div>
	{/if}
</section>

<style>
	.dd { max-width: 900px; margin: 0 auto; padding: 1.5rem 1rem 4rem; }
	.muted { color: var(--muted); }
	.small { font-size: 0.82rem; }
	.filters { display: flex; gap: 0.5rem; margin: 0.8rem 0; }
	.pill { padding: 0.25rem 0.7rem; border: 1px solid var(--border); border-radius: 3px; color: var(--muted); text-decoration: none; font-size: 0.85rem; }
	.pill.active { border-color: var(--accent); color: var(--accent); }
	.rows { display: flex; flex-direction: column; gap: 0.4rem; }
	.drop {
		display: grid; grid-template-columns: 1fr auto auto; gap: 0.5rem 1rem; align-items: center;
		padding: 0.55rem 0.8rem; border: 1px solid var(--border); border-radius: var(--radius);
		background: linear-gradient(180deg, rgba(58, 48, 36, 0.6), rgba(40, 32, 24, 0.6));
	}
	.drop.credited { border-left: 3px solid var(--success); }
	.drop.pending { border-left: 3px solid var(--yellow); }
	.main { display: flex; align-items: baseline; gap: 0.5rem; flex-wrap: wrap; }
	.rsn { font-family: var(--font-heading); }
	.item { color: var(--accent); }
	.tag { font-size: 0.62rem; text-transform: uppercase; padding: 0.02rem 0.3rem; border: 1px solid var(--border); border-radius: 3px; color: var(--muted); }
	.meta { display: flex; flex-direction: column; align-items: flex-end; gap: 0.15rem; font-size: 0.85rem; }
	.meta a { color: var(--accent); }
	.outcome { font-size: 0.8rem; }
	.out-credited { color: var(--success); }
	.out-pending { color: var(--yellow); }
	.acts form { margin: 0; }
	button.sm { min-height: 0; padding: 0.2rem 0.55rem; font-size: 0.78rem; }
	button.danger { border-color: var(--danger); color: var(--danger); }
	.err { color: var(--danger); background: var(--danger-bg); border: 1px solid var(--danger); padding: 0.5rem 0.8rem; border-radius: var(--radius); }
	.ok { color: var(--success); }
	@media (max-width: 640px) { .drop { grid-template-columns: 1fr; } .meta { align-items: flex-start; } }
</style>

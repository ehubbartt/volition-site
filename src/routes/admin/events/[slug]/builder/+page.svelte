<script lang="ts">
	import { enhance } from '$app/forms';
	import type { SubmitFunction } from '@sveltejs/kit';
	import type { PageData, ActionData } from './$types';
	import { TIERS } from '$lib/bingo/tiles';

	let { data, form }: { data: PageData; form: ActionData } = $props();

	const keepValues: SubmitFunction = () => async ({ update }) => update({ reset: false });

	const tierKeys = TIERS.map((t) => t.key);

	// Group tiles by row for display (main grid + bonus column).
	const tilesByRow = $derived.by(() => {
		const map = new Map<number, typeof data.tiles>();
		for (const t of data.tiles) {
			const arr = map.get(t.row) ?? [];
			arr.push(t);
			map.set(t.row, arr);
		}
		return [...map.entries()].sort((a, b) => a[0] - b[0]);
	});

	const trackedByTile = $derived.by(() => {
		const map = new Map<string, typeof data.trackedItems>();
		for (const it of data.trackedItems) {
			const arr = map.get(it.tile_id) ?? [];
			arr.push(it);
			map.set(it.tile_id, arr);
		}
		return map;
	});
</script>

<svelte:head><title>Event Builder · {data.event.name}</title></svelte:head>

<section class="builder">
	<header>
		<a class="back" href="/admin/events">← Events</a>
		<h1>Builder · {data.event.name}</h1>
		<p class="sub">
			Slug <code>{data.event.slug}</code> · status <code>{data.event.status}</code> ·
			<a href="/bingo/{data.event.slug}" target="_blank" rel="noreferrer">view board ↗</a>
		</p>
	</header>

	{#if form?.error}<p class="err">{form.error}</p>{/if}
	{#if form?.ok}<p class="ok">Saved.</p>{/if}

	{#if !data.built}
		<div class="card warn">
			<p>
				This event has no tiles yet. Pick a template to clone its structure and tiles — then edit
				anything below.
			</p>
			<form method="POST" action="?/pickTemplate" use:enhance={keepValues} class="inline">
				<select name="template" required>
					{#each data.templates as t}<option value={t.slug}>{t.name}</option>{/each}
				</select>
				<button type="submit" class="primary">Clone template</button>
			</form>
		</div>
	{/if}

	<!-- Structure -->
	<div class="card">
		<h2>Structure</h2>
		<form method="POST" action="?/updateStructure" use:enhance={keepValues} class="struct">
			<label><span>Rows</span><input name="rowCount" type="number" min="1" value={data.structure.rowCount} /></label>
			<label>
				<span>Hours between row releases</span>
				<input name="rowIntervalHours" type="number" min="0.1" step="0.1" value={data.structure.rowIntervalHours} />
			</label>
			<label class="check">
				<input name="bonusEnabled" type="checkbox" checked={data.structure.bonusEnabled} />
				<span>Bonus column enabled</span>
			</label>
			<div class="tier-points">
				{#each data.structure.tiers as tier}
					<label>
						<span>{tier.label} pts</span>
						<input name="point_{tier.key}" type="number" min="0" value={tier.points} />
					</label>
				{/each}
			</div>
			<p class="muted note">Saving rebuilds the tile grid to match — adds blank tiles for new rows/bonus and removes tiles that no longer fit. Existing tile content is kept.</p>
			<button type="submit" class="primary">Save structure</button>
		</form>
	</div>

	<!-- Tiles -->
	<div class="card">
		<h2>Tiles ({data.tiles.length})</h2>
		{#if data.tiles.length === 0}
			<p class="muted">No tiles yet — clone a template above.</p>
		{/if}
		{#each tilesByRow as [row, tiles]}
			<div class="row-group">
				<h3>Row {row}</h3>
				{#each tiles as t}
					<details class="tile">
						<summary>
							<span class="tier-chip tier-{t.tier}">{t.tier}</span>
							<strong>{t.name}</strong>
							<code>{t.id}</code>
							{#if trackedByTile.get(t.id)?.length}<span class="track-badge">⛓ {trackedByTile.get(t.id)!.length}</span>{/if}
						</summary>

						<form method="POST" action="?/saveTile" use:enhance={keepValues} class="edit">
							<input type="hidden" name="tile_id" value={t.id} />
							<label><span>Name</span><input name="name" type="text" value={t.name} required /></label>
							<div class="two">
								<label><span>Row</span><input name="row" type="number" min="1" value={t.row} /></label>
								<label>
									<span>Tier</span>
									<select name="tier">{#each tierKeys as k}<option value={k} selected={k === t.tier}>{k}</option>{/each}</select>
								</label>
								<label><span>Points</span><input name="points" type="number" min="0" value={t.points} /></label>
							</div>
							<label><span>Image URL</span><input name="img" type="text" value={t.img ?? ''} /></label>
							<label><span>How-to / FAQ (markdown)</span><textarea name="details_md" rows="4">{data.details[t.id] ?? ''}</textarea></label>
							<div class="actions">
								<button type="submit" class="primary">Save tile</button>
							</div>
						</form>

						<!-- Tracked items for this tile -->
						<div class="tracked">
							<h4>Auto-tracked items</h4>
							{#each trackedByTile.get(t.id) ?? [] as it}
								<div class="track-row">
									<span>{it.item_name}{#if it.item_id} <code>#{it.item_id}</code>{/if} ×{it.required_qty}{#if it.source_name} · {it.source_name}{/if}</span>
									<form method="POST" action="?/deleteTrackedItem" use:enhance={keepValues}>
										<input type="hidden" name="id" value={it.id} />
										<button type="submit" class="danger sm">Remove</button>
									</form>
								</div>
							{/each}
							<form method="POST" action="?/addTrackedItem" use:enhance={keepValues} class="track-add">
								<input type="hidden" name="tile_id" value={t.id} />
								<input name="item_name" type="text" placeholder="Item name" required />
								<input name="item_id" type="number" placeholder="Item id" />
								<input name="required_qty" type="number" min="1" value="1" title="Required quantity" />
								<input name="source_name" type="text" placeholder="Source (optional)" />
								<button type="submit">Add item</button>
							</form>
						</div>

						<form method="POST" action="?/deleteTile" use:enhance={keepValues} class="delete-tile">
							<input type="hidden" name="tile_id" value={t.id} />
							<button type="submit" class="danger sm">Delete tile</button>
						</form>
					</details>
				{/each}
			</div>
		{/each}
	</div>
</section>

<style>
	.builder { max-width: 880px; margin: 0 auto; padding: 1.5rem 1rem 4rem; }
	header h1 { margin: 0.3rem 0 0; }
	.back { color: var(--accent); text-decoration: none; font-size: 0.9rem; }
	.sub { color: #9a9a9a; font-size: 0.85rem; }
	.card { background: #161310; border: 1px solid #2a241c; border-radius: 10px; padding: 1rem 1.1rem; margin-top: 1.1rem; }
	.card.warn { border-color: var(--accent); }
	h2 { margin: 0 0 0.6rem; font-size: 1.05rem; }
	h3 { margin: 1rem 0 0.4rem; font-size: 0.95rem; color: #cdb78f; }
	h4 { margin: 0.6rem 0 0.3rem; font-size: 0.82rem; color: #9a9a9a; }
	label { display: flex; flex-direction: column; gap: 0.2rem; font-size: 0.82rem; margin: 0.4rem 0; }
	label.check { flex-direction: row; align-items: center; gap: 0.5rem; }
	input, select, textarea { background: #0f0d0a; border: 1px solid #342c20; color: #eee; border-radius: 6px; padding: 0.4rem 0.5rem; font: inherit; }
	/* Checkboxes must not inherit the text-input box sizing (padding/border made the
	   control resize on toggle, jiggling the adjacent label). */
	input[type='checkbox'] { width: 1rem; height: 1rem; flex: 0 0 auto; padding: 0; border-radius: 3px; accent-color: var(--accent); }
	.note { margin: 0.2rem 0 0; font-size: 0.78rem; }
	.struct .tier-points { display: flex; flex-wrap: wrap; gap: 0.6rem; }
	.struct .tier-points label { width: 120px; }
	.two { display: flex; gap: 0.6rem; }
	.two label { flex: 1; }
	button { background: #2a241c; color: #eee; border: 1px solid #3a3128; border-radius: 6px; padding: 0.4rem 0.8rem; cursor: pointer; font: inherit; }
	button.primary { background: var(--accent); color: #1a1207; border-color: var(--accent); font-weight: 600; }
	button.danger { background: #3a1c1c; border-color: #5a2a2a; color: #f3b0b0; }
	button.sm { padding: 0.25rem 0.55rem; font-size: 0.78rem; }
	.inline { display: flex; gap: 0.5rem; align-items: center; margin-top: 0.6rem; }
	.tile { border: 1px solid #2a241c; border-radius: 8px; margin: 0.4rem 0; padding: 0.2rem 0.6rem; }
	.tile summary { cursor: pointer; display: flex; gap: 0.5rem; align-items: center; padding: 0.4rem 0; }
	.tile summary code { color: #8a7a5c; font-size: 0.75rem; }
	.tier-chip { font-size: 0.7rem; padding: 0.1rem 0.4rem; border-radius: 4px; background: #2a241c; text-transform: uppercase; }
	.track-badge { margin-left: auto; color: var(--accent); font-size: 0.78rem; }
	.tracked { border-top: 1px dashed #2a241c; margin-top: 0.5rem; padding-top: 0.4rem; }
	.track-row { display: flex; justify-content: space-between; align-items: center; font-size: 0.82rem; padding: 0.15rem 0; }
	.track-add { display: flex; flex-wrap: wrap; gap: 0.4rem; margin-top: 0.4rem; }
	.track-add input { flex: 1; min-width: 90px; }
	.delete-tile { margin-top: 0.6rem; }
	.err { color: #f3b0b0; background: #2a1414; padding: 0.5rem 0.8rem; border-radius: 6px; }
	.ok { color: #b0f3b8; background: #14250f; padding: 0.5rem 0.8rem; border-radius: 6px; }
	.muted { color: #777; }
	code { background: #0f0d0a; padding: 0.05rem 0.3rem; border-radius: 4px; }
</style>

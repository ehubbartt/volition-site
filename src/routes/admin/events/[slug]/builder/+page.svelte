<script lang="ts">
	import { enhance } from '$app/forms';
	import type { SubmitFunction } from '@sveltejs/kit';
	import type { PageData, ActionData } from './$types';
	import ItemAutocomplete from '$lib/admin/ItemAutocomplete.svelte';

	let { data, form }: { data: PageData; form: ActionData } = $props();

	const keepValues: SubmitFunction = () => async ({ update }) => update({ reset: false });

	// Column editor working copy (main columns, excluding bonus).
	type Col = { key: string; label: string; points: number };
	let cols = $state<Col[]>(
		data.structure.tiers
			.filter((t) => t.key !== 'bonus')
			.map((t) => ({ key: t.key, label: t.label, points: t.points }))
	);
	const bonusTier0 = data.structure.tiers.find((t) => t.key === 'bonus');
	let bonusEnabled = $state(data.structure.bonusEnabled);
	let bonusLabel = $state(bonusTier0?.label ?? 'Bonus');
	let bonusPoints = $state(bonusTier0?.points ?? 5);
	function addCol() {
		cols = [...cols, { key: '', label: '', points: 1 }];
	}
	function removeCol(i: number) {
		cols = cols.filter((_, idx) => idx !== i);
	}

	// Tier options for the per-tile editor's column dropdown.
	const columnOptions = $derived(data.structure.tiers.map((t) => ({ key: t.key, label: t.label })));

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
			<div class="two">
				<label><span>Rows</span><input name="rowCount" type="number" min="1" value={data.structure.rowCount} /></label>
				<label>
					<span>Hours between row releases</span>
					<input name="rowIntervalHours" type="number" min="0.1" step="0.1" value={data.structure.rowIntervalHours} />
				</label>
			</div>

			<h3>Columns</h3>
			<div class="cols-editor">
				{#each cols as col, i (i)}
					<div class="col-row">
						<input type="hidden" name="col_key" value={col.key} />
						<input name="col_label" placeholder="Column name" bind:value={col.label} required />
						<input class="pts-in" name="col_points" type="number" min="0" bind:value={col.points} title="Points" />
						<button type="button" class="danger sm" title="Remove column" onclick={() => removeCol(i)}>✕</button>
					</div>
				{/each}
				<button type="button" class="sm add" onclick={addCol}>+ Add column</button>
			</div>

			<label class="check">
				<input name="bonusEnabled" type="checkbox" bind:checked={bonusEnabled} />
				<span>Bonus column enabled</span>
			</label>
			{#if bonusEnabled}
				<div class="two">
					<label><span>Bonus column name</span><input name="bonus_label" bind:value={bonusLabel} /></label>
					<label><span>Bonus points</span><input name="bonus_points" type="number" min="0" bind:value={bonusPoints} /></label>
				</div>
			{/if}

			<p class="muted note">Saving rebuilds the tile grid to match — adds blank tiles for new columns/rows/bonus and removes tiles that no longer fit. Existing tile content is kept.</p>
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
									<span>Column</span>
									<select name="tier">{#each columnOptions as c}<option value={c.key} selected={c.key === t.tier}>{c.label}</option>{/each}</select>
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
									<span>
										{#if it.match_type === 'collection'}<span class="mt-tag">clog</span>{/if}
										{it.item_name}{#if it.item_id} <code>#{it.item_id}</code>{/if} ×{it.required_qty}{#if it.source_name} · {it.source_name}{/if}
									</span>
									<form method="POST" action="?/deleteTrackedItem" use:enhance={keepValues}>
										<input type="hidden" name="id" value={it.id} />
										<button type="submit" class="danger sm">Remove</button>
									</form>
								</div>
							{/each}
							<form method="POST" action="?/addTrackedItem" use:enhance={keepValues} class="track-add">
								<input type="hidden" name="tile_id" value={t.id} />
								<ItemAutocomplete />
								<input name="required_qty" type="number" min="1" value="1" title="Required quantity" />
								<input name="source_name" type="text" placeholder="Source (optional)" />
								<select name="match_type" title="How this item completes the tile">
									<option value="loot">Loot drop</option>
									<option value="collection">Collection log / pet</option>
								</select>
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
	/* Reuses the site's global form-control + button styling (src/app.css) and
	   design tokens; only layout + a couple of variants are defined here. */
	.builder { max-width: 880px; margin: 0 auto; padding: 1.5rem 1rem 4rem; }
	header h1 { margin: 0.3rem 0 0; }
	.back { color: var(--accent); text-decoration: none; font-size: 0.9rem; }
	.sub { color: var(--muted); font-size: 0.85rem; }
	.card {
		background: linear-gradient(180deg, rgba(58, 48, 36, 0.85), rgba(40, 32, 24, 0.85));
		border: 1px solid var(--border);
		border-radius: var(--radius);
		box-shadow: var(--shadow-card);
		padding: 1.1rem 1.2rem;
		margin-top: 1.1rem;
	}
	.card.warn { border-color: var(--accent); }
	h2 { margin: 0 0 0.6rem; font-size: 1.1rem; color: var(--accent); text-shadow: var(--ts); }
	h3 { margin: 1rem 0 0.4rem; font-size: 0.95rem; color: var(--text); }
	h4 { margin: 0.6rem 0 0.3rem; font-size: 0.82rem; color: var(--muted); }
	label { display: flex; flex-direction: column; gap: 0.25rem; font-size: 0.85rem; margin: 0.5rem 0; }
	label span { color: var(--muted); }
	label.check { flex-direction: row; align-items: center; gap: 0.5rem; }
	.note { margin: 0.3rem 0 0; font-size: 0.8rem; }
	.cols-editor { display: flex; flex-direction: column; gap: 0.4rem; margin: 0.3rem 0 0.6rem; }
	.col-row { display: flex; align-items: center; gap: 0.4rem; }
	.col-row input[name='col_label'] { flex: 1; }
	.col-row .pts-in { width: 5rem; }
	.cols-editor .add { align-self: flex-start; }
	.two { display: flex; gap: 0.6rem; }
	.two label { flex: 1; }
	button.primary { border-color: var(--accent); font-family: var(--font-heading); }
	button.primary:hover { background: var(--accent-soft); }
	button.danger { border-color: var(--danger); color: var(--danger); }
	button.danger:hover { background: var(--danger-bg); border-color: var(--danger); }
	button.sm { min-height: 0; padding: 0.3rem 0.6rem; font-size: 0.8rem; }
	.inline { display: flex; gap: 0.5rem; align-items: center; margin-top: 0.6rem; }
	.tile { border: 1px solid var(--border); border-radius: var(--radius); margin: 0.4rem 0; padding: 0.2rem 0.7rem; background: var(--surface-alt); }
	.tile summary { cursor: pointer; display: flex; gap: 0.5rem; align-items: center; padding: 0.45rem 0; }
	.tile summary code { color: var(--muted); font-size: 0.75rem; }
	.tier-chip { font-size: 0.7rem; padding: 0.1rem 0.4rem; border-radius: var(--radius); background: var(--surface); color: var(--accent); text-transform: uppercase; }
	.track-badge { margin-left: auto; color: var(--accent); font-size: 0.78rem; }
	.mt-tag { font-size: 0.62rem; text-transform: uppercase; letter-spacing: 0.05em; padding: 0.02rem 0.3rem; border: 1px solid var(--border); border-radius: 3px; color: var(--muted); margin-right: 0.25rem; }
	.tracked { border-top: 1px dashed var(--border); margin-top: 0.5rem; padding-top: 0.4rem; }
	.track-row { display: flex; justify-content: space-between; align-items: center; font-size: 0.85rem; padding: 0.15rem 0; }
	.track-add { display: flex; flex-wrap: wrap; gap: 0.4rem; margin-top: 0.4rem; }
	.track-add input { flex: 1; min-width: 90px; }
	.delete-tile { margin-top: 0.6rem; }
	.err { color: var(--danger); background: var(--danger-bg); border: 1px solid var(--danger); padding: 0.5rem 0.8rem; border-radius: var(--radius); }
	.ok { color: var(--success); background: var(--success-bg); padding: 0.5rem 0.8rem; border-radius: var(--radius); }
	.muted { color: var(--muted); }
	code { background: var(--surface-alt); padding: 0.05rem 0.3rem; border-radius: 3px; }
</style>

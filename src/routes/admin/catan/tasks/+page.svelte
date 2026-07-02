<script lang="ts">
	import { enhance } from '$app/forms';
	import { TILE_TYPE_LABEL, type TaskPools, type TileType } from '$lib/catan/board';
	import type { PageData, ActionData } from './$types';

	let { data, form }: { data: PageData; form: ActionData } = $props();

	const TYPES: TileType[] = ['boss', 'skilling', 'raids', 'custom'];
	const HINTS: Record<TileType, string> = {
		boss: 'e.g. Zulrah / KC — earns Boss (B) tokens',
		skilling: 'e.g. Agility / EHP — earns Skilling (S) tokens',
		raids: 'e.g. Chambers of Xeric / KC — earns Raids (R) tokens',
		custom: 'e.g. Hard clue caskets / opened — earns Custom (C) tokens'
	};

	let pools = $state<TaskPools>({ boss: [], skilling: [], raids: [], custom: [] });
	// Fill/re-sync the editor whenever fresh data lands (initial load and after a save).
	$effect(() => {
		pools = structuredClone(data.pools);
	});

	function addRow(type: TileType) {
		pools[type] = [...pools[type], { label: '', unit: 'KC', perRating: 10 }];
	}

	function removeRow(type: TileType, i: number) {
		pools[type] = pools[type].filter((_, idx) => idx !== i);
	}
</script>

<svelte:head>
	<title>Gielinor Catan — task pools</title>
</svelte:head>

<main>
	<a href="/admin/catan" class="back">← test games</a>
	<h1>Task pools</h1>
	<p class="hint">
		The lists boards draw tasks from — 3 are sampled per tile when a game is created (existing
		games keep the tasks they were generated with). A task's amount is
		<b>per-rating × tile rating</b>: e.g. Zulrah at 35 per-rating becomes 35 KC on a rating-1
		tile and 175 KC on a rating-5.
	</p>

	{#if form?.error}
		<p class="banner error">{form.error}</p>
	{:else if form?.saved}
		<p class="banner ok">Task pools saved — new games will use them.</p>
	{/if}

	<form method="POST" action="?/save" use:enhance>
		{#each TYPES as type (type)}
			<section>
				<h2>{TILE_TYPE_LABEL[type]} tasks ({pools[type].length})</h2>
				<p class="hint">{HINTS[type]}</p>
				<div class="rows">
					<div class="row head">
						<span>Task</span><span>Unit</span><span>Per-rating</span><span></span>
					</div>
					{#each pools[type] as row, i (i)}
						<div class="row">
							<input bind:value={row.label} placeholder="Task name" maxlength="80" />
							<input bind:value={row.unit} placeholder="KC / EHP / …" maxlength="24" />
							<input type="number" bind:value={row.perRating} min="1" step="any" />
							<button type="button" class="danger" onclick={() => removeRow(type, i)} title="Remove">✕</button>
						</div>
					{/each}
				</div>
				<button type="button" onclick={() => addRow(type)}>+ Add {TILE_TYPE_LABEL[type]} task</button>
			</section>
		{/each}

		<input type="hidden" name="pools" value={JSON.stringify(pools)} />
		<div class="actions">
			<button type="submit" class="primary">Save all pools</button>
		</div>
	</form>
</main>

<style>
	main {
		max-width: 860px;
		margin: 0 auto;
		padding: 1.5rem 1rem 3rem;
	}
	h1,
	h2 {
		font-family: var(--font-heading);
		text-shadow: var(--ts);
	}
	.back {
		color: var(--muted);
		font-size: 0.9rem;
	}
	.hint {
		color: var(--muted);
	}
	.banner {
		border-radius: var(--radius);
		padding: 0.5rem 0.75rem;
	}
	.banner.error {
		color: var(--danger);
		background: var(--danger-bg);
		border: 1px solid var(--danger);
	}
	.banner.ok {
		color: var(--success);
		background: var(--success-bg);
		border: 1px solid var(--success);
	}
	section {
		background: var(--surface-alt);
		border: 1px solid var(--border);
		border-radius: var(--radius-lg);
		padding: 0.75rem 1rem;
		margin: 1rem 0;
	}
	.rows {
		display: grid;
		gap: 0.35rem;
		margin-bottom: 0.5rem;
	}
	.row {
		display: grid;
		grid-template-columns: 1fr 8rem 7rem 2.2rem;
		gap: 0.4rem;
		align-items: center;
	}
	.row.head span {
		color: var(--muted);
		font-size: 0.8rem;
	}
	input {
		background: var(--surface);
		border: 1px solid var(--border);
		border-radius: var(--radius);
		color: var(--text);
		padding: 0.35rem 0.5rem;
		width: 100%;
	}
	button {
		background: var(--surface);
		border: 1px solid var(--border-strong);
		border-radius: var(--radius);
		color: var(--text);
		padding: 0.35rem 0.65rem;
		cursor: pointer;
	}
	button:hover {
		border-color: var(--accent);
	}
	button.danger:hover {
		border-color: var(--danger);
		color: var(--danger);
	}
	button.primary {
		border-color: var(--accent);
		background: var(--accent-soft);
		font-family: var(--font-heading);
	}
	.actions {
		position: sticky;
		bottom: 0.5rem;
	}
</style>

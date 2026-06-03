<script lang="ts">
	import type { PageData, ActionData } from './$types';
	import { enhance } from '$app/forms';
	import CardThumb from '$lib/cards/CardThumb.svelte';
	import PackThumb from '$lib/cards/PackThumb.svelte';
	import { RARITIES, isValidRarity, type Card, type CardAbility } from '$lib/cards/rarity';
	import type { CardPack } from '$lib/cards/packs';

	let { data, form }: { data: PageData; form: ActionData } = $props();

	type Tab = 'cards' | 'packs';
	let tab = $state<Tab>('cards');

	// Blank ability rows appended to each form so admins can add more.
	const BLANK_ROWS = 3;

	function toCard(c: PageData['cards'][number]): Card {
		return {
			id: c.id,
			name: c.name,
			level: c.level,
			rarity: (isValidRarity(c.rarity) ? c.rarity : 'common') as Card['rarity'],
			abilities: (c.abilities ?? []) as CardAbility[],
			flavor: c.flavor,
			front_url: c.front_url,
			back_url: c.back_url
		};
	}

	function toPack(p: PageData['packs'][number]): CardPack {
		return {
			id: p.id,
			name: p.name,
			description: p.description,
			cost_vp: p.cost_vp,
			front_url: p.front_url,
			back_url: p.back_url
		};
	}

	function abilityRows(card: Card | null): CardAbility[] {
		const existing = card?.abilities ?? [];
		return [...existing, ...Array.from({ length: BLANK_ROWS }, () => ({ name: '', description: '' }))];
	}

	function packName(id: string | null): string {
		return data.packs.find((p) => p.id === id)?.name ?? '—';
	}
</script>

<svelte:head>
	<title>Admin · Cards & Packs</title>
</svelte:head>

<section>
	<h1>Cards &amp; Packs</h1>

	{#if form?.error}
		<div class="error">{form.error}</div>
	{/if}

	<nav class="tabs">
		<button type="button" class="tab" class:active={tab === 'cards'} onclick={() => (tab = 'cards')}>
			Cards <span class="count">{data.cards.length}</span>
		</button>
		<button type="button" class="tab" class:active={tab === 'packs'} onclick={() => (tab = 'packs')}>
			Packs <span class="count">{data.packs.length}</span>
		</button>
	</nav>

	{#if tab === 'cards'}
		{#if data.packs.length === 0}
			<div class="error">
				Create a set/pack first (Packs tab) — every card must belong to one.
			</div>
		{/if}

		<details class="card">
			<summary><strong>Create new card</strong></summary>
			<form method="POST" action="?/createCard" enctype="multipart/form-data" use:enhance>
				<label>
					<span>Name</span>
					<input name="name" type="text" required placeholder="The Great Olm" />
				</label>
				<label>
					<span>Set / pack</span>
					<select name="pack_id" required>
						<option value="" disabled selected>Pick a set…</option>
						{#each data.packs as p}
							<option value={p.id}>{p.name}</option>
						{/each}
					</select>
				</label>
				<div class="row">
					<label>
						<span>Combat level</span>
						<input name="level" type="number" min="0" placeholder="1043" />
					</label>
					<label>
						<span>Rarity</span>
						<select name="rarity">
							{#each RARITIES as r}
								<option value={r.key} selected={r.key === 'common'}>{r.label}</option>
							{/each}
						</select>
					</label>
				</div>
				<label>
					<span>Flavor / description (optional)</span>
					<textarea name="flavor" rows="2"></textarea>
				</label>

				<fieldset class="abilities">
					<legend>Abilities</legend>
					{#each abilityRows(null) as ab}
						<div class="ability-row">
							<input name="ability_name" type="text" placeholder="Flame Wall" value={ab.name} />
							<input name="ability_desc" type="text" placeholder="Description" value={ab.description} />
						</div>
					{/each}
				</fieldset>

				<div class="row">
					<label>
						<span>Front art</span>
						<input name="front" type="file" accept="image/png,image/jpeg,image/webp,image/gif" />
					</label>
					<label>
						<span>Back art (optional — defaults to the Volition card back)</span>
						<input name="back" type="file" accept="image/png,image/jpeg,image/webp,image/gif" />
					</label>
				</div>

				<button type="submit" class="primary">Create card</button>
			</form>
		</details>

		<h2>Existing cards ({data.cards.length})</h2>
		{#if data.cards.length === 0}
			<p class="muted">No cards yet.</p>
		{:else}
			<ul class="item-list">
				{#each data.cards as raw (raw.id)}
					{@const card = toCard(raw)}
					<li class="card">
						<div class="item-head">
							<div class="thumb">
								<CardThumb {card} />
							</div>
							<div class="head-meta">
								<strong>{card.name}</strong>
								<span class="muted">{card.rarity}{#if card.level} · lvl {card.level}{/if}</span>
								<span class="muted small">Set: {packName(raw.pack_id)}</span>
								{#if card.abilities.length}
									<span class="muted small">{card.abilities.length} abilit{card.abilities.length === 1 ? 'y' : 'ies'}</span>
								{/if}
							</div>
							<form method="POST" action="?/deleteCard" use:enhance class="delete-form">
								<input type="hidden" name="id" value={card.id} />
								<button
									type="submit"
									class="danger"
									onclick={(e) => {
										if (!confirm(`Delete "${card.name}"?`)) e.preventDefault();
									}}
								>
									Delete
								</button>
							</form>
						</div>

						<details class="edit-block">
							<summary>Edit</summary>
							<form method="POST" action="?/updateCard" enctype="multipart/form-data" use:enhance class="edit-form">
								<input type="hidden" name="id" value={card.id} />
								<label>
									<span>Name</span>
									<input name="name" type="text" required value={card.name} />
								</label>
								<label>
									<span>Set / pack</span>
									<select name="pack_id" required>
										<option value="" disabled selected={!raw.pack_id}>Pick a set…</option>
										{#each data.packs as p}
											<option value={p.id} selected={raw.pack_id === p.id}>{p.name}</option>
										{/each}
									</select>
								</label>
								<div class="row">
									<label>
										<span>Combat level</span>
										<input name="level" type="number" min="0" value={card.level ?? ''} />
									</label>
									<label>
										<span>Rarity</span>
										<select name="rarity">
											{#each RARITIES as r}
												<option value={r.key} selected={r.key === card.rarity}>{r.label}</option>
											{/each}
										</select>
									</label>
								</div>
								<label>
									<span>Flavor / description</span>
									<textarea name="flavor" rows="2">{card.flavor ?? ''}</textarea>
								</label>

								<fieldset class="abilities">
									<legend>Abilities <span class="muted small">(clear a name to remove it)</span></legend>
									{#each abilityRows(card) as ab}
										<div class="ability-row">
											<input name="ability_name" type="text" placeholder="Name" value={ab.name} />
											<input name="ability_desc" type="text" placeholder="Description" value={ab.description} />
										</div>
									{/each}
								</fieldset>

								<div class="row">
									<label>
										<span>Replace front art (optional)</span>
										<input name="front" type="file" accept="image/png,image/jpeg,image/webp,image/gif" />
									</label>
									<label>
										<span>Replace back art (optional)</span>
										<input name="back" type="file" accept="image/png,image/jpeg,image/webp,image/gif" />
									</label>
								</div>

								<button type="submit" class="primary">Save changes</button>
							</form>
						</details>
					</li>
				{/each}
			</ul>
		{/if}
	{:else if tab === 'packs'}
		<details class="card">
			<summary><strong>Create new pack</strong></summary>
			<form method="POST" action="?/createPack" enctype="multipart/form-data" use:enhance>
				<label>
					<span>Name</span>
					<input name="name" type="text" required placeholder="Standard Pack" />
				</label>
				<label>
					<span>Description (optional)</span>
					<textarea name="description" rows="2"></textarea>
				</label>
				<label>
					<span>Cost (VP)</span>
					<input name="cost_vp" type="number" min="0" value="0" />
				</label>
				<div class="row">
					<label>
						<span>Front art (optional — defaults to the standard pack image)</span>
						<input name="front" type="file" accept="image/png,image/jpeg,image/webp,image/gif" />
					</label>
					<label>
						<span>Back art (optional — defaults to the standard pack back)</span>
						<input name="back" type="file" accept="image/png,image/jpeg,image/webp,image/gif" />
					</label>
				</div>
				<button type="submit" class="primary">Create pack</button>
			</form>
		</details>

		<h2>Existing packs ({data.packs.length})</h2>
		{#if data.packs.length === 0}
			<p class="muted">No packs yet.</p>
		{:else}
			<ul class="item-list">
				{#each data.packs as raw (raw.id)}
					{@const pack = toPack(raw)}
					<li class="card">
						<div class="item-head">
							<div class="thumb">
								<PackThumb {pack} />
							</div>
							<div class="head-meta">
								<strong>{pack.name}</strong>
								<span class="muted">{pack.cost_vp.toLocaleString()} VP</span>
								{#if pack.description}
									<span class="muted small">{pack.description}</span>
								{/if}
							</div>
							<form method="POST" action="?/deletePack" use:enhance class="delete-form">
								<input type="hidden" name="id" value={pack.id} />
								<button
									type="submit"
									class="danger"
									onclick={(e) => {
										if (!confirm(`Delete "${pack.name}"?`)) e.preventDefault();
									}}
								>
									Delete
								</button>
							</form>
						</div>

						<details class="edit-block">
							<summary>Edit</summary>
							<form method="POST" action="?/updatePack" enctype="multipart/form-data" use:enhance class="edit-form">
								<input type="hidden" name="id" value={pack.id} />
								<label>
									<span>Name</span>
									<input name="name" type="text" required value={pack.name} />
								</label>
								<label>
									<span>Description</span>
									<textarea name="description" rows="2">{pack.description ?? ''}</textarea>
								</label>
								<label>
									<span>Cost (VP)</span>
									<input name="cost_vp" type="number" min="0" value={pack.cost_vp} />
								</label>
								<div class="row">
									<label>
										<span>Replace front art (optional)</span>
										<input name="front" type="file" accept="image/png,image/jpeg,image/webp,image/gif" />
									</label>
									<label>
										<span>Replace back art (optional)</span>
										<input name="back" type="file" accept="image/png,image/jpeg,image/webp,image/gif" />
									</label>
								</div>
								<button type="submit" class="primary">Save changes</button>
							</form>
						</details>
					</li>
				{/each}
			</ul>
		{/if}
	{/if}
</section>

<style>
	h1 {
		margin-bottom: 1rem;
	}

	h2 {
		margin: 2rem 0 1rem;
	}

	.muted {
		color: var(--muted);
	}

	.small {
		font-size: 0.8rem;
	}

	.error {
		background: var(--danger-bg);
		border: 1px solid var(--danger);
		color: var(--danger);
		padding: 0.6rem 0.8rem;
		border-radius: 4px;
		margin-bottom: 1rem;
	}

	.tabs {
		display: flex;
		gap: 0.25rem;
		margin-bottom: 1.25rem;
		border-bottom: 1px solid var(--border);
	}

	.tab {
		display: inline-flex;
		align-items: center;
		gap: 0.4rem;
		min-height: auto;
		padding: 0.55rem 1rem;
		background: transparent;
		border: none;
		border-bottom: 2px solid transparent;
		border-radius: 0;
		color: var(--muted);
		font-size: 1rem;
		cursor: pointer;
		transition: color 0.15s, border-color 0.15s;
	}

	.tab:hover {
		color: var(--text);
		background: transparent;
	}

	.tab.active {
		color: var(--accent);
		border-bottom-color: var(--accent);
	}

	.count {
		padding: 0.05rem 0.45rem;
		background: var(--surface-alt);
		border: 1px solid var(--border);
		border-radius: 999px;
		font-size: 0.75rem;
		color: var(--text);
	}

	.card {
		padding: 1.25rem;
		background: linear-gradient(180deg, rgba(58, 48, 36, 0.85), rgba(40, 32, 24, 0.85));
		border: 1px solid var(--border);
		border-radius: var(--radius);
		margin-bottom: 1rem;
		box-shadow: var(--shadow-card);
	}

	form {
		display: flex;
		flex-direction: column;
		gap: 0.75rem;
		margin-top: 1rem;
	}

	form.delete-form {
		margin-top: 0;
	}

	label {
		display: flex;
		flex-direction: column;
		gap: 0.25rem;
	}

	label span {
		font-size: 0.8rem;
		color: var(--muted);
	}

	.row {
		display: grid;
		grid-template-columns: 1fr 1fr;
		gap: 0.75rem;
	}

	.abilities {
		border: 1px solid var(--border);
		border-radius: var(--radius);
		padding: 0.75rem;
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
		margin: 0;
	}

	.abilities legend {
		font-size: 0.8rem;
		color: var(--muted);
		padding: 0 0.35rem;
	}

	.ability-row {
		display: grid;
		grid-template-columns: 1fr 2fr;
		gap: 0.5rem;
	}

	.item-list {
		list-style: none;
		padding: 0;
		margin: 0;
	}

	.item-head {
		display: flex;
		align-items: center;
		gap: 1rem;
	}

	.thumb {
		width: 5.5rem;
		flex: 0 0 auto;
	}

	.head-meta {
		display: flex;
		flex-direction: column;
		gap: 0.15rem;
		margin-right: auto;
		min-width: 0;
	}

	.edit-block {
		margin-top: 0.75rem;
		padding-top: 0.75rem;
		border-top: 1px solid var(--border);
	}

	.edit-block summary {
		cursor: pointer;
		color: var(--accent);
		font-size: 0.95rem;
	}

	.edit-form {
		margin-top: 0.75rem;
	}

	button.primary {
		border-color: var(--accent);
		font-family: 'rsbold', ui-sans-serif, Arial, sans-serif;
		align-self: flex-start;
	}

	button.primary:hover {
		background: var(--accent-soft);
	}

	button.danger {
		border-color: var(--danger);
		color: var(--danger);
	}

	button.danger:hover {
		background: var(--danger-bg);
	}
</style>

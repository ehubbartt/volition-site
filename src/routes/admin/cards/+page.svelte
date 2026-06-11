<script lang="ts">
	import type { PageData, ActionData } from './$types';
	import { enhance } from '$app/forms';
	import { page } from '$app/stores';
	import type { SubmitFunction } from '@sveltejs/kit';
	import CardsTabs from '$lib/admin/CardsTabs.svelte';
	import CardThumb from '$lib/cards/CardThumb.svelte';
	import PackThumb from '$lib/cards/PackThumb.svelte';
	import CardInspector3D from '$lib/cards/CardInspector3D.svelte';
	import CardModelBuilder from '$lib/cards/CardModelBuilder.svelte';
	import {
		RARITIES,
		RARITY_BY_KEY,
		DEFAULT_RARITY,
		isValidRarity,
		toCardLayers,
		type Card,
		type CardAbility,
		type CardRarity
	} from '$lib/cards/rarity';
	import { LAYER_EFFECTS } from '$lib/cards/layerEffects';
	import { LAYER_ACCEPT, FRONT_ACCEPT, MODEL_ACCEPT, isVideoLayerUrl } from '$lib/cards/config';
	import type { CardPack } from '$lib/cards/packs';

	let { data, form }: { data: PageData; form: ActionData } = $props();

	type Tab = 'cards' | 'packs' | 'grant';
	// The active tab is driven by the URL (?tab=) so the shared CardsTabs bar can
	// link between it and the sibling tool routes (pack tester/sim/stats).
	let tab = $derived.by<Tab>(() => {
		const t = $page.url.searchParams.get('tab');
		return t === 'packs' || t === 'grant' ? t : 'cards';
	});

	// Click a card thumbnail to preview it in the full 3D inspector (no need to own
	// or open it). Finish is unset here, so it shows the base card (no holo).
	let inspecting = $state<Card | null>(null);
	// Card whose 3D model is being placed in the builder modal (null = closed).
	let builderCard = $state<Card | null>(null);

	// ── Grant tab ─────────────────────────────────────────────────────────
	let grantTarget = $state<'one' | 'all'>('one');
	let granting = $state(false);

	function memberLabel(m: PageData['members'][number]): string {
		return m.rsn || m.discord_username || 'Unknown member';
	}

	// Confirm before a mass grant; keep the form's typed values after submit.
	const onGrantSubmit: SubmitFunction = ({ formData, cancel }) => {
		if (formData.get('target') === 'all') {
			const qty = formData.get('quantity') ?? '1';
			const packName = data.packs.find((p) => p.id === formData.get('pack_id'))?.name ?? 'this pack';
			if (!confirm(`Give ${qty} × ${packName} to all ${data.members.length} members?`)) {
				cancel();
				return;
			}
		}
		granting = true;
		return async ({ update }) => {
			await update({ reset: false });
			granting = false;
		};
	};

	// Only the grantPacks action returns a `message` (success toast for the Grant tab).
	let grantMsg = $derived(form && 'message' in form ? (form as { message?: string }).message : null);

	// Edit forms: keep the typed values after a successful save. SvelteKit's default
	// enhance resets the form on success, but Svelte sets the input `value` property
	// (not the defaultValue attribute), so a reset blanks every pre-filled field.
	const keepValues: SubmitFunction = () => async ({ update }) => update({ reset: false });

	// Blank ability rows appended to each form so admins can add more.
	const BLANK_ROWS = 3;

	type RawCard = PageData['cards'][number];
	type RawPack = PageData['packs'][number];

	// Cards group rarest → most common within a set (reverse of the ascending list).
	const RARITY_ORDER: CardRarity[] = [...RARITIES].reverse().map((r) => r.key);

	function toCard(c: RawCard): Card {
		return {
			id: c.id,
			name: c.name,
			level: c.level,
			rarity: (isValidRarity(c.rarity) ? c.rarity : DEFAULT_RARITY) as Card['rarity'],
			abilities: (c.abilities ?? []) as CardAbility[],
			flavor: c.flavor,
			front_url: c.front_url,
			back_url: c.back_url,
			layers: toCardLayers((c as { layers?: unknown }).layers),
			full_art: !!(c as { full_art?: boolean }).full_art,
			holo_url: (c as { holo_url?: string | null }).holo_url ?? null,
			sound_url: (c as { sound_url?: string | null }).sound_url ?? null,
			model_url: (c as { model_url?: string | null }).model_url ?? null,
			model_settings: (c as { model_settings?: Card['model_settings'] }).model_settings ?? null,
			models: (c as { models?: Card['models'] }).models ?? []
		};
	}

	function toPack(p: RawPack): CardPack {
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

	function cardRarity(c: RawCard): CardRarity {
		return isValidRarity(c.rarity) ? c.rarity : DEFAULT_RARITY;
	}

	// How many 3D depth layers a card has (jsonb array on the row).
	function layerCount(c: RawCard): number {
		const l = (c as { layers?: unknown }).layers;
		return Array.isArray(l) ? l.length : 0;
	}

	function cardsInPack(packId: string): RawCard[] {
		return data.cards.filter((c) => c.pack_id === packId);
	}

	// Split a card list into rarity buckets (rarest first), dropping empty ones.
	function byRarity(cards: RawCard[]) {
		return RARITY_ORDER.map((key) => ({
			meta: RARITY_BY_KEY[key],
			cards: cards.filter((c) => cardRarity(c) === key)
		})).filter((g) => g.cards.length > 0);
	}

	// Cards grouped by their set (pack order from the server), with a trailing
	// "No set" bucket for any orphans (pack_id is required, so usually empty).
	let cardGroups = $derived.by(() => {
		const groups: { pack: RawPack | null; cards: RawCard[] }[] = data.packs.map((p) => ({
			pack: p,
			cards: cardsInPack(p.id)
		}));
		const orphans = data.cards.filter(
			(c) => !c.pack_id || !data.packs.some((p) => p.id === c.pack_id)
		);
		if (orphans.length) groups.push({ pack: null, cards: orphans });
		return groups;
	});

	// Collapse state for the Existing-cards groups (keyed by pack id, or 'none' for
	// the orphan bucket) so admins can fold packs away and focus on certain sets.
	let collapsedGroups = $state(new Set<string>());
	function toggleGroup(key: string) {
		const next = new Set(collapsedGroups);
		if (next.has(key)) next.delete(key);
		else next.add(key);
		collapsedGroups = next;
	}
	function collapseAllGroups() {
		collapsedGroups = new Set(cardGroups.map((g) => g.pack?.id ?? 'none'));
	}
	function expandAllGroups() {
		collapsedGroups = new Set();
	}

	function rarityCount(packId: string, key: string): number {
		return cardsInPack(packId).filter((c) => cardRarity(c) === key).length;
	}

	// Only rarities that actually have cards in the set can be rolled, so the
	// per-slot editor only shows those (keeps the grid compact).
	function presentRarities(packId: string) {
		return RARITIES.filter((r) => rarityCount(packId, r.key) > 0);
	}

	// Editable per-slot rarity drop weights (relative). slotW[packId][slot][rarity].
	// Each slot is one card in the open; the number of slots = the pack's "Cards
	// per open". Seeded from the server's slot_weights; any slot the server hasn't
	// stored yet falls back to the pack's legacy per-pack rarity_weights.
	function blankSlotFor(p: RawPack): Record<string, number> {
		const legacy = (p.rarity_weights ?? {}) as Record<string, number>;
		const slot: Record<string, number> = {};
		for (const r of RARITIES) slot[r.key] = Number(legacy[r.key] ?? 0);
		return slot;
	}

	function seedSlotW(): Record<string, Record<string, number>[]> {
		const out: Record<string, Record<string, number>[]> = {};
		for (const p of data.packs) {
			const saved = (Array.isArray(p.slot_weights) ? p.slot_weights : []) as Record<string, number>[];
			const legacy = (p.rarity_weights ?? {}) as Record<string, number>;
			const count = Math.max(1, Number(p.cards_per_pack ?? 5));
			const arr: Record<string, number>[] = [];
			for (let i = 0; i < count; i++) {
				// A stored slot wins outright (missing keys = 0); only an entirely
				// unconfigured slot falls back to the legacy per-pack weights.
				const base = saved[i] ?? legacy;
				const slot: Record<string, number> = {};
				for (const r of RARITIES) slot[r.key] = Number(base?.[r.key] ?? 0);
				arr.push(slot);
			}
			out[p.id] = arr;
		}
		return out;
	}

	function seedSlotCount(): Record<string, number> {
		const out: Record<string, number> = {};
		for (const p of data.packs) out[p.id] = Math.max(1, Number(p.cards_per_pack ?? 5));
		return out;
	}

	// Editable per-slot holo chances (percent). slotFin[packId][slot] = {holo,reverse}.
	// Seeded from the server's slot_finishes; a pack with none seeded to the legacy
	// rule (last slot 100% holo, second-to-last 100% reverse) so the editor shows
	// the current effective behaviour and saving preserves it.
	type SlotFin = { holo: number; reverse: number };
	function seedSlotFin(): Record<string, SlotFin[]> {
		const out: Record<string, SlotFin[]> = {};
		for (const p of data.packs) {
			const saved = (Array.isArray(p.slot_finishes) ? p.slot_finishes : []) as SlotFin[];
			const count = Math.max(1, Number(p.cards_per_pack ?? 5));
			const arr: SlotFin[] = [];
			for (let i = 0; i < count; i++) {
				if (saved.length) {
					arr.push({ holo: Number(saved[i]?.holo ?? 0), reverse: Number(saved[i]?.reverse ?? 0) });
				} else if (i === count - 1) {
					arr.push({ holo: 100, reverse: 0 });
				} else if (i === count - 2) {
					arr.push({ holo: 0, reverse: 100 });
				} else {
					arr.push({ holo: 0, reverse: 0 });
				}
			}
			out[p.id] = arr;
		}
		return out;
	}

	let slotW = $state(seedSlotW());
	let slotCount = $state(seedSlotCount());
	let slotFin = $state(seedSlotFin());

	// Reseed when the server data changes (create/delete, or a save that updated
	// cards_per_pack / slot_weights). Keyed on the fields the editor mirrors.
	let lastPackKey = '';
	$effect(() => {
		const key = JSON.stringify(
			data.packs.map((p) => [p.id, p.cards_per_pack, p.slot_weights, p.slot_finishes])
		);
		if (key !== lastPackKey) {
			lastPackKey = key;
			slotW = seedSlotW();
			slotCount = seedSlotCount();
			slotFin = seedSlotFin();
		}
	});

	// Grow each pack's slot arrays to match its live "Cards per open" input so new
	// slots get editable rows immediately (slots past the count are kept but
	// ignored on save).
	$effect(() => {
		for (const p of data.packs) {
			const need = Math.max(1, Number(slotCount[p.id] ?? 1));
			const arr = (slotW[p.id] ??= []);
			while (arr.length < need) arr.push(blankSlotFor(p));
			const fin = (slotFin[p.id] ??= []);
			while (fin.length < need) fin.push({ holo: 0, reverse: 0 });
		}
	});

	// Live drop % for a rarity within one slot = its weight ÷ total weight of the
	// rarities present in the set, for that slot.
	function slotPct(packId: string, slot: number, key: string): number {
		if (rarityCount(packId, key) === 0) return 0;
		const s = slotW[packId]?.[slot];
		if (!s) return 0;
		let total = 0;
		for (const r of RARITIES) {
			if (rarityCount(packId, r.key) > 0) total += Math.max(0, s[r.key] ?? 0);
		}
		if (total <= 0) return 0;
		return (Math.max(0, s[key] ?? 0) / total) * 100;
	}

	// Live Normal % for a slot's finish = whatever isn't Holo or Reverse.
	function normalPct(packId: string, slot: number): number {
		const f = slotFin[packId]?.[slot];
		if (!f) return 100;
		return Math.max(0, 100 - (Number(f.holo) || 0) - (Number(f.reverse) || 0));
	}
</script>

<svelte:head>
	<title>Admin · Cards & Packs</title>
</svelte:head>

{#snippet cardEntry(raw: RawCard)}
	{@const card = toCard(raw)}
	{@const modelCount = card.models?.length ?? (card.model_url ? 1 : 0)}
	<li class="card">
		<div class="item-head">
			<button type="button" class="thumb thumb-btn" onclick={() => (inspecting = card)} title="Inspect in 3D">
				<CardThumb {card} flip={false} />
			</button>
			<div class="head-meta">
				<strong>{card.name}</strong>
				<span class="muted">{card.rarity}{#if card.level} · lvl {card.level}{/if}</span>
				<span class="muted small">Set: {packName(raw.pack_id)}</span>
				{#if card.abilities.length}
					<span class="muted small">{card.abilities.length} abilit{card.abilities.length === 1 ? 'y' : 'ies'}</span>
				{/if}
				{#if layerCount(raw)}
					<span class="muted small">3D · {layerCount(raw)} layer{layerCount(raw) === 1 ? '' : 's'}</span>
				{/if}
				{#if card.full_art}
					<span class="muted small">Full art · no holo</span>
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
			<form method="POST" action="?/updateCard" enctype="multipart/form-data" use:enhance={keepValues} class="edit-form">
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
						<span>Replace front art (optional — image or WEBM/MP4 video)</span>
						<input name="front" type="file" accept={FRONT_ACCEPT} />
					</label>
					<label>
						<span>Replace back art (optional)</span>
						<input name="back" type="file" accept="image/png,image/jpeg,image/webp,image/gif" />
					</label>
				</div>

				<label>
					<span>
						3D depth layers (optional) — uploading replaces all; stacked bottom→top.
						Images or WEBM/MP4 video (animated layer).
						{#if layerCount(raw)} · currently {layerCount(raw)}{/if}
					</span>
					<input name="layer" type="file" multiple accept={LAYER_ACCEPT} />
				</label>
				{#if card.layers && card.layers.length}
					<fieldset class="layer-fx">
						<legend>Layer effects <span class="muted small">(plays in 3D)</span></legend>
						{#each card.layers as ly, i}
							<div class="layer-fx-row">
								{#if isVideoLayerUrl(ly.url)}
									<!-- svelte-ignore a11y_media_has_caption -->
									<video class="layer-fx-thumb" src={ly.url} muted autoplay loop playsinline></video>
								{:else}
									<img class="layer-fx-thumb" src={ly.url} alt="Layer {i + 1}" />
								{/if}
								<span class="muted small">Layer {i + 1} (bottom→top)</span>
								<select name="existing_layer_effect">
									<option value="" selected={!ly.effect}>None</option>
									{#each LAYER_EFFECTS as fx}
										<option value={fx.key} selected={ly.effect === fx.key}>{fx.label}</option>
									{/each}
								</select>
							</div>
						{/each}
					</fieldset>
					<label class="check">
						<input type="checkbox" name="clear_layers" />
						<span>Remove all 3D layers</span>
					</label>
				{/if}

				<label class="check">
					<input type="checkbox" name="full_art" checked={card.full_art} />
					<span>Full art (skips the standard holo / reverse holo masks)</span>
				</label>

				<label>
					<span>
						Full-art holo image (optional) — foil over the whole card, full-art only
						{#if card.holo_url} · has one{/if}
					</span>
					<input name="holo" type="file" accept="image/png,image/jpeg,image/webp,image/gif" />
				</label>
				{#if card.holo_url}
					<label class="check">
						<input type="checkbox" name="remove_holo" />
						<span>Remove full-art holo image</span>
					</label>
				{/if}

				<label>
					<span>Open sound (optional — plays when the card is revealed){#if card.sound_url} · has one{/if}</span>
					<input name="sound" type="file" accept="audio/*" />
				</label>
				{#if card.sound_url}
					<div class="row">
						<audio controls src={card.sound_url} preload="none"></audio>
					</div>
					<label class="check">
						<input type="checkbox" name="remove_sound" />
						<span>Remove open sound</span>
					</label>
				{/if}

				<label>
					<span>3D models (optional .glb — add one or more){#if modelCount} · {modelCount} on card{/if}</span>
					<input name="model" type="file" accept={MODEL_ACCEPT} multiple />
					<span class="muted small">Export as glTF Binary (.glb), uncompressed (no Draco), low-poly. Uploading appends; place each in the builder.</span>
				</label>
				{#if modelCount}
					<div class="model-row">
						<button type="button" class="builder-btn" onclick={() => (builderCard = card)}>
							🎛 Open 3D builder — place, rotate, size &amp; animate ({modelCount})
						</button>
						<label class="check">
							<input type="checkbox" name="remove_models" />
							<span>Remove all 3D models</span>
						</label>
					</div>
				{/if}

				<button type="submit" class="primary">Save changes</button>
			</form>
		</details>
	</li>
{/snippet}

{#snippet packCardList(packId: string)}
	{@const cards = cardsInPack(packId)}
	{#if cards.length === 0}
		<p class="muted small">No cards in this set yet.</p>
	{:else}
		{#each byRarity(cards) as rg (rg.meta.key)}
			<div class="rarity-group">
				<span class="rarity-label" style="--rc: {rg.meta.color}">{rg.meta.label} ({rg.cards.length})</span>
				<ul class="mini-list">
					{#each rg.cards as raw (raw.id)}
						{@const card = toCard(raw)}
						<li class="mini-card">
							<button type="button" class="mini-thumb thumb-btn" onclick={() => (inspecting = card)} title="Inspect in 3D"><CardThumb {card} flip={false} /></button>
							<div class="mini-meta">
								<span class="mini-name">{card.name}</span>
								{#if card.level}<span class="muted small">lvl {card.level}</span>{/if}
							</div>
						</li>
					{/each}
				</ul>
			</div>
		{/each}
	{/if}
{/snippet}

<section>
	<CardsTabs />

	{#if form?.error}
		<div class="error">{form.error}</div>
	{/if}
	{#if grantMsg}
		<div class="ok">{grantMsg}</div>
	{/if}

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
								<option value={r.key} selected={r.key === DEFAULT_RARITY}>{r.label}</option>
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
						<span>Front art (image or WEBM/MP4 video)</span>
						<input name="front" type="file" accept={FRONT_ACCEPT} />
					</label>
					<label>
						<span>Back art (optional — defaults to the Volition card back)</span>
						<input name="back" type="file" accept="image/png,image/jpeg,image/webp,image/gif" />
					</label>
				</div>

				<label>
					<span>3D depth layers (optional, multiple — stacked bottom→top above the front). Images or WEBM/MP4 video.</span>
					<input name="layer" type="file" multiple accept={LAYER_ACCEPT} />
				</label>

				<label class="check">
					<input type="checkbox" name="full_art" />
					<span>Full art (skips the standard holo / reverse holo masks)</span>
				</label>

				<label>
					<span>Full-art holo image (optional) — foil over the whole card, full-art only</span>
					<input name="holo" type="file" accept="image/png,image/jpeg,image/webp,image/gif" />
				</label>

				<label>
					<span>Open sound (optional — plays when the card is revealed)</span>
					<input name="sound" type="file" accept="audio/*" />
				</label>

				<label>
					<span>3D models (optional .glb — add one or more)</span>
					<input name="model" type="file" accept={MODEL_ACCEPT} multiple />
					<span class="muted small">Export as glTF Binary (.glb), uncompressed (no Draco), low-poly. Place each in the 3D builder after creating (Edit).</span>
				</label>

				<button type="submit" class="primary">Create card</button>
			</form>
		</details>

		<div class="existing-head">
			<h2>Existing cards ({data.cards.length})</h2>
			{#if cardGroups.length > 1}
				<div class="group-controls">
					<button type="button" class="ghost small" onclick={expandAllGroups}>Expand all</button>
					<button type="button" class="ghost small" onclick={collapseAllGroups}>Collapse all</button>
				</div>
			{/if}
		</div>
		{#if data.cards.length === 0}
			<p class="muted">No cards yet.</p>
		{:else}
			{#each cardGroups as group (group.pack?.id ?? 'none')}
				{@const key = group.pack?.id ?? 'none'}
				{@const collapsed = collapsedGroups.has(key)}
				<section class="pack-group">
					<button
						type="button"
						class="group-head"
						aria-expanded={!collapsed}
						onclick={() => toggleGroup(key)}
					>
						<span class="chevron" class:collapsed>▾</span>
						{group.pack?.name ?? 'No set'}
						<span class="count">{group.cards.length}</span>
					</button>
					{#if !collapsed}
						{#each byRarity(group.cards) as rg (rg.meta.key)}
							<div class="rarity-group">
								<span class="rarity-label" style="--rc: {rg.meta.color}">{rg.meta.label} ({rg.cards.length})</span>
								<ul class="item-list">
									{#each rg.cards as raw (raw.id)}
										{@render cardEntry(raw)}
									{/each}
								</ul>
							</div>
						{/each}
					{/if}
				</section>
			{/each}
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
				<div class="row">
					<label>
						<span>Cost (VP)</span>
						<input name="cost_vp" type="number" min="0" value="0" />
					</label>
					<label>
						<span>Cards per open</span>
						<input name="cards_per_pack" type="number" min="1" max="50" value="5" />
					</label>
				</div>
				<label class="check">
					<input type="checkbox" name="released" />
					<span>Released (visible to players in the Gamba store)</span>
				</label>
				<label class="check">
					<input type="checkbox" name="teaser" />
					<span>Teaser (show in the store as a locked “coming soon” card — name + art only, can't be opened; ignored once released)</span>
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
				<div class="row">
					<label>
						<span>Regular holo foil (optional — overrides the default)</span>
						<input name="holo_regular" type="file" accept="image/png,image/jpeg,image/webp,image/gif" />
					</label>
					<label>
						<span>Reverse holo foil (optional — overrides the default)</span>
						<input name="holo_reverse" type="file" accept="image/png,image/jpeg,image/webp,image/gif" />
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
								<PackThumb {pack} flip={false} />
							</div>
							<div class="head-meta">
								<div class="name-row">
									<strong>{pack.name}</strong>
									<span class="badge" class:live={raw.released}>{raw.released ? 'Released' : 'Draft'}</span>
									{#if raw.weekly_free}<span class="badge weekly">Weekly free</span>{/if}
								</div>
								<span class="muted">{pack.cost_vp.toLocaleString()} VP · {raw.cards_per_pack} per open</span>
								<span class="muted small">{cardsInPack(pack.id).length} card{cardsInPack(pack.id).length === 1 ? '' : 's'}</span>
								{#if pack.description}
									<span class="muted small">{pack.description}</span>
								{/if}
							</div>
							<div class="head-actions">
								<form method="POST" action="?/toggleRelease" use:enhance>
									<input type="hidden" name="id" value={pack.id} />
									<button type="submit" class="toggle">
										{raw.released ? 'Unrelease' : 'Release'}
									</button>
								</form>
								<form method="POST" action="?/toggleWeeklyFree" use:enhance>
									<input type="hidden" name="id" value={pack.id} />
									<button type="submit" class="toggle" title="Free pack everyone can claim once a week">
										{raw.weekly_free ? 'Unset weekly' : 'Set weekly'}
									</button>
								</form>
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
						</div>

						<details class="edit-block cards-block">
							<summary>Cards in this set ({cardsInPack(pack.id).length})</summary>
							{@render packCardList(pack.id)}
						</details>

						<details class="edit-block">
							<summary>Edit</summary>
							<form method="POST" action="?/updatePack" enctype="multipart/form-data" use:enhance={keepValues} class="edit-form">
								<input type="hidden" name="id" value={pack.id} />
								<label>
									<span>Name</span>
									<input name="name" type="text" required value={pack.name} />
								</label>
								<label>
									<span>Description</span>
									<textarea name="description" rows="2">{pack.description ?? ''}</textarea>
								</label>
								<div class="row">
									<label>
										<span>Cost (VP)</span>
										<input name="cost_vp" type="number" min="0" value={pack.cost_vp} />
									</label>
									<label>
										<span>Cards per open</span>
										<input
											name="cards_per_pack"
											type="number"
											min="1"
											max="50"
											bind:value={slotCount[pack.id]}
										/>
									</label>
								</div>

								<fieldset class="rates">
									<legend>
										Per-slot drop rates
										<span class="muted small">(one card per slot · rarity = relative weights; holo/reverse = % chance for that slot)</span>
									</legend>
									{#if presentRarities(pack.id).length === 0}
										<p class="muted small">Add cards to this set first to set drop rates.</p>
									{:else}
										{#each (slotW[pack.id] ?? []).slice(0, Math.max(1, slotCount[pack.id] ?? 1)) as slot, i (i)}
											<div class="slot">
												<span class="slot-head">Slot {i + 1}</span>
												<div class="slot-grid">
													{#each presentRarities(pack.id) as r (r.key)}
														<label class="slot-rate">
															<span class="rate-name" style="--rc: {r.color}">{r.label}</span>
															<input
																type="number"
																min="0"
																step="any"
																name={`slot_${i}_weight_${r.key}`}
																bind:value={slot[r.key]}
															/>
															<span class="rate-pct">{slotPct(pack.id, i, r.key).toFixed(0)}%</span>
														</label>
													{/each}
												</div>
												<div class="slot-finish">
													<label class="fin"><span>Holo %</span><input type="number" min="0" max="100" step="any" name={`slot_${i}_holo`} bind:value={slotFin[pack.id][i].holo} /></label>
													<label class="fin"><span>Reverse %</span><input type="number" min="0" max="100" step="any" name={`slot_${i}_reverse`} bind:value={slotFin[pack.id][i].reverse} /></label>
													<span class="muted small">Normal {normalPct(pack.id, i).toFixed(0)}%</span>
												</div>
											</div>
										{/each}
									{/if}
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

								<fieldset class="rates">
									<legend>
										Holo foils <span class="muted small">(optional — overrides the default star/ripple for every holo pulled from this pack)</span>
									</legend>
									<div class="row">
										<label>
											<span>Regular holo foil{#if raw.holo_regular_url} · set{/if}</span>
											<input name="holo_regular" type="file" accept="image/png,image/jpeg,image/webp,image/gif" />
										</label>
										<label>
											<span>Reverse holo foil{#if raw.holo_reverse_url} · set{/if}</span>
											<input name="holo_reverse" type="file" accept="image/png,image/jpeg,image/webp,image/gif" />
										</label>
									</div>
									{#if raw.holo_regular_url}
										<label class="check">
											<input type="checkbox" name="remove_holo_regular" />
											<span>Remove regular holo foil</span>
										</label>
									{/if}
									{#if raw.holo_reverse_url}
										<label class="check">
											<input type="checkbox" name="remove_holo_reverse" />
											<span>Remove reverse holo foil</span>
										</label>
									{/if}
								</fieldset>

								<button type="submit" class="primary">Save changes</button>
							</form>
						</details>
					</li>
				{/each}
			</ul>
		{/if}
	{:else if tab === 'grant'}
		<p class="muted grant-note">
			Award card packs to members. Only members who have
			<strong>signed into the site</strong> can receive packs.
		</p>

		<form method="POST" action="?/grantPacks" use:enhance={onGrantSubmit} class="grant-form card">
			<label>
				<span>Pack</span>
				<select name="pack_id" required>
					<option value="" disabled selected>Pick a pack…</option>
					{#each data.packs as p (p.id)}
						<option value={p.id}>{p.name}{p.released ? '' : ' · unreleased'}</option>
					{/each}
				</select>
			</label>

			<fieldset class="target">
				<legend>Award to</legend>
				<label class="radio">
					<input type="radio" name="target" value="one" bind:group={grantTarget} />
					<span>A member</span>
				</label>
				<label class="radio">
					<input type="radio" name="target" value="all" bind:group={grantTarget} />
					<span>Everyone ({data.members.length} members)</span>
				</label>
			</fieldset>

			{#if grantTarget === 'one'}
				<label>
					<span>Member</span>
					<select name="user_id" required>
						<option value="" disabled selected>Pick a member…</option>
						{#each data.members as m (m.id)}
							<option value={m.id}>{memberLabel(m)}</option>
						{/each}
					</select>
				</label>
			{/if}

			<label>
				<span>Quantity</span>
				<input type="number" name="quantity" min="1" max="100" value="1" required />
			</label>

			<button type="submit" class="primary" disabled={granting}>
				{granting ? 'Awarding…' : 'Award pack(s)'}
			</button>
		</form>
	{/if}
</section>

{#if inspecting}
	<CardInspector3D card={inspecting} onClose={() => (inspecting = null)} allowFinishToggle />
{/if}

{#if builderCard}
	<CardModelBuilder card={builderCard} onClose={() => (builderCard = null)} />
{/if}

<style>
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

	.ok {
		background: var(--accent-soft);
		border: 1px solid var(--accent);
		color: var(--text);
		padding: 0.6rem 0.8rem;
		border-radius: 4px;
		margin-bottom: 1rem;
	}

	.grant-note {
		margin: 0 0 1rem;
		max-width: 40rem;
	}

	.grant-form {
		max-width: 28rem;
	}

	.target {
		border: 1px solid var(--border);
		border-radius: var(--radius);
		padding: 0.75rem;
		display: flex;
		gap: 1rem;
		margin: 0;
	}

	.target legend {
		font-size: 0.8rem;
		color: var(--muted);
		padding: 0 0.35rem;
	}

	.target .radio {
		flex-direction: row;
		align-items: center;
		gap: 0.4rem;
		cursor: pointer;
	}

	.target .radio input {
		width: auto;
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

	.model-row {
		display: flex;
		flex-direction: column;
		gap: 0.4rem;
		margin: 0.25rem 0 0.5rem;
	}

	.builder-btn {
		align-self: flex-start;
		padding: 0.45rem 0.8rem;
		font-family: 'rsbold', ui-sans-serif, Arial, sans-serif;
		font-size: 0.88rem;
		color: var(--accent);
		background: var(--accent-soft);
		border: 1px solid var(--accent);
		border-radius: var(--radius);
	}

	.builder-btn:hover {
		background: rgba(255, 152, 31, 0.2);
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

	.layer-fx {
		border: 1px solid var(--border);
		border-radius: var(--radius);
		padding: 0.75rem;
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
		margin: 0;
	}

	.layer-fx legend {
		font-size: 0.8rem;
		color: var(--muted);
		padding: 0 0.35rem;
	}

	.layer-fx-row {
		display: grid;
		grid-template-columns: auto 1fr auto;
		align-items: center;
		gap: 0.6rem;
	}

	.layer-fx-thumb {
		width: 2rem;
		height: 2rem;
		object-fit: cover;
		border-radius: 0.3rem;
		border: 1px solid var(--border);
		background: var(--surface);
	}

	.rates {
		border: 1px solid var(--border);
		border-radius: var(--radius);
		padding: 0.75rem;
		display: flex;
		flex-direction: column;
		gap: 0.4rem;
		margin: 0;
	}

	.rates legend {
		font-size: 0.8rem;
		color: var(--muted);
		padding: 0 0.35rem;
	}

	/* One block per slot (= one card in the open). */
	.slot {
		border: 1px solid var(--border);
		border-radius: var(--radius);
		padding: 0.5rem 0.6rem;
		background: var(--surface-alt);
	}

	.slot-head {
		display: block;
		margin-bottom: 0.4rem;
		font-family: 'rsbold', ui-sans-serif, Arial, sans-serif;
		font-size: 0.8rem;
		letter-spacing: 0.5px;
		color: var(--text);
	}

	.slot-grid {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(9.5rem, 1fr));
		gap: 0.4rem 0.6rem;
	}

	/* Per-slot holo chances, below that slot's rarity grid. */
	.slot-finish {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.5rem 0.75rem;
		margin-top: 0.5rem;
		padding-top: 0.5rem;
		border-top: 1px dashed var(--border);
	}

	.fin {
		flex-direction: row;
		align-items: center;
		gap: 0.35rem;
	}

	.fin span {
		font-size: 0.8rem;
	}

	.fin input {
		width: 3.6rem;
		padding: 0.2rem 0.3rem;
	}

	.slot-rate {
		flex-direction: row;
		align-items: center;
		gap: 0.35rem;
	}

	.rate-name {
		color: var(--rc);
		font-size: 0.85rem;
		flex: 1 1 auto;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.slot-rate input {
		width: 3.2rem;
		flex: 0 0 auto;
		padding: 0.2rem 0.3rem;
	}

	.rate-pct {
		flex: 0 0 auto;
		width: 2.6rem;
		text-align: right;
		font-size: 0.75rem;
		color: var(--muted);
		font-variant-numeric: tabular-nums;
	}

	/* Grouping: one section per set, rarity buckets within. */
	.pack-group {
		margin-bottom: 1.5rem;
	}

	.group-head {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		width: 100%;
		margin: 1.5rem 0 0.75rem;
		padding: 0 0 0.4rem;
		border: 0;
		border-bottom: 1px solid var(--border);
		border-radius: 0;
		background: none;
		text-align: left;
		font-family: 'rsbold', ui-sans-serif, Arial, sans-serif;
		font-size: 1.15rem;
		color: inherit;
		cursor: pointer;
		min-height: 0;
	}

	.group-head:hover {
		color: var(--accent);
	}

	.chevron {
		display: inline-block;
		font-size: 0.85rem;
		transition: transform 0.15s;
	}

	.chevron.collapsed {
		transform: rotate(-90deg);
	}

	.existing-head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 1rem;
		flex-wrap: wrap;
	}

	.group-controls {
		display: flex;
		gap: 0.4rem;
	}

	.ghost.small {
		padding: 0.25rem 0.6rem;
		font-size: 0.8rem;
		min-height: 0;
		background: var(--surface-alt);
		border: 1px solid var(--border);
		color: var(--muted);
	}

	.ghost.small:hover {
		border-color: var(--accent);
		color: var(--text);
	}

	.rarity-group {
		margin-bottom: 1rem;
	}

	.rarity-label {
		display: inline-block;
		margin: 0.35rem 0 0.5rem;
		padding: 0.1rem 0.6rem;
		border-radius: 999px;
		border: 1px solid var(--rc);
		color: var(--rc);
		font-size: 0.78rem;
		font-family: 'rsbold', ui-sans-serif, Arial, sans-serif;
		letter-spacing: 0.5px;
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

	/* Thumbnails are clickable to open the 3D inspector — strip button chrome. */
	.thumb-btn {
		display: block;
		padding: 0;
		border: none;
		background: none;
		min-height: 0;
		cursor: pointer;
	}

	.thumb-btn:hover {
		background: none;
	}

	.head-meta {
		display: flex;
		flex-direction: column;
		gap: 0.15rem;
		margin-right: auto;
		min-width: 0;
	}

	.name-row {
		display: flex;
		align-items: center;
		gap: 0.5rem;
	}

	.badge {
		padding: 0.05rem 0.5rem;
		border-radius: 999px;
		border: 1px solid var(--border);
		background: var(--surface-alt);
		color: var(--muted);
		font-size: 0.7rem;
		font-family: 'rsbold', ui-sans-serif, Arial, sans-serif;
		letter-spacing: 0.5px;
		text-transform: uppercase;
	}

	.badge.live {
		border-color: var(--success);
		color: var(--success);
		background: var(--success-bg);
	}

	.badge.weekly {
		border-color: var(--accent);
		color: var(--accent);
		background: var(--accent-soft);
	}

	.head-actions {
		display: flex;
		flex-direction: column;
		gap: 0.4rem;
		flex: 0 0 auto;
	}

	.head-actions form {
		margin: 0;
	}

	button.toggle {
		border-color: var(--accent);
		color: var(--accent);
		font-size: 0.9rem;
	}

	button.toggle:hover {
		background: var(--accent-soft);
	}

	label.check {
		flex-direction: row;
		align-items: center;
		gap: 0.5rem;
	}

	label.check input {
		width: auto;
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

	/* Compact card list shown when expanding a pack. */
	.mini-list {
		list-style: none;
		padding: 0;
		margin: 0.25rem 0 0;
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(12rem, 1fr));
		gap: 0.5rem;
	}

	.mini-card {
		display: flex;
		align-items: center;
		gap: 0.6rem;
		padding: 0.4rem 0.6rem;
		background: var(--surface-alt);
		border: 1px solid var(--border);
		border-radius: var(--radius);
		min-width: 0;
	}

	.mini-thumb {
		width: 2.75rem;
		flex: 0 0 auto;
	}

	.mini-meta {
		display: flex;
		flex-direction: column;
		gap: 0.1rem;
		min-width: 0;
	}

	.mini-name {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
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

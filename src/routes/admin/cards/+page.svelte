<script lang="ts">
	import type { PageData, ActionData } from './$types';
	import { enhance } from '$app/forms';
	import { page } from '$app/stores';
	import { fly, fade } from 'svelte/transition';
	import type { SubmitFunction } from '@sveltejs/kit';
	import CardsTabs from '$lib/admin/CardsTabs.svelte';
	import CardThumb from '$lib/cards/CardThumb.svelte';
	import PackThumb from '$lib/cards/PackThumb.svelte';
	import CardInspector3D from '$lib/cards/CardInspector3D.svelte';
	import CardModelBuilder from '$lib/cards/CardModelBuilder.svelte';
	import { formatGP } from '$lib/gp';
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
	import { LAYER_EFFECTS, isLayerEffect } from '$lib/cards/layerEffects';
	import { LAYER_ACCEPT, FRONT_ACCEPT, MODEL_ACCEPT, isVideoLayerUrl } from '$lib/cards/config';
	import { untrack } from 'svelte';
	import type { CardPack } from '$lib/cards/packs';

	let { data, form }: { data: PageData; form: ActionData } = $props();

	// Card testers get full CRUD; general admins get VIEW-only on the card/pack editors
	// (the create/edit/delete affordances are hidden and the forms render disabled).
	// The grant tab + the pack-test/sim/stats tools stay available to both.
	const canEdit = $derived(data.canEdit);

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

	// ── Edit drawer ───────────────────────────────────────────────────────
	// One slide-out panel handles create + edit for both cards and packs, so only
	// a single (heavy) edit form is ever mounted — the grids stay light no matter
	// how many cards exist. Editing targets are tracked by id and re-derived from
	// the (live-reloading) data so a save/refresh keeps the drawer in sync.
	type DrawerState =
		| { type: 'card-new' }
		| { type: 'card-edit'; id: string }
		| { type: 'pack-new' }
		| { type: 'pack-edit'; id: string }
		| null;
	let drawer = $state<DrawerState>(null);

	const drawerCard = $derived.by(() => {
		const d = drawer;
		if (d?.type !== 'card-edit') return null;
		return data.cards.find((c) => c.id === d.id) ?? null;
	});
	const drawerPack = $derived.by(() => {
		const d = drawer;
		if (d?.type !== 'pack-edit') return null;
		return data.packs.find((p) => p.id === d.id) ?? null;
	});

	const drawerKey = $derived(drawer ? `${drawer.type}:${'id' in drawer ? drawer.id : 'new'}` : '');
	const drawerTitle = $derived.by(() => {
		switch (drawer?.type) {
			case 'card-new':
				return 'New card';
			case 'card-edit':
				return drawerCard ? `Edit · ${drawerCard.name}` : 'Edit card';
			case 'pack-new':
				return 'New pack';
			case 'pack-edit':
				return drawerPack ? `Edit · ${drawerPack.name}` : 'Edit pack';
			default:
				return '';
		}
	});

	// Close the drawer if its target was deleted, or when switching tabs.
	$effect(() => {
		if (drawer?.type === 'card-edit' && !drawerCard) drawer = null;
		if (drawer?.type === 'pack-edit' && !drawerPack) drawer = null;
	});
	$effect(() => {
		tab;
		drawer = null;
	});
	// Lock background scroll while the drawer is open.
	$effect(() => {
		if (typeof document === 'undefined') return;
		document.body.style.overflow = drawer ? 'hidden' : '';
		return () => {
			document.body.style.overflow = '';
		};
	});

	// ── Filters ───────────────────────────────────────────────────────────
	let search = $state('');
	let packFilter = $state<string>('all'); // 'all' | 'none' | pack id
	let rarityFilter = $state<string>('all'); // 'all' | rarity key
	let packSearch = $state('');

	// ── Grant tab ─────────────────────────────────────────────────────────
	let grantTarget = $state<'one' | 'all' | 'event'>('one');
	let granting = $state(false);

	function memberLabel(m: PageData['members'][number]): string {
		return m.rsn || m.discord_username || 'Unknown member';
	}

	// Confirm before a mass grant; keep the form's typed values after submit.
	const onGrantSubmit: SubmitFunction = ({ formData, cancel }) => {
		const target = formData.get('target');
		const qty = formData.get('quantity') ?? '1';
		const packName = data.packs.find((p) => p.id === formData.get('pack_id'))?.name ?? 'this pack';
		if (target === 'all') {
			if (!confirm(`Give ${qty} × ${packName} to all ${data.members.length} members?`)) {
				cancel();
				return;
			}
		} else if (target === 'event') {
			const ev = data.events.find((e) => e.id === formData.get('event_id'));
			if (!confirm(`Give ${qty} × ${packName} to every clan member who participated in ${ev?.name ?? 'this event'}?`)) {
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
	// The event-participants grant also returns the recipient names (rsn/Discord).
	let grantRecipients = $derived(
		form && 'recipients' in form ? ((form as { recipients?: string[] }).recipients ?? []) : []
	);

	// Edit forms: keep the typed values after a successful save. SvelteKit's default
	// enhance resets the form on success, but Svelte sets the input `value` property
	// (not the defaultValue attribute), so a reset blanks every pre-filled field.
	const keepValues: SubmitFunction = () => async ({ update }) => update({ reset: false });

	// Create forms: on success close the drawer (the new row appears in the grid);
	// on failure keep the drawer + typed values so the error can be fixed.
	const onCreateDone: SubmitFunction = () => async ({ result, update }) => {
		await update();
		if (result.type === 'success') drawer = null;
	};

	// ── 3D depth-layer manager (card edit drawer) ──────────────────────────
	// Each row is an EXISTING layer (has path/url) or a NEW pending file. The drawer
	// edits order + depth + recessed + effect per layer; on submit we serialise the
	// order into `layers_json` and inject the new files (see onEditCard).
	type LayerRow = {
		key: string;
		url: string; // existing url, or a blob: preview url for a new file
		path: string | null; // existing storage path; null for a new file
		file: File | null; // set for a new pending layer
		effect: string; // '' or a LayerEffect key
		depth: number;
		inset: boolean;
		isVideo: boolean;
	};
	let layerRows = $state<LayerRow[]>([]);
	let nextLayerKey = 0;
	let seededLayerId = '';

	function defaultDepth(index: number): number {
		return Math.min(0.5, 0.08 * (index + 1));
	}

	// (Re)build the rows from a card's stored layers, revoking any blob previews first.
	function seedLayers(c: RawCard | null) {
		for (const r of layerRows) if (r.file && r.url.startsWith('blob:')) URL.revokeObjectURL(r.url);
		const raw = (Array.isArray((c as { layers?: unknown } | null)?.layers)
			? (c as { layers: unknown[] }).layers
			: []) as { path?: string; url?: string; effect?: string; depth?: number; inset?: boolean }[];
		layerRows = raw
			.filter((l) => typeof l.url === 'string' && l.url)
			.map((l, i) => ({
				key: `cur-${nextLayerKey++}`,
				url: l.url as string,
				path: typeof l.path === 'string' ? l.path : null,
				file: null,
				effect: isLayerEffect(l.effect) ? l.effect : '',
				depth:
					typeof l.depth === 'number' && Number.isFinite(l.depth) ? l.depth : defaultDepth(i),
				inset: l.inset === true,
				isVideo: isVideoLayerUrl(l.url as string)
			}));
	}

	// Seed when a different card opens for editing (not on incidental data reloads, so
	// in-progress edits survive). seedLayers reads layerRows, so untrack the call.
	$effect(() => {
		const c = drawer?.type === 'card-edit' ? drawerCard : null;
		if (!c) {
			seededLayerId = '';
			return;
		}
		if (seededLayerId !== c.id) {
			seededLayerId = c.id;
			untrack(() => seedLayers(c));
		}
	});

	function moveLayer(i: number, dir: -1 | 1) {
		const j = i + dir;
		if (j < 0 || j >= layerRows.length) return;
		const tmp = layerRows[i];
		layerRows[i] = layerRows[j];
		layerRows[j] = tmp;
	}

	function removeLayer(i: number) {
		const [r] = layerRows.splice(i, 1);
		if (r?.file && r.url.startsWith('blob:')) URL.revokeObjectURL(r.url);
	}

	function addLayerFiles(e: Event) {
		const input = e.currentTarget as HTMLInputElement;
		for (const f of Array.from(input.files ?? [])) {
			layerRows.push({
				key: `new-${nextLayerKey++}`,
				url: URL.createObjectURL(f),
				path: null,
				file: f,
				effect: '',
				depth: defaultDepth(layerRows.length),
				inset: false,
				isVideo: f.type.startsWith('video/')
			});
		}
		input.value = ''; // files live in layerRows now; injected via onEditCard
	}

	// Card edit submit: serialise the layer order into `layers_json` + inject the new
	// files as `layer` (with parallel new_layer_* meta), then keep the form's values.
	const onEditCard: SubmitFunction = ({ formData }) => {
		formData.delete('layer');
		formData.delete('new_layer_effect');
		formData.delete('new_layer_depth');
		formData.delete('new_layer_inset');
		const entries = layerRows.map((r) => {
			if (r.file) {
				formData.append('layer', r.file);
				formData.append('new_layer_effect', r.effect || '');
				formData.append('new_layer_depth', String(r.depth));
				formData.append('new_layer_inset', String(r.inset));
				return { new: true, effect: r.effect || null, depth: r.depth, inset: r.inset };
			}
			return { path: r.path, url: r.url, effect: r.effect || null, depth: r.depth, inset: r.inset };
		});
		formData.set('layers_json', JSON.stringify(entries));
		return async ({ update, result }) => {
			await update({ reset: false });
			// Refresh rows from the saved data so new files become existing layers (no
			// duplicate re-upload on the next save).
			if (result.type === 'success' && drawerCard) untrack(() => seedLayers(drawerCard));
		};
	};

	// Blank ability rows appended to each form so admins can add more.
	const BLANK_ROWS = 3;

	type RawCard = PageData['cards'][number];
	type RawPack = PageData['packs'][number];

	// Ascending index per rarity, for sorting grids rarest-first.
	const RARITY_INDEX: Record<string, number> = Object.fromEntries(
		RARITIES.map((r, i) => [r.key, i])
	);

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
			holo_border: !!(c as { holo_border?: boolean }).holo_border,
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

	function cardRarity(c: RawCard): CardRarity {
		return isValidRarity(c.rarity) ? c.rarity : DEFAULT_RARITY;
	}

	function modelCountFor(card: Card): number {
		return card.models?.length ?? (card.model_url ? 1 : 0);
	}

	// How many 3D depth layers a card has (jsonb array on the row).
	function layerCount(c: RawCard): number {
		const l = (c as { layers?: unknown }).layers;
		return Array.isArray(l) ? l.length : 0;
	}

	function cardsInPack(packId: string): RawCard[] {
		return data.cards.filter((c) => c.pack_id === packId);
	}

	// Sort a card list rarest-first, then by name.
	function sortedCards(cards: RawCard[]): RawCard[] {
		return [...cards].sort((a, b) => {
			const r = (RARITY_INDEX[cardRarity(b)] ?? 0) - (RARITY_INDEX[cardRarity(a)] ?? 0);
			return r !== 0 ? r : a.name.localeCompare(b.name);
		});
	}

	// A card matches the active search + rarity filters.
	function cardMatches(c: RawCard, q: string): boolean {
		if (q && !c.name.toLowerCase().includes(q)) return false;
		if (rarityFilter !== 'all' && cardRarity(c) !== rarityFilter) return false;
		return true;
	}

	// Cards grouped by their set (pack order from the server), honouring the search/
	// rarity/pack filters, with a trailing "No set" bucket for orphans. Empty groups
	// are hidden while filtering, but shown otherwise (so empty sets are visible).
	let cardGroups = $derived.by(() => {
		const q = search.trim().toLowerCase();
		const filtering = q !== '' || rarityFilter !== 'all' || packFilter !== 'all';
		const packs = packFilter === 'all' || packFilter === 'none'
			? data.packs
			: data.packs.filter((p) => p.id === packFilter);

		const groups: { pack: RawPack | null; cards: RawCard[] }[] = packs.map((p) => ({
			pack: p,
			cards: sortedCards(cardsInPack(p.id).filter((c) => cardMatches(c, q)))
		}));

		if (packFilter === 'all' || packFilter === 'none') {
			const orphans = sortedCards(
				data.cards.filter(
					(c) =>
						(!c.pack_id || !data.packs.some((p) => p.id === c.pack_id)) && cardMatches(c, q)
				)
			);
			if (orphans.length || (packFilter === 'none' && !filtering))
				groups.push({ pack: null, cards: orphans });
		}

		return groups.filter((g) => g.cards.length > 0 || !filtering);
	});

	let visibleCardCount = $derived(cardGroups.reduce((n, g) => n + g.cards.length, 0));

	let visiblePacks = $derived.by(() => {
		const q = packSearch.trim().toLowerCase();
		return q ? data.packs.filter((p) => p.name.toLowerCase().includes(q)) : data.packs;
	});

	// Collapse state for the card-grid groups (keyed by pack id, or 'none').
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

<svelte:window
	onkeydown={(e) => {
		if (e.key === 'Escape' && drawer && !builderCard && !inspecting) drawer = null;
	}}
/>

<!-- ── Card create/edit form (shared by the drawer) ── -->
{#snippet cardForm(card: Card | null, raw: RawCard | null)}
	{@const isEdit = !!raw}
	{@const modelCount = card ? modelCountFor(card) : 0}
	<form
		method="POST"
		action={isEdit ? '?/updateCard' : '?/createCard'}
		enctype="multipart/form-data"
		use:enhance={isEdit ? onEditCard : onCreateDone}
		class="edit-form"
	>
		{#if isEdit && card}<input type="hidden" name="id" value={card.id} />{/if}
		<fieldset class="form-ro" disabled={!canEdit}>
		<label>
			<span>Name</span>
			<input name="name" type="text" required value={card?.name ?? ''} placeholder="The Great Olm" />
		</label>
		<label>
			<span>Set / pack</span>
			<select name="pack_id" required>
				<option value="" disabled selected={!raw?.pack_id}>Pick a set…</option>
				{#each data.packs as p}
					<option value={p.id} selected={raw?.pack_id === p.id}>{p.name}</option>
				{/each}
			</select>
		</label>
		<div class="row">
			<label>
				<span>Combat level</span>
				<input name="level" type="number" min="0" value={card?.level ?? ''} placeholder="1043" />
			</label>
			<label>
				<span>Rarity</span>
				<select name="rarity">
					{#each RARITIES as r}
						<option value={r.key} selected={r.key === (card?.rarity ?? DEFAULT_RARITY)}>{r.label}</option>
					{/each}
				</select>
			</label>
		</div>
		<label>
			<span>Flavor / description</span>
			<textarea name="flavor" rows="2">{card?.flavor ?? ''}</textarea>
		</label>

		<fieldset class="abilities">
			<legend>Abilities <span class="muted small">(clear a name to remove it)</span></legend>
			{#each abilityRows(card) as ab}
				<div class="ability-row">
					<input name="ability_name" type="text" placeholder="Ability name" value={ab.name} />
					<input name="ability_desc" type="text" placeholder="Description" value={ab.description} />
				</div>
			{/each}
		</fieldset>

		<div class="row">
			<label>
				<span>{isEdit ? 'Replace front art' : 'Front art'} (image or WEBM/MP4 video)</span>
				<input name="front" type="file" accept={FRONT_ACCEPT} />
			</label>
			<label>
				<span>{isEdit ? 'Replace back art (optional)' : 'Back art (optional — defaults to the Volition card back)'}</span>
				<input name="back" type="file" accept="image/png,image/jpeg,image/webp,image/gif" />
			</label>
		</div>

		{#if isEdit}
			<fieldset class="layer-fx">
				<legend>
					3D depth layers
					<span class="muted small">(first = bottom; depth = how far off the card; Recessed = sunk into it)</span>
				</legend>
				{#if layerRows.length === 0}
					<p class="muted small">No layers yet — add images/video below.</p>
				{/if}
				{#each layerRows as row, i (row.key)}
					<div class="layer-row">
						<div class="layer-reorder">
							<button type="button" class="icon-mini" disabled={i === 0} onclick={() => moveLayer(i, -1)} title="Move up" aria-label="Move up">▲</button>
							<button type="button" class="icon-mini" disabled={i === layerRows.length - 1} onclick={() => moveLayer(i, 1)} title="Move down" aria-label="Move down">▼</button>
						</div>
						{#if row.isVideo}
							<!-- svelte-ignore a11y_media_has_caption -->
							<video class="layer-fx-thumb" src={row.url} muted autoplay loop playsinline></video>
						{:else}
							<img class="layer-fx-thumb" src={row.url} alt="Layer {i + 1}" />
						{/if}
						<div class="layer-controls">
							<label class="layer-depth">
								<span>{row.inset ? 'Depth into card' : 'Height off card'}: {row.depth.toFixed(2)}</span>
								<input type="range" min="0.02" max="0.5" step="0.01" bind:value={row.depth} />
							</label>
							<div class="layer-ctl-row">
								<label class="check"><input type="checkbox" bind:checked={row.inset} /><span>Recessed</span></label>
								<select bind:value={row.effect} class="layer-effect" aria-label="Layer effect">
									<option value="">No effect</option>
									{#each LAYER_EFFECTS as fx}
										<option value={fx.key}>{fx.label}</option>
									{/each}
								</select>
								<button type="button" class="icon-mini danger" onclick={() => removeLayer(i)} title="Delete layer" aria-label="Delete layer">🗑</button>
							</div>
						</div>
					</div>
				{/each}
				<label class="add-layers">
					<span>Add layers (image or WEBM/MP4 — placed at the bottom; reorder above)</span>
					<input type="file" multiple accept={LAYER_ACCEPT} onchange={addLayerFiles} />
				</label>
			</fieldset>
		{:else}
			<label>
				<span>3D depth layers (optional, multiple — stacked bottom→top above the front). Images or WEBM/MP4 video.</span>
				<input name="layer" type="file" multiple accept={LAYER_ACCEPT} />
			</label>
		{/if}

		<label class="check">
			<input type="checkbox" name="full_art" checked={card?.full_art ?? false} />
			<span>Full art (skips the standard holo / reverse holo masks)</span>
		</label>

		<label class="check">
			<input type="checkbox" name="holo_border" checked={card?.holo_border ?? false} />
			<span>Border reverse holo (full-art only — foil on the card frame only, leaving the art clean; otherwise a full-art holo covers the whole card)</span>
		</label>

		<label>
			<span>
				Full-art holo image (optional) — the foil texture, full-art only. Covers the whole card,
				or just the frame if “Border reverse holo” is on. Defaults to the reverse ripple foil if left empty.
				{#if isEdit && card?.holo_url} · has one{/if}
			</span>
			<input name="holo" type="file" accept="image/png,image/jpeg,image/webp,image/gif" />
		</label>
		{#if isEdit && card?.holo_url}
			<label class="check">
				<input type="checkbox" name="remove_holo" />
				<span>Remove full-art holo image</span>
			</label>
		{/if}

		<label>
			<span>Open sound (optional — plays when the card is revealed){#if isEdit && card?.sound_url} · has one{/if}</span>
			<input name="sound" type="file" accept="audio/*" />
		</label>
		{#if isEdit && card?.sound_url}
			<div class="row">
				<audio controls src={card.sound_url} preload="none"></audio>
			</div>
			<label class="check">
				<input type="checkbox" name="remove_sound" />
				<span>Remove open sound</span>
			</label>
		{/if}

		<label>
			<span>3D models (optional .glb — add one or more){#if isEdit && modelCount} · {modelCount} on card{/if}</span>
			<input name="model" type="file" accept={MODEL_ACCEPT} multiple />
			<span class="muted small">
				Export as glTF Binary (.glb), uncompressed (no Draco), low-poly.
				{isEdit ? 'Uploading appends; place each in the builder.' : 'Place each in the 3D builder after creating (Edit).'}
			</span>
		</label>
		{#if isEdit && card && modelCount}
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
		</fieldset>

		{#if canEdit}
			<button type="submit" class="primary">{isEdit ? 'Save changes' : 'Create card'}</button>
		{/if}
	</form>
{/snippet}

<!-- ── Compact card list shown inside a pack's edit drawer ── -->
{#snippet packCardList(packId: string)}
	{@const cards = sortedCards(cardsInPack(packId))}
	{#if cards.length === 0}
		<p class="muted small">No cards in this set yet.</p>
	{:else}
		<ul class="mini-list">
			{#each cards as raw (raw.id)}
				{@const card = toCard(raw)}
				<li class="mini-card">
					<button type="button" class="mini-thumb thumb-btn" onclick={() => (inspecting = card)} title="Inspect in 3D"><CardThumb {card} flip={false} /></button>
					<div class="mini-meta">
						<span class="mini-name">{card.name}</span>
						<span class="muted small" style="--rc: {RARITY_BY_KEY[card.rarity]?.color}">{card.rarity}{#if card.level} · lvl {card.level}{/if}</span>
					</div>
					<button type="button" class="mini-edit" onclick={() => (drawer = { type: 'card-edit', id: card.id })}>{canEdit ? 'Edit' : 'View'}</button>
				</li>
			{/each}
		</ul>
	{/if}
{/snippet}

<!-- ── Pack create form (drawer) ── -->
{#snippet packCreateForm()}
	<form method="POST" action="?/createPack" enctype="multipart/form-data" use:enhance={onCreateDone} class="edit-form">
		<fieldset class="form-ro" disabled={!canEdit}>
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
				<span>Cost (GP) — blank = not GP-buyable</span>
				<input name="cost_gp" type="number" min="0" placeholder="e.g. 2000000" />
			</label>
			<label>
				<span>Discount % (off the GP price)</span>
				<input name="discount_pct" type="number" min="0" max="100" value="0" />
			</label>
			<label>
				<span>Discount % (off the VP price)</span>
				<input name="discount_vp_pct" type="number" min="0" max="100" value="0" />
			</label>
			<label>
				<span>Cards per open</span>
				<input name="cards_per_pack" type="number" min="1" max="50" value="5" />
			</label>
		</div>
		<label>
			<span>Release status</span>
			<select name="release_status">
				<option value="draft">Not released (draft — hidden from the store)</option>
				<option value="coming_soon">Coming soon (locked “coming soon” card — name + art only, can't be opened)</option>
				<option value="released">Released (live and openable in the Gamba store)</option>
			</select>
		</label>
		<label class="check">
			<input type="checkbox" name="elemental" />
			<span>Elemental (event gift — never purchasable with VP or wallet; only shows in the store for players who own one. Award via the Grant tab.)</span>
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
		</fieldset>
		{#if canEdit}
			<button type="submit" class="primary">Create pack</button>
		{/if}
	</form>
{/snippet}

<!-- ── Pack edit form (drawer) ── -->
{#snippet packEditForm(raw: RawPack)}
	{@const pack = toPack(raw)}
	{@const releaseStatus = raw.released ? 'released' : raw.teaser ? 'coming_soon' : 'draft'}
	<form method="POST" action="?/updatePack" enctype="multipart/form-data" use:enhance={keepValues} class="edit-form">
		<input type="hidden" name="id" value={pack.id} />
		<fieldset class="form-ro" disabled={!canEdit}>
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
				<span>Cost (GP)</span>
				<input name="cost_gp" type="number" min="0" value={raw.cost_gp ?? ''} placeholder="not GP-buyable" />
			</label>
			<label>
				<span>Discount % (off the GP price)</span>
				<input name="discount_pct" type="number" min="0" max="100" value={raw.discount_pct ?? 0} />
			</label>
			<label>
				<span>Discount % (off the VP price)</span>
				<input name="discount_vp_pct" type="number" min="0" max="100" value={raw.discount_vp_pct ?? 0} />
			</label>
			<label>
				<span>Cards per open</span>
				<input name="cards_per_pack" type="number" min="1" max="50" bind:value={slotCount[pack.id]} />
			</label>
		</div>

		<label>
			<span>Release status</span>
			<select name="release_status">
				<option value="draft" selected={releaseStatus === 'draft'}>Not released (draft — hidden from the store)</option>
				<option value="coming_soon" selected={releaseStatus === 'coming_soon'}>Coming soon (locked “coming soon” card — name + art only, can't be opened)</option>
				<option value="released" selected={releaseStatus === 'released'}>Released (live and openable in the Gamba store)</option>
			</select>
		</label>
		<label class="check">
			<input type="checkbox" name="elemental" checked={raw.elemental} />
			<span>Elemental (event gift — never purchasable with VP or wallet; only shows in the store for players who own one. Award via the Grant tab.)</span>
		</label>

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
									<input type="number" min="0" step="any" name={`slot_${i}_weight_${r.key}`} bind:value={slot[r.key]} />
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
		</fieldset>
		{#if canEdit}
			<button type="submit" class="primary">Save changes</button>
		{/if}
	</form>
{/snippet}

<!-- ── Card grid tile ── -->
{#snippet cardTile(raw: RawCard)}
	{@const card = toCard(raw)}
	<li class="tile">
		<button type="button" class="tile-main" onclick={() => (inspecting = card)} title="Inspect {card.name} in 3D">
			<div class="tile-thumb"><CardThumb {card} flip={false} /></div>
			<span class="tile-name">{card.name}</span>
			<span class="tile-rarity" style="--rc: {RARITY_BY_KEY[card.rarity]?.color}">{card.rarity}{#if card.level} · lvl {card.level}{/if}</span>
			<span class="tile-tags">
				{#if layerCount(raw)}<span class="tag">3D ×{layerCount(raw)}</span>{/if}
				{#if modelCountFor(card)}<span class="tag">model</span>{/if}
				{#if card.full_art}<span class="tag">full art</span>{/if}
				{#if card.sound_url}<span class="tag">🔊</span>{/if}
			</span>
		</button>
		<div class="tile-foot">
			<button type="button" class="mini" onclick={() => (drawer = { type: 'card-edit', id: card.id })}>{canEdit ? 'Edit' : 'View'}</button>
		</div>
	</li>
{/snippet}

<!-- ── Pack grid tile ── -->
{#snippet packTile(raw: RawPack)}
	{@const pack = toPack(raw)}
	{@const n = cardsInPack(pack.id).length}
	<li class="tile pack-tile">
		<button type="button" class="tile-main" onclick={() => (drawer = { type: 'pack-edit', id: pack.id })} title="{canEdit ? 'Edit' : 'View'} {pack.name}">
			<div class="tile-thumb pack"><PackThumb {pack} flip={false} /></div>
			<span class="tile-name">{pack.name}</span>
			<span class="tile-badges">
				<span class="badge" class:live={raw.released}>{raw.released ? 'Released' : 'Draft'}</span>
				{#if raw.weekly_free}<span class="badge weekly">Weekly</span>{/if}
				{#if raw.teaser}<span class="badge teaser">Coming soon</span>{/if}
				{#if raw.elemental}<span class="badge elemental">Elemental</span>{/if}
			</span>
			<span class="muted small">{pack.cost_vp.toLocaleString()} VP{#if raw.cost_gp} · {formatGP(raw.cost_gp)} GP{/if}{#if raw.discount_vp_pct} · {raw.discount_vp_pct}% off VP{/if}{#if raw.discount_pct} · {raw.discount_pct}% off GP{/if} · {raw.cards_per_pack}/open · {n} card{n === 1 ? '' : 's'}</span>
		</button>
		{#if canEdit}
			<div class="pack-actions">
				<form method="POST" action="?/setReleaseStatus" use:enhance>
					<input type="hidden" name="id" value={pack.id} />
					<select
						name="release_status"
						class="status-select"
						title="Release status"
						value={raw.released ? 'released' : raw.teaser ? 'coming_soon' : 'draft'}
						onchange={(e) => e.currentTarget.form?.requestSubmit()}
					>
						<option value="draft">Not released</option>
						<option value="coming_soon">Coming soon</option>
						<option value="released">Released</option>
					</select>
				</form>
				<form method="POST" action="?/toggleWeeklyFree" use:enhance>
					<input type="hidden" name="id" value={pack.id} />
					<button type="submit" class="mini" title="Free pack everyone can claim once a week">{raw.weekly_free ? 'Unset weekly' : 'Set weekly'}</button>
				</form>
				<form method="POST" action="?/toggleElemental" use:enhance>
					<input type="hidden" name="id" value={pack.id} />
					<button type="submit" class="mini" title="Event gift — never purchasable; only shows for owners">{raw.elemental ? 'Unset elemental' : 'Make elemental'}</button>
				</form>
				<form method="POST" action="?/deletePack" use:enhance>
					<input type="hidden" name="id" value={pack.id} />
					<button type="submit" class="mini danger" onclick={(e) => { if (!confirm(`Delete "${pack.name}"?`)) e.preventDefault(); }}>Delete</button>
				</form>
			</div>
		{/if}
	</li>
{/snippet}

<section>
	<CardsTabs />

	{#if !canEdit && (tab === 'cards' || tab === 'packs')}
		<p class="ro-note">👁 View-only — creating, editing and deleting cards &amp; packs requires the card tester role. You can still grant packs and use the pack tester/simulator/stats.</p>
	{/if}

	{#if form?.error && !drawer}
		<div class="error">{form.error}</div>
	{/if}
	{#if grantMsg}
		<div class="ok">
			{grantMsg}
			{#if grantRecipients.length > 0}
				<details class="recipients">
					<summary>Show {grantRecipients.length} recipient{grantRecipients.length === 1 ? '' : 's'}</summary>
					<ul>
						{#each grantRecipients as name (name)}
							<li>{name}</li>
						{/each}
					</ul>
				</details>
			{/if}
		</div>
	{/if}

	{#if tab === 'cards'}
		{#if data.packs.length === 0}
			<div class="error">Create a set/pack first (Packs tab) — every card must belong to one.</div>
		{/if}

		<div class="toolbar">
			<input class="search" type="search" placeholder="Search cards…" bind:value={search} aria-label="Search cards" />
			<select bind:value={packFilter} aria-label="Filter by set">
				<option value="all">All sets</option>
				{#each data.packs as p (p.id)}
					<option value={p.id}>{p.name}</option>
				{/each}
				<option value="none">No set</option>
			</select>
			<select bind:value={rarityFilter} aria-label="Filter by rarity">
				<option value="all">All rarities</option>
				{#each [...RARITIES].reverse() as r (r.key)}
					<option value={r.key}>{r.label}</option>
				{/each}
			</select>
			<span class="result-count">{visibleCardCount} card{visibleCardCount === 1 ? '' : 's'}</span>
			{#if cardGroups.length > 1}
				<div class="group-controls">
					<button type="button" class="ghost small" onclick={expandAllGroups}>Expand all</button>
					<button type="button" class="ghost small" onclick={collapseAllGroups}>Collapse all</button>
				</div>
			{/if}
			{#if canEdit}
				<button type="button" class="primary new-btn" disabled={data.packs.length === 0} onclick={() => (drawer = { type: 'card-new' })}>+ New card</button>
			{/if}
		</div>

		{#if cardGroups.length === 0}
			<p class="muted">{data.cards.length === 0 ? 'No cards yet.' : 'No cards match your filters.'}</p>
		{:else}
			{#each cardGroups as group (group.pack?.id ?? 'none')}
				{@const key = group.pack?.id ?? 'none'}
				{@const collapsed = collapsedGroups.has(key)}
				<section class="pack-group">
					<button type="button" class="group-head" aria-expanded={!collapsed} onclick={() => toggleGroup(key)}>
						<span class="chevron" class:collapsed>▾</span>
						{group.pack?.name ?? 'No set'}
						<span class="count">{group.cards.length}</span>
					</button>
					{#if !collapsed}
						<ul class="card-grid">
							{#each group.cards as raw (raw.id)}
								{@render cardTile(raw)}
							{/each}
						</ul>
					{/if}
				</section>
			{/each}
		{/if}
	{:else if tab === 'packs'}
		<div class="toolbar">
			<input class="search" type="search" placeholder="Search packs…" bind:value={packSearch} aria-label="Search packs" />
			<span class="result-count">{visiblePacks.length} pack{visiblePacks.length === 1 ? '' : 's'}</span>
			{#if canEdit}
				<button type="button" class="primary new-btn" onclick={() => (drawer = { type: 'pack-new' })}>+ New pack</button>
			{/if}
		</div>

		{#if visiblePacks.length === 0}
			<p class="muted">{data.packs.length === 0 ? 'No packs yet.' : 'No packs match.'}</p>
		{:else}
			<ul class="pack-grid">
				{#each visiblePacks as raw (raw.id)}
					{@render packTile(raw)}
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
				<label class="radio">
					<input type="radio" name="target" value="event" bind:group={grantTarget} />
					<span>Event participants (clan members who completed ≥1 tile/task)</span>
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
			{:else if grantTarget === 'event'}
				<label>
					<span>Event</span>
					<select name="event_id" required>
						<option value="" disabled selected>Pick an event…</option>
						{#each data.events as e (e.id)}
							<option value={e.id}>{e.name}{e.status && e.status !== 'closed' ? ` · ${e.status}` : ''}</option>
						{/each}
					</select>
				</label>
				<p class="muted small">
					Grants to every <strong>clan member</strong> who completed at least one tile or task.
					Team completions credit the whole team. Non-clan participants are skipped.
				</p>
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

{#if drawer}
	<div class="drawer-backdrop" transition:fade={{ duration: 150 }} onclick={() => (drawer = null)} aria-hidden="true"></div>
	<div class="drawer" transition:fly={{ x: 540, duration: 200 }} role="dialog" aria-modal="true" aria-label={drawerTitle} tabindex="-1">
		<header class="drawer-head">
			<h2>{drawerTitle}</h2>
			<button type="button" class="close" onclick={() => (drawer = null)} aria-label="Close">✕</button>
		</header>
		<div class="drawer-body">
			{#if form?.error}
				<div class="error">{form.error}</div>
			{/if}
			{#key drawerKey}
				{#if drawer.type === 'card-new'}
					{@render cardForm(null, null)}
				{:else if drawer.type === 'card-edit' && drawerCard}
					{@render cardForm(toCard(drawerCard), drawerCard)}
					{#if canEdit}
						<form method="POST" action="?/deleteCard" use:enhance class="danger-zone">
							<input type="hidden" name="id" value={drawerCard.id} />
							<button
								type="submit"
								class="danger"
								onclick={(e) => { if (!confirm(`Delete "${drawerCard?.name}"?`)) e.preventDefault(); }}
							>
								Delete card
							</button>
						</form>
					{/if}
				{:else if drawer.type === 'pack-new'}
					{@render packCreateForm()}
				{:else if drawer.type === 'pack-edit' && drawerPack}
					<details class="edit-block cards-block" open>
						<summary>Cards in this set ({cardsInPack(drawerPack.id).length})</summary>
						{@render packCardList(drawerPack.id)}
					</details>
					{@render packEditForm(drawerPack)}
				{/if}
			{/key}
		</div>
	</div>
{/if}

{#if inspecting}
	<CardInspector3D card={inspecting} onClose={() => (inspecting = null)} allowFinishToggle />
{/if}

{#if builderCard}
	<CardModelBuilder card={builderCard} onClose={() => (builderCard = null)} />
{/if}

<style>
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

	.ok .recipients {
		margin-top: 0.4rem;
	}

	.ok .recipients summary {
		cursor: pointer;
		color: var(--muted);
		font-size: 0.85rem;
	}

	.ok .recipients ul {
		margin: 0.4rem 0 0;
		padding-left: 1.2rem;
		max-height: 12rem;
		overflow-y: auto;
		columns: 2;
	}

	.ok .recipients li {
		font-size: 0.85rem;
	}

	/* View-only (non-card-tester admin) banner on the Cards/Packs tabs. */
	.ro-note {
		background: rgba(255, 255, 255, 0.04);
		border: 1px solid var(--border);
		color: var(--muted);
		padding: 0.55rem 0.8rem;
		border-radius: 4px;
		margin: 0 0 1rem;
		font-size: 0.9rem;
	}

	/* Wraps an editor form's controls; `disabled` (admins without the card-tester role)
	   natively disables every descendant input. display:contents keeps the form's own
	   grid/flex layout intact (the fieldset itself generates no box). */
	.form-ro {
		display: contents;
		border: 0;
		margin: 0;
		padding: 0;
		min-inline-size: 0;
	}

	/* ── Toolbar (search + filters + new) ── */
	.toolbar {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.5rem;
		margin-bottom: 1.25rem;
	}

	.search {
		flex: 1 1 12rem;
		min-width: 8rem;
		max-width: 22rem;
	}

	.toolbar select {
		flex: 0 0 auto;
		width: auto;
	}

	.result-count {
		font-size: 0.8rem;
		color: var(--muted);
		font-variant-numeric: tabular-nums;
	}

	.new-btn {
		margin-left: auto;
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

	/* ── Card grouping ── */
	.pack-group {
		margin-bottom: 1.5rem;
	}

	.group-head {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		width: 100%;
		margin: 0 0 0.75rem;
		padding: 0 0 0.4rem;
		border: 0;
		border-bottom: 1px solid var(--border);
		border-radius: 0;
		background: none;
		text-align: left;
		font-family: var(--font-heading);
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

	.count {
		padding: 0.05rem 0.45rem;
		background: var(--surface-alt);
		border: 1px solid var(--border);
		border-radius: 3px;
		font-size: 0.75rem;
		color: var(--text);
	}

	/* ── Grids of tiles ── */
	.card-grid {
		list-style: none;
		margin: 0;
		padding: 0;
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(8.5rem, 1fr));
		gap: 0.75rem;
	}

	.pack-grid {
		list-style: none;
		margin: 0;
		padding: 0;
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(12rem, 1fr));
		gap: 0.9rem;
	}

	.tile {
		position: relative;
		display: flex;
		flex-direction: column;
		background: linear-gradient(180deg, rgba(58, 48, 36, 0.55), rgba(40, 32, 24, 0.55));
		border: 1px solid var(--border);
		border-radius: var(--radius);
		overflow: hidden;
	}

	.tile-main {
		display: flex;
		flex-direction: column;
		align-items: stretch;
		gap: 0.2rem;
		width: 100%;
		padding: 0.5rem 0.5rem 0.6rem;
		border: 0;
		background: none;
		text-align: left;
		cursor: pointer;
		color: var(--text);
		min-height: 0;
	}

	.tile-main:hover {
		background: rgba(255, 152, 31, 0.06);
	}

	.tile-thumb {
		width: 100%;
		margin-bottom: 0.35rem;
	}

	.tile-thumb.pack {
		max-width: 7.5rem;
		margin-inline: auto;
	}

	.tile-name {
		font-family: var(--font-heading);
		font-size: 0.92rem;
		line-height: 1.15;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.tile-rarity {
		font-size: 0.74rem;
		color: var(--rc, var(--muted));
		text-transform: capitalize;
	}

	.tile-tags {
		display: flex;
		flex-wrap: wrap;
		gap: 0.25rem;
		margin-top: 0.2rem;
	}

	.tag {
		font-size: 0.62rem;
		letter-spacing: 0.03em;
		padding: 0.02rem 0.35rem;
		border-radius: 3px;
		border: 1px solid var(--border);
		background: var(--surface-alt);
		color: var(--muted);
		white-space: nowrap;
	}

	.tile-badges {
		display: flex;
		flex-wrap: wrap;
		gap: 0.3rem;
		margin: 0.1rem 0;
	}

	/* Edit button below a card tile. */
	.tile-foot {
		padding: 0 0.5rem 0.5rem;
		margin-top: auto;
	}

	/* ── Pack tile footer ── */
	.pack-actions {
		display: flex;
		flex-wrap: wrap;
		gap: 0.3rem;
		padding: 0 0.5rem 0.5rem;
		margin-top: auto;
	}

	.pack-actions form {
		margin: 0;
		flex: 1 1 auto;
	}

	button.mini {
		width: 100%;
		padding: 0.3rem 0.4rem;
		font-size: 0.78rem;
		min-height: 0;
		border: 1px solid var(--border);
		color: var(--muted);
		background: var(--surface-alt);
	}

	button.mini:hover {
		border-color: var(--accent);
		color: var(--text);
	}

	button.mini.danger {
		color: var(--danger);
		border-color: transparent;
	}

	button.mini.danger:hover {
		border-color: var(--danger);
		background: var(--danger-bg);
	}

	/* Release-status dropdown in the pack list — styled to match the mini buttons. */
	.status-select {
		width: 100%;
		padding: 0.3rem 0.4rem;
		font-size: 0.78rem;
		min-height: 0;
		border: 1px solid var(--border);
		color: var(--muted);
		background: var(--surface-alt);
		border-radius: var(--radius, 6px);
		cursor: pointer;
	}

	.status-select:hover {
		border-color: var(--accent);
		color: var(--text);
	}

	.badge {
		padding: 0.05rem 0.5rem;
		border-radius: 3px;
		border: 1px solid var(--border);
		background: var(--surface-alt);
		color: var(--muted);
		font-size: 0.7rem;
		font-family: var(--font-heading);
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

	.badge.teaser {
		border-color: #c79a3a;
		color: #e0b34d;
		background: rgba(199, 154, 58, 0.15);
	}

	.badge.elemental {
		border-color: #6f7bff;
		color: #9aa6ff;
		background: rgba(111, 123, 255, 0.15);
	}

	/* ── Slide-out edit drawer ── */
	.drawer-backdrop {
		position: fixed;
		inset: 0;
		background: rgba(0, 0, 0, 0.55);
		z-index: 40;
	}

	.drawer {
		position: fixed;
		top: 0;
		right: 0;
		height: 100dvh;
		width: min(40rem, 100%);
		display: flex;
		flex-direction: column;
		background: linear-gradient(180deg, rgba(48, 40, 30, 0.98), rgba(34, 28, 21, 0.98));
		border-left: 1px solid var(--border);
		box-shadow: -10px 0 30px rgba(0, 0, 0, 0.45);
		z-index: 41;
	}

	.drawer-head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 1rem;
		padding: 1rem 1.25rem;
		border-bottom: 1px solid var(--border);
		flex: 0 0 auto;
	}

	.drawer-head h2 {
		margin: 0;
		font-size: 1.2rem;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.close {
		flex: 0 0 auto;
		width: 2rem;
		height: 2rem;
		padding: 0;
		min-height: 0;
		font-size: 1rem;
		line-height: 1;
		border: 1px solid var(--border);
		background: var(--surface-alt);
		color: var(--muted);
		cursor: pointer;
		border-radius: var(--radius);
	}

	.close:hover {
		border-color: var(--accent);
		color: var(--text);
	}

	.drawer-body {
		flex: 1 1 auto;
		overflow-y: auto;
		padding: 1.25rem;
	}

	/* ── Forms (drawer) ── */
	form {
		display: flex;
		flex-direction: column;
		gap: 0.75rem;
	}

	.edit-form {
		margin: 0;
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
		font-family: var(--font-heading);
		font-size: 0.88rem;
		color: var(--accent);
		background: var(--accent-soft);
		border: 1px solid var(--accent);
		border-radius: var(--radius);
	}

	.builder-btn:hover {
		background: rgba(255, 152, 31, 0.2);
	}

	.abilities,
	.layer-fx,
	.rates {
		border: 1px solid var(--border);
		border-radius: var(--radius);
		padding: 0.75rem;
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
		margin: 0;
	}

	.rates {
		gap: 0.4rem;
	}

	.abilities legend,
	.layer-fx legend,
	.rates legend {
		font-size: 0.8rem;
		color: var(--muted);
		padding: 0 0.35rem;
	}

	.ability-row {
		display: grid;
		grid-template-columns: 1fr 2fr;
		gap: 0.5rem;
	}

	/* Per-layer manager row: reorder | thumb | controls. */
	.layer-row {
		display: grid;
		grid-template-columns: auto auto 1fr;
		align-items: center;
		gap: 0.6rem;
		padding: 0.4rem;
		border: 1px solid var(--border);
		border-radius: var(--radius);
		background: var(--surface-alt);
	}

	.layer-reorder {
		display: flex;
		flex-direction: column;
		gap: 0.15rem;
	}

	.icon-mini {
		width: 1.5rem;
		height: 1.4rem;
		padding: 0;
		min-height: 0;
		font-size: 0.7rem;
		line-height: 1;
		border: 1px solid var(--border);
		border-radius: 0.25rem;
		background: var(--surface);
		cursor: pointer;
	}

	.icon-mini:hover:not(:disabled) {
		border-color: var(--accent);
	}

	.icon-mini:disabled {
		opacity: 0.35;
		cursor: default;
	}

	.icon-mini.danger {
		color: var(--danger);
	}

	.icon-mini.danger:hover {
		border-color: var(--danger);
		background: var(--danger-bg);
	}

	.layer-fx-thumb {
		width: 2.75rem;
		height: 2.75rem;
		object-fit: cover;
		border-radius: 0.3rem;
		border: 1px solid var(--border);
		background: var(--surface);
	}

	.layer-controls {
		display: flex;
		flex-direction: column;
		gap: 0.3rem;
		min-width: 0;
	}

	.layer-depth {
		gap: 0.15rem;
	}

	.layer-depth span {
		font-size: 0.75rem;
	}

	.layer-depth input[type='range'] {
		width: 100%;
	}

	.layer-ctl-row {
		display: flex;
		align-items: center;
		gap: 0.6rem;
		flex-wrap: wrap;
	}

	.layer-effect {
		width: auto;
		flex: 0 0 auto;
		padding: 0.2rem 0.3rem;
	}

	.add-layers {
		margin-top: 0.25rem;
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
		font-family: var(--font-heading);
		font-size: 0.8rem;
		letter-spacing: 0.5px;
		color: var(--text);
	}

	.slot-grid {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(9.5rem, 1fr));
		gap: 0.4rem 0.6rem;
	}

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

	label.check {
		flex-direction: row;
		align-items: center;
		gap: 0.5rem;
	}

	label.check input {
		width: auto;
	}

	.edit-block {
		margin-bottom: 1rem;
		padding-bottom: 0.75rem;
		border-bottom: 1px solid var(--border);
	}

	.edit-block summary {
		cursor: pointer;
		color: var(--accent);
		font-size: 0.95rem;
	}

	.cards-block {
		margin-top: 0;
	}

	/* Compact card list shown in a pack's edit drawer. */
	.mini-list {
		list-style: none;
		padding: 0;
		margin: 0.5rem 0 0;
		display: flex;
		flex-direction: column;
		gap: 0.4rem;
	}

	.mini-card {
		display: flex;
		align-items: center;
		gap: 0.6rem;
		padding: 0.35rem 0.5rem;
		background: var(--surface-alt);
		border: 1px solid var(--border);
		border-radius: var(--radius);
		min-width: 0;
	}

	.mini-thumb {
		width: 2.5rem;
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

	.mini-meta {
		display: flex;
		flex-direction: column;
		gap: 0.1rem;
		min-width: 0;
		margin-right: auto;
	}

	.mini-name {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.mini-meta .small {
		color: var(--rc, var(--muted));
		text-transform: capitalize;
	}

	.mini-edit {
		flex: 0 0 auto;
		padding: 0.25rem 0.6rem;
		font-size: 0.78rem;
		min-height: 0;
		border: 1px solid var(--border);
		color: var(--accent);
		background: none;
	}

	.mini-edit:hover {
		background: var(--accent-soft);
	}

	/* ── Grant tab ── */
	.grant-note {
		margin: 0 0 1rem;
		max-width: 40rem;
	}

	.grant-form {
		max-width: 28rem;
	}

	.card {
		padding: 1.25rem;
		background: linear-gradient(180deg, rgba(58, 48, 36, 0.85), rgba(40, 32, 24, 0.85));
		border: 1px solid var(--border);
		border-radius: var(--radius);
		box-shadow: var(--shadow-card);
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

	button.primary {
		border-color: var(--accent);
		font-family: var(--font-heading);
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

	/* Card delete, separated at the bottom of the edit drawer. */
	.danger-zone {
		margin-top: 1rem;
		padding-top: 1rem;
		border-top: 1px solid var(--border);
	}

	@media (max-width: 540px) {
		.drawer {
			width: 100%;
		}

		.new-btn {
			margin-left: 0;
		}
	}
</style>

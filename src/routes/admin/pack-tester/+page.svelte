<script lang="ts">
	import type { PageData } from './$types';
	import PackOpener from '$lib/cards/PackOpener.svelte';
	import { DEFAULT_PACK_FRONT } from '$lib/cards/packs';
	import type { Card } from '$lib/cards/rarity';

	let { data }: { data: PageData } = $props();

	let selectedId = $state('');
	let count = $state(5);
	let opened = $state<Card[]>([]);
	let openerOpen = $state(false);

	// Default to the first pack once data is available.
	$effect(() => {
		if (!selectedId && data.packs.length) selectedId = data.packs[0].id;
	});

	let selectedPack = $derived(data.packs.find((p) => p.id === selectedId) ?? null);

	function openPack() {
		const pool = selectedPack?.cards ?? [];
		if (pool.length === 0) return;
		// Uniform random, with replacement (duplicates allowed).
		const rolled: Card[] = [];
		for (let i = 0; i < count; i++) {
			rolled.push(pool[Math.floor(Math.random() * pool.length)]);
		}
		opened = rolled;
		openerOpen = true;
	}
</script>

<svelte:head>
	<title>Admin · Pack Tester</title>
</svelte:head>

<section>
	<h1>Pack tester</h1>
	<p class="muted note">
		Dev tool — opens are free, nothing is saved, and cards are picked uniformly at random from the
		set. Spin the pack, pull down to rip it open, then swipe through your pull.
	</p>

	{#if data.packs.length === 0}
		<p class="muted">No packs yet. Create one in <a href="/admin/cards">Cards &amp; Packs</a> → Packs tab.</p>
	{:else}
		<div class="controls card">
			<div class="pack-pick">
				<img
					src={selectedPack?.front_url || DEFAULT_PACK_FRONT}
					alt=""
					class="pack-art"
				/>
				<div class="pack-fields">
					<label>
						<span>Set / pack</span>
						<select bind:value={selectedId}>
							{#each data.packs as p}
								<option value={p.id}>{p.name} ({p.cards.length} cards)</option>
							{/each}
						</select>
					</label>
					<label>
						<span>Cards per open</span>
						<input type="number" min="1" max="50" bind:value={count} />
					</label>
					<button type="button" class="primary" onclick={openPack} disabled={!selectedPack?.cards.length}>
						Open pack
					</button>
				</div>
			</div>
			{#if selectedPack && selectedPack.cards.length === 0}
				<p class="muted warn">This set has no cards yet — add some in <a href="/admin/cards">Cards &amp; Packs</a>.</p>
			{/if}
		</div>

	{/if}
</section>

{#if openerOpen && selectedPack}
	<PackOpener
		pack={{ name: selectedPack.name, front_url: selectedPack.front_url, back_url: selectedPack.back_url }}
		cards={opened}
		onClose={() => (openerOpen = false)}
	/>
{/if}

<style>
	h1 {
		margin-bottom: 0.5rem;
	}

	.muted {
		color: var(--muted);
	}

	.note {
		margin-top: 0;
		max-width: 50rem;
	}

	.card {
		padding: 1.25rem;
		background: linear-gradient(180deg, rgba(58, 48, 36, 0.85), rgba(40, 32, 24, 0.85));
		border: 1px solid var(--border);
		border-radius: var(--radius);
		margin-bottom: 1.5rem;
		box-shadow: var(--shadow-card);
	}

	.pack-pick {
		display: flex;
		gap: 1rem;
		align-items: flex-start;
	}

	.pack-art {
		width: 6rem;
		aspect-ratio: 5 / 7;
		object-fit: cover;
		border: 1px solid var(--accent);
		border-radius: var(--radius);
		flex: 0 0 auto;
	}

	.pack-fields {
		display: flex;
		flex-direction: column;
		gap: 0.75rem;
		flex: 1;
		min-width: 0;
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

	.warn {
		margin: 0.75rem 0 0;
	}

	button.primary {
		border-color: var(--accent);
		font-family: 'rsbold', ui-sans-serif, Arial, sans-serif;
		align-self: flex-start;
	}

	button.primary:hover:not(:disabled) {
		background: var(--accent-soft);
	}

	button.primary:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}
</style>

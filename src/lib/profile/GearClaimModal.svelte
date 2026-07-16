<script lang="ts">
	// Manual gear-claim modal (untrackable rank gear — items whose obtain method never
	// registers a collection-log slot, e.g. Oathplate crafted from shards, or upgraded
	// variants combined outside the log). Mirrors the event submission modal's feel: a shared
	// ImageDropper (drag / drop / paste) for the proof, in a centred modal card. Posts to the
	// /me page's ?/submitGearClaim action and closes on success. Opened prefilled from the rank
	// grid's "Claim this item" shortcut.
	import { enhance } from '$app/forms';
	import { invalidateAll } from '$app/navigation';
	import ImageDropper from '$lib/ImageDropper.svelte';
	import WikiImage from '$lib/WikiImage.svelte';
	import { itemImageUrl, wikiPageUrl } from '$lib/wikiImage';

	interface ClaimableItem {
		item: string;
		entry: string;
		points: number;
	}
	interface ExistingClaim {
		id: number | string;
		item_name: string;
		status: string;
		review_note?: string | null;
	}

	interface Props {
		// Prefilled item name (bindable so the datalist input stays editable).
		item: string;
		claimableGear: ClaimableItem[];
		existingClaims: ExistingClaim[];
		onclose: () => void;
	}

	let { item = $bindable(''), claimableGear, existingClaims, onclose }: Props = $props();

	let submitting = $state(false);
	let error = $state<string | null>(null);
	let dropCount = $state(0);
	let dropError = $state<string | null>(null);
	let resetKey = $state(0);

	// Submit is allowed once an item is named and at least one proof image is staged.
	const canSubmit = $derived(item.trim().length > 0 && dropCount > 0 && !submitting);

	function onKey(e: KeyboardEvent) {
		if (e.key === 'Escape') onclose();
	}
	function backdropClick(e: MouseEvent) {
		if (e.target === e.currentTarget) onclose();
	}
</script>

<svelte:window onkeydown={onKey} />

<!-- svelte-ignore a11y_click_events_have_key_events -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="backdrop" onclick={backdropClick}>
	<div class="modal" role="dialog" aria-labelledby="claim-title" aria-modal="true">
		<button type="button" class="close" aria-label="Close" onclick={onclose}>×</button>

		<header class="head">
			{#if item.trim()}
				<div class="head-img"><WikiImage src={itemImageUrl(item.trim())} alt={item} size={40} /></div>
			{/if}
			<div class="head-text">
				<h2 id="claim-title">Claim rank gear</h2>
				<p class="sub">Prove gear the collection log can't see</p>
			</div>
		</header>

		<p class="intro">
			Some gear counts for rank but never shows in your collection log — the way you obtained it
			just doesn't register a log slot, like Oathplate crafted from Oathplate shards, or upgraded
			variants combined outside the log (Blood Torva, Radiant Oathplate, …). Pick the item, drop
			or paste a screenshot showing you own it, and an admin will review. Approved items count the
			next time you check your rank.
		</p>

		<form
			method="POST"
			action="?/submitGearClaim"
			enctype="multipart/form-data"
			use:enhance={() => {
				submitting = true;
				error = null;
				return async ({ result, update }) => {
					await update({ reset: false });
					submitting = false;
					if (result.type === 'success') {
						resetKey++; // clear the staged images
						await invalidateAll();
						onclose();
					} else if (result.type === 'failure') {
						const data = result.data as { claimError?: string } | undefined;
						error = data?.claimError ?? 'Submit failed';
					} else if (result.type === 'error') {
						error = result.error?.message ?? 'Something went wrong';
					}
				};
			}}
		>
			<label class="field">
				<span class="field-label">Item</span>
				<input
					list="gear-claim-items"
					name="item_name"
					placeholder="Item (e.g. Oathplate chest)"
					bind:value={item}
					autocomplete="off"
					required
				/>
				<datalist id="gear-claim-items">
					{#each claimableGear as g (g.item)}
						<option value={g.item}>{g.entry} · {g.points} pts</option>
					{/each}
				</datalist>
			</label>

			<span class="field-label">Proof</span>
			<ImageDropper
				name="proof"
				captureWindowPaste
				{resetKey}
				bind:count={dropCount}
				bind:error={dropError}
			/>

			<label class="field">
				<span class="field-label">Note for the reviewer <em>(optional)</em></span>
				<input type="text" name="note" placeholder="Anything the reviewer should know" />
			</label>

			{#if dropError}<p class="error">{dropError}</p>{/if}
			{#if error}<p class="error">{error}</p>{/if}

			<div class="actions">
				<button type="submit" class="primary" disabled={!canSubmit}>
					{#if submitting}Submitting…{:else}Submit {dropCount > 1 ? `${dropCount} images` : 'claim'}{/if}
				</button>
				<button type="button" onclick={onclose} disabled={submitting}>Cancel</button>
			</div>
		</form>

		{#if existingClaims.length}
			<section class="existing">
				<h3>Your claims</h3>
				<ul class="claim-list">
					{#each existingClaims as c (c.id)}
						<li>
							<a href={wikiPageUrl(c.item_name)} target="_blank" rel="noreferrer noopener">{c.item_name} ↗</a>
							<span class="claim-status {c.status}">{c.status}</span>
							{#if c.status === 'rejected' && c.review_note}
								<span class="muted small">— {c.review_note}</span>
							{/if}
						</li>
					{/each}
				</ul>
			</section>
		{/if}
	</div>
</div>

<style>
	.backdrop {
		position: fixed;
		inset: 0;
		background: rgba(0, 0, 0, 0.72);
		z-index: 100;
		display: flex;
		align-items: flex-start;
		justify-content: center;
		padding: 2rem 1rem 4rem;
		overflow-y: auto;
	}

	.modal {
		position: relative;
		width: 100%;
		max-width: 34rem;
		padding: 1.5rem;
		background: linear-gradient(180deg, rgba(58, 48, 36, 0.97), rgba(40, 32, 24, 0.97));
		border: 1px solid var(--border);
		border-radius: var(--radius);
		box-shadow: var(--shadow-card);
		color: var(--text);
		font-family: var(--font-body);
	}

	.close {
		position: absolute;
		top: 6px;
		right: 8px;
		width: 32px;
		height: 32px;
		min-height: 0;
		padding: 0;
		display: flex;
		align-items: center;
		justify-content: center;
		line-height: 1;
		font-family: var(--font-heading);
		font-size: 1.4rem;
		background: transparent;
		border-color: transparent;
		color: var(--muted);
	}
	.close:hover {
		color: var(--accent);
		background: transparent;
	}

	.head {
		display: flex;
		align-items: center;
		gap: 0.75rem;
		margin-bottom: 0.75rem;
		padding-right: 2rem;
	}
	.head-img {
		width: 3rem;
		height: 3rem;
		display: flex;
		align-items: center;
		justify-content: center;
		flex-shrink: 0;
		background: var(--surface-alt);
		border: 1px solid var(--border);
		border-radius: var(--radius);
	}
	.head-text {
		display: flex;
		flex-direction: column;
		gap: 0.15rem;
		min-width: 0;
	}
	.head h2 {
		margin: 0;
		font-size: 1.3rem;
	}
	.head .sub {
		margin: 0;
		font-size: 0.8rem;
		color: var(--muted);
	}

	.intro {
		margin: 0 0 0.75rem;
		font-size: 0.85rem;
		color: var(--muted);
	}

	.field {
		display: flex;
		flex-direction: column;
		gap: 0.3rem;
		margin-bottom: 0.5rem;
	}
	.field-label {
		font-family: var(--font-heading);
		font-size: 0.85rem;
		color: var(--accent);
		letter-spacing: 0.5px;
	}
	.field-label em {
		font-family: var(--font-body);
		font-style: normal;
		font-size: 0.72rem;
		color: var(--muted);
	}
	.field input,
	.existing + * {
		width: 100%;
	}
	input[type='text'],
	input[list] {
		width: 100%;
		padding: 0.4rem 0.55rem;
		background: var(--surface);
		border: 1px solid var(--border-strong);
		border-radius: 3px;
		color: var(--text);
		font-family: var(--font-body);
		font-size: 0.9rem;
	}

	.actions {
		display: flex;
		gap: 0.5rem;
		flex-wrap: wrap;
		margin-top: 0.5rem;
	}
	button.primary {
		border-color: var(--accent);
	}
	button.primary:hover:not(:disabled) {
		background: var(--accent-soft);
	}

	.error {
		margin: 0.5rem 0 0;
		padding: 0.5rem 0.7rem;
		background: var(--danger-bg);
		border: 1px solid var(--danger);
		color: var(--danger);
		border-radius: 3px;
		font-size: 0.85rem;
	}

	.existing {
		margin-top: 1.25rem;
		padding-top: 1rem;
		border-top: 1px solid var(--border);
	}
	.existing h3 {
		margin: 0 0 0.5rem;
		font-size: 0.95rem;
	}
	.claim-list {
		list-style: none;
		margin: 0;
		padding: 0;
		display: flex;
		flex-direction: column;
		gap: 0.35rem;
	}
	.claim-list li {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		flex-wrap: wrap;
		font-size: 0.85rem;
	}
	.claim-list a {
		color: var(--text);
	}
	.claim-status {
		font-size: 0.65rem;
		text-transform: uppercase;
		letter-spacing: 0.04em;
		padding: 0.02rem 0.4rem;
		border-radius: 3px;
		border: 1px solid var(--border);
		color: var(--muted);
	}
	.claim-status.pending {
		background: rgba(255, 152, 31, 0.18);
		border-color: var(--accent);
		color: var(--accent);
	}
	.claim-status.approved {
		background: var(--success-bg);
		border-color: var(--success);
		color: var(--success);
	}
	.claim-status.rejected {
		background: var(--danger-bg);
		border-color: var(--danger);
		color: var(--danger);
	}
	.muted {
		color: var(--muted);
	}
	.small {
		font-size: 0.8rem;
	}
</style>

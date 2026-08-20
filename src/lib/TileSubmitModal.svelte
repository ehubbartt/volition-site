<script lang="ts">
	import WikiImage from '$lib/WikiImage.svelte';
	import { enhance } from '$app/forms';
	import ImageDropper from '$lib/ImageDropper.svelte';
	import type { Snippet } from 'svelte';

	// Reusable "submit a tile" modal: an optional proof-image dropper + a submit button that
	// POSTs (multipart) to `submitUrl` with `tile_id` and the `proof` files. Generic so it works
	// for personal-bingo tiles and other board/event submissions. The caller owns the form
	// action and closes the modal via `onclose` (called after a successful submit). Content
	// placed inside the component (children) renders between the header and the form — the
	// personal board uses it to show the tile's details alongside the submit controls.
	interface Props {
		tile: { id: string | number; name: string; img?: string | string[] | null };
		submitUrl: string; // form action, e.g. "?/submitTile"
		onclose: () => void;
		note?: string; // optional helper line under the header
		requireImage?: boolean; // if true, at least one image is needed to submit
		submitLabel?: string; // verb on the button (default "Submit")
		children?: Snippet; // optional extra content (e.g. tile details) above the form
		// Extra inputs rendered INSIDE the form, above the dropper, so they post with it.
		// `children` sits outside the form and can't carry fields — use this for anything
		// the action needs (e.g. Battleship's drop value).
		fields?: Snippet;
	}
	let {
		tile,
		submitUrl,
		onclose,
		note = '',
		requireImage = false,
		submitLabel = 'Submit',
		children,
		fields
	}: Props = $props();

	let stagedCount = $state(0);
	let resetKey = $state(0);
	let submitting = $state(false);
	let error = $state<string | null>(null);

	function onKey(e: KeyboardEvent) {
		if (e.key === 'Escape') onclose();
	}
	function backdropClick(e: MouseEvent) {
		if (e.target === e.currentTarget) onclose();
	}
</script>

<svelte:window onkeydown={onKey} />

<div class="backdrop" role="presentation" onclick={backdropClick}>
	<div class="modal" role="dialog" tabindex="-1" aria-label={`Submit ${tile.name}`} aria-modal="true">
		<button type="button" class="close" aria-label="Close" onclick={onclose}>×</button>

		<header class="head">
			{#if tile.img}
				<div class="head-icon"><WikiImage src={tile.img} alt="" size={32} /></div>
			{/if}
			<h2>{tile.name}</h2>
		</header>

		{#if children}{@render children()}{/if}

		{#if note}<p class="note">{note}</p>{/if}

		<form
			method="POST"
			enctype="multipart/form-data"
			action={submitUrl}
			use:enhance={() => {
				submitting = true;
				error = null;
				return async ({ result, update }) => {
					await update({ reset: false });
					submitting = false;
					if (result.type === 'success') {
						resetKey += 1;
						onclose();
					} else if (result.type === 'failure') {
						const data = result.data as { error?: string } | undefined;
						error = data?.error ?? 'Submit failed';
					} else if (result.type === 'error') {
						error = result.error?.message ?? 'Something went wrong';
					}
				};
			}}
		>
			<input type="hidden" name="tile_id" value={tile.id} />

			{#if fields}<div class="fields">{@render fields()}</div>{/if}

			<ImageDropper bind:count={stagedCount} bind:error {resetKey} captureWindowPaste />

			{#if error}<p class="error">{error}</p>{/if}

			<div class="actions">
				<button type="submit" class="primary" disabled={submitting || (requireImage && stagedCount === 0)}>
					{#if submitting}
						Submitting…
					{:else}
						{submitLabel}{stagedCount > 0 ? ` ${stagedCount > 1 ? `${stagedCount} images` : 'proof'}` : ''}
					{/if}
				</button>
				{#if stagedCount > 0}
					<button type="button" onclick={() => (resetKey += 1)}>Clear</button>
				{/if}
			</div>
		</form>
	</div>
</div>

<style>
	.backdrop {
		position: fixed;
		inset: 0;
		z-index: 60;
		display: flex;
		align-items: center;
		justify-content: center;
		padding: 1rem;
		background: rgba(0, 0, 0, 0.6);
	}
	.modal {
		position: relative;
		width: 100%;
		max-width: 26rem;
		background: #2a2418;
		border: 4px solid transparent;
		border-image: url('/osrs/border-tiny.png') 4 / 4px round;
		border-radius: 6px;
		padding: 1.1rem 1.2rem 1.2rem;
	}
	.close {
		position: absolute;
		top: 0.35rem;
		right: 0.5rem;
		background: none;
		border: none;
		min-height: 0;
		padding: 0.1rem 0.4rem;
		font-size: 1.3rem;
		line-height: 1;
		color: var(--muted);
		cursor: pointer;
	}
	.close:hover {
		color: var(--accent);
	}
	.head {
		display: flex;
		align-items: center;
		gap: 0.7rem;
		margin: 0 1.5rem 0.6rem 0;
	}
	.head-icon {
		flex: none;
		display: flex;
		align-items: center;
		justify-content: center;
		width: 48px;
		height: 48px;
		border-radius: 50%;
		background: radial-gradient(circle at 50% 38%, #f1e8cf, #c3b088);
		box-shadow: inset 0 0 0 2px rgba(0, 0, 0, 0.45);
	}
	/* :global — the <img> is rendered by <WikiImage>, so a scoped selector never matches it. */
	.head-icon :global(img) {
		max-width: 66%;
		max-height: 66%;
		object-fit: contain;
	}
	.head h2 {
		margin: 0;
		font-size: 1.05rem;
		color: var(--accent);
	}
	.note {
		margin: 0 0 0.8rem;
		font-size: 0.85rem;
		color: var(--muted);
	}
	.error {
		color: var(--danger, #e06666);
		font-size: 0.85rem;
		margin: 0.5rem 0 0;
	}
	/* Caller-supplied inputs. Styled here so every consumer's fields look the same
	   rather than each page re-styling them. */
	.fields {
		display: grid;
		gap: 0.55rem;
		margin-bottom: 0.75rem;
	}
	.fields :global(label) {
		display: grid;
		gap: 0.2rem;
		font-size: 0.85rem;
	}
	.fields :global(input) {
		background: var(--surface-alt);
		color: var(--text);
		border: 1px solid var(--border);
		border-radius: var(--radius);
		padding: 0.4rem 0.5rem;
		font-family: var(--font-body);
		font-size: 0.9rem;
		width: 100%;
	}
	.actions {
		display: flex;
		gap: 0.6rem;
		margin-top: 0.9rem;
	}
</style>

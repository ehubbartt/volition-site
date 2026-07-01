<script lang="ts">
	import { enhance } from '$app/forms';
	import ImageDropper from '$lib/ImageDropper.svelte';

	// Reusable "submit a tile" modal: an optional proof-image dropper + a submit button that
	// POSTs (multipart) to `submitUrl` with `tile_id` and the `proof` files. Generic so it works
	// for personal-bingo tiles and other board/event submissions. The caller owns the form
	// action and closes the modal via `onclose` (called after a successful submit).
	interface Props {
		tile: { id: string | number; name: string; img?: string | null };
		submitUrl: string; // form action, e.g. "?/submitTile"
		onclose: () => void;
		note?: string; // optional helper line under the header
		requireImage?: boolean; // if true, at least one image is needed to submit
		submitLabel?: string; // verb on the button (default "Submit")
	}
	let { tile, submitUrl, onclose, note = '', requireImage = false, submitLabel = 'Submit' }: Props = $props();

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
				<div class="head-icon"><img src={tile.img} alt="" referrerpolicy="no-referrer" onerror={(e) => ((e.currentTarget as HTMLImageElement).style.display = 'none')} /></div>
			{/if}
			<h2>{tile.name}</h2>
		</header>

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
	.head-icon img {
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
	.actions {
		display: flex;
		gap: 0.6rem;
		margin-top: 0.9rem;
	}
</style>

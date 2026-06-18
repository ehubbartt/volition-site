<script lang="ts">
	// Reusable on-theme confirmation modal — a styled replacement for window.confirm().
	// The parent owns the action: `onconfirm` fires when the user clicks Confirm (the
	// dialog does NOT auto-close on confirm, so the parent can close it once its async
	// work finishes). Cancel / backdrop / Escape close it and fire `oncancel`.
	import type { Snippet } from 'svelte';

	let {
		open = $bindable(false),
		title,
		message = '',
		confirmLabel = 'Confirm',
		cancelLabel = 'Cancel',
		busyLabel,
		busy = false,
		danger = false,
		onconfirm,
		oncancel,
		children
	}: {
		open?: boolean;
		title: string;
		message?: string;
		confirmLabel?: string;
		cancelLabel?: string;
		busyLabel?: string;
		busy?: boolean;
		danger?: boolean;
		onconfirm?: () => void;
		oncancel?: () => void;
		children?: Snippet;
	} = $props();

	function cancel() {
		if (busy) return;
		open = false;
		oncancel?.();
	}
</script>

<svelte:window
	onkeydown={(e) => {
		if (open && e.key === 'Escape') cancel();
	}}
/>

{#if open}
	<div
		class="overlay"
		role="button"
		tabindex="-1"
		onclick={(e) => {
			if (e.target === e.currentTarget) cancel();
		}}
		onkeydown={() => {}}
	>
		<div class="dialog" role="dialog" aria-modal="true" aria-label={title}>
			<h2>{title}</h2>
			{#if children}
				<div class="body">{@render children()}</div>
			{:else if message}
				<p class="body">{message}</p>
			{/if}
			<div class="actions">
				<button type="button" class="ghost" disabled={busy} onclick={cancel}>{cancelLabel}</button>
				<button
					type="button"
					class="confirm"
					class:danger
					disabled={busy}
					onclick={() => onconfirm?.()}
				>
					{busy ? (busyLabel ?? confirmLabel) : confirmLabel}
				</button>
			</div>
		</div>
	</div>
{/if}

<style>
	.overlay {
		position: fixed;
		inset: 0;
		z-index: 200;
		background: rgba(0, 0, 0, 0.6);
		display: flex;
		align-items: center;
		justify-content: center;
		padding: 1rem;
	}
	.dialog {
		width: min(28rem, 100%);
		background: var(--surface);
		border: 1px solid var(--border-strong);
		border-radius: var(--radius-lg);
		box-shadow: var(--shadow-card);
		padding: 1.25rem 1.4rem 1.1rem;
	}
	h2 {
		margin: 0 0 0.6rem;
		font-size: 1.15rem;
		color: var(--accent);
		text-shadow: var(--ts);
	}
	.body {
		margin: 0 0 1.1rem;
		color: var(--text);
		font-size: 0.92rem;
		line-height: 1.45;
		white-space: pre-line;
	}
	.actions {
		display: flex;
		justify-content: flex-end;
		gap: 0.6rem;
	}
	button {
		padding: 0.5rem 1rem;
		border-radius: var(--radius);
		font-family: var(--font-body);
		cursor: pointer;
	}
	.ghost {
		background: var(--surface-alt);
		border: 1px solid var(--border);
		color: var(--muted);
	}
	.ghost:hover:not(:disabled) {
		color: var(--text);
	}
	.confirm {
		background: var(--accent-soft);
		border: 1px solid var(--accent);
		color: var(--accent);
	}
	.confirm:hover:not(:disabled) {
		background: var(--accent);
		color: #000;
	}
	.confirm.danger {
		background: var(--danger-bg);
		border-color: var(--danger);
		color: var(--danger);
	}
	.confirm.danger:hover:not(:disabled) {
		background: var(--danger);
		color: #fff;
	}
	button:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}
</style>

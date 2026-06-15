<script lang="ts">
	// Shared image-proof dropper used by EVERY on-site submission UI (bingo tiles,
	// weekly tasks, and any future event). Accepts images via file picker, drag &
	// drop, AND paste (Ctrl/Cmd+V). Stages multiple images with previews and syncs
	// them onto a hidden <input type="file" multiple> so the surrounding <form>
	// submits them under `name` (default "proof").
	//
	// Place it INSIDE the parent <form>. The parent owns the submit/clear buttons
	// and reads `count` (bindable) to enable/label them; it triggers a clear by
	// bumping `resetKey`. Validation errors flow out via the bindable `error`.
	import { untrack } from 'svelte';
	import { MAX_IMAGES_PER_SUBMISSION, MAX_UPLOAD_BYTES, ALLOWED_MIME } from '$lib/bingo/config';

	interface Props {
		// Form field name the files submit under (server reads this).
		name?: string;
		// Max images that can be staged at once.
		max?: number;
		// Block adding (e.g. when the parent isn't in a submittable state).
		disabled?: boolean;
		// A modal dropper (single instance) grabs EVERY window paste. Inline droppers
		// leave this false so several on one page don't all consume the same paste —
		// only the hovered one reacts.
		captureWindowPaste?: boolean;
		// Bump this (e.g. `resetKey++`) to clear the staged images — after a
		// successful submit, or when the parent's "Clear" button is clicked.
		resetKey?: number;
		// Number of staged images (bindable, for the parent's submit button + label).
		count?: number;
		// Validation error (bindable; shared with the parent's submit/remove errors).
		error?: string | null;
	}

	let {
		name = 'proof',
		max = MAX_IMAGES_PER_SUBMISSION,
		disabled = false,
		captureWindowPaste = false,
		resetKey = 0,
		count = $bindable(0),
		error = $bindable(null)
	}: Props = $props();

	const accept = ALLOWED_MIME.join(',');
	const maxMb = Math.round(MAX_UPLOAD_BYTES / 1_000_000);

	let fileInput: HTMLInputElement | null = $state(null);
	let staged = $state<Array<{ file: File; url: string }>>([]);
	let dragOver = $state(false);
	let hovered = $state(false);
	let focused = $state(false);

	// Clear when the parent bumps resetKey (after a successful submit / "Clear").
	// untrack: capture the initial value once without making it a tracked dep.
	let lastReset = untrack(() => resetKey);
	$effect(() => {
		if (resetKey !== lastReset) {
			lastReset = resetKey;
			doClear();
		}
	});

	// Mirror the staged files onto the hidden <input type="file" multiple> so the
	// form submits them all. Setting .files programmatically does not refire change,
	// so this won't loop with handleSelect.
	function syncInput() {
		if (!fileInput) return;
		const dt = new DataTransfer();
		for (const s of staged) dt.items.add(s.file);
		fileInput.files = dt.files;
		count = staged.length;
	}

	function addFiles(files: FileList | File[]) {
		if (disabled) return;
		error = null;
		for (const f of Array.from(files)) {
			if (!f.type.startsWith('image/')) continue;
			if (f.size > MAX_UPLOAD_BYTES) {
				error = `Each image must be ${maxMb} MB or smaller.`;
				continue;
			}
			if (staged.length >= max) {
				error = `You can attach up to ${max} images per submission.`;
				break;
			}
			staged = [...staged, { file: f, url: URL.createObjectURL(f) }];
		}
		syncInput();
	}

	function removeStaged(i: number) {
		const s = staged[i];
		if (s) URL.revokeObjectURL(s.url);
		staged = staged.filter((_, idx) => idx !== i);
		syncInput();
	}

	function doClear() {
		for (const s of staged) URL.revokeObjectURL(s.url);
		staged = [];
		if (fileInput) fileInput.value = '';
		count = 0;
	}

	function handleDrop(e: DragEvent) {
		e.preventDefault();
		dragOver = false;
		if (e.dataTransfer?.files?.length) addFiles(e.dataTransfer.files);
	}

	function handleSelect(e: Event) {
		const t = e.target as HTMLInputElement;
		if (t.files?.length) addFiles(t.files);
	}

	function handlePaste(e: ClipboardEvent) {
		if (disabled) return;
		// A modal dropper grabs every paste; an inline one only when it's the one the
		// user is pointing at (hover/focus) — so multiple on a page don't all fire.
		if (!captureWindowPaste && !hovered && !focused) return;
		const items = e.clipboardData?.items;
		if (!items) return;
		for (const item of items) {
			if (item.kind === 'file' && item.type.startsWith('image/')) {
				const f = item.getAsFile();
				if (f) {
					e.preventDefault();
					addFiles([f]);
					return;
				}
			}
		}
	}
</script>

<svelte:window onpaste={handlePaste} />

<!-- svelte-ignore a11y_no_static_element_interactions -->
<label
	class="dropzone"
	class:drag-over={dragOver}
	onmouseenter={() => (hovered = true)}
	onmouseleave={() => (hovered = false)}
	onfocusin={() => (focused = true)}
	onfocusout={() => (focused = false)}
	ondragover={(e) => {
		e.preventDefault();
		if (!disabled) dragOver = true;
	}}
	ondragleave={() => (dragOver = false)}
	ondrop={handleDrop}
>
	<input
		bind:this={fileInput}
		type="file"
		{name}
		{accept}
		multiple
		{disabled}
		onchange={handleSelect}
		hidden
	/>
	<span class="big">{staged.length > 0 ? 'Add another image' : 'Drop or paste image'}</span>
	<span class="hint">click · drag · paste (Ctrl/Cmd+V) · up to {max} images, {maxMb} MB each</span>
</label>

{#if staged.length > 0}
	<div class="staged">
		{#each staged as s, i (s.url)}
			<div class="staged-item">
				<img src={s.url} alt={`Staged ${i + 1}`} />
				<button
					type="button"
					class="staged-remove"
					aria-label="Remove image"
					onclick={() => removeStaged(i)}
				>
					×
				</button>
			</div>
		{/each}
	</div>
{/if}

<style>
	.dropzone {
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		gap: 0.4rem;
		min-height: 9rem;
		padding: 1rem;
		margin: 0.5rem 0 0.75rem;
		background: var(--surface-alt);
		border: 2px dashed var(--border-strong);
		border-radius: var(--radius);
		text-align: center;
		cursor: pointer;
		transition: border-color 0.15s, background 0.15s;
	}

	.dropzone:hover,
	.dropzone.drag-over {
		border-color: var(--accent);
		background: var(--accent-soft);
	}

	.big {
		font-family: var(--font-heading);
		font-size: 1.05rem;
		color: var(--accent);
	}

	.hint {
		font-size: 0.8rem;
		color: var(--muted);
	}

	.staged {
		display: flex;
		flex-wrap: wrap;
		gap: 0.4rem;
		margin-bottom: 0.75rem;
	}

	.staged-item {
		position: relative;
	}

	.staged-item img {
		display: block;
		width: 5.5rem;
		height: 5.5rem;
		object-fit: cover;
		border-radius: 3px;
		border: 1px solid var(--border);
		background: #000;
	}

	.staged-remove {
		position: absolute;
		top: -6px;
		right: -6px;
		width: 20px;
		height: 20px;
		min-height: 0;
		padding: 0;
		line-height: 1;
		font-size: 1rem;
		border-radius: 50%;
		background: var(--danger);
		color: #fff;
		border: 1px solid #000;
		display: flex;
		align-items: center;
		justify-content: center;
	}
</style>

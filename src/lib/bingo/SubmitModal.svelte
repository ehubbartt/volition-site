<script lang="ts">
	import { enhance } from '$app/forms';
	import AccountIcon from '$lib/AccountIcon.svelte';
	import type { BingoTile } from './tiles';
	import { TIER_BY_KEY } from './tiles';
	import type { TileStatus } from './state';

	interface Submission {
		proof_url: string;
		proof_path?: string;
		submitted_at: string;
	}

	interface Completion {
		user_id: string;
		rsn: string | null;
		discord_username: string;
		account_type: string | null;
		submitted_at: string;
		proof_url: string;
		isMe: boolean;
	}

	interface Props {
		tile: BingoTile;
		status: TileStatus;
		mySubmission: Submission | null;
		community: Completion[];
		canSubmit: boolean;
		onclose: () => void;
	}

	let { tile, status, mySubmission, community, canSubmit, onclose }: Props = $props();

	const tier = $derived(TIER_BY_KEY[tile.tier]);
	const submittable = $derived(status === 'open' && canSubmit);

	let fileInput: HTMLInputElement | null = $state(null);
	let file = $state<File | null>(null);
	let previewUrl = $state<string | null>(null);
	let dragOver = $state(false);
	let submitting = $state(false);
	let error = $state<string | null>(null);

	$effect(() => {
		if (!previewUrl) return;
		const url = previewUrl;
		return () => URL.revokeObjectURL(url);
	});

	function setFile(f: File | null) {
		file = f;
		previewUrl = f ? URL.createObjectURL(f) : null;
		error = null;
		if (fileInput) {
			if (f) {
				const dt = new DataTransfer();
				dt.items.add(f);
				fileInput.files = dt.files;
			} else {
				fileInput.value = '';
			}
		}
	}

	function handleDrop(e: DragEvent) {
		e.preventDefault();
		dragOver = false;
		if (!submittable) return;
		const f = e.dataTransfer?.files?.[0];
		if (f) setFile(f);
	}

	function handleSelect(e: Event) {
		const target = e.target as HTMLInputElement;
		const f = target.files?.[0];
		if (f) setFile(f);
	}

	function onKey(e: KeyboardEvent) {
		if (e.key === 'Escape') onclose();
	}

	function backdropClick(e: MouseEvent) {
		if (e.target === e.currentTarget) onclose();
	}

	function fmtDate(iso: string): string {
		try {
			return new Date(iso).toLocaleString();
		} catch {
			return iso;
		}
	}
</script>

<svelte:window onkeydown={onKey} />

<!-- svelte-ignore a11y_click_events_have_key_events -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="backdrop" onclick={backdropClick}>
	<div class="modal" role="dialog" aria-labelledby="modal-title" aria-modal="true">
		<button type="button" class="close" aria-label="Close" onclick={onclose}>×</button>

		<header class="head">
			<span class="tier-pill" style="background: {tier.color}; color: #1a1208">{tier.label}</span>
			<h2 id="modal-title">{tile.name}</h2>
			<p class="points">{tile.points} point{tile.points === 1 ? '' : 's'}</p>
		</header>

		{#if mySubmission}
			<section class="my-proof">
				<h3>Your proof</h3>
				<a href={mySubmission.proof_url} target="_blank" rel="noopener" class="proof-link">
					<img src={mySubmission.proof_url} alt="Your submission proof" />
				</a>
				<p class="meta">Submitted {fmtDate(mySubmission.submitted_at)}</p>
			</section>
		{/if}

		{#if submittable}
			<form
				method="POST"
				enctype="multipart/form-data"
				action={mySubmission ? '?/replace' : '?/submit'}
				use:enhance={() => {
					submitting = true;
					return async ({ result, update }) => {
						await update({ reset: false });
						submitting = false;
						if (result.type === 'success') {
							setFile(null);
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

				<!-- svelte-ignore a11y_no_static_element_interactions -->
				<label
					class="dropzone"
					class:drag-over={dragOver}
					class:has-file={!!file}
					ondragover={(e) => {
						e.preventDefault();
						dragOver = true;
					}}
					ondragleave={() => (dragOver = false)}
					ondrop={handleDrop}
				>
					<input
						bind:this={fileInput}
						type="file"
						name="proof"
						accept="image/png,image/jpeg,image/webp,image/gif"
						onchange={handleSelect}
						hidden
					/>
					{#if file && previewUrl}
						<img src={previewUrl} alt="Preview" class="preview" />
						<span class="hint">Click or drop another to replace this preview</span>
					{:else}
						<span class="big">Drop image here</span>
						<span class="hint">or click to choose · PNG/JPG/WEBP/GIF, max 10 MB</span>
					{/if}
				</label>

				{#if error}<p class="error">{error}</p>{/if}

				<div class="actions">
					<button type="submit" class="primary" disabled={!file || submitting}>
						{#if submitting}
							{mySubmission ? 'Replacing…' : 'Submitting…'}
						{:else}
							{mySubmission ? 'Replace proof' : 'Submit proof'}
						{/if}
					</button>
					{#if file}
						<button type="button" onclick={() => setFile(null)}>Clear</button>
					{/if}
				</div>
			</form>

			{#if mySubmission}
				<form
					method="POST"
					action="?/remove"
					use:enhance={() => {
						return async ({ result, update }) => {
							await update({ reset: false });
							if (result.type === 'failure') {
								const data = result.data as { error?: string } | undefined;
								error = data?.error ?? 'Remove failed';
							}
						};
					}}
					class="remove-form"
				>
					<input type="hidden" name="tile_id" value={tile.id} />
					<button type="submit" class="danger">Remove my submission</button>
				</form>
			{/if}
		{:else}
			<p class="locked-msg">
				{#if !canSubmit && status === 'open'}
					Only Volition clan members can submit tiles for this event. If you've recently joined,
					ping an admin to be added to the clan list.
				{:else if status === 'past-locked'}
					This tile is locked — the event has ended.
				{:else}
					This tile is not yet open.
				{/if}
			</p>
		{/if}

		{#if community.length > 0}
			<section class="community">
				<h3>Submissions ({community.length})</h3>
				<ul>
					{#each community as c (c.user_id)}
						<li>
							<a href={c.proof_url} target="_blank" rel="noopener">
								<img src={c.proof_url} alt={`Proof by ${c.rsn ?? c.discord_username}`} />
								<span class="who">
									<AccountIcon type={c.account_type} />
									<strong>{c.rsn ?? c.discord_username}</strong>
									{#if c.isMe}<span class="me-tag">you</span>{/if}
								</span>
								<span class="when">{fmtDate(c.submitted_at)}</span>
							</a>
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
		max-width: 38rem;
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
		margin-bottom: 1rem;
		padding-right: 2rem;
	}

	.tier-pill {
		display: inline-block;
		padding: 0.1rem 0.55rem;
		border-radius: 3px;
		font-family: var(--font-heading);
		font-size: 0.75rem;
		letter-spacing: 1px;
		text-transform: uppercase;
		text-shadow: none;
	}

	.head h2 {
		margin: 0.4rem 0 0.25rem;
		font-size: 1.3rem;
	}

	.points {
		margin: 0;
		font-family: var(--font-heading);
		color: var(--yellow);
		font-size: 0.95rem;
	}

	.my-proof {
		margin: 1rem 0;
		padding: 0.85rem;
		border: 1px solid var(--success);
		background: var(--success-bg);
		border-radius: var(--radius);
	}

	.my-proof h3 {
		margin: 0 0 0.5rem;
		font-size: 0.95rem;
		color: var(--success);
	}

	.proof-link {
		display: block;
	}

	.my-proof img {
		display: block;
		max-width: 100%;
		max-height: 18rem;
		border-radius: 3px;
		border: 1px solid var(--border);
	}

	.my-proof .meta {
		margin: 0.4rem 0 0;
		color: var(--muted);
		font-size: 0.8rem;
	}

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

	.dropzone.has-file {
		padding: 0.5rem;
	}

	.preview {
		max-width: 100%;
		max-height: 16rem;
		border-radius: 3px;
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

	.actions {
		display: flex;
		gap: 0.5rem;
		flex-wrap: wrap;
	}

	button.primary {
		border-color: var(--accent);
	}

	button.primary:hover:not(:disabled) {
		background: var(--accent-soft);
	}

	button.danger {
		border-color: var(--danger);
		color: var(--danger);
	}

	button.danger:hover {
		background: var(--danger-bg);
	}

	.remove-form {
		margin-top: 0.5rem;
	}

	.error {
		margin: 0.5rem 0;
		padding: 0.5rem 0.7rem;
		background: var(--danger-bg);
		border: 1px solid var(--danger);
		color: var(--danger);
		border-radius: 3px;
		font-size: 0.85rem;
	}

	.locked-msg {
		padding: 0.75rem;
		background: var(--surface-alt);
		border: 1px solid var(--border);
		border-radius: var(--radius);
		color: var(--muted);
	}

	.community {
		margin-top: 1.25rem;
		padding-top: 1rem;
		border-top: 1px solid var(--border);
	}

	.community h3 {
		margin: 0 0 0.6rem;
		font-size: 0.95rem;
	}

	.community ul {
		list-style: none;
		padding: 0;
		margin: 0;
		display: grid;
		gap: 0.6rem;
		grid-template-columns: repeat(auto-fill, minmax(11rem, 1fr));
	}

	.community li a {
		display: flex;
		flex-direction: column;
		gap: 0.3rem;
		padding: 0.45rem;
		background: var(--surface-alt);
		border: 1px solid var(--border);
		border-radius: 3px;
		text-decoration: none;
		color: var(--text);
	}

	.community li a:hover {
		border-color: var(--accent);
		text-decoration: none;
	}

	.community img {
		display: block;
		width: 100%;
		height: 6rem;
		object-fit: cover;
		border-radius: 3px;
		background: #000;
	}

	.community .who {
		display: flex;
		align-items: center;
		gap: 0.35rem;
		font-size: 0.85rem;
	}

	.community .when {
		font-size: 0.7rem;
		color: var(--muted);
	}

	.me-tag {
		font-size: 0.65rem;
		text-transform: uppercase;
		background: var(--accent-soft);
		border: 1px solid var(--accent);
		color: var(--accent);
		padding: 0.02rem 0.32rem;
		border-radius: 3px;
	}
</style>

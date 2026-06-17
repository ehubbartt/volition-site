<script lang="ts">
	import { enhance } from '$app/forms';
	import AccountIcon from '$lib/AccountIcon.svelte';
	import { MAX_IMAGES_PER_SUBMISSION } from '$lib/bingo/config';
	import type { BoardStatus } from './state';

	type SubmissionStatus = 'pending' | 'approved' | 'rejected';

	interface TeamSubmission {
		id: string;
		proof_urls: string[];
		quantity: number;
		submitted_at: string;
		status: SubmissionStatus;
		reviewed_by_name: string | null;
		submitted_by_name: string;
	}

	interface Completion {
		id: string;
		user_id: string;
		rsn: string | null;
		discord_username: string;
		account_type: string | null;
		team_name: string | null;
		submitted_at: string;
		proof_urls: string[];
		quantity: number;
		reviewed_by_name: string | null;
		isMine: boolean;
	}

	interface SwapOption {
		to_lane: number;
		name: string;
		img: string | null;
	}

	interface Props {
		tile: { id: string; name: string; img: string | null; faq_html: string | null };
		status: BoardStatus;
		teamSubmissions: TeamSubmission[];
		community: Completion[];
		communityCount: number;
		canSubmit: boolean;
		isAdmin: boolean;
		testMode?: boolean;
		progress?: { approved: number; required: number; pending: number } | null;
		// Swaps: if this tile can be swapped, the adjacent-path tiles to swap to + how many
		// swaps the team has left. Empty options ⇒ not swappable (already started / no swaps).
		swapsAvailable?: number;
		swapOptions?: SwapOption[];
		onZoom: (url: string) => void;
		onclose: () => void;
	}

	let {
		tile,
		status,
		teamSubmissions,
		community,
		communityCount,
		canSubmit,
		isAdmin,
		testMode = false,
		progress = null,
		swapsAvailable = 0,
		swapOptions = [],
		onZoom,
		onclose
	}: Props = $props();

	let showSwap = $state(false);

	const submittable = $derived(status === 'open' && canSubmit);
	// Swappable only when this is the team's active, not-yet-started tile and the page sent
	// adjacent-path options + a positive balance.
	const canSwap = $derived(submittable && swapsAvailable > 0 && swapOptions.length > 0);

	// Count-based tiles (required > 1) let a single proof cover several — the submitter
	// picks how many of `required` this one covers. Defaults to whatever's still needed.
	const required = $derived(progress?.required ?? 1);
	const approvedSoFar = $derived(progress?.approved ?? 0);
	const needsQty = $derived(required > 1);
	// Defaults to 1 (one proof = one of the required); the player bumps it if a single
	// proof legitimately covers several.
	let claimQty = $state(1);

	let fileInput: HTMLInputElement | null = $state(null);
	let staged = $state<Array<{ file: File; url: string }>>([]);
	let dragOver = $state(false);
	let submitting = $state(false);
	let error = $state<string | null>(null);

	// Mirror the staged files onto the hidden <input type="file" multiple> so the
	// form submits them all under "proof". Setting .files programmatically does
	// not refire the change event, so this won't loop with handleSelect.
	function syncInput() {
		if (!fileInput) return;
		const dt = new DataTransfer();
		for (const s of staged) dt.items.add(s.file);
		fileInput.files = dt.files;
	}

	function addFiles(files: FileList | File[]) {
		error = null;
		for (const f of Array.from(files)) {
			if (!f.type.startsWith('image/')) continue;
			if (staged.length >= MAX_IMAGES_PER_SUBMISSION) {
				error = `You can attach up to ${MAX_IMAGES_PER_SUBMISSION} images per submission.`;
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

	function clearStaged() {
		for (const s of staged) URL.revokeObjectURL(s.url);
		staged = [];
		if (fileInput) fileInput.value = '';
	}

	function handleDrop(e: DragEvent) {
		e.preventDefault();
		dragOver = false;
		if (!submittable) return;
		if (e.dataTransfer?.files?.length) addFiles(e.dataTransfer.files);
	}

	function handleSelect(e: Event) {
		const target = e.target as HTMLInputElement;
		if (target.files?.length) addFiles(target.files);
	}

	function handlePaste(e: ClipboardEvent) {
		if (!submittable) return;
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

<svelte:window onkeydown={onKey} onpaste={handlePaste} />

<!-- svelte-ignore a11y_click_events_have_key_events -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="backdrop" onclick={backdropClick}>
	<div class="modal" role="dialog" aria-labelledby="modal-title" aria-modal="true">
		<button type="button" class="close" aria-label="Close" onclick={onclose}>×</button>

		<header class="head">
			{#if tile.img}
				<img class="tile-img" src={tile.img} alt={tile.name} loading="lazy" />
			{/if}
			<div class="head-text">
				<h2 id="modal-title">{tile.name}</h2>
				{#if progress}
					{@const have = Math.min(progress.required, progress.approved + progress.pending)}
					{@const done = progress.approved + progress.pending >= progress.required}
					<div class="progress-line">
						{#if progress.approved >= progress.required}
							<span class="prog-done">✓ Complete ({progress.approved}/{progress.required})</span>
						{:else if done}
							<span class="prog-submitted">✓ Done — pending approval</span>
						{:else}
							<span class="prog-count">{have}/{progress.required}</span>
						{/if}
						{#if progress.pending > 0}
							<span class="prog-pending">{progress.pending} in review</span>
						{/if}
					</div>
				{/if}
			</div>
		</header>

		{#if tile.faq_html}
			<section class="details">
				<h3>How to complete</h3>
				<div class="details-body">{@html tile.faq_html}</div>
			</section>
		{/if}

		{#if canSwap}
			<section class="swap">
				<button type="button" class="swap-toggle" onclick={() => (showSwap = !showSwap)}>
					🔀 Swap this tile <span class="swap-left">{swapsAvailable} left</span>
				</button>
				{#if showSwap}
					<p class="swap-note">
						Replace this tile with the matching tile from an adjacent path. Uses 1 swap — you can't
						swap a tile you've already started, and the swap is final.
					</p>
					<div class="swap-opts">
						{#each swapOptions as opt (opt.to_lane)}
							<form
								method="POST"
								action="?/swapTile"
								use:enhance={() => {
									return async ({ result, update }) => {
										await update({ reset: false });
										if (result.type === 'success') onclose();
										else if (result.type === 'failure') {
											const data = result.data as { error?: string } | undefined;
											error = data?.error ?? 'Swap failed';
										}
									};
								}}
							>
								<input type="hidden" name="tile_id" value={tile.id} />
								<input type="hidden" name="to_lane" value={opt.to_lane} />
								<button type="submit" class="swap-opt" title={`Swap to ${opt.name}`}>
									{#if opt.img}<img src={opt.img} alt={opt.name} loading="lazy" />{/if}
									<span class="swap-opt-name">{opt.name}</span>
								</button>
							</form>
						{/each}
					</div>
				{/if}
			</section>
		{/if}

		{#if teamSubmissions.length > 0}
			<section class="my-proof">
				<h3>Your team's proofs ({teamSubmissions.length})</h3>
				<ul class="mine-list">
					{#each teamSubmissions as sub (sub.id)}
						<li class="mine-item status-{sub.status}">
							<div class="thumb-row">
								{#each sub.proof_urls as url, idx (url)}
									<button
										type="button"
										class="proof-link"
										onclick={() => onZoom(url)}
										aria-label={`View proof ${idx + 1}`}
									>
										<img src={url} alt={`Team submission proof ${idx + 1}`} />
									</button>
								{/each}
							</div>
							<div class="mine-meta">
								<div class="mine-meta-left">
									<span class="status-pill status-{sub.status}">
										{sub.status === 'pending'
											? 'Pending review'
											: sub.status === 'approved'
												? 'Approved'
												: 'Rejected'}
									</span>
									{#if sub.quantity > 1}<span class="qty-badge">covers {sub.quantity}</span>{/if}
									<span class="meta">By {sub.submitted_by_name} · {fmtDate(sub.submitted_at)}</span>
									{#if sub.status === 'approved' && sub.reviewed_by_name}
										<span class="meta">· Accepted by {sub.reviewed_by_name}</span>
									{/if}
								</div>
								{#if submittable}
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
									>
										<input type="hidden" name="submission_id" value={sub.id} />
										<button type="submit" class="danger small">Remove</button>
									</form>
								{/if}
							</div>
						</li>
					{/each}
				</ul>
			</section>
		{/if}

		{#if submittable}
			<form
				method="POST"
				enctype="multipart/form-data"
				action="?/submit"
				use:enhance={() => {
					submitting = true;
					return async ({ result, update }) => {
						await update({ reset: false });
						submitting = false;
						if (result.type === 'success') {
							clearStaged();
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
				{#if testMode}
					<input type="hidden" name="test" value="1" />
					<p class="test-note">🧪 Test mode — this submission is hidden from the live queue (see the <strong>Test</strong> tab in admin submissions). It still counts toward your test team's progress.</p>
				{/if}

				{#if needsQty}
					<label class="qty-field">
						<span class="qty-label">How many of the {required} does this proof cover?</span>
						<div class="qty-row">
							<input
								type="number"
								name="quantity"
								min="1"
								max={required}
								bind:value={claimQty}
							/>
							<span class="qty-hint">{approvedSoFar}/{required} approved so far</span>
						</div>
					</label>
				{:else}
					<input type="hidden" name="quantity" value="1" />
				{/if}

				<!-- svelte-ignore a11y_no_static_element_interactions -->
				<label
					class="dropzone"
					class:drag-over={dragOver}
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
						multiple
						onchange={handleSelect}
						hidden
					/>
					<span class="big">
						{staged.length > 0 ? 'Add another image' : 'Drop or paste image'}
					</span>
					<span class="hint">
						click to choose · paste (Ctrl/Cmd+V) · up to {MAX_IMAGES_PER_SUBMISSION} images, 10 MB each
					</span>
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

				{#if error}<p class="error">{error}</p>{/if}

				<p class="optimistic-hint">Submitting advances your team right away — if an admin rejects a proof, you'll need to redo this tile.</p>

				<div class="actions">
					<button type="submit" class="primary" disabled={staged.length === 0 || submitting}>
						{#if submitting}
							Submitting…
						{:else}
							Submit {staged.length > 1 ? `${staged.length} images` : 'proof'}{#if needsQty} · covers {claimQty}{/if}
						{/if}
					</button>
					{#if staged.length > 0}
						<button type="button" onclick={clearStaged}>Clear</button>
					{/if}
				</div>
			</form>
		{:else}
			<p class="locked-msg">
				{#if !canSubmit && status === 'open'}
					Only teams can submit for this event. Join the event and pair up with a teammate first,
					or ping an admin if you think this is wrong.
				{:else if status === 'past-locked'}
					This tile is locked — the event has ended.
				{:else}
					This tile is not yet open.
				{/if}
			</p>
		{/if}

		{#if testMode && submittable}
			<form
				method="POST"
				action="?/testComplete"
				class="test-complete-form"
				use:enhance={() => {
					return async ({ result, update }) => {
						await update({ reset: false });
						if (result.type === 'success') onclose();
						else if (result.type === 'failure') {
							const data = result.data as { error?: string } | undefined;
							error = data?.error ?? 'Insta-complete failed';
						}
					};
				}}
			>
				<input type="hidden" name="tile_id" value={tile.id} />
				<button type="submit" class="test-complete">🧪 Insta-complete (test)</button>
			</form>
		{/if}

		{#if community.length > 0}
			<section class="community">
				<h3>Submissions ({community.length})</h3>
				<ul>
					{#each community as c (c.id)}
						<li>
							<div class="thumb-row">
								{#each c.proof_urls as url, idx (url)}
									<button
										type="button"
										class="proof-thumb"
										onclick={() => onZoom(url)}
										aria-label={`View proof ${idx + 1} by ${c.rsn ?? c.discord_username}`}
									>
										<img src={url} alt={`Proof ${idx + 1} by ${c.rsn ?? c.discord_username}`} />
									</button>
								{/each}
							</div>
							<div class="who">
								<AccountIcon type={c.account_type} />
								<strong>{c.rsn ?? c.discord_username}</strong>
								{#if c.team_name}<span class="team-tag">{c.team_name}</span>{/if}
								{#if c.isMine}<span class="me-tag">your team</span>{/if}
								{#if c.quantity > 1}<span class="qty-badge">covers {c.quantity}</span>{/if}
							</div>
							<div class="when">{fmtDate(c.submitted_at)}</div>
							{#if c.reviewed_by_name}
								<div class="when accepted-by">Accepted by {c.reviewed_by_name}</div>
							{/if}
							{#if isAdmin}
								<form
									method="POST"
									action="?/adminReject"
									use:enhance={() => {
										return async ({ result, update }) => {
											await update({ reset: false });
											if (result.type === 'failure') {
												const data = result.data as { error?: string } | undefined;
												error = data?.error ?? 'Reject failed';
											}
										};
									}}
								>
									<input type="hidden" name="submission_id" value={c.id} />
									<button type="submit" class="danger small">Reject</button>
								</form>
							{/if}
						</li>
					{/each}
				</ul>
			</section>
		{:else if communityCount > 0}
			<section class="community community-count-only">
				<h3>
					{communityCount} team submission{communityCount === 1 ? '' : 's'}
				</h3>
				<p class="muted small">Individual proofs are visible to admins only.</p>
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
		display: flex;
		align-items: center;
		gap: 0.75rem;
		margin-bottom: 1rem;
		padding-right: 2rem;
	}

	.tile-img {
		width: 3rem;
		height: 3rem;
		object-fit: contain;
		flex-shrink: 0;
		image-rendering: auto;
		filter: drop-shadow(0 2px 3px rgba(0, 0, 0, 0.6));
	}

	.head-text {
		display: flex;
		flex-direction: column;
		gap: 0.25rem;
		min-width: 0;
	}

	.head h2 {
		margin: 0;
		font-size: 1.3rem;
	}

	.progress-line {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		flex-wrap: wrap;
		font-size: 0.8rem;
	}

	.prog-done {
		color: var(--success);
		font-family: var(--font-heading);
	}

	.prog-count {
		color: var(--yellow);
		font-family: var(--font-heading);
	}

	.prog-submitted {
		color: var(--accent);
		font-family: var(--font-heading);
	}

	.prog-pending {
		padding: 0.02rem 0.4rem;
		border-radius: 3px;
		background: rgba(255, 152, 31, 0.18);
		border: 1px solid var(--accent);
		color: var(--accent);
	}

	.details {
		margin: 1rem 0;
		padding: 0.85rem 1rem;
		border: 1px solid var(--border);
		background: var(--surface-alt);
		border-radius: var(--radius);
	}

	.details h3 {
		margin: 0 0 0.5rem;
		font-size: 0.95rem;
		color: var(--accent);
		letter-spacing: 1px;
	}

	.details-body :global(p) {
		margin: 0 0 0.5rem;
	}

	.details-body :global(:last-child) {
		margin-bottom: 0;
	}

	.details-body :global(ul),
	.details-body :global(ol) {
		margin: 0.3rem 0 0.6rem;
		padding-left: 1.2rem;
	}

	.details-body :global(li) {
		margin-bottom: 0.15rem;
	}

	.details-body :global(code) {
		padding: 0.05rem 0.35rem;
		background: rgba(0, 0, 0, 0.35);
		border: 1px solid var(--border);
		border-radius: 3px;
		font-size: 0.9em;
	}

	.details-body :global(a) {
		color: var(--accent);
	}

	.swap {
		margin: 1rem 0;
	}

	.swap-toggle {
		width: 100%;
		font-family: var(--font-heading);
		font-size: 0.9rem;
		letter-spacing: 0.5px;
		border: 1px dashed var(--yellow);
		color: var(--yellow);
		background: rgba(240, 210, 60, 0.08);
		display: flex;
		align-items: center;
		justify-content: center;
		gap: 0.5rem;
	}

	.swap-toggle:hover {
		background: rgba(240, 210, 60, 0.16);
	}

	.swap-left {
		font-size: 0.7rem;
		padding: 0.02rem 0.4rem;
		border-radius: 999px;
		background: rgba(240, 210, 60, 0.2);
		border: 1px solid var(--yellow);
	}

	.swap-note {
		margin: 0.6rem 0 0.5rem;
		font-size: 0.8rem;
		color: var(--muted);
	}

	.swap-opts {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(8rem, 1fr));
		gap: 0.5rem;
	}

	.swap-opt {
		width: 100%;
		display: flex;
		align-items: center;
		gap: 0.5rem;
		padding: 0.45rem 0.6rem;
		background: var(--surface-alt);
		border: 1px solid var(--border-strong);
		border-radius: var(--radius);
		color: var(--text);
		text-align: left;
		cursor: pointer;
		min-height: 0;
	}

	.swap-opt:hover {
		border-color: var(--yellow);
		background: rgba(240, 210, 60, 0.1);
	}

	.swap-opt img {
		width: 2rem;
		height: 2rem;
		object-fit: contain;
		flex-shrink: 0;
	}

	.swap-opt-name {
		font-size: 0.82rem;
		line-height: 1.1;
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

	.thumb-row {
		display: flex;
		flex-wrap: wrap;
		gap: 0.35rem;
	}

	.thumb-row .proof-link,
	.thumb-row .proof-thumb {
		display: block;
		border-radius: 3px;
		overflow: hidden;
		padding: 0;
		background: transparent;
		border: 0;
		cursor: pointer;
		min-height: 0;
	}

	.thumb-row img {
		display: block;
		width: 6rem;
		height: 6rem;
		object-fit: cover;
		border-radius: 3px;
		border: 1px solid var(--border);
		background: #000;
	}

	.thumb-row .proof-link:hover,
	.thumb-row .proof-thumb:hover {
		outline: 1px solid var(--accent);
	}

	.my-proof .meta {
		color: var(--muted);
		font-size: 0.8rem;
	}

	.mine-list {
		list-style: none;
		padding: 0;
		margin: 0;
		display: flex;
		flex-direction: column;
		gap: 0.6rem;
	}

	.mine-list li {
		display: flex;
		flex-direction: column;
		gap: 0.35rem;
	}

	.mine-meta {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 0.5rem;
		flex-wrap: wrap;
	}

	.mine-meta-left {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		flex-wrap: wrap;
	}

	.status-pill {
		display: inline-block;
		padding: 0.05rem 0.45rem;
		font-family: var(--font-heading);
		font-size: 0.68rem;
		letter-spacing: 1px;
		text-transform: uppercase;
		border-radius: 3px;
		border: 1px solid transparent;
		text-shadow: none;
	}

	.status-pill.status-pending {
		background: rgba(255, 152, 31, 0.18);
		border-color: var(--accent);
		color: var(--accent);
	}

	.status-pill.status-approved {
		background: var(--success-bg);
		border-color: var(--success);
		color: var(--success);
	}

	.status-pill.status-rejected {
		background: var(--danger-bg);
		border-color: var(--danger);
		color: var(--danger);
	}

	.mine-item.status-rejected .proof-link img {
		opacity: 0.55;
		filter: saturate(0.5);
	}

	button.danger.small {
		font-size: 0.78rem;
		padding: 0.25rem 0.55rem;
		min-height: 0;
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

	.test-note {
		margin: 0 0 0.6rem;
		padding: 0.5rem 0.7rem;
		font-size: 0.8rem;
		background: rgba(255, 152, 31, 0.12);
		border: 1px dashed var(--accent);
		border-radius: var(--radius);
		color: var(--accent);
	}

	.test-complete-form {
		margin-top: 0.75rem;
	}

	button.test-complete {
		width: 100%;
		font-size: 0.85rem;
		border: 1px dashed var(--accent);
		color: var(--accent);
		background: rgba(255, 152, 31, 0.08);
	}

	button.test-complete:hover {
		background: var(--accent-soft);
	}

	.qty-field {
		display: flex;
		flex-direction: column;
		gap: 0.35rem;
		margin: 0 0 0.75rem;
		padding: 0.6rem 0.75rem;
		background: var(--surface-alt);
		border: 1px solid var(--border);
		border-radius: var(--radius);
	}

	.qty-label {
		font-size: 0.85rem;
		color: var(--text);
	}

	.qty-row {
		display: flex;
		align-items: center;
		gap: 0.6rem;
	}

	.qty-row input {
		width: 5rem;
		padding: 0.35rem 0.5rem;
		background: var(--surface);
		border: 1px solid var(--border-strong);
		border-radius: 3px;
		color: var(--text);
		font-family: var(--font-heading);
		font-size: 1rem;
	}

	.qty-hint {
		font-size: 0.78rem;
		color: var(--muted);
	}

	.qty-badge {
		font-size: 0.65rem;
		text-transform: uppercase;
		letter-spacing: 0.04em;
		background: rgba(255, 152, 31, 0.18);
		border: 1px solid var(--accent);
		color: var(--accent);
		padding: 0.02rem 0.38rem;
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

	.optimistic-hint {
		margin: 0;
		font-size: 0.78rem;
		color: var(--muted);
		font-style: italic;
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

	.community-count-only .muted.small {
		margin: 0;
		font-size: 0.8rem;
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

	.community li {
		display: flex;
		flex-direction: column;
		gap: 0.3rem;
		padding: 0.45rem;
		background: var(--surface-alt);
		border: 1px solid var(--border);
		border-radius: 3px;
		color: var(--text);
	}

	.community li form {
		display: flex;
		margin-top: 0.15rem;
	}

	.community li form button {
		width: 100%;
	}

	.community .who {
		display: flex;
		align-items: center;
		gap: 0.35rem;
		font-size: 0.85rem;
		flex-wrap: wrap;
	}

	.community .when {
		font-size: 0.7rem;
		color: var(--muted);
	}

	.community .accepted-by {
		color: var(--success);
	}

	.team-tag {
		font-size: 0.65rem;
		background: var(--surface);
		border: 1px solid var(--border);
		color: var(--muted);
		padding: 0.02rem 0.32rem;
		border-radius: 3px;
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

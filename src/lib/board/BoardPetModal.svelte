<script lang="ts">
	// Submit a pet drop for a BONUS SWAP. Each approved pet = +1 bonus swap (usable on any
	// floor). Posts to the board's ?/submitPet action (a generic vs_submissions row with the
	// pet target) — reviewed in /admin/submissions; the swap balance derives from approved pets.
	import { enhance } from '$app/forms';
	import { invalidateAll } from '$app/navigation';
	import ImageDropper from '$lib/ImageDropper.svelte';
	import Lightbox from '$lib/Lightbox.svelte';

	type SubmissionStatus = 'pending' | 'approved' | 'rejected';

	interface PetSub {
		id: string;
		proof_urls: string[];
		submitted_at: string;
		status: SubmissionStatus;
		reviewed_by_name: string | null;
		review_note: string | null;
		submitted_by_name: string;
	}

	interface Props {
		petSubmissions: PetSub[];
		canSubmit: boolean;
		onclose: () => void;
	}

	let { petSubmissions, canSubmit, onclose }: Props = $props();

	let stagedCount = $state(0);
	let resetKey = $state(0);
	let submitting = $state(false);
	let removing = $state<string | null>(null);
	let error = $state<string | null>(null);
	let lightboxSrc = $state<string | null>(null);

	const approvedCount = $derived(petSubmissions.filter((p) => p.status === 'approved').length);

	const STATUS_LABEL: Record<SubmissionStatus, string> = {
		pending: 'Pending review',
		approved: 'Approved · +1 swap',
		rejected: 'Rejected'
	};

	function fmtDate(iso: string): string {
		try {
			return new Date(iso).toLocaleString();
		} catch {
			return iso;
		}
	}
</script>

<svelte:window onkeydown={(e) => e.key === 'Escape' && onclose()} />

<div class="backdrop" role="presentation">
	<div class="modal" role="dialog" aria-modal="true" aria-labelledby="pet-title">
		<button type="button" class="close" onclick={onclose} aria-label="Close">✕</button>
		<header class="head">
			<span class="badge" aria-hidden="true">🐾</span>
			<div>
				<h2 id="pet-title">Submit a pet for a bonus swap</h2>
				<p class="sub">Each approved pet earns your team <strong>+1 bonus swap</strong> — usable on any floor.</p>
			</div>
		</header>

		<p class="intro">
			Got a pet during the event? Upload proof below. An admin reviews it, and once approved your
			team's swap balance goes up by one. {#if approvedCount > 0}<strong class="approved-note">Your team has {approvedCount} approved pet{approvedCount === 1 ? '' : 's'}.</strong>{/if}
		</p>

		{#if petSubmissions.length > 0}
			<div class="mine">
				<h3>Your team's pets ({petSubmissions.length})</h3>
				<ul class="mine-list">
					{#each petSubmissions as sub (sub.id)}
						<li class="mine-item status-{sub.status}">
							<div class="thumb-row">
								{#each sub.proof_urls as url, idx (url)}
									<button type="button" class="proof-link" onclick={() => (lightboxSrc = url)} aria-label={`View proof ${idx + 1}`}>
										<img src={url} alt={`Pet proof ${idx + 1}`} />
									</button>
								{/each}
							</div>
							<div class="mine-meta">
								<div class="mine-meta-left">
									<span class="status-pill status-{sub.status}">{STATUS_LABEL[sub.status]}</span>
									<span class="meta">by {sub.submitted_by_name} · {fmtDate(sub.submitted_at)}</span>
									{#if sub.status === 'approved' && sub.reviewed_by_name}
										<span class="meta">· Accepted by {sub.reviewed_by_name}</span>
									{/if}
								</div>
								{#if sub.status === 'pending'}
									<form
										method="POST"
										action="?/remove"
										use:enhance={() => {
											removing = sub.id;
											return async ({ result }) => {
												removing = null;
												if (result.type === 'success') await invalidateAll();
												else if (result.type === 'failure') error = (result.data as { error?: string } | undefined)?.error ?? 'Remove failed';
												else if (result.type === 'error') error = 'Something went wrong';
											};
										}}
									>
										<input type="hidden" name="submission_id" value={sub.id} />
										<button type="submit" class="danger small" disabled={removing !== null}>Remove</button>
									</form>
								{/if}
							</div>
							{#if sub.status === 'rejected' && sub.review_note}
								<p class="reject-note"><strong>Reason:</strong> {sub.review_note}</p>
							{/if}
						</li>
					{/each}
				</ul>
			</div>
		{/if}

		{#if canSubmit}
			<form
				class="submit"
				method="POST"
				enctype="multipart/form-data"
				action="?/submitPet"
				use:enhance={() => {
					submitting = true;
					error = null;
					return async ({ result }) => {
						submitting = false;
						if (result.type === 'success') {
							resetKey += 1;
							await invalidateAll();
						} else if (result.type === 'failure') {
							error = (result.data as { error?: string } | undefined)?.error ?? 'Submit failed';
						} else if (result.type === 'error') {
							error = result.error?.message ?? 'Something went wrong';
						}
					};
				}}
			>
				<h3>Submit a pet</h3>
				<ImageDropper bind:count={stagedCount} bind:error {resetKey} captureWindowPaste />

				{#if error}<p class="error">{error}</p>{/if}

				<div class="actions">
					<button type="submit" class="primary" disabled={stagedCount === 0 || submitting}>
						{#if submitting}Submitting…{:else}Submit pet for a swap{/if}
					</button>
					{#if stagedCount > 0}<button type="button" onclick={() => (resetKey += 1)}>Clear</button>{/if}
				</div>
			</form>
		{:else}
			<p class="locked-msg">Only teams can submit pets. Join the event and pair up with a teammate first.</p>
		{/if}
	</div>
</div>

{#if lightboxSrc}
	<Lightbox src={lightboxSrc} alt="Pet proof" onclose={() => (lightboxSrc = null)} />
{/if}

<style>
	.backdrop {
		position: fixed;
		inset: 0;
		background: rgba(0, 0, 0, 0.82);
		z-index: 200;
		display: flex;
		align-items: center;
		justify-content: center;
		padding: 2rem 1rem;
		overflow-y: auto;
		backdrop-filter: blur(2px);
		-webkit-backdrop-filter: blur(2px);
	}
	.modal {
		position: relative;
		margin: auto;
		width: 100%;
		max-width: 34rem;
		padding: 1.5rem;
		background: linear-gradient(180deg, rgba(58, 48, 36, 0.98), rgba(40, 32, 24, 0.98));
		border: 1px solid var(--accent);
		border-radius: var(--radius);
		box-shadow: var(--shadow-card);
		color: var(--text);
		font-family: var(--font-body);
	}
	.close {
		position: absolute;
		top: 0.6rem;
		right: 0.6rem;
		background: none;
		border: 0;
		color: var(--muted);
		font-size: 1rem;
		cursor: pointer;
		min-height: 0;
		padding: 0.25rem 0.4rem;
	}
	.close:hover {
		color: var(--accent);
	}
	.head {
		display: flex;
		align-items: center;
		gap: 0.75rem;
		margin-bottom: 0.6rem;
	}
	.badge {
		font-size: 1.6rem;
		line-height: 1;
		flex-shrink: 0;
	}
	.head h2 {
		margin: 0;
		font-size: 1.3rem;
		color: var(--accent);
		text-shadow: var(--ts);
	}
	.sub {
		margin: 0.15rem 0 0;
		font-size: 0.85rem;
		color: var(--muted);
	}
	.intro {
		margin: 0 0 1rem;
		font-size: 0.9rem;
		line-height: 1.45;
	}
	.approved-note {
		color: var(--yellow);
	}
	.mine,
	.submit {
		margin-top: 0.9rem;
	}
	.mine h3,
	.submit h3 {
		margin: 0 0 0.6rem;
		font-size: 0.95rem;
		color: var(--accent);
	}
	.mine-list {
		list-style: none;
		padding: 0;
		margin: 0;
		display: flex;
		flex-direction: column;
		gap: 0.6rem;
	}
	.mine-item {
		display: flex;
		flex-direction: column;
		gap: 0.35rem;
	}
	.thumb-row {
		display: flex;
		flex-wrap: wrap;
		gap: 0.35rem;
	}
	.thumb-row .proof-link {
		display: block;
		border-radius: 3px;
		overflow: hidden;
		padding: 0;
		border: 0;
		background: none;
		min-height: 0;
		cursor: pointer;
	}
	.thumb-row img {
		display: block;
		width: 5rem;
		height: 5rem;
		object-fit: cover;
		border-radius: 3px;
		border: 1px solid var(--border);
		background: #000;
	}
	.thumb-row .proof-link:hover {
		outline: 1px solid var(--accent);
	}
	.mine-item.status-rejected img {
		opacity: 0.55;
		filter: saturate(0.5);
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
	.meta {
		color: var(--muted);
		font-size: 0.8rem;
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
		background: rgba(127, 209, 138, 0.12);
		border-color: #7fd18a;
		color: #7fd18a;
	}
	.status-pill.status-rejected {
		background: rgba(255, 0, 0, 0.12);
		border-color: var(--danger);
		color: var(--danger);
	}
	.reject-note {
		margin: 0;
		padding: 0.4rem 0.6rem;
		background: rgba(255, 0, 0, 0.08);
		border: 1px solid var(--danger);
		border-radius: 3px;
		font-size: 0.82rem;
	}
	.reject-note strong {
		color: var(--danger);
	}
	.actions {
		display: flex;
		gap: 0.5rem;
		flex-wrap: wrap;
		margin-top: 0.6rem;
	}
	button.primary {
		border-color: var(--accent);
	}
	button.primary:hover:not(:disabled) {
		background: var(--accent-soft);
	}
	button.primary:disabled {
		opacity: 0.55;
		cursor: not-allowed;
	}
	button.danger {
		border-color: var(--danger);
		color: var(--danger);
	}
	button.danger.small {
		font-size: 0.78rem;
		padding: 0.25rem 0.55rem;
		min-height: 0;
	}
	.error {
		margin: 0.5rem 0 0;
		padding: 0.5rem 0.7rem;
		background: rgba(255, 0, 0, 0.12);
		border: 1px solid var(--danger);
		color: var(--danger);
		border-radius: 3px;
		font-size: 0.85rem;
	}
	.locked-msg {
		margin: 0.9rem 0 0;
		font-size: 0.88rem;
		color: var(--muted);
	}
</style>

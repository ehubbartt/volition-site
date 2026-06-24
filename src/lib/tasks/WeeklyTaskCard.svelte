<script lang="ts">
	import { enhance } from '$app/forms';
	import { invalidateAll } from '$app/navigation';
	import ImageDropper from '$lib/ImageDropper.svelte';
	import Lightbox from '$lib/Lightbox.svelte';
	import AccountIcon from '$lib/AccountIcon.svelte';
	import StatusPill from '$lib/StatusPill.svelte';
	import { formatDateTime } from '$lib/datetime';

	type SubmissionStatus = 'pending' | 'approved' | 'rejected';

	interface MySub {
		id: string;
		proof_urls: string[];
		submitted_at: string;
		status: SubmissionStatus;
		reviewed_by_name: string | null;
		review_note: string | null;
	}

	// Admin-only "every submission" row (the see-all + un-approve view).
	interface AdminSub {
		id: string;
		proof_urls: string[];
		submitted_at: string;
		status: SubmissionStatus;
		submitter: string;
		account_type: string | null;
		reviewed_by_name: string | null;
		review_note: string | null;
	}

	interface Task {
		id: string;
		name: string;
		description_html: string | null;
		reward: string | null;
		endsAt: string | null;
		mySubmissions: MySub[];
		allSubmissions: AdminSub[];
	}

	let {
		task,
		canSubmit,
		isAdmin = false
	}: { task: Task; canSubmit: boolean; isAdmin?: boolean } = $props();

	let stagedCount = $state(0);
	let resetKey = $state(0);
	let submitting = $state(false);
	let error = $state<string | null>(null);
	// Once this week's task is approved you can't submit it again (server enforces it too).
	const done = $derived(task.mySubmissions.some((s) => s.status === 'approved'));
	// Image lightbox (modal) + admin un-approve state.
	let lightboxSrc = $state<string | null>(null);
	let adminBusy = $state<string | null>(null);

	const fmtDate = formatDateTime;
</script>

<section class="panel task">
	<div class="task-head">
		<h2>{task.name}</h2>
		{#if task.reward}<span class="reward" title="Reward">🎁 {task.reward}</span>{/if}
	</div>
	{#if task.endsAt}
		<p class="deadline">Due {fmtDate(task.endsAt)}</p>
	{/if}
	{#if task.description_html}
		<div class="task-desc">{@html task.description_html}</div>
	{/if}

	{#if task.mySubmissions.length > 0}
		<div class="mine">
			<h3>Your submissions ({task.mySubmissions.length})</h3>
			<ul class="mine-list">
				{#each task.mySubmissions as sub (sub.id)}
					<li class="mine-item status-{sub.status}">
						<div class="thumb-row">
							{#each sub.proof_urls as url, idx (url)}
								<button type="button" class="proof-link" onclick={() => (lightboxSrc = url)} aria-label={`View proof ${idx + 1}`}>
									<img src={url} alt={`Your proof ${idx + 1}`} />
								</button>
							{/each}
						</div>
						<div class="mine-meta">
							<div class="mine-meta-left">
								<StatusPill status={sub.status} label={sub.status === 'pending' ? 'Pending review' : undefined} />
								<span class="meta">Submitted {fmtDate(sub.submitted_at)}</span>
								{#if sub.status === 'approved' && sub.reviewed_by_name}
									<span class="meta">· Accepted by {sub.reviewed_by_name}</span>
								{/if}
							</div>
							{#if sub.status === 'pending'}
								<form
									method="POST"
									action="?/remove"
									use:enhance={() => {
										return async ({ result, update }) => {
											await update({ reset: false });
											if (result.type === 'failure') {
												const d = result.data as { error?: string } | undefined;
												error = d?.error ?? 'Remove failed';
											}
										};
									}}
								>
									<input type="hidden" name="submission_id" value={sub.id} />
									<button type="submit" class="danger small">Remove</button>
								</form>
							{/if}
							</div>
							{#if sub.status === 'rejected' && sub.review_note}
								<p class="reject-note">
									<strong>Reason:</strong>
									{sub.review_note}
								</p>
							{/if}
						</li>
				{/each}
			</ul>
		</div>
	{/if}

	{#if done}
		<p class="done-note">✓ Completed — you've finished this week's task. It can't be submitted again.</p>
	{:else if canSubmit}
		<form
			class="submit"
			method="POST"
			enctype="multipart/form-data"
			action="?/submit"
			use:enhance={() => {
				submitting = true;
				return async ({ result, update }) => {
					await update({ reset: false });
					submitting = false;
					if (result.type === 'success') resetKey += 1;
					else if (result.type === 'failure') {
						const d = result.data as { error?: string } | undefined;
						error = d?.error ?? 'Submit failed';
					} else if (result.type === 'error') {
						error = result.error?.message ?? 'Something went wrong';
					}
				};
			}}
		>
			<input type="hidden" name="event_id" value={task.id} />
			<h3>Submit proof</h3>
			<ImageDropper bind:count={stagedCount} bind:error {resetKey} />

			{#if error}<p class="error">{error}</p>{/if}

			<div class="actions">
				<button type="submit" class="primary" disabled={stagedCount === 0 || submitting}>
					{#if submitting}Submitting…{:else}Submit {stagedCount > 1 ? `${stagedCount} images` : 'proof'}{/if}
				</button>
				{#if stagedCount > 0}<button type="button" onclick={() => (resetKey += 1)}>Clear</button>{/if}
			</div>
		</form>
	{/if}

	{#if isAdmin && task.allSubmissions.length > 0}
		<div class="admin-subs">
			<h3>All submissions ({task.allSubmissions.length})</h3>
			<ul class="admin-list">
				{#each task.allSubmissions as sub (sub.id)}
					<li class="admin-item status-{sub.status}">
						<div class="thumb-row">
							{#each sub.proof_urls as url, idx (url)}
								<button type="button" class="proof-link" onclick={() => (lightboxSrc = url)} aria-label={`View proof ${idx + 1}`}>
									<img src={url} alt={`Proof ${idx + 1}`} />
								</button>
							{/each}
						</div>
						<div class="admin-meta">
							<span class="who"><AccountIcon type={sub.account_type} size={20} /> <strong>{sub.submitter}</strong></span>
							<StatusPill status={sub.status} />
							<span class="meta">{fmtDate(sub.submitted_at)}</span>
							{#if sub.reviewed_by_name}
								<span class="meta">· {sub.status === 'approved' ? 'approved' : 'rejected'} by {sub.reviewed_by_name}</span>
							{/if}
						</div>
						{#if sub.review_note}<p class="reject-note"><strong>Note:</strong> {sub.review_note}</p>{/if}
						{#if sub.status !== 'rejected'}
							<form
								method="POST"
								action="?/adminReject"
								use:enhance={({ cancel }) => {
									if (sub.status === 'approved' && !confirm('Un-approve this submission and reclaim its rewards (VP always; pack if still unopened)? The player is notified on Discord.')) {
										cancel();
										return;
									}
									adminBusy = sub.id;
									error = null;
									return async ({ result }) => {
										adminBusy = null;
										if (result.type === 'success') await invalidateAll();
										else if (result.type === 'failure') error = (result.data as { error?: string } | undefined)?.error ?? 'Action failed';
										else if (result.type === 'error') error = 'Something went wrong';
									};
								}}
							>
								<input type="hidden" name="submission_id" value={sub.id} />
								<input class="admin-note" name="note" placeholder="Reason (optional — shown to the player)" />
								<button type="submit" class="danger small" disabled={adminBusy !== null}>
									{sub.status === 'approved' ? 'Un-approve & reclaim' : 'Reject'}
								</button>
							</form>
						{/if}
					</li>
				{/each}
			</ul>
		</div>
	{/if}
</section>

{#if lightboxSrc}
	<Lightbox src={lightboxSrc} alt="Submission proof" onclose={() => (lightboxSrc = null)} />
{/if}

<style>
	.panel {
		background: linear-gradient(180deg, rgba(58, 48, 36, 0.6), rgba(40, 32, 24, 0.6));
		border: 1px solid var(--border);
		border-radius: var(--radius);
		box-shadow: var(--shadow-card);
		padding: 1.1rem 1.25rem;
		margin-bottom: 1rem;
	}
	.task-head {
		display: flex;
		align-items: center;
		gap: 0.6rem;
		flex-wrap: wrap;
	}
	.task-head h2 {
		margin: 0;
		font-size: 1.3rem;
	}
	.reward {
		font-size: 0.72rem;
		color: var(--yellow);
		background: rgba(255, 255, 0, 0.08);
		border: 1px solid rgba(255, 255, 0, 0.3);
		border-radius: var(--radius);
		padding: 0.1rem 0.45rem;
		white-space: nowrap;
	}
	.deadline {
		margin: 0.25rem 0 0;
		font-size: 0.8rem;
		color: var(--muted);
	}
	.task-desc {
		margin-top: 0.5rem;
	}
	.task-desc :global(p) {
		margin: 0 0 0.5rem;
	}
	.task-desc :global(:last-child) {
		margin-bottom: 0;
	}
	.task-desc :global(a) {
		color: var(--accent);
	}

	.mine,
	.submit {
		margin-top: 0.9rem;
	}
	.done-note {
		margin: 0.9rem 0 0;
		padding: 0.5rem 0.7rem;
		background: rgba(127, 209, 138, 0.1);
		border: 1px solid #7fd18a;
		border-radius: 3px;
		color: #7fd18a;
		font-size: 0.88rem;
	}
	.mine h3,
	.submit h3,
	.admin-subs h3 {
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
		width: 6rem;
		height: 6rem;
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
	.reject-note {
		margin: 0;
		padding: 0.4rem 0.6rem;
		background: rgba(255, 0, 0, 0.08);
		border: 1px solid var(--danger);
		border-radius: 3px;
		font-size: 0.82rem;
		color: var(--text);
	}
	.reject-note strong {
		color: var(--danger);
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
	button.danger.small {
		font-size: 0.78rem;
		padding: 0.25rem 0.55rem;
		min-height: 0;
	}
	.error {
		margin: 0.5rem 0;
		padding: 0.5rem 0.7rem;
		background: rgba(255, 0, 0, 0.12);
		border: 1px solid var(--danger);
		color: var(--danger);
		border-radius: 3px;
		font-size: 0.85rem;
	}

	/* Admin "all submissions" community view */
	.admin-subs {
		margin-top: 1rem;
		padding-top: 0.9rem;
		border-top: 1px dashed var(--border);
	}
	.admin-list {
		list-style: none;
		margin: 0;
		padding: 0;
		display: flex;
		flex-direction: column;
		gap: 0.8rem;
	}
	.admin-item {
		display: flex;
		flex-direction: column;
		gap: 0.4rem;
		padding: 0.6rem;
		background: var(--surface-alt);
		border: 1px solid var(--border);
		border-radius: var(--radius);
	}
	.admin-item.status-rejected img {
		opacity: 0.55;
		filter: saturate(0.5);
	}
	.admin-meta {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		flex-wrap: wrap;
		font-size: 0.85rem;
	}
	.admin-meta .who {
		display: inline-flex;
		align-items: center;
		gap: 0.35rem;
	}
	.admin-note {
		flex: 1 1 14rem;
		min-width: 0;
		padding: 0.3rem 0.5rem;
		margin-right: 0.4rem;
		background: var(--surface);
		border: 1px solid var(--border);
		border-radius: 3px;
		color: var(--text);
		font: inherit;
		font-size: 0.82rem;
	}
	.admin-note:focus {
		outline: none;
		border-color: var(--accent);
	}
	.admin-item form {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.4rem;
	}
</style>

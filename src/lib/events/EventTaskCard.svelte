<script lang="ts">
	import { enhance } from '$app/forms';
	import ImageDropper from '$lib/ImageDropper.svelte';
	import type { EventTask } from '$lib/events/simple';

	let { task, canSubmit }: { task: EventTask; canSubmit: boolean } = $props();

	let stagedCount = $state(0);
	let resetKey = $state(0);
	let submitting = $state(false);
	let error = $state<string | null>(null);

	function fmtDate(iso: string): string {
		try {
			return new Date(iso).toLocaleString();
		} catch {
			return iso;
		}
	}
</script>

<section class="panel task" class:done={task.done} class:locked={task.locked}>
	<div class="task-head">
		<h2>
			{#if task.done}<span class="check" aria-hidden="true">✓</span>{:else if task.locked}<span class="lock" aria-hidden="true">🔒</span>{/if}
			{task.name}
		</h2>
		{#if task.reward}<span class="reward" title="Reward">🎁 {task.reward}</span>{/if}
	</div>
	{#if task.description_html}
		<div class="task-desc">{@html task.description_html}</div>
	{/if}

	{#if task.locked}
		<p class="locked-note">🔒 Complete the previous task to unlock this one.</p>
	{/if}

	{#if task.mySubmissions.length > 0}
		<div class="mine">
			<h3>Your submissions ({task.mySubmissions.length})</h3>
			<ul class="mine-list">
				{#each task.mySubmissions as sub (sub.id)}
					<li class="mine-item status-{sub.status}">
						<div class="thumb-row">
							{#each sub.proof_urls as url, idx (url)}
								<a class="proof-link" href={url} target="_blank" rel="noopener noreferrer">
									<img src={url} alt={`Your proof ${idx + 1}`} />
								</a>
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
								<span class="meta">Submitted {fmtDate(sub.submitted_at)}</span>
								{#if sub.status === 'approved' && sub.reviewed_by_name}
									<span class="meta">· Accepted by {sub.reviewed_by_name}</span>
								{/if}
							</div>
							{#if sub.status === 'pending'}
								<form
									method="POST"
									action="?/removeTask"
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

	{#if task.done}
		<p class="done-note">✓ Completed — nice work! This task can't be submitted again.</p>
	{:else if canSubmit && !task.locked}
		<form
			class="submit"
			method="POST"
			enctype="multipart/form-data"
			action="?/submitTask"
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
			<input type="hidden" name="task_id" value={task.id} />
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
</section>

<style>
	.panel {
		background: linear-gradient(180deg, rgba(58, 48, 36, 0.6), rgba(40, 32, 24, 0.6));
		border: 1px solid var(--border);
		border-radius: var(--radius);
		box-shadow: var(--shadow-card);
		padding: 1.1rem 1.25rem;
		margin-bottom: 1rem;
	}
	.panel.done {
		border-color: #7fd18a;
	}
	.panel.locked {
		opacity: 0.7;
	}
	.panel.locked .task-head h2 {
		color: var(--muted);
	}
	.lock {
		font-size: 0.9rem;
	}
	.locked-note {
		margin: 0.5rem 0 0;
		font-size: 0.85rem;
		color: var(--muted);
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
		display: flex;
		align-items: center;
		gap: 0.4rem;
	}
	.check {
		color: #7fd18a;
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
</style>

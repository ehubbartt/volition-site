<script lang="ts">
	import { enhance } from '$app/forms';
	import { MAX_IMAGES_PER_SUBMISSION } from '$lib/bingo/config';

	type SubmissionStatus = 'pending' | 'approved' | 'rejected';

	interface MySub {
		id: string;
		proof_urls: string[];
		submitted_at: string;
		status: SubmissionStatus;
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
	}

	let { task, canSubmit }: { task: Task; canSubmit: boolean } = $props();

	let fileInput: HTMLInputElement | null = $state(null);
	let staged = $state<Array<{ file: File; url: string }>>([]);
	let dragOver = $state(false);
	let submitting = $state(false);
	let error = $state<string | null>(null);

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
				error = `Up to ${MAX_IMAGES_PER_SUBMISSION} images per submission.`;
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

	function fmtDate(iso: string): string {
		try {
			return new Date(iso).toLocaleString();
		} catch {
			return iso;
		}
	}
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

	{#if canSubmit}
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
					if (result.type === 'success') clearStaged();
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
			<!-- svelte-ignore a11y_no_static_element_interactions -->
			<label
				class="dropzone"
				class:drag-over={dragOver}
				ondragover={(e) => {
					e.preventDefault();
					dragOver = true;
				}}
				ondragleave={() => (dragOver = false)}
				ondrop={(e) => {
					e.preventDefault();
					dragOver = false;
					if (e.dataTransfer?.files?.length) addFiles(e.dataTransfer.files);
				}}
			>
				<input
					bind:this={fileInput}
					type="file"
					name="proof"
					accept="image/png,image/jpeg,image/webp,image/gif"
					multiple
					onchange={(e) => {
						const t = e.target as HTMLInputElement;
						if (t.files?.length) addFiles(t.files);
					}}
					hidden
				/>
				<span class="big">{staged.length > 0 ? 'Add another image' : 'Drop or choose image'}</span>
				<span class="hint">up to {MAX_IMAGES_PER_SUBMISSION} images, 10 MB each</span>
			</label>

			{#if staged.length > 0}
				<div class="staged">
					{#each staged as s, i (s.url)}
						<div class="staged-item">
							<img src={s.url} alt={`Staged ${i + 1}`} />
							<button type="button" class="staged-remove" aria-label="Remove image" onclick={() => removeStaged(i)}>×</button>
						</div>
					{/each}
				</div>
			{/if}

			{#if error}<p class="error">{error}</p>{/if}

			<div class="actions">
				<button type="submit" class="primary" disabled={staged.length === 0 || submitting}>
					{#if submitting}Submitting…{:else}Submit {staged.length > 1 ? `${staged.length} images` : 'proof'}{/if}
				</button>
				{#if staged.length > 0}<button type="button" onclick={clearStaged}>Clear</button>{/if}
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
	.dropzone {
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		gap: 0.4rem;
		min-height: 8rem;
		padding: 1rem;
		margin: 0.25rem 0 0.75rem;
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

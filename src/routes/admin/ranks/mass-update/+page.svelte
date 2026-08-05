<script lang="ts">
	import { enhance } from '$app/forms';
	import RanksTabs from '$lib/admin/RanksTabs.svelte';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();

	// The sweep auto-chains: the first batch stamps `since`, and each response with
	// remaining > 0 resubmits until the whole roster is re-checked (or Stop is pressed).
	let runForm = $state<HTMLFormElement | null>(null);
	let running = $state(false);
	let stopRequested = $state(false);
	let runSince = $state<string | null>(null);

	let total = $state(data.total);
	let doneCount = $state(0); // members re-checked this run
	let savedCount = $state(0); // ranks written to players.rank
	let failedCount = $state(0);
	let remaining = $state<number | null>(null);
	let errors = $state<string[]>([]);
	let finished = $state(false);

	const MAX_RETRIES = 4;
	const RETRY_DELAY_MS = 8000;
	let retries = $state(0);

	const pct = $derived(total > 0 ? Math.min(100, Math.round((doneCount / total) * 100)) : 0);
</script>

<svelte:head><title>Mass Rank Update · Admin · Volition</title></svelte:head>

<section class="wrap">
	<RanksTabs />
	<h1>Mass Rank Update</h1>
	<p class="muted">
		Runs the same <strong>“Check my rank”</strong> over every site member — pulling live
		WiseOldMan, TempleOSRS and WikiSync data, recomputing their composite rank, and writing it
		(plus their signature rank) to <code>players.rank</code>. It goes slowly to stay within
		WoM's rate limit and keeps going on its own until everyone is up to date. Safe to leave
		running; press Stop to pause after the current batch.
	</p>

	<div class="card">
		<div class="row between">
			<div>
				<strong>{data.total} members</strong>
				<p class="muted small">with an RSN to re-check</p>
			</div>
			<form
				method="POST"
				action="?/run"
				bind:this={runForm}
				use:enhance={({ formData }) => {
					if (!runSince) {
						// New run — stamp the pass and reset the counters.
						runSince = new Date().toISOString();
						doneCount = 0;
						savedCount = 0;
						failedCount = 0;
						errors = [];
						finished = false;
					}
					formData.set('since', runSince);
					running = true;
					return async ({ result }) => {
						// Transient WOM failure → back off and retry the same batch.
						const retryable =
							result.type === 'failure' && !!result.data && result.data.retryable === true;
						if (retryable && !stopRequested && retries < MAX_RETRIES) {
							retries += 1;
							setTimeout(() => runForm?.requestSubmit(), RETRY_DELAY_MS);
							return;
						}

						if (result.type === 'success' && result.data) {
							const d = result.data as {
								processed: number;
								saved: number;
								failed: number;
								errors?: string[];
								total: number;
								remaining: number;
							};
							doneCount += d.processed;
							savedCount += d.saved;
							failedCount += d.failed;
							total = d.total;
							remaining = d.remaining;
							if (d.errors?.length) errors = [...errors, ...d.errors].slice(-8);
							retries = 0;

							if (d.remaining > 0 && !stopRequested) {
								setTimeout(() => runForm?.requestSubmit(), 300);
								return;
							}
						}

						// Done, stopped, or a non-retryable failure.
						running = false;
						runSince = null;
						stopRequested = false;
						retries = 0;
						if (result.type === 'success') finished = true;
					};
				}}
			>
				<button class="btn" type="submit" disabled={running}>
					{running ? 'Re-checking…' : 'Start mass re-check'}
				</button>
				{#if running}
					<button class="btn ghost" type="button" onclick={() => (stopRequested = true)}>
						Stop after this batch
					</button>
				{/if}
			</form>
		</div>

		{#if running || finished || doneCount > 0}
			<div class="progress">
				<div class="osrs-bar"><span class="osrs-bar-fill" style="width:{pct}%"></span></div>
				<div class="row between small muted">
					<span>{doneCount} / {total} re-checked ({pct}%)</span>
					<span>
						{savedCount} rank{savedCount === 1 ? '' : 's'} saved{#if failedCount > 0} · {failedCount} failed{/if}
						{#if running && remaining !== null} · ~{remaining} to go{/if}
					</span>
				</div>
			</div>
			{#if finished && !running}
				<p class="done">✅ Done — re-checked {doneCount} member{doneCount === 1 ? '' : 's'}, {savedCount} rank{savedCount === 1 ? '' : 's'} saved{#if failedCount > 0}, {failedCount} failed{/if}.</p>
			{:else if running && retries > 0}
				<p class="muted small">WoM rate-limited — retrying ({retries}/{MAX_RETRIES})…</p>
			{/if}
		{/if}

		{#if errors.length}
			<details class="errs">
				<summary>Recent issues ({errors.length})</summary>
				<ul>{#each errors as e (e)}<li>{e}</li>{/each}</ul>
			</details>
		{/if}
	</div>

	<p class="muted small note">
		A member whose TempleOSRS or WikiSync is unavailable is scored from partial data and their
		clan rank is <em>not</em> overwritten (avoids a wrong demotion) — they just aren't counted as
		“saved”. Re-run later to pick them up.
	</p>
</section>

<style>
	.wrap {
		max-width: 60rem;
		margin: 0 auto;
	}
	.muted {
		color: var(--muted);
	}
	.small {
		font-size: 0.85rem;
	}
	.card {
		margin-top: 1rem;
		padding: 1rem 1.1rem;
		background: var(--surface-alt);
		border: 1px solid var(--border);
		border-radius: var(--radius);
	}
	.row {
		display: flex;
		gap: 1rem;
		align-items: center;
	}
	.between {
		justify-content: space-between;
		flex-wrap: wrap;
	}
	.btn.ghost {
		background: var(--surface);
	}
	.progress {
		margin-top: 1rem;
		display: flex;
		flex-direction: column;
		gap: 0.4rem;
	}
	.osrs-bar {
		height: 0.9rem;
	}
	.done {
		margin: 0.6rem 0 0;
		color: var(--success, #6aa84f);
		font-size: 0.9rem;
	}
	.errs {
		margin-top: 0.8rem;
		font-size: 0.82rem;
	}
	.errs summary {
		cursor: pointer;
		color: var(--muted);
	}
	.errs ul {
		margin: 0.4rem 0 0;
		padding-left: 1.1rem;
		color: var(--danger);
	}
	.note {
		margin-top: 1rem;
		line-height: 1.5;
	}
</style>

<script lang="ts">
	import { enhance } from '$app/forms';
	import { invalidateAll } from '$app/navigation';
	import WikiImage from '$lib/WikiImage.svelte';
	import { itemImageUrl } from '$lib/wikiImage';
	import type { PageData, ActionData } from './$types';

	let { data, form }: { data: PageData; form: ActionData } = $props();

	let busyId = $state<number | null>(null);
	const fmtWhen = (iso: string) =>
		new Date(iso).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
</script>

<svelte:head><title>Rank Gear Claims · Admin · Volition</title></svelte:head>

<section class="wrap">
	<h1>Rank Gear Claims</h1>
	<p class="muted">
		Manual claims for gear the Temple collection log can't prove — items whose obtain method
		doesn't register a log slot (e.g. Oathplate crafted from shards), or upgraded variants
		combined outside the log (Blood Torva, Radiant Oathplate, …). Approving counts the
		item toward the member's gear score on their <strong>next rank check</strong> (or the next
		rank-sim refresh).
	</p>

	{#if form && 'reviewError' in form && form.reviewError}
		<p class="err">{form.reviewError}</p>
	{/if}

	<div class="card">
		<strong>Pending ({data.pending.length})</strong>
		{#each data.pending as c (c.id)}
			<div class="claim">
				<div class="claim-icon">
					<WikiImage src={itemImageUrl(c.item_name)} alt={c.item_name} size={40} />
				</div>
				<div class="claim-body">
					<p class="claim-head">
						<strong>{c.rsn ?? c.discord_username ?? 'Unknown member'}</strong> claims
						<strong>{c.item_name}</strong>
						<span class="muted small">— {c.entry} · {c.points} pts · {fmtWhen(c.submitted_at)}</span>
					</p>
					{#if c.note}<p class="muted small">“{c.note}”</p>{/if}
					<div class="proofs">
						{#each c.proof_urls as url (url)}
							<a href={url} target="_blank" rel="noreferrer noopener">
								<img src={url} alt="proof" loading="lazy" />
							</a>
						{:else}
							<span class="muted small">No screenshots attached.</span>
						{/each}
					</div>
					<form
						method="POST"
						action="?/review"
						class="review"
						use:enhance={() => {
							busyId = c.id;
							return async ({ update }) => {
								await update({ reset: false });
								busyId = null;
								await invalidateAll();
							};
						}}
					>
						<input type="hidden" name="id" value={c.id} />
						<input type="text" name="review_note" placeholder="Note to the member (optional)" />
						<button class="btn primary" type="submit" name="decision" value="approve" disabled={busyId === c.id}>
							Approve
						</button>
						<button class="btn danger" type="submit" name="decision" value="reject" disabled={busyId === c.id}>
							Reject
						</button>
					</form>
				</div>
			</div>
		{:else}
			<p class="muted small">Nothing waiting for review.</p>
		{/each}
	</div>

	<div class="card">
		<strong>Recent decisions</strong>
		<table class="decided">
			<thead><tr><th>Member</th><th>Item</th><th>Status</th><th>Note</th><th>When</th></tr></thead>
			<tbody>
				{#each data.decided as c (c.id)}
					<tr>
						<td>{c.rsn ?? c.discord_username ?? '—'}</td>
						<td>{c.item_name}</td>
						<td class:ok-text={c.status === 'approved'} class:err-text={c.status === 'rejected'}>{c.status}</td>
						<td class="muted small">{c.review_note ?? ''}</td>
						<td class="muted small">{c.reviewed_at ? fmtWhen(c.reviewed_at) : ''}</td>
					</tr>
				{:else}
					<tr><td colspan="5" class="muted">No decisions yet.</td></tr>
				{/each}
			</tbody>
		</table>
	</div>
</section>

<style>
	.wrap {
		max-width: 56rem;
		margin: 0 auto;
		padding: 1.2rem;
	}
	.muted {
		color: var(--muted);
	}
	.small {
		font-size: 0.82rem;
	}
	.err {
		color: var(--danger);
	}
	.card {
		margin-top: 1rem;
		padding: 1rem 1.1rem;
		background: var(--surface-alt);
		border: 1px solid var(--border);
		border-radius: var(--radius);
	}
	.claim {
		display: flex;
		gap: 0.8rem;
		padding: 0.85rem 0;
		border-top: 1px solid var(--border);
		margin-top: 0.85rem;
	}
	.claim-icon {
		flex: 0 0 auto;
	}
	.claim-body {
		flex: 1;
		min-width: 0;
	}
	.claim-head {
		margin: 0 0 0.25rem;
	}
	.proofs {
		display: flex;
		flex-wrap: wrap;
		gap: 0.5rem;
		margin: 0.4rem 0 0.6rem;
	}
	.proofs img {
		height: 90px;
		border: 1px solid var(--border);
		border-radius: 6px;
		object-fit: cover;
	}
	.review {
		display: flex;
		flex-wrap: wrap;
		gap: 0.5rem;
		align-items: center;
	}
	.review input[type='text'] {
		flex: 1;
		min-width: 12rem;
	}
	.decided {
		width: 100%;
		border-collapse: collapse;
		margin-top: 0.6rem;
		font-size: 0.88rem;
	}
	.decided th,
	.decided td {
		text-align: left;
		padding: 0.35rem 0.5rem;
		border-bottom: 1px solid var(--border);
	}
	.ok-text {
		color: var(--success, #6aa84f);
	}
	.err-text {
		color: var(--danger);
	}
</style>

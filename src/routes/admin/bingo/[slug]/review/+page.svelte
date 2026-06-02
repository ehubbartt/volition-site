<script lang="ts">
	import { enhance } from '$app/forms';
	import { invalidateAll } from '$app/navigation';
	import AccountIcon from '$lib/AccountIcon.svelte';
	import Lightbox from '$lib/Lightbox.svelte';
	import { TIER_BY_KEY } from '$lib/bingo/tiles';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();

	let currentIndex = $state(0);
	let busy = $state(false);
	let error = $state<string | null>(null);
	let lastAction = $state<null | { kind: 'approve' | 'reject'; rsn: string }>(null);
	let lightboxSrc = $state<string | null>(null);

	const current = $derived(data.groups[currentIndex] ?? null);
	const remaining = $derived(data.groups.length - currentIndex);
	const tier = $derived(current ? TIER_BY_KEY[current.tile.tier] : null);

	function nextCard() {
		currentIndex += 1;
	}

	function onKey(e: KeyboardEvent) {
		if (busy || !current) return;
		if (e.key === 'ArrowRight') {
			document.getElementById('approve-btn')?.click();
		} else if (e.key === 'ArrowLeft') {
			document.getElementById('reject-btn')?.click();
		}
	}

	function fmt(iso: string) {
		try {
			return new Date(iso).toLocaleString();
		} catch {
			return iso;
		}
	}
</script>

<svelte:head>
	<title>Review · {data.event.name}</title>
</svelte:head>

<svelte:window onkeydown={onKey} />

<nav class="crumbs">
	<a href="/admin/events">← Admin</a>
	<span class="sep">·</span>
	<a href="/bingo/{data.event.slug}">View event →</a>
</nav>

<section class="hero">
	<h1>Review submissions</h1>
	<p class="muted">{data.event.name}</p>

	<div class="stats">
		<div class="stat">
			<span class="label">Pending</span>
			<strong>{remaining}</strong>
		</div>
		<div class="stat">
			<span class="label">Approved</span>
			<strong>{data.stats.approved}</strong>
		</div>
		<div class="stat">
			<span class="label">Rejected</span>
			<strong>{data.stats.rejected}</strong>
		</div>
	</div>

	<p class="kbd-hint muted">
		Use <kbd>←</kbd> to reject, <kbd>→</kbd> to approve
	</p>
</section>

{#if current}
	{@const tilePoints = current.tile.points}
	{@const tileTier = tier!}
	<article class="card">
		<header class="card-head">
			<div class="who">
				<AccountIcon type={current.user.account_type} size={28} />
				<div class="who-text">
					<strong class="rsn">{current.user.rsn ?? current.user.discord_username}</strong>
					<span class="muted who-sub">
						{current.user.discord_username}
						{#if current.user.clan_label}· {current.user.clan_label}{/if}
					</span>
				</div>
			</div>
			<div class="progress muted">{currentIndex + 1} of {data.groups.length}</div>
		</header>

		<section class="tile-block">
			<div class="tile-line">
				<span class="tier-pill" style="background: {tileTier.color}; color: #1a1208">
					{tileTier.label}
				</span>
				<span class="tile-row muted">Row {current.tile.row}</span>
				<span class="tile-pts">{tilePoints} pt{tilePoints === 1 ? '' : 's'}</span>
			</div>
			<h2 class="tile-name">{current.tile.name}</h2>
			{#if current.tile.details_html}
				<div class="details">
					<h3>How to complete</h3>
					<div class="details-body">{@html current.tile.details_html}</div>
				</div>
			{/if}
		</section>

		<section class="proofs">
			<h3>
				{current.submissions.length} proof{current.submissions.length === 1 ? '' : 's'}
			</h3>
			<ul class="proof-list">
				{#each current.submissions as sub (sub.id)}
					<li>
						<div class="sub-images">
							{#each sub.proof_urls as url, idx (url)}
								<button
									type="button"
									class="proof-button"
									onclick={() => (lightboxSrc = url)}
									aria-label={`View proof ${idx + 1}`}
								>
									<img src={url} alt={`Submitted proof ${idx + 1}`} />
								</button>
							{/each}
						</div>
						<p class="meta muted">Submitted {fmt(sub.submitted_at)}</p>
					</li>
				{/each}
			</ul>
		</section>

		{#if error}<p class="error">{error}</p>{/if}

		<div class="actions">
			<form
				method="POST"
				action="?/reject"
				use:enhance={() => {
					busy = true;
					return async ({ result }) => {
						busy = false;
						if (result.type === 'success') {
							lastAction = {
								kind: 'reject',
								rsn: current?.user.rsn ?? current?.user.discord_username ?? ''
							};
							nextCard();
						} else if (result.type === 'failure') {
							const data = result.data as { error?: string } | undefined;
							error = data?.error ?? 'Reject failed';
						} else if (result.type === 'error') {
							error = result.error?.message ?? 'Something went wrong';
						}
					};
				}}
			>
				<input type="hidden" name="user_id" value={current.user_id} />
				<input type="hidden" name="tile_id" value={current.tile_id} />
				<button id="reject-btn" type="submit" class="reject" disabled={busy} title="Reject (←)">
					<span class="big-icon">✗</span>
					<span class="label-text">Reject</span>
				</button>
			</form>

			<form
				method="POST"
				action="?/approve"
				use:enhance={() => {
					busy = true;
					return async ({ result }) => {
						busy = false;
						if (result.type === 'success') {
							lastAction = {
								kind: 'approve',
								rsn: current?.user.rsn ?? current?.user.discord_username ?? ''
							};
							nextCard();
						} else if (result.type === 'failure') {
							const data = result.data as { error?: string } | undefined;
							error = data?.error ?? 'Approve failed';
						} else if (result.type === 'error') {
							error = result.error?.message ?? 'Something went wrong';
						}
					};
				}}
			>
				<input type="hidden" name="user_id" value={current.user_id} />
				<input type="hidden" name="tile_id" value={current.tile_id} />
				<button id="approve-btn" type="submit" class="approve" disabled={busy} title="Approve (→)">
					<span class="big-icon">✓</span>
					<span class="label-text">Approve</span>
				</button>
			</form>
		</div>

		{#if lastAction}
			<p class="last-action muted">
				Last: {lastAction.kind === 'approve' ? 'approved' : 'rejected'} <strong>{lastAction.rsn}</strong>
			</p>
		{/if}
	</article>
{:else}
	<article class="card done">
		<h2>🎉 All caught up</h2>
		<p class="muted">No pending submissions right now.</p>
		<button
			type="button"
			class="primary"
			onclick={() => {
				currentIndex = 0;
				invalidateAll();
			}}
		>
			Check for new submissions
		</button>
	</article>
{/if}

{#if lightboxSrc}
	<Lightbox src={lightboxSrc} alt="Submitted proof" onclose={() => (lightboxSrc = null)} />
{/if}

<style>
	.crumbs {
		margin-bottom: 0.75rem;
		font-size: 0.9rem;
	}

	.crumbs a {
		color: rgba(255, 255, 255, 0.5);
		text-decoration: none;
	}

	.crumbs a:hover {
		color: var(--accent);
	}

	.sep {
		color: rgba(255, 255, 255, 0.3);
		margin: 0 0.4rem;
	}

	.hero {
		margin-bottom: 1.25rem;
	}

	.hero h1 {
		margin: 0 0 0.2rem;
	}

	.muted {
		color: var(--muted);
	}

	.stats {
		display: flex;
		gap: 1rem;
		margin: 0.75rem 0 0.4rem;
		flex-wrap: wrap;
	}

	.stat {
		padding: 0.4rem 0.85rem;
		background: var(--surface-alt);
		border: 1px solid var(--border);
		border-radius: var(--radius);
		display: flex;
		flex-direction: column;
		gap: 0.05rem;
		min-width: 5rem;
	}

	.stat .label {
		font-family: var(--font-heading);
		font-size: 0.7rem;
		letter-spacing: 1px;
		text-transform: uppercase;
		color: var(--muted);
	}

	.stat strong {
		font-family: var(--font-heading);
		color: var(--yellow);
		font-size: 1.1rem;
	}

	.kbd-hint {
		font-size: 0.85rem;
		margin: 0.25rem 0 0;
	}

	kbd {
		display: inline-block;
		padding: 0.05rem 0.4rem;
		background: var(--surface);
		border: 1px solid var(--border-strong);
		border-radius: 3px;
		font-family: var(--font-heading);
		font-size: 0.78rem;
		color: var(--accent);
	}

	.card {
		max-width: 38rem;
		margin: 0 auto;
		padding: 1.25rem;
		background: linear-gradient(180deg, rgba(58, 48, 36, 0.92), rgba(40, 32, 24, 0.92));
		border: 1px solid var(--border);
		border-radius: var(--radius);
		box-shadow: var(--shadow-card);
	}

	.card.done {
		text-align: center;
		padding: 2rem;
	}

	.card.done h2 {
		margin: 0 0 0.5rem;
	}

	.card-head {
		display: flex;
		justify-content: space-between;
		align-items: flex-start;
		gap: 0.75rem;
		margin-bottom: 0.85rem;
		flex-wrap: wrap;
	}

	.who {
		display: flex;
		align-items: center;
		gap: 0.6rem;
	}

	.who-text {
		display: flex;
		flex-direction: column;
		gap: 0.1rem;
	}

	.rsn {
		font-family: var(--font-heading);
		color: var(--yellow);
		text-shadow: var(--ts);
		font-size: 1.05rem;
	}

	.who-sub {
		font-size: 0.8rem;
	}

	.progress {
		font-family: var(--font-heading);
		font-size: 0.85rem;
		color: var(--muted);
	}

	.tile-block {
		padding: 0.75rem 0.85rem;
		background: var(--surface-alt);
		border: 1px solid var(--border);
		border-radius: var(--radius);
		margin-bottom: 0.85rem;
	}

	.tile-line {
		display: flex;
		align-items: baseline;
		gap: 0.6rem;
		flex-wrap: wrap;
		margin-bottom: 0.3rem;
	}

	.tier-pill {
		padding: 0.1rem 0.55rem;
		border-radius: 3px;
		font-family: var(--font-heading);
		font-size: 0.72rem;
		letter-spacing: 1px;
		text-transform: uppercase;
		text-shadow: none;
	}

	.tile-row {
		font-family: var(--font-heading);
		font-size: 0.75rem;
		letter-spacing: 1px;
		text-transform: uppercase;
	}

	.tile-pts {
		font-family: var(--font-heading);
		color: var(--yellow);
		font-size: 0.9rem;
		margin-left: auto;
	}

	.tile-name {
		margin: 0;
		font-size: 1.2rem;
		color: var(--accent);
	}

	.details {
		margin-top: 0.6rem;
		padding-top: 0.6rem;
		border-top: 1px dashed var(--border);
	}

	.details h3 {
		margin: 0 0 0.3rem;
		font-size: 0.78rem;
		letter-spacing: 1px;
		text-transform: uppercase;
		color: var(--muted);
	}

	.details-body :global(p) {
		margin: 0 0 0.4rem;
		font-size: 0.9rem;
	}

	.details-body :global(:last-child) {
		margin-bottom: 0;
	}

	.details-body :global(ul),
	.details-body :global(ol) {
		margin: 0.25rem 0 0.5rem;
		padding-left: 1.15rem;
	}

	.proofs {
		margin-bottom: 1rem;
	}

	.proofs h3 {
		margin: 0 0 0.5rem;
		font-size: 0.95rem;
		color: var(--accent);
	}

	.proof-list {
		list-style: none;
		padding: 0;
		margin: 0;
		display: flex;
		flex-direction: column;
		gap: 0.85rem;
	}

	.sub-images {
		display: flex;
		flex-wrap: wrap;
		gap: 0.5rem;
	}

	.proof-list .proof-button {
		display: block;
		border-radius: 3px;
		overflow: hidden;
		flex: 1 1 14rem;
		max-width: 100%;
		padding: 0;
		background: transparent;
		border: 0;
		cursor: pointer;
		min-height: 0;
	}

	.proof-list .proof-button:hover {
		outline: 1px solid var(--accent);
	}

	.proof-list img {
		display: block;
		width: 100%;
		max-height: 28rem;
		object-fit: contain;
		background: #000;
		border: 1px solid var(--border);
		border-radius: 3px;
	}

	.proof-list .meta {
		margin: 0.3rem 0 0;
		font-size: 0.8rem;
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

	.actions {
		display: grid;
		grid-template-columns: 1fr 1fr;
		gap: 0.75rem;
		margin-top: 0.5rem;
	}

	.actions form {
		display: contents;
	}

	.actions button {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 0.25rem;
		padding: 1rem 0.75rem;
		font-family: var(--font-heading);
		font-size: 1rem;
		letter-spacing: 1px;
		border-radius: var(--radius);
		min-height: 5rem;
		text-shadow: none;
		transition:
			transform 0.1s,
			background 0.15s,
			border-color 0.15s,
			box-shadow 0.15s;
	}

	.actions button:active:not(:disabled) {
		transform: scale(0.97);
	}

	.big-icon {
		font-size: 2.2rem;
		line-height: 1;
	}

	.label-text {
		font-size: 0.85rem;
		letter-spacing: 2px;
	}

	.reject {
		background: var(--danger-bg);
		border-color: var(--danger);
		color: var(--danger);
	}

	.reject:hover:not(:disabled) {
		background: rgba(255, 0, 0, 0.2);
		box-shadow: 0 0 0 1px rgba(255, 0, 0, 0.4);
	}

	.approve {
		background: var(--success-bg);
		border-color: var(--success);
		color: var(--success);
	}

	.approve:hover:not(:disabled) {
		background: rgba(13, 193, 13, 0.25);
		box-shadow: 0 0 0 1px rgba(13, 193, 13, 0.5);
	}

	.last-action {
		margin: 0.7rem 0 0;
		text-align: center;
		font-size: 0.8rem;
	}

	button.primary {
		border-color: var(--accent);
	}

	button.primary:hover {
		background: var(--accent-soft);
	}

	@media (max-width: 540px) {
		.card {
			padding: 1rem;
		}

		.actions button {
			min-height: 4.5rem;
			padding: 0.75rem 0.5rem;
		}

		.big-icon {
			font-size: 1.8rem;
		}

		.proof-list img {
			max-height: 22rem;
		}
	}
</style>

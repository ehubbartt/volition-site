<script lang="ts">
	import { enhance } from '$app/forms';
	import type { SubmitFunction } from '@sveltejs/kit';
	import AccountIcon from '$lib/AccountIcon.svelte';
	import { TIER_BY_KEY } from '$lib/bingo/tiles';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();

	let error = $state<string | null>(null);

	function fmt(iso: string) {
		try {
			return new Date(iso).toLocaleString();
		} catch {
			return iso;
		}
	}

	function statusLabel(s: string) {
		return s === 'pending' ? 'Pending' : s === 'approved' ? 'Approved' : 'Rejected';
	}

	const moderate: SubmitFunction = () => {
		return async ({ result, update }) => {
			await update({ reset: false });
			if (result.type === 'failure') {
				const d = result.data as { error?: string } | undefined;
				error = d?.error ?? 'Action failed';
			}
		};
	};
</script>

<svelte:head>
	<title>{data.target.rsn ?? data.target.discord_username} · {data.event.name}</title>
</svelte:head>

<nav class="crumbs">
	<a href="/bingo/{data.event.slug}">← Back to event</a>
	<span class="sep">·</span>
	<a href="/admin/bingo/{data.event.slug}/review">Review queue →</a>
</nav>

<section class="hero">
	<div class="who">
		<AccountIcon type={data.target.account_type} size={32} />
		<div>
			<h1>{data.target.rsn ?? data.target.discord_username}</h1>
			<p class="muted">
				{data.target.discord_username}{#if data.target.clan_label} · {data.target.clan_label}{/if}
			</p>
		</div>
	</div>
	<div class="stats">
		<div class="stat"><span class="label">Points</span><strong>{data.totalPoints}</strong></div>
		<div class="stat"><span class="label">Tiles done</span><strong>{data.approvedTiles}</strong></div>
		<div class="stat">
			<span class="label">Submissions</span><strong>{data.totalSubmissions}</strong>
		</div>
	</div>
</section>

{#if error}
	<p class="error-banner">{error}</p>
{/if}

{#if data.groups.length === 0}
	<p class="muted empty">This user hasn't submitted anything for this event yet.</p>
{:else}
	<ul class="tiles">
		{#each data.groups as g (g.tile_id)}
			{@const tier = TIER_BY_KEY[g.tier]}
			<li class="tile-card status-{g.status}">
				<header class="tile-head">
					<span class="tier-pill" style="background: {tier.color}; color: #1a1208">
						{tier.label}
					</span>
					<span class="tile-name">{g.tile_name}</span>
					<span class="tile-meta muted">Row {g.row} · {g.points} pt{g.points === 1 ? '' : 's'}</span>
					<span class="tile-status status-{g.status}">{statusLabel(g.status)}</span>
				</header>
				<ul class="proofs">
					{#each g.submissions as s (s.id)}
						<li class="proof status-{s.status}">
							<div class="proof-images">
								{#each s.proof_urls as url, idx (url)}
									<a href={url} target="_blank" rel="noopener">
										<img src={url} alt={`Proof ${idx + 1}`} />
									</a>
								{/each}
							</div>
							<div class="proof-meta">
								<span class="status-pill status-{s.status}">{statusLabel(s.status)}</span>
								<span class="muted when">{fmt(s.submitted_at)}</span>
							</div>
							<div class="proof-actions">
								{#if s.status !== 'approved'}
									<form method="POST" action="?/approve" use:enhance={moderate}>
										<input type="hidden" name="submission_id" value={s.id} />
										<button type="submit" class="approve small">Approve</button>
									</form>
								{/if}
								{#if s.status !== 'rejected'}
									<form method="POST" action="?/reject" use:enhance={moderate}>
										<input type="hidden" name="submission_id" value={s.id} />
										<button type="submit" class="reject small">Reject</button>
									</form>
								{/if}
							</div>
						</li>
					{/each}
				</ul>
			</li>
		{/each}
	</ul>
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
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 1rem;
		flex-wrap: wrap;
		margin-bottom: 1.25rem;
		padding: 1rem 1.25rem;
		background: linear-gradient(180deg, rgba(58, 48, 36, 0.7), rgba(40, 32, 24, 0.7));
		border: 1px solid var(--border);
		border-radius: var(--radius);
		box-shadow: var(--shadow-card);
	}

	.who {
		display: flex;
		align-items: center;
		gap: 0.75rem;
	}

	.who h1 {
		margin: 0;
		font-size: 1.5rem;
	}

	.who p {
		margin: 0.1rem 0 0;
	}

	.muted {
		color: var(--muted);
	}

	.stats {
		display: flex;
		gap: 0.75rem;
		flex-wrap: wrap;
	}

	.stat {
		display: flex;
		flex-direction: column;
		gap: 0.05rem;
		padding: 0.4rem 0.85rem;
		background: var(--surface-alt);
		border: 1px solid var(--border);
		border-radius: var(--radius);
		min-width: 4.5rem;
	}

	.stat .label {
		font-family: var(--font-heading);
		font-size: 0.68rem;
		letter-spacing: 1px;
		text-transform: uppercase;
		color: var(--muted);
	}

	.stat strong {
		font-family: var(--font-heading);
		color: var(--yellow);
		font-size: 1.1rem;
	}

	.empty {
		padding: 1.5rem;
		text-align: center;
	}

	.error-banner {
		margin: 0 0 1rem;
		padding: 0.55rem 0.8rem;
		background: var(--danger-bg);
		border: 1px solid var(--danger);
		color: var(--danger);
		border-radius: 3px;
		font-size: 0.9rem;
	}

	.tiles {
		list-style: none;
		padding: 0;
		margin: 0;
		display: flex;
		flex-direction: column;
		gap: 0.85rem;
	}

	.tile-card {
		padding: 0.85rem 1rem;
		background: linear-gradient(180deg, rgba(58, 48, 36, 0.85), rgba(40, 32, 24, 0.85));
		border: 1px solid var(--border);
		border-radius: var(--radius);
	}

	.tile-card.status-approved {
		border-color: var(--success);
	}

	.tile-card.status-pending {
		border-color: var(--accent);
	}

	.tile-card.status-rejected {
		border-color: var(--danger);
		opacity: 0.85;
	}

	.tile-head {
		display: flex;
		align-items: center;
		gap: 0.6rem;
		flex-wrap: wrap;
		margin-bottom: 0.7rem;
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

	.tile-name {
		font-family: var(--font-heading);
		color: var(--accent);
		font-size: 1.05rem;
	}

	.tile-meta {
		font-size: 0.8rem;
	}

	.tile-status {
		margin-left: auto;
		font-family: var(--font-heading);
		font-size: 0.8rem;
	}

	.tile-status.status-approved {
		color: var(--success);
	}

	.tile-status.status-pending {
		color: var(--accent);
	}

	.tile-status.status-rejected {
		color: var(--danger);
	}

	.proofs {
		list-style: none;
		padding: 0;
		margin: 0;
		display: grid;
		gap: 0.6rem;
		grid-template-columns: repeat(auto-fill, minmax(10rem, 1fr));
	}

	.proof {
		background: var(--surface-alt);
		border: 1px solid var(--border);
		border-radius: 3px;
		padding: 0.4rem;
	}

	.proof.status-rejected img {
		opacity: 0.5;
		filter: saturate(0.5);
	}

	.proof-images {
		display: flex;
		flex-wrap: wrap;
		gap: 0.3rem;
	}

	.proof a {
		display: block;
		flex: 1 1 4.5rem;
	}

	.proof a:hover {
		outline: 1px solid var(--accent);
	}

	.proof img {
		display: block;
		width: 100%;
		height: 5rem;
		object-fit: cover;
		border-radius: 3px;
		background: #000;
	}

	.proof-meta {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 0.4rem;
		margin-top: 0.35rem;
		flex-wrap: wrap;
	}

	.proof-actions {
		display: flex;
		gap: 0.35rem;
		margin-top: 0.4rem;
	}

	.proof-actions form {
		flex: 1 1 0;
	}

	.proof-actions button {
		width: 100%;
		min-height: 0;
		padding: 0.25rem 0.4rem;
		font-size: 0.75rem;
	}

	button.approve {
		border-color: var(--success);
		color: var(--success);
	}

	button.approve:hover {
		background: var(--success-bg);
	}

	button.reject {
		border-color: var(--danger);
		color: var(--danger);
	}

	button.reject:hover {
		background: var(--danger-bg);
	}

	.status-pill {
		display: inline-block;
		padding: 0.05rem 0.45rem;
		font-family: var(--font-heading);
		font-size: 0.65rem;
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

	.when {
		font-size: 0.72rem;
	}
</style>

<script lang="ts">
	import { enhance } from '$app/forms';
	import AccountIcon from '$lib/AccountIcon.svelte';
	import Lightbox from '$lib/Lightbox.svelte';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();

	let error = $state<string | null>(null);
	let lightboxSrc = $state<string | null>(null);

	function fmt(iso: string) {
		try {
			return new Date(iso).toLocaleString();
		} catch {
			return iso;
		}
	}
</script>

<svelte:head>
	<title>{data.team.name} · DuoWolf · {data.event.name}</title>
</svelte:head>

<nav class="crumbs">
	<a href="/admin/submissions">← All submissions</a>
	<span class="sep">·</span>
	<a href="/events/{data.event.slug}/board">View board →</a>
</nav>

<section class="hero">
	<h1>{data.team.name}</h1>
	<div class="members">
		{#each data.team.members as m (m.discord_username)}
			<span class="member"><AccountIcon type={m.account_type} /> {m.rsn ?? m.discord_username}</span>
		{/each}
	</div>
	<div class="stats">
		<div class="stat"><span class="label">Tiles done</span><strong>{data.summary.tilesComplete}</strong></div>
		<div class="stat"><span class="label">Submissions</span><strong>{data.summary.totalSubmissions}</strong></div>
		<div class="stat wide">
			<span class="label">Progress</span>
			<strong>{data.summary.finished ? '🏁 Finished' : data.summary.stage}</strong>
		</div>
		<div class="stat">
			<span class="label">Swaps left</span>
			<strong title={`${data.swaps.baseRemaining}/${data.swaps.perFloor} base this floor · ${data.swaps.bonusRemaining} bonus left (${data.swaps.bonusGranted} granted) · ${data.swaps.used} used`}>
				🔀 {data.swaps.available}
			</strong>
		</div>
	</div>

	<form
		class="grant"
		method="POST"
		action="?/grantSwap"
		use:enhance={() => async ({ result, update }) => {
			await update({ reset: false });
			if (result.type === 'failure') error = (result.data as { error?: string })?.error ?? 'Grant failed';
		}}
	>
		<span class="grant-label">Grant bonus swap (e.g. relevant pet):</span>
		<input type="number" name="amount" min="1" max="10" value="1" aria-label="Bonus swaps" />
		<input type="text" name="note" placeholder="note (optional, e.g. Zuk pet on Inferno)" />
		<button type="submit" class="grant-btn">Grant</button>
	</form>
</section>

{#if error}<p class="error">{error}</p>{/if}

{#if data.groups.length === 0}
	<p class="muted">No submissions from this team yet.</p>
{:else}
	<ul class="groups">
		{#each data.groups as g (g.tile_id)}
			<li class="group status-{g.status}">
				<div class="g-head">
					{#if g.tile_img}<img class="g-img" src={g.tile_img} alt={g.tile_name} referrerpolicy="no-referrer" />{/if}
					<div class="g-text">
						<strong>{g.tile_name}</strong>
						<span class="g-prog" class:full={g.approved >= g.required}>
							{g.approved}/{g.required} approved
						</span>
					</div>
					<span class="pill status-{g.status}">{g.status}</span>
				</div>
				<ul class="subs">
					{#each g.submissions as s (s.id)}
						<li class="sub sub-{s.status}">
							<div class="imgs">
								{#each s.proof_urls as url, i (url)}
									<button type="button" class="thumb" onclick={() => (lightboxSrc = url)} aria-label={`Proof ${i + 1}`}>
										<img src={url} alt={`Proof ${i + 1}`} />
									</button>
								{/each}
							</div>
							<div class="sub-meta">
								<span class="pill status-{s.status}">{s.status}</span>
								{#if s.quantity > 1}<span class="pill covers">covers {s.quantity}</span>{/if}
								<span class="muted">By {s.submitted_by} · {fmt(s.submitted_at)}</span>
								{#if s.reviewed_by_name}<span class="muted">· by {s.reviewed_by_name}</span>{/if}
							</div>
							<div class="sub-actions">
								{#if s.status !== 'approved'}
									<form method="POST" action="?/approve" use:enhance={() => async ({ result, update }) => {
										await update({ reset: false });
										if (result.type === 'failure') error = (result.data as { error?: string })?.error ?? 'Failed';
									}}>
										<input type="hidden" name="submission_id" value={s.id} />
										<button type="submit" class="approve">Approve</button>
									</form>
								{/if}
								{#if s.status !== 'rejected'}
									<form method="POST" action="?/reject" use:enhance={() => async ({ result, update }) => {
										await update({ reset: false });
										if (result.type === 'failure') error = (result.data as { error?: string })?.error ?? 'Failed';
									}}>
										<input type="hidden" name="submission_id" value={s.id} />
										<button type="submit" class="reject">Reject</button>
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

{#if lightboxSrc}
	<Lightbox src={lightboxSrc} alt="Proof" onclose={() => (lightboxSrc = null)} />
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
		margin: 0 0 0.4rem;
	}
	.muted {
		color: var(--muted);
	}

	.members {
		display: flex;
		flex-wrap: wrap;
		gap: 0.75rem;
		margin-bottom: 0.6rem;
	}
	.member {
		display: flex;
		align-items: center;
		gap: 0.35rem;
		font-size: 0.9rem;
	}

	.stats {
		display: flex;
		gap: 1rem;
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
		font-size: 1.05rem;
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

	.grant {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		flex-wrap: wrap;
		margin-top: 0.85rem;
		padding: 0.6rem 0.75rem;
		background: var(--surface-alt);
		border: 1px dashed var(--yellow);
		border-radius: var(--radius);
	}
	.grant-label {
		font-size: 0.82rem;
		color: var(--yellow);
		font-family: var(--font-heading);
		letter-spacing: 0.5px;
	}
	.grant input[type='number'] {
		width: 4rem;
	}
	.grant input[type='text'] {
		flex: 1;
		min-width: 12rem;
	}
	.grant input {
		padding: 0.3rem 0.5rem;
		background: var(--surface);
		border: 1px solid var(--border-strong);
		border-radius: 3px;
		color: var(--text);
	}
	.grant-btn {
		border-color: var(--yellow);
		color: var(--yellow);
		font-size: 0.82rem;
		padding: 0.3rem 0.8rem;
		min-height: 0;
	}
	.grant-btn:hover {
		background: rgba(240, 210, 60, 0.12);
	}

	.groups {
		list-style: none;
		padding: 0;
		margin: 0;
		display: flex;
		flex-direction: column;
		gap: 0.85rem;
	}
	.group {
		padding: 0.85rem;
		background: var(--surface-alt);
		border: 1px solid var(--border);
		border-radius: var(--radius);
	}
	.group.status-approved {
		border-color: var(--success);
	}
	.g-head {
		display: flex;
		align-items: center;
		gap: 0.6rem;
		margin-bottom: 0.6rem;
	}
	.g-img {
		width: 2rem;
		height: 2rem;
		object-fit: contain;
	}
	.g-text {
		display: flex;
		flex-direction: column;
		gap: 0.1rem;
		flex: 1;
		min-width: 0;
	}
	.g-prog {
		font-family: var(--font-heading);
		font-size: 0.8rem;
		color: var(--yellow);
	}
	.g-prog.full {
		color: var(--success);
	}

	.pill {
		font-family: var(--font-heading);
		font-size: 0.65rem;
		letter-spacing: 1px;
		text-transform: uppercase;
		padding: 0.05rem 0.45rem;
		border-radius: 3px;
		border: 1px solid transparent;
	}
	.pill.status-pending {
		background: rgba(255, 152, 31, 0.18);
		border-color: var(--accent);
		color: var(--accent);
	}
	.pill.status-approved {
		background: var(--success-bg);
		border-color: var(--success);
		color: var(--success);
	}
	.pill.status-rejected {
		background: var(--danger-bg);
		border-color: var(--danger);
		color: var(--danger);
	}

	.subs {
		list-style: none;
		padding: 0;
		margin: 0;
		display: flex;
		flex-direction: column;
		gap: 0.6rem;
	}
	.sub {
		padding: 0.5rem;
		background: var(--surface);
		border: 1px solid var(--border);
		border-radius: 3px;
	}
	.sub-rejected .thumb img {
		opacity: 0.55;
		filter: saturate(0.5);
	}
	.imgs {
		display: flex;
		flex-wrap: wrap;
		gap: 0.4rem;
		margin-bottom: 0.4rem;
	}
	.thumb {
		display: block;
		padding: 0;
		border: 0;
		background: transparent;
		cursor: pointer;
		min-height: 0;
	}
	.thumb img {
		width: 6rem;
		height: 6rem;
		object-fit: cover;
		border: 1px solid var(--border);
		border-radius: 3px;
		background: #000;
	}
	.thumb:hover {
		outline: 1px solid var(--accent);
	}
	.sub-meta {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		flex-wrap: wrap;
		font-size: 0.8rem;
		margin-bottom: 0.4rem;
	}
	.sub-actions {
		display: flex;
		gap: 0.5rem;
	}
	.sub-actions button {
		font-size: 0.78rem;
		padding: 0.25rem 0.7rem;
		min-height: 0;
	}
	.approve {
		border-color: var(--success);
		color: var(--success);
	}
	.approve:hover {
		background: var(--success-bg);
	}
	.reject {
		border-color: var(--danger);
		color: var(--danger);
	}
	.reject:hover {
		background: var(--danger-bg);
	}
</style>

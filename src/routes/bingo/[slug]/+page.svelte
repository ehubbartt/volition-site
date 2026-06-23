<script lang="ts">
	import { invalidateAll } from '$app/navigation';
	import AccountIcon from '$lib/AccountIcon.svelte';
	import type { PageData } from './$types';
	import { TIERS } from '$lib/bingo/tiles';
	import type { BingoTier, BingoTile } from '$lib/bingo/tiles';
	import { BINGO_EVENT_SLUG } from '$lib/bingo/config';
	import { getTileStatus, formatCountdown } from '$lib/bingo/state';
	import TileCell from '$lib/bingo/TileCell.svelte';
	import SubmitModal from '$lib/bingo/SubmitModal.svelte';
	import Lightbox from '$lib/Lightbox.svelte';

	let { data }: { data: PageData } = $props();

	const mainTierHeaders = TIERS.filter((t) => t.key !== 'bonus');
	const TIER_ORDER: BingoTier[] = ['skilling', 'easy', 'medium', 'hard'];

	// Row count is data-driven: the number of grid rows comes from the loaded tiles
	// (built/cloned events can have any row count), not a hardcoded constant.
	const rowCount = $derived(
		data.tiles.reduce((max, t) => (t.tier !== 'bonus' && t.row > max ? t.row : max), 0)
	);
	const rowNumbers = $derived(Array.from({ length: rowCount }, (_, i) => i + 1));

	const tileById = $derived(new Map(data.tiles.map((t) => [t.id, t])));
	const bonusTiles = $derived(data.tiles.filter((t) => t.tier === 'bonus'));

	function tilesForRow(r: number): BingoTile[] {
		return TIER_ORDER.map((tier) => tileById.get(`r${r}-${tier}`)!).filter(Boolean);
	}

	let openTileId = $state<string | null>(null);
	const openTile = $derived(openTileId ? tileById.get(openTileId) ?? null : null);

	let now = $state(Date.now());
	let reloadedAtZero = false;

	$effect(() => {
		if (!data.running || !data.state) return;
		const id = setInterval(() => {
			now = Date.now();
		}, 1000);
		return () => clearInterval(id);
	});

	const liveState = $derived.by(() => {
		if (!data.state) return null;
		const start = data.state.startAt ? new Date(data.state.startAt).getTime() : null;
		const ends = data.state.endsAt ? new Date(data.state.endsAt).getTime() : null;
		const nextRow = data.state.nextRowAt ? new Date(data.state.nextRowAt).getTime() : null;
		return {
			...data.state,
			msUntilStart: start && now < start ? start - now : 0,
			msUntilNextRow: nextRow ? nextRow - now : null,
			msUntilEnd: ends ? ends - now : null
		};
	});

	$effect(() => {
		if (!liveState || !data.running) return;
		const remaining =
			liveState.status === 'pre' ? liveState.msUntilStart : liveState.msUntilNextRow ?? null;
		if (remaining !== null && remaining <= 0 && !reloadedAtZero) {
			reloadedAtZero = true;
			invalidateAll().then(() => {
				reloadedAtZero = false;
			});
		}
	});

	function getStatus(tileId: string) {
		const tile = tileById.get(tileId);
		if (!tile || !data.state) return 'blurred' as const;
		return getTileStatus(tile, data.state);
	}

	function communityFor(tileId: string) {
		return data.completionsByTile[tileId] ?? [];
	}

	function communityCountFor(tileId: string): number {
		return data.completionCountByTile[tileId] ?? 0;
	}

	function mineFor(tileId: string) {
		return data.mySubmissions[tileId] ?? [];
	}

	function myStatusFor(tileId: string): 'approved' | 'pending' | 'rejected' | null {
		const subs = mineFor(tileId);
		if (subs.length === 0) return null;
		if (subs.some((s) => s.status === 'approved')) return 'approved';
		if (subs.some((s) => s.status === 'pending')) return 'pending';
		return 'rejected';
	}

	function openModal(tileId: string) {
		const status = getStatus(tileId);
		if (status === 'blurred') return;
		openTileId = tileId;
	}

	function closeModal() {
		openTileId = null;
	}

	let lightboxSrc = $state<string | null>(null);

	function openLightbox(url: string) {
		lightboxSrc = url;
	}

	function closeLightbox() {
		lightboxSrc = null;
	}
</script>

<svelte:head>
	<title>{data.event?.name ?? 'Bingo'} · Volition</title>
</svelte:head>

<section class="hero">
	<div class="hero-head">
		<h1>{data.event?.name ?? 'Volition Bingo'}</h1>
		{#if data.event}
			<span class="badge {data.event.status}">{data.event.status}</span>
		{/if}
	</div>

	{#if data.event?.description_html}
		<div class="muted description">{@html data.event.description_html}</div>
	{/if}

	{#if !data.isClanMember && !data.archived}
		<p class="non-member-note">
			You're signed in, but you're not on the Volition clan list — you can browse the board, but
			submissions are limited to clan members. Ping an admin if you think this is wrong.
		</p>
	{/if}

	{#if data.archived}
		<p class="ended-note">
			This event has ended. Submissions are closed — browse the final board, leaderboard, and your
			submissions below.
		</p>
	{:else if !data.running}
		<p class="muted">The bingo event is not currently running. Check back soon!</p>
	{:else if liveState}
		<div class="status-row">
			{#if liveState.status === 'pre'}
				<span class="status-label">Starts in</span>
				<strong class="countdown">{formatCountdown(liveState.msUntilStart)}</strong>
			{:else if liveState.status === 'active'}
				{#if liveState.nextRowAt}
					<span class="status-label">
						Row {(liveState.activeRow ?? 0) + 1} of {rowCount} · next in
					</span>
					<strong class="countdown">{formatCountdown(liveState.msUntilNextRow)}</strong>
				{:else}
					<span class="status-label">All {rowCount} rows open</span>
				{/if}
			{:else}
				<span class="status-label">Event ended</span>
			{/if}
		</div>
	{/if}
</section>

<section class="layout">
	<div class="board-wrap">
		<div class="board" class:no-bonus={!data.bonusEnabled} role="grid" aria-label="Bingo board">
			<div class="cell-header"></div>
			{#each mainTierHeaders as t (t.key)}
				<div class="cell-header tier-header" style="--tier-color: {t.color}">
					<div class="pts">{t.points} pt{t.points === 1 ? '' : 's'}</div>
					<div class="tier-name" style="background: {t.color}">{t.label}</div>
				</div>
			{/each}
			{#if data.bonusEnabled}
				<div class="cell-gap"></div>
				<div class="cell-header tier-header" style="--tier-color: #ff981f">
					<div class="pts">{TIERS[4].points} pts</div>
					<div class="tier-name bonus" style="background: #ff981f">Bonus</div>
				</div>
			{/if}

			{#each rowNumbers as r (r)}
				<div class="row-number">{r}</div>
				{#each tilesForRow(r) as tile (tile.id)}
					<TileCell
						{tile}
						status={getStatus(tile.id)}
						myStatus={myStatusFor(tile.id)}
						onclick={() => openModal(tile.id)}
					/>
				{/each}
				{#if data.bonusEnabled}
					<div class="cell-gap"></div>
					{@const bonus = bonusTiles[r - 1]}
					{#if bonus}
						<TileCell
							tile={bonus}
							status={getStatus(bonus.id)}
							myStatus={myStatusFor(bonus.id)}
							onclick={() => openModal(bonus.id)}
						/>
					{/if}
				{/if}
			{/each}
		</div>
	</div>

	<aside class="sidebar">
		<div class="card">
			<h2>Leaderboard</h2>
			{#if data.leaderboard.length === 0}
				<p class="muted">No submissions yet.</p>
			{:else}
				<ol class="lb">
					{#each data.leaderboard as p, i (p.user_id)}
						{@const isMe = p.user_id === data.user?.id}
						<li class:me={isMe}>
							{#if data.isAdmin}
								<a class="lb-row" href="/admin/bingo/{BINGO_EVENT_SLUG}/user/{p.user_id}">
									<span class="rank">{i + 1}</span>
									<AccountIcon type={p.account_type} />
									<span class="name">
										{p.rsn ?? p.discord_username}
										{#if isMe}<span class="me-tag">you</span>{/if}
									</span>
									<span class="pts">{p.points} pt{p.points === 1 ? '' : 's'}</span>
									<span class="cnt">×{p.count}</span>
								</a>
							{:else}
								<div class="lb-row">
									<span class="rank">{i + 1}</span>
									<AccountIcon type={p.account_type} />
									<span class="name">
										{p.rsn ?? p.discord_username}
										{#if isMe}<span class="me-tag">you</span>{/if}
									</span>
									<span class="pts">{p.points} pt{p.points === 1 ? '' : 's'}</span>
									<span class="cnt">×{p.count}</span>
								</div>
							{/if}
						</li>
					{/each}
				</ol>
			{/if}
		</div>
	</aside>
</section>

{#if openTile}
	<SubmitModal
		tile={openTile}
		status={getStatus(openTile.id)}
		mySubmissions={mineFor(openTile.id)}
		community={communityFor(openTile.id)}
		communityCount={communityCountFor(openTile.id)}
		canSubmit={data.isClanMember}
		isAdmin={data.isAdmin}
		onZoom={openLightbox}
		onclose={closeModal}
	/>
{/if}

{#if lightboxSrc}
	<Lightbox src={lightboxSrc} alt="Bingo proof" onclose={closeLightbox} />
{/if}

<style>
	.hero {
		margin-bottom: 1.5rem;
		padding: 1.25rem 1.5rem;
		background: linear-gradient(180deg, rgba(58, 48, 36, 0.7), rgba(40, 32, 24, 0.7));
		border: 1px solid var(--border);
		border-radius: var(--radius);
		box-shadow: var(--shadow-card);
	}

	.hero-head {
		display: flex;
		align-items: center;
		gap: 0.75rem;
		flex-wrap: wrap;
		margin-bottom: 0.5rem;
	}

	.hero h1 {
		margin: 0;
	}

	.muted {
		color: var(--muted);
	}

	.description :global(p) {
		margin: 0 0 0.5rem;
	}

	.description :global(:last-child) {
		margin-bottom: 0;
	}

	.badge {
		display: inline-block;
		padding: 0.1rem 0.55rem;
		font-size: 0.8rem;
		text-transform: uppercase;
		letter-spacing: 0.05em;
		border-radius: 3px;
		background: var(--surface-alt);
		border: 1px solid var(--border);
		color: var(--muted);
	}

	.badge.open {
		background: var(--accent-soft);
		border-color: var(--accent);
		color: var(--accent);
	}

	.non-member-note {
		margin: 0.7rem 0 0;
		padding: 0.55rem 0.8rem;
		background: var(--surface-alt);
		border: 1px solid var(--accent);
		border-left-width: 3px;
		border-radius: 3px;
		color: var(--accent);
		font-size: 0.9rem;
	}

	.ended-note {
		margin: 0.7rem 0 0;
		padding: 0.55rem 0.8rem;
		background: var(--surface-alt);
		border: 1px solid var(--border-strong);
		border-left: 3px solid var(--muted);
		border-radius: 3px;
		color: var(--muted);
		font-size: 0.9rem;
	}

	.status-row {
		margin-top: 0.7rem;
		display: flex;
		align-items: baseline;
		gap: 0.6rem;
		flex-wrap: wrap;
	}

	.status-label {
		color: var(--muted);
		font-size: 0.95rem;
	}

	.countdown {
		font-family: var(--font-heading);
		font-size: 1.3rem;
		color: var(--yellow);
		text-shadow: var(--ts-strong);
	}

	.layout {
		display: grid;
		gap: 1.25rem;
		grid-template-columns: 1fr;
	}

	@media (min-width: 64rem) {
		.layout {
			grid-template-columns: 1fr 16rem;
		}
	}

	.board-wrap {
		overflow-x: auto;
	}

	.board {
		display: grid;
		grid-template-columns: 1.6rem repeat(4, minmax(7.5rem, 1fr)) 0.6rem minmax(7.5rem, 1fr);
		gap: 0.45rem;
		min-width: 36rem;
		padding: 0.5rem;
		background: linear-gradient(180deg, rgba(58, 48, 36, 0.5), rgba(40, 32, 24, 0.5));
		border: 1px solid var(--border);
		border-radius: var(--radius);
	}

	/* Bonus column disabled → drop the gap + bonus tracks. */
	.board.no-bonus {
		grid-template-columns: 1.6rem repeat(4, minmax(7.5rem, 1fr));
		min-width: 30rem;
	}

	@media (max-width: 720px) {
		.board {
			grid-template-columns: 1.2rem repeat(4, 1fr) 0.3rem 1fr;
			gap: 0.3rem;
			min-width: 0;
			padding: 0.3rem;
		}
		.board.no-bonus {
			grid-template-columns: 1.2rem repeat(4, 1fr);
		}
	}

	@media (max-width: 480px) {
		.board {
			grid-template-columns: 0.9rem repeat(4, 1fr) 0.2rem 1fr;
			gap: 0.22rem;
			padding: 0.22rem;
		}
		.board.no-bonus {
			grid-template-columns: 0.9rem repeat(4, 1fr);
		}
	}

	.cell-header,
	.cell-gap,
	.row-number {
		display: flex;
		align-items: center;
		justify-content: center;
	}

	.cell-gap {
		min-height: 0;
	}

	.tier-header {
		flex-direction: column;
		gap: 0.2rem;
		padding: 0.2rem 0;
	}

	.tier-header .pts {
		font-size: 0.7rem;
		color: var(--muted);
		text-transform: uppercase;
		letter-spacing: 1px;
		font-family: var(--font-heading);
	}

	.tier-header .tier-name {
		width: 100%;
		padding: 0.25rem 0.5rem;
		text-align: center;
		font-family: var(--font-heading);
		font-size: 0.85rem;
		color: #1a1208;
		border-radius: 3px;
		text-shadow: none;
		letter-spacing: 1px;
	}

	.row-number {
		font-family: var(--font-heading);
		font-size: 1.1rem;
		color: var(--accent);
		text-shadow: var(--ts);
	}

	@media (max-width: 720px) {
		.tier-header .pts {
			display: none;
		}
		.tier-header .tier-name {
			font-size: 0.65rem;
			padding: 0.18rem 0.2rem;
			letter-spacing: 0.5px;
		}
		.row-number {
			font-size: 0.78rem;
		}
	}

	@media (max-width: 480px) {
		.tier-header .tier-name {
			font-size: 0.58rem;
			padding: 0.15rem 0.15rem;
			letter-spacing: 0;
		}
	}

	.card {
		padding: 1rem;
		background: linear-gradient(180deg, rgba(58, 48, 36, 0.85), rgba(40, 32, 24, 0.85));
		border: 1px solid var(--border);
		border-radius: var(--radius);
		box-shadow: var(--shadow-card);
	}

	.card h2 {
		margin: 0 0 0.6rem;
		font-size: 1.1rem;
	}

	.lb {
		list-style: none;
		padding: 0;
		margin: 0;
		display: flex;
		flex-direction: column;
		gap: 0.3rem;
	}

	.lb li {
		border-radius: 3px;
	}

	.lb-row {
		display: grid;
		grid-template-columns: 1.5rem 22px 1fr auto auto;
		align-items: center;
		gap: 0.4rem;
		padding: 0.35rem 0.5rem;
		background: var(--surface-alt);
		border: 1px solid var(--border);
		border-radius: 3px;
		font-size: 0.85rem;
		color: var(--text);
		text-decoration: none;
	}

	a.lb-row:hover {
		border-color: var(--accent);
		text-decoration: none;
	}

	.lb li.me .lb-row {
		border-color: var(--accent);
		background: var(--accent-soft);
		box-shadow: inset 0 0 0 1px rgba(255, 152, 31, 0.3);
	}

	.lb .rank {
		font-family: var(--font-heading);
		color: var(--accent);
		text-align: center;
	}

	.lb .name {
		display: flex;
		align-items: center;
		gap: 0.35rem;
		min-width: 0;
		overflow: hidden;
		white-space: nowrap;
	}

	.lb .me-tag {
		flex-shrink: 0;
	}

	.lb .me-tag {
		font-size: 0.6rem;
		text-transform: uppercase;
		background: var(--accent);
		color: #1a1208;
		padding: 0.02rem 0.3rem;
		border-radius: 3px;
		text-shadow: none;
	}

	.lb .pts {
		font-family: var(--font-heading);
		color: var(--yellow);
	}

	.lb .cnt {
		color: var(--muted);
		font-size: 0.75rem;
	}

	@media (max-width: 720px) {
		.hero {
			padding: 0.9rem 1rem;
			margin-bottom: 0.9rem;
		}

		.countdown {
			font-size: 1.05rem;
		}

		.status-label {
			font-size: 0.85rem;
		}

		.layout {
			gap: 1rem;
		}

		.lb li {
			font-size: 0.78rem;
			padding: 0.3rem 0.4rem;
			gap: 0.3rem;
		}
	}
</style>

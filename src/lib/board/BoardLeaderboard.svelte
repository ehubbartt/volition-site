<script lang="ts">
	// Spoiler-free standings (stage/position only — never tile content). Clan tabs let you
	// see the top teams for each clan; "All" is the overall top N. Used by the board side
	// panel (fill=true) and the duo event page's board panel (fill=false).
	interface LeaderEntry {
		rank: number;
		name: string;
		stageLabel: string;
		floor: number;
		stageIndex: number;
		pct: number;
		finished: boolean;
		tilesComplete: number;
		isMine: boolean;
		clan: string;
		clanLabel: string;
	}
	interface ClanGroup {
		clan: string;
		label: string;
		entries: LeaderEntry[];
	}

	let {
		leaderboard,
		byClan = [],
		teamCount,
		fill = false,
		maxHeight = 'min(78vh, 760px)'
	}: {
		leaderboard: LeaderEntry[];
		byClan?: ClanGroup[];
		teamCount: number;
		fill?: boolean;
		maxHeight?: string;
	} = $props();

	let activeTab = $state('all');

	const tabs = $derived([{ clan: 'all', label: 'All' }, ...byClan.map((g) => ({ clan: g.clan, label: g.label }))]);
	const shown = $derived(
		activeTab === 'all' ? leaderboard : (byClan.find((g) => g.clan === activeTab)?.entries ?? [])
	);
	const subtitle = $derived(
		activeTab === 'all'
			? `Top ${leaderboard.length} of ${teamCount} team${teamCount === 1 ? '' : 's'}`
			: `${shown.length} team${shown.length === 1 ? '' : 's'}`
	);
</script>

<aside class="lb" style:height={fill ? maxHeight : null} style:max-height={maxHeight}>
	<div class="lb-head">
		<h2>Leaderboard</h2>
		<span class="lb-sub">{subtitle}</span>
	</div>

	{#if tabs.length > 1}
		<div class="lb-tabs" role="tablist" aria-label="Filter leaderboard by clan">
			{#each tabs as t (t.clan)}
				<button
					type="button"
					role="tab"
					aria-selected={activeTab === t.clan}
					class="lb-tab"
					class:active={activeTab === t.clan}
					onclick={() => (activeTab = t.clan)}
				>
					{t.label}
				</button>
			{/each}
		</div>
	{/if}

	{#if shown.length === 0}
		<p class="lb-empty">No teams here yet.</p>
	{:else}
		<ol class="lb-list">
			{#each shown as e (e.rank)}
				<li class:mine={e.isMine} class:done={e.finished}>
					<span class="lb-rank" class:top={e.rank <= 3}>{e.rank}</span>
					<div class="lb-body">
						<div class="lb-row">
							<span class="lb-name" title={e.name}>{e.name}</span>
							{#if e.isMine}<span class="lb-you">you</span>{/if}
						</div>
						<span class="lb-stage">
							{e.finished ? '🏁 Finished' : e.stageLabel}
							{#if activeTab === 'all'}<span class="lb-clan">· {e.clanLabel}</span>{/if}
						</span>
						<div class="lb-bar" title={`${e.pct}% of the climb`}>
							<div class="lb-fill" style="width: {e.pct}%"></div>
						</div>
					</div>
				</li>
			{/each}
		</ol>
	{/if}
</aside>

<style>
	.lb {
		display: flex;
		flex-direction: column;
		background: var(--surface-alt);
		border: 1px solid var(--border);
		border-radius: var(--radius);
		overflow: hidden;
	}

	.lb-head {
		padding: 0.75rem 0.85rem 0.6rem;
		border-bottom: 1px solid var(--border);
	}

	.lb-head h2 {
		margin: 0;
		font-size: 1.05rem;
		color: var(--accent);
		letter-spacing: 1px;
		text-shadow: var(--ts);
	}

	.lb-sub {
		font-size: 0.72rem;
		color: var(--muted);
		text-transform: uppercase;
		letter-spacing: 0.05em;
	}

	.lb-tabs {
		display: flex;
		flex-wrap: wrap;
		gap: 3px;
		padding: 0.5rem 0.55rem;
		border-bottom: 1px solid var(--border);
	}

	.lb-tab {
		min-height: 0;
		padding: 0.2rem 0.5rem;
		font-size: 0.72rem;
		background: transparent;
		border: 1px solid var(--border);
		border-radius: 999px;
		color: var(--muted);
		cursor: pointer;
	}

	.lb-tab:hover {
		color: var(--accent);
		border-color: var(--accent);
	}

	.lb-tab.active {
		color: var(--accent);
		border-color: var(--accent);
		background: var(--accent-soft);
	}

	.lb-empty {
		padding: 1rem 0.85rem;
		color: var(--muted);
		font-size: 0.85rem;
	}

	.lb-list {
		list-style: none;
		margin: 0;
		padding: 0.35rem;
		overflow-y: auto;
		flex: 1;
		display: flex;
		flex-direction: column;
		gap: 0.2rem;
	}

	.lb-list li {
		display: flex;
		align-items: center;
		gap: 0.55rem;
		padding: 0.4rem 0.45rem;
		border-radius: 4px;
	}

	.lb-list li.mine {
		background: var(--accent-soft);
		outline: 1px solid var(--accent);
	}

	.lb-rank {
		flex-shrink: 0;
		width: 1.5rem;
		text-align: center;
		font-family: var(--font-heading);
		font-size: 0.9rem;
		color: var(--muted);
	}

	.lb-rank.top {
		color: var(--yellow);
	}

	.lb-body {
		flex: 1;
		min-width: 0;
		display: flex;
		flex-direction: column;
		gap: 0.15rem;
	}

	.lb-row {
		display: flex;
		align-items: center;
		gap: 0.35rem;
	}

	.lb-name {
		font-size: 0.85rem;
		font-weight: 600;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.lb-you {
		flex-shrink: 0;
		font-size: 0.6rem;
		text-transform: uppercase;
		letter-spacing: 0.04em;
		background: var(--accent);
		color: #1a1209;
		padding: 0.02rem 0.3rem;
		border-radius: 999px;
	}

	.lb-stage {
		font-size: 0.72rem;
		color: var(--muted);
	}

	.lb-clan {
		opacity: 0.8;
	}

	.lb-list li.done .lb-stage {
		color: var(--success);
	}

	.lb-bar {
		height: 0.3rem;
		margin-top: 0.1rem;
		background: rgba(0, 0, 0, 0.35);
		border-radius: 999px;
		overflow: hidden;
	}

	.lb-fill {
		height: 100%;
		background: var(--accent);
		border-radius: 999px;
	}

	.lb-list li.done .lb-fill {
		background: var(--success);
	}
</style>

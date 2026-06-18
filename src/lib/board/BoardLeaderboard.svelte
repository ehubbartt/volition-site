<script lang="ts">
	// Spoiler-free standings: how far each team has climbed (floor/section stage only — never
	// the tile name/content). Top 20.
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
	}

	let { entries, teamCount }: { entries: LeaderEntry[]; teamCount: number } = $props();
</script>

<aside class="lb">
	<div class="lb-head">
		<h2>Leaderboard</h2>
		<span class="lb-sub">Top {entries.length} of {teamCount} team{teamCount === 1 ? '' : 's'}</span>
	</div>

	{#if entries.length === 0}
		<p class="lb-empty">No teams have started yet.</p>
	{:else}
		<ol class="lb-list">
			{#each entries as e (e.rank)}
				<li class:mine={e.isMine} class:done={e.finished}>
					<span class="lb-rank" class:top={e.rank <= 3}>{e.rank}</span>
					<div class="lb-body">
						<div class="lb-row">
							<span class="lb-name" title={e.name}>{e.name}</span>
							{#if e.isMine}<span class="lb-you">you</span>{/if}
						</div>
						<span class="lb-stage">{e.finished ? '🏁 Finished' : e.stageLabel}</span>
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
		height: min(78vh, 760px);
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

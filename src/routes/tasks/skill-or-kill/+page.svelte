<script lang="ts">
	import { formatCountdown } from '$lib/tasks';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();

	// Live clock so the "ends in" countdowns tick.
	let now = $state(Date.now());
	$effect(() => {
		const id = setInterval(() => (now = Date.now()), 1000);
		return () => clearInterval(id);
	});

	function endsIn(endsAt: string | null): string {
		if (!endsAt) return '';
		return formatCountdown(new Date(endsAt).getTime() - now);
	}

	function medal(i: number): string {
		return i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : `${i + 1}.`;
	}
</script>

<svelte:head><title>Skill or Kill · Volition</title></svelte:head>

<section class="head">
	<a class="back" href="/tasks">← To Do</a>
	<h1>Skill or Kill</h1>
</section>

{#if data.competitions.length === 0}
	<div class="panel note">No active Skill or Kill competition right now. Check back after the next reset.</div>
{:else}
	<div class="comps">
		{#each data.competitions as c (c.womId)}
			<section class="panel comp">
				<header class="comp-head">
					<div>
						<span class="kind">{c.kind === 'skill' ? '⭐ Skill' : '⚔️ Boss'}</span>
						<h2>{c.label}</h2>
					</div>
					{#if c.endsAt}
						<span class="ends">Ends in <strong>{endsIn(c.endsAt)}</strong></span>
					{/if}
				</header>

				{#if !c.reachable}
					<p class="muted small">Live standings are unavailable right now.</p>
				{:else if c.participants.length === 0}
					<p class="muted small">No participants yet — be the first.</p>
				{:else}
					<ol class="board">
						{#each c.participants as p, i (p.rsn)}
							<li class:top={i < 3}>
								<span class="rank">{medal(i)}</span>
								<span class="rsn">{p.rsn}</span>
								<span class="gained">{p.display}</span>
							</li>
						{/each}
					</ol>
				{/if}

				<a class="wom" href={c.womUrl} target="_blank" rel="noopener noreferrer">View on WiseOldMan →</a>
			</section>
		{/each}
	</div>
{/if}

<style>
	.head {
		display: flex;
		align-items: baseline;
		gap: 1rem;
		margin-bottom: 1.25rem;
	}
	.head h1 {
		font-family: var(--font-heading);
		font-size: 2rem;
		margin: 0;
		text-shadow: var(--ts);
	}
	.back {
		color: var(--muted);
		text-decoration: none;
		font-size: 0.9rem;
	}
	.back:hover {
		color: var(--accent);
	}

	.comps {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(18rem, 1fr));
		gap: 1rem;
		align-items: start;
	}

	.panel {
		background: linear-gradient(180deg, rgba(58, 48, 36, 0.6), rgba(40, 32, 24, 0.6));
		border: 1px solid var(--border);
		border-radius: var(--radius);
		box-shadow: var(--shadow-card);
		padding: 1.1rem 1.25rem;
	}
	.note {
		color: var(--muted);
	}

	.comp-head {
		display: flex;
		align-items: flex-start;
		justify-content: space-between;
		gap: 0.75rem;
		margin-bottom: 0.75rem;
	}
	.kind {
		font-size: 0.72rem;
		text-transform: uppercase;
		letter-spacing: 0.04em;
		color: var(--accent);
	}
	.comp-head h2 {
		margin: 0.1rem 0 0;
		font-size: 1.25rem;
	}
	.ends {
		font-size: 0.8rem;
		color: var(--muted);
		white-space: nowrap;
	}
	.ends strong {
		color: var(--text);
	}

	.board {
		list-style: none;
		margin: 0 0 0.75rem;
		padding: 0;
		display: flex;
		flex-direction: column;
		gap: 0.15rem;
	}
	.board li {
		display: grid;
		grid-template-columns: 1.8rem 1fr auto;
		align-items: center;
		gap: 0.5rem;
		padding: 0.3rem 0.4rem;
		border-radius: 3px;
	}
	.board li.top {
		background: var(--surface-alt);
	}
	.rank {
		text-align: center;
		font-family: var(--font-heading);
		color: var(--muted);
	}
	.rsn {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.gained {
		font-family: var(--font-heading);
		color: var(--yellow);
		font-size: 0.9rem;
		white-space: nowrap;
	}

	.wom {
		color: var(--accent);
		text-decoration: none;
		font-size: 0.85rem;
	}
	.wom:hover {
		text-decoration: underline;
	}

	.small {
		font-size: 0.85rem;
	}
	.muted {
		color: var(--muted);
	}
</style>

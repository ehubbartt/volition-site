<script lang="ts">
	import { formatCountdown, type PlayerTask } from '$lib/tasks';
	import Skeleton from '$lib/Skeleton.svelte';
	import { swrResource } from '$lib/swrResource.svelte';
	import type { PageData } from './$types';

	let { data: pageData }: { data: PageData } = $props();

	// The task list is STREAMED (see +page.ts) so navigation lands instantly;
	// swrResource shows cached content synchronously and swaps in fresh data.
	const tasksRes = swrResource(() => pageData.tasks, [] as PlayerTask[]);
	const tasks = $derived(tasksRes.value);
	const tasksReady = $derived(tasksRes.ready);

	// Live clock so the countdowns tick (pattern from the gamba page).
	let now = $state(Date.now());
	$effect(() => {
		const id = setInterval(() => (now = Date.now()), 1000);
		return () => clearInterval(id);
	});

	const todoCount = $derived(tasks.filter((t) => t.status === 'todo').length);

	// First-time setup (Temple/Dink links) renders as its own section above the list
	// and disappears entirely once both are done (the server omits completed ones).
	const setupTasks = $derived(tasks.filter((t) => t.kind === 'setup'));
	const mainTasks = $derived(tasks.filter((t) => t.kind !== 'setup'));

	const STATUS_LABEL: Record<PlayerTask['status'], string> = {
		todo: 'To do',
		active: 'Active',
		done: 'Done'
	};

	function resetLabel(t: PlayerTask): string {
		if (t.timerLabel) return t.timerLabel; // explicit override (e.g. task events)
		if (t.status === 'done') return 'Resets in';
		if (t.kind === 'competition') return 'Ends in';
		if (t.kind === 'event') return 'Next unlock in'; // bingo row unlock, not a deadline
		return 'Time left'; // an incomplete daily/weekly task: how long you have to do it
	}

	function countdownFor(t: PlayerTask): string {
		if (!t.resetAt) return '';
		return formatCountdown(new Date(t.resetAt).getTime() - now);
	}
</script>

<svelte:head><title>To Do · Volition</title></svelte:head>

<section class="head">
	<div>
		<h1>To Do</h1>
		<p class="muted">
			{#if todoCount > 0}
				You have <strong>{todoCount}</strong>
				{todoCount === 1 ? 'thing' : 'things'} to do.
			{:else}
				You're all caught up — nice.
			{/if}
		</p>
	</div>
</section>

{#snippet taskMain(t: PlayerTask)}
	<div class="task-main">
		<div class="task-head">
			<span class="badge badge-{t.status}">{STATUS_LABEL[t.status]}</span>
			<span class="task-title">{t.title}</span>
			{#if t.reward}
				<span class="reward" title="Reward">🎁 {t.reward}</span>
			{/if}
		</div>
		{#if t.description}
			<p class="task-desc">{t.description}</p>
		{/if}
		{#if t.progress}
			<div class="bar" aria-hidden="true">
				<div
					class="bar-fill"
					style="width: {t.progress.total
						? Math.round((t.progress.done / t.progress.total) * 100)
						: 0}%"
				></div>
			</div>
		{/if}
	</div>
{/snippet}

{#snippet taskCard(t: PlayerTask)}
	<li>
		<a
			class="task panel"
			class:is-done={t.status === 'done'}
			href={t.href}
			target={t.external ? '_blank' : undefined}
			rel={t.external ? 'noopener noreferrer' : undefined}
		>
			{@render taskMain(t)}
			<div class="task-cta">
				{#if t.resetAt}
					<span class="reset">{resetLabel(t)} <strong>{countdownFor(t)}</strong></span>
				{/if}
				<span class="cta">{t.ctaLabel} →</span>
			</div>
		</a>
	</li>
{/snippet}

{#if !tasksReady}
	<ul class="task-list">
		{#each { length: 4 }, i (i)}
			<li><Skeleton height="5.5rem" radius="8px" /></li>
		{/each}
	</ul>
{:else if tasks.length === 0}
	<div class="panel empty">Nothing time-gated right now. Check back later!</div>
{:else}
	{#if setupTasks.length > 0}
		<section class="setup-block">
			<h2 class="setup-title">⚙️ Finish your setup</h2>
			<p class="muted setup-sub">
				Needed for the ranking system and auto-tracked bingo — each takes about 2 minutes.
			</p>
			<ul class="task-list">
				{#each setupTasks as t (t.id)}
					{@render taskCard(t)}
				{/each}
			</ul>
		</section>
	{/if}
	<ul class="task-list">
		{#each mainTasks as t (t.id)}
			{@render taskCard(t)}
		{/each}
	</ul>
{/if}

<style>
	.head {
		display: flex;
		justify-content: space-between;
		align-items: flex-end;
		gap: 1rem;
		margin-bottom: 1.25rem;
	}
	.head h1 {
		font-family: var(--font-heading);
		font-size: 2rem;
		margin: 0 0 0.2rem;
		text-shadow: var(--ts);
	}
	.muted {
		color: var(--muted);
		margin: 0;
	}

	.task-list {
		list-style: none;
		margin: 0;
		padding: 0;
		display: flex;
		flex-direction: column;
		gap: 0.7rem;
	}

	.panel {
		background: linear-gradient(180deg, rgba(58, 48, 36, 0.6), rgba(40, 32, 24, 0.6));
		border: 1px solid var(--border);
		border-radius: var(--radius);
		box-shadow: var(--shadow-card);
	}
	.empty {
		padding: 1.5rem;
		text-align: center;
		color: var(--muted);
	}

	/* First-time setup section: its own block above the list, gone once complete. */
	.setup-block {
		margin-bottom: 1.5rem;
		padding-bottom: 1.25rem;
		border-bottom: 1px solid var(--border);
	}
	.setup-title {
		margin: 0 0 0.15rem;
		font-size: 1.05rem;
		color: var(--accent);
	}
	.setup-sub {
		margin: 0 0 0.75rem;
		font-size: 0.85rem;
	}

	.task {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 1rem;
		padding: 0.9rem 1.1rem;
		text-decoration: none;
		color: var(--text);
		transition: border-color 0.12s ease, transform 0.12s ease;
	}
	.task:hover {
		border-color: var(--border-strong);
		transform: translateY(-1px);
	}
	.task.is-done {
		opacity: 0.7;
	}

	.task-main {
		min-width: 0;
		flex: 1;
	}
	.task-head {
		display: flex;
		align-items: center;
		gap: 0.55rem;
		flex-wrap: wrap;
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
	.task-title {
		font-family: var(--font-heading);
		font-size: 1.05rem;
		text-shadow: var(--ts);
	}
	.task-desc {
		margin: 0.3rem 0 0;
		color: var(--muted);
		font-size: 0.9rem;
	}

	.badge {
		font-size: 0.68rem;
		text-transform: uppercase;
		letter-spacing: 0.04em;
		padding: 0.12rem 0.4rem;
		border-radius: var(--radius);
		border: 1px solid transparent;
		white-space: nowrap;
	}
	.badge-todo {
		color: var(--accent);
		border-color: rgba(255, 152, 31, 0.45);
		background: var(--accent-soft);
	}
	.badge-active {
		color: var(--yellow);
		border-color: rgba(255, 255, 0, 0.35);
		background: rgba(255, 255, 0, 0.1);
	}
	.badge-done {
		color: #7fd18a;
		border-color: rgba(127, 209, 138, 0.35);
		background: rgba(127, 209, 138, 0.1);
	}

	.bar {
		margin-top: 0.5rem;
		height: 5px;
		background: var(--surface-alt);
		border-radius: 999px;
		overflow: hidden;
		max-width: 320px;
	}
	.bar-fill {
		height: 100%;
		background: var(--accent);
		border-radius: 999px;
	}

	.task-cta {
		display: flex;
		flex-direction: column;
		align-items: flex-end;
		gap: 0.3rem;
		text-align: right;
		white-space: nowrap;
	}
	.reset {
		font-size: 0.8rem;
		color: var(--muted);
	}
	.reset strong {
		color: var(--text);
	}
	.cta {
		font-family: var(--font-heading);
		color: var(--accent);
		font-size: 0.9rem;
	}

	@media (max-width: 540px) {
		.task {
			flex-direction: column;
			align-items: flex-start;
		}
		.task-cta {
			align-items: flex-start;
			text-align: left;
		}
	}
</style>

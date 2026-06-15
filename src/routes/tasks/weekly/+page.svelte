<script lang="ts">
	import WeeklyTaskCard from '$lib/tasks/WeeklyTaskCard.svelte';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();
</script>

<svelte:head><title>Weekly Tasks · Volition</title></svelte:head>

<section class="head">
	<a class="back" href="/tasks">← To Do</a>
	<h1>Weekly Tasks</h1>
</section>

{#if data.tasks.length === 0}
	<div class="panel note">There are no active tasks right now. Check back after the next reset.</div>
{:else}
	{#if !data.isClanMember}
		<p class="panel note">
			Only Volition clan members can submit tasks. If you've recently joined, ping an admin to be
			added to the clan list.
		</p>
	{/if}
	{#each data.tasks as task (task.id)}
		<WeeklyTaskCard {task} canSubmit={data.isClanMember} isAdmin={data.isAdmin} />
	{/each}
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
	.panel {
		background: linear-gradient(180deg, rgba(58, 48, 36, 0.6), rgba(40, 32, 24, 0.6));
		border: 1px solid var(--border);
		border-radius: var(--radius);
		box-shadow: var(--shadow-card);
		padding: 1.1rem 1.25rem;
		margin-bottom: 1rem;
	}
	.note {
		color: var(--muted);
	}
</style>

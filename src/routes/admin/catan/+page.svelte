<script lang="ts">
	import { enhance } from '$app/forms';

	let { data, form } = $props();
</script>

<svelte:head>
	<title>Gielinor Catan — tester</title>
</svelte:head>

<main>
	<h1>Gielinor Catan — test games</h1>
	<p class="hint">
		Single-admin tester: create a game, then act as each of the 8 teams and play the ruleset
		through by hand. See <code>docs/GIELINOR-CATAN.md</code>. Boards draw their tasks from the
		<a href="/admin/catan/tasks">task pools</a> (boss / skilling / raids / custom lists).
	</p>

	{#if form?.error}
		<p class="error">{form.error}</p>
	{/if}

	<form method="POST" action="?/create" use:enhance class="create">
		<input name="name" placeholder="Game name" maxlength="80" />
		<input name="seed" placeholder="Board seed (optional)" inputmode="numeric" />
		<button type="submit">Create test game</button>
	</form>

	{#if data.games.length === 0}
		<p class="hint">No test games yet.</p>
	{:else}
		<ul class="games">
			{#each data.games as g (g.id)}
				<li>
					<a href="/admin/catan/{g.slug}">{g.name}</a>
					<span class="meta">{g.slug} · {new Date(g.created_at).toLocaleString()}</span>
					<form
						method="POST"
						action="?/delete"
						use:enhance
						onsubmit={(e) => {
							if (!confirm(`Delete "${g.name}" and all its game state?`)) e.preventDefault();
						}}
					>
						<input type="hidden" name="event_id" value={g.id} />
						<button type="submit" class="danger">Delete</button>
					</form>
				</li>
			{/each}
		</ul>
	{/if}
</main>

<style>
	main {
		max-width: 720px;
		margin: 0 auto;
		padding: 1.5rem 1rem 3rem;
	}
	h1 {
		font-family: var(--font-heading);
		text-shadow: var(--ts-strong);
	}
	.hint {
		color: var(--muted);
	}
	.error {
		color: var(--danger);
		background: var(--danger-bg);
		border: 1px solid var(--danger);
		border-radius: var(--radius);
		padding: 0.5rem 0.75rem;
	}
	.create {
		display: flex;
		gap: 0.5rem;
		flex-wrap: wrap;
		margin: 1rem 0 1.5rem;
	}
	input {
		background: var(--surface-alt);
		border: 1px solid var(--border);
		border-radius: var(--radius);
		color: var(--text);
		padding: 0.45rem 0.6rem;
	}
	button {
		background: var(--surface);
		border: 1px solid var(--border-strong);
		border-radius: var(--radius);
		color: var(--text);
		padding: 0.45rem 0.8rem;
		cursor: pointer;
	}
	button:hover {
		border-color: var(--accent);
	}
	button.danger:hover {
		border-color: var(--danger);
		color: var(--danger);
	}
	.games {
		list-style: none;
		padding: 0;
		display: grid;
		gap: 0.5rem;
	}
	.games li {
		display: flex;
		align-items: center;
		gap: 0.75rem;
		background: var(--surface-alt);
		border: 1px solid var(--border);
		border-radius: var(--radius-lg);
		padding: 0.6rem 0.9rem;
	}
	.games a {
		color: var(--accent);
		font-family: var(--font-heading);
	}
	.games .meta {
		color: var(--muted);
		font-size: 0.85rem;
		margin-right: auto;
	}
</style>

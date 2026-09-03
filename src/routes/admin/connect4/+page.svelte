<script lang="ts">
	import { enhance } from '$app/forms';
	let { data, form } = $props();
</script>

<svelte:head><title>Connect Four — admin</title></svelte:head>

<div class="page">
	<h1>Connect Four</h1>
	<p class="lead">
		A shared board (classically 25×10). Both clans chase the same objectives — one per
		column; the first team to get one claims it and a piece falls into place. Connect four
		(or more) to score.
	</p>

	{#if form?.error}<p class="err">{form.error}</p>{/if}

	<section class="osrs-panel">
		<div class="osrs-titlebar">Games</div>
		{#if !data.games.length}
			<p class="muted pad">No games yet.</p>
		{:else}
			<div class="table-wrap">
			<table class="osrs-table">
				<thead>
					<tr><th>Name</th><th>Phase</th><th>Pieces</th><th></th></tr>
				</thead>
				<tbody>
					{#each data.games as g (g.id)}
						<tr>
							<td>
								<a href="/admin/connect4/{g.slug}">{g.name}</a>
								{#if g.test}<span class="osrs-badge">test</span>{/if}
							</td>
							<td>{g.phase}</td>
							<td>{g.pieces} / {g.deckSize}</td>
							<td class="right">
								{#if g.test}
									<form method="POST" action="?/remove" use:enhance>
										<input type="hidden" name="id" value={g.id} />
										<button class="danger" type="submit">Delete</button>
									</form>
								{/if}
							</td>
						</tr>
					{/each}
				</tbody>
			</table>
			</div>
		{/if}
	</section>

	<section class="osrs-panel">
		<div class="osrs-titlebar">New game</div>
		<form method="POST" action="?/create" use:enhance class="pad grid">
			<label>Name <input name="name" required placeholder="Clan vs clan — Connect Four" /></label>
			<label>Slug <input name="slug" placeholder="auto from the name" /></label>
			<label class="wide">Description <input name="description" /></label>

			<label>Side 1 name <input name="side1" value="Red" /></label>
			<label>Side 2 name <input name="side2" value="Yellow" /></label>

			<p class="wide sub">
				Board size — fixed once created. The pool needs one tile per cell, so a bigger
				board needs more candidates (add custom tasks if the generated list runs short).
			</p>
			<label>Columns (5–40) <input name="cols" type="number" min="5" max="40" value="25" /></label>
			<label>Rows (4–15) <input name="rows" type="number" min="4" max="15" value="10" /></label>

			<details class="wide fold">
				<summary>Scoring — the defaults are fine, and every dial is retunable later (even mid-game)</summary>
				<div class="grid">
					<p class="wide sub">
						Applied to the whole board whenever changed. Set <em>points per tile</em> to 0 to
						score connect-fours only.
					</p>
					<label>Points per tile <input name="tile_points" type="number" value={data.defaults.tile_points} /></label>
					<label>Connect 4 <input name="line_4" type="number" value={data.defaults.line_points[0].points} /></label>
					<label>Run of 5 <input name="line_5" type="number" value={data.defaults.line_points[1].points} /></label>
					<label>Run of 6 <input name="line_6" type="number" value={data.defaults.line_points[2].points} /></label>
					<label>Run of 7 <input name="line_7" type="number" value={data.defaults.line_points[3].points} /></label>
					<label>Each cell past 7 <input name="extra_per_cell" type="number" value={data.defaults.extra_per_cell} /></label>
				</div>
			</details>

			<label class="check wide">
				<input type="checkbox" name="test" checked /> Test game — deletable, and it refuses real Dink drops
			</label>
			<div class="wide"><button type="submit">Create</button></div>
		</form>
	</section>
</div>

<style>
	.page {
		max-width: 60rem;
		margin: 0 auto;
		padding: 1rem;
		display: grid;
		gap: 1rem;
	}
	.lead {
		color: var(--muted);
		margin: 0;
	}
	.pad {
		padding: 0.75rem;
	}
	.table-wrap {
		overflow-x: auto;
	}
	.grid {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(12rem, 1fr));
		gap: 0.6rem;
	}
	.grid .wide {
		grid-column: 1 / -1;
	}
	label {
		display: grid;
		gap: 0.2rem;
		font-size: 0.85rem;
		color: var(--muted);
	}
	label.check {
		display: flex;
		align-items: center;
		gap: 0.4rem;
	}
	.sub {
		margin: 0.4rem 0 0;
		color: var(--muted);
		font-size: 0.85rem;
	}
	.fold {
		border: 1px solid var(--border);
		border-radius: var(--radius);
		padding: 0.4rem 0.6rem;
		background: var(--surface-alt);
	}
	.fold > summary {
		cursor: pointer;
		font-size: 0.85rem;
		color: var(--muted);
	}
	.fold[open] > summary {
		color: var(--heading);
		margin-bottom: 0.4rem;
	}
	.right {
		text-align: right;
	}
	.err {
		color: var(--danger);
		background: var(--danger-bg);
		padding: 0.5rem;
		border-radius: var(--radius);
	}
	.muted {
		color: var(--muted);
	}
	.danger {
		color: var(--danger);
	}
</style>

<script lang="ts">
	import type { PageData, ActionData } from './$types';
	import { enhance } from '$app/forms';

	let { data, form }: { data: PageData; form: ActionData } = $props();

	let showCreate = $state(false);

	const gp = (n: number) => (n >= 1_000_000 ? `${n / 1_000_000}m` : n.toLocaleString());

	const PHASE_LABEL: Record<string, string> = {
		setup: 'Setup',
		signup: 'Signups open',
		draft: 'Drafting',
		placement: 'Placing fleets',
		battle: 'Battle',
		finished: 'Finished'
	};
</script>

<svelte:head><title>Battleship — Admin</title></svelte:head>

<div class="page">
	<header>
		<div>
			<h1>Battleship</h1>
			<p class="sub">
				Two captains draft the signup pool, each side hides a fleet, and drops become bombs.
				See <code>docs/BATTLESHIP.md</code> for the ruleset.
			</p>
		</div>
		<button class="btn" onclick={() => (showCreate = !showCreate)}>
			{showCreate ? 'Cancel' : 'New game'}
		</button>
	</header>

	{#if form?.error}<p class="err">{form.error}</p>{/if}

	{#if showCreate}
		<form method="POST" action="?/create" use:enhance class="card create">
			<h2>New game</h2>
			<label>Name<input name="name" required placeholder="Summer Battleship" /></label>
			<label>Slug <span class="hint">(optional — derived from the name)</span><input name="slug" placeholder="summer-battleship" /></label>
			<label>Description<textarea name="description" rows="2"></textarea></label>

			<div class="row">
				<label>Signups open<input type="datetime-local" name="signup_opens_at" /></label>
				<label>Signups close<input type="datetime-local" name="signup_closes_at" /></label>
			</div>

			<fieldset>
				<legend>Bomb tiers — the single-drop gp value that earns each size</legend>
				<div class="row">
					{#each data.defaultTiers as t (t.tier)}
						<label>
							{t.name} <span class="hint">({t.span}×{t.span})</span>
							<input name="tier_{t.tier - 1}" value={t.min_value} inputmode="numeric" />
						</label>
					{/each}
				</div>
				<p class="hint">
					Defaults are {data.defaultTiers.map((t) => gp(t.min_value)).join(' / ')}. Keep the
					lowest above 3m so members who run Dink with several Discord servers don't have to
					change their config.
				</p>
			</fieldset>

			<div class="row">
				<label>
					Board size <span class="hint">(blank = scale with the draft)</span>
					<input name="size" inputmode="numeric" placeholder="auto" />
				</label>
				<label>
					Placement window (minutes)
					<input name="placement_minutes" inputmode="numeric" placeholder="60" />
				</label>
			</div>

			<div class="checks">
				<label class="check"><input type="checkbox" name="test" /> Test game <span class="hint">(deletable here; hidden from /events)</span></label>
				<label class="check"><input type="checkbox" name="unlisted" /> Unlisted</label>
			</div>

			<button class="btn primary" type="submit">Create</button>
		</form>
	{/if}

	{#if data.games.length === 0}
		<p class="empty">No Battleship games yet.</p>
	{:else}
		<ul class="games">
			{#each data.games as g (g.id)}
				<li class="card">
					<div class="meta">
						<a class="name" href="/admin/battleship/{g.slug}">{g.name}</a>
						<div class="tags">
							<span class="pill">{PHASE_LABEL[g.phase] ?? g.phase}</span>
							<span class="pill quiet">{g.status}</span>
							{#if g.test}<span class="pill test">test</span>{/if}
							{#if g.unlisted}<span class="pill quiet">unlisted</span>{/if}
							{#if g.winner}<span class="pill win">side {g.winner} won</span>{/if}
						</div>
					</div>
					<div class="actions">
						<a class="btn" href="/events/{g.slug}/battleship">Player view</a>
						<a class="btn" href="/admin/battleship/{g.slug}">Run it</a>
						{#if g.test}
							<form method="POST" action="?/remove" use:enhance>
								<input type="hidden" name="id" value={g.id} />
								<button class="btn danger" type="submit">Delete</button>
							</form>
						{/if}
					</div>
				</li>
			{/each}
		</ul>
	{/if}
</div>

<style>
	.page { max-width: 60rem; margin: 0 auto; padding: 1rem; }
	header { display: flex; align-items: flex-start; justify-content: space-between; gap: 1rem; flex-wrap: wrap; }
	h1 { font-family: var(--font-heading); color: var(--heading); text-shadow: var(--ts-strong); margin: 0; }
	.sub { color: var(--muted); margin: 0.25rem 0 1rem; max-width: 46rem; }
	.card {
		background: var(--surface); border: 1px solid var(--border);
		border-radius: var(--radius-lg); padding: 0.85rem; box-shadow: var(--shadow-card);
	}
	.create { display: grid; gap: 0.65rem; margin-bottom: 1rem; }
	.create h2 { margin: 0; font-family: var(--font-heading); color: var(--heading); font-size: 1.1rem; }
	label { display: grid; gap: 0.25rem; font-size: 0.9rem; }
	input, textarea {
		background: var(--surface-alt); color: var(--text);
		border: 1px solid var(--border); border-radius: var(--radius); padding: 0.4rem 0.5rem;
		font-family: var(--font-body); font-size: 0.9rem;
	}
	.row { display: flex; gap: 0.65rem; flex-wrap: wrap; }
	.row > label { flex: 1 1 10rem; }
	fieldset { border: 1px solid var(--border); border-radius: var(--radius); padding: 0.6rem; }
	legend { font-size: 0.85rem; color: var(--muted); padding: 0 0.35rem; }
	.hint { color: var(--muted); font-size: 0.8rem; font-weight: normal; }
	.checks { display: flex; gap: 1rem; flex-wrap: wrap; }
	.check { display: flex; align-items: center; gap: 0.4rem; }
	.check input { width: auto; }
	.games { list-style: none; padding: 0; margin: 0; display: grid; gap: 0.6rem; }
	.games li { display: flex; align-items: center; justify-content: space-between; gap: 1rem; flex-wrap: wrap; }
	.name { font-family: var(--font-heading); color: var(--accent); text-decoration: none; font-size: 1.05rem; }
	.name:hover { text-decoration: underline; }
	.tags { display: flex; gap: 0.35rem; margin-top: 0.3rem; flex-wrap: wrap; }
	.pill {
		font-size: 0.72rem; padding: 0.1rem 0.4rem; border-radius: 999px;
		border: 1px solid var(--border-strong); background: var(--surface-alt); color: var(--text);
	}
	.pill.quiet { color: var(--muted); }
	.pill.test { border-color: var(--accent); color: var(--accent); }
	.pill.win { border-color: var(--success); color: var(--success); }
	.actions { display: flex; gap: 0.4rem; align-items: center; flex-wrap: wrap; }
	.btn {
		background: var(--surface-alt); color: var(--text); border: 1px solid var(--border-strong);
		border-radius: var(--radius); padding: 0.35rem 0.7rem; cursor: pointer;
		font-family: var(--font-body); font-size: 0.85rem; text-decoration: none; display: inline-block;
	}
	.btn:hover { border-color: var(--accent); }
	.btn.primary { background: var(--accent-soft); border-color: var(--accent); color: var(--accent); }
	.btn.danger { color: var(--danger); border-color: var(--danger); }
	.err { color: var(--danger); background: var(--danger-bg); border: 1px solid var(--danger); padding: 0.5rem; border-radius: var(--radius); }
	.empty { color: var(--muted); }
	code { background: var(--surface-alt); padding: 0.05rem 0.3rem; border-radius: 3px; }
</style>

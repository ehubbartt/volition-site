<script lang="ts">
	import type { PageData, ActionData } from './$types';
	import { enhance } from '$app/forms';
	import BoardGrid from '$lib/battleship/BoardGrid.svelte';
	import { cellLabel } from '$lib/battleship/rules';

	let { data, form }: { data: PageData; form: ActionData } = $props();

	const game = $derived(data.game);
	const sides = $derived(game.sides);
	// Which side the tester is currently acting as. One admin plays both.
	let actingSide = $state(1);
	let targetAnchor = $state<{ x: number; y: number } | null>(null);
	let selectedBomb = $state<string | null>(null);

	const acting = $derived(sides.find((s) => s.side === actingSide));
	const enemy = $derived(sides.find((s) => s.side !== actingSide));

	const myBombs = $derived(game.arsenal.filter((a) => a.side === actingSide && !a.spentAt));
	const selected = $derived(myBombs.find((b) => b.id === selectedBomb) ?? myBombs[0]);
	const selectedTier = $derived(game.config.tiers.find((t) => t.tier === selected?.tier));

	const shotsAt = (side: number) => game.shots.filter((s) => s.targetSide === side);
	const sunkIds = (side: number) => {
		const hit = new Set(shotsAt(side).map((s) => s.cell));
		const f = sides.find((s) => s.side === side)?.fleet ?? [];
		return f.filter((sh) => sh.cells.length > 0 && sh.cells.every((c) => hit.has(c))).map((sh) => sh.id);
	};

	const gp = (n: number) => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}m` : n.toLocaleString());
	const standing = (side: number) => game.standings.find((s) => s.side === side);

	const PHASE_LABEL: Record<string, string> = {
		setup: 'Setup', signup: 'Signups open', draft: 'Drafting',
		placement: 'Placing fleets', battle: 'Battle', finished: 'Finished'
	};

	// Reset the aim when the acting side flips, so a stale anchor can't be fired.
	$effect(() => {
		void actingSide;
		targetAnchor = null;
		selectedBomb = null;
	});
</script>

<svelte:head><title>{game.event.name} — Battleship tester</title></svelte:head>

<div class="page">
	<header>
		<div>
			<a class="back" href="/admin/battleship">← All games</a>
			<h1>{game.event.name}</h1>
			<div class="tags">
				<span class="pill accent">{PHASE_LABEL[game.phase] ?? game.phase}</span>
				<span class="pill">{game.config.size}×{game.config.size}</span>
				{#if game.test}<span class="pill test">test</span>{/if}
				{#if game.winner}<span class="pill win">Side {game.winner} won</span>{/if}
			</div>
		</div>
		<a class="btn" href="/events/{game.event.slug}/battleship">Player view →</a>
	</header>

	{#if form && 'error' in form && form.error}<p class="err">{form.error}</p>{/if}
	{#if form && 'report' in form && form.report}<p class="ok">{form.report}</p>{/if}

	<!-- ── Phase driver ────────────────────────────────────────────────── -->
	<section class="osrs-panel">
		<h2>Run the game</h2>

		{#if game.phase === 'signup'}
			<p class="muted">{game.pool.length} signed up. Seed the pool, then pick two captains.</p>
			<form method="POST" action="?/seed" use:enhance class="inline">
				<label>Sign up<input name="count" value="32" size="4" inputmode="numeric" /></label>
				<button class="btn" type="submit">roster members</button>
			</form>

			{#if game.pool.length >= 2}
				<form method="POST" action="?/startDraft" use:enhance class="grid2">
					<label>Side 1 name<input name="name1" value="Fleet Red" /></label>
					<label>Side 2 name<input name="name2" value="Fleet Blue" /></label>
					<label>
						Captain 1
						<select name="captain1" required>
							{#each game.pool as p (p.userId)}<option value={p.userId}>{p.rsn ?? p.userId}</option>{/each}
						</select>
					</label>
					<label>
						Captain 2
						<select name="captain2" required>
							{#each game.pool as p, i (p.userId)}<option value={p.userId} selected={i === 1}>{p.rsn ?? p.userId}</option>{/each}
						</select>
					</label>
					<button class="btn primary" type="submit">Start the draft</button>
				</form>
			{/if}

		{:else if game.phase === 'draft'}
			<p class="muted">
				<strong>Side {game.draft.turn}</strong> picks next · {game.pool.length} left in the pool
			</p>
			<div class="draftgrid">
				{#each game.pool.slice(0, 40) as p (p.userId)}
					<form method="POST" action="?/pick" use:enhance>
						<input type="hidden" name="side" value={game.draft.turn} />
						<input type="hidden" name="user_id" value={p.userId} />
						<button class="btn small" type="submit">{p.rsn ?? 'unknown'}</button>
					</form>
				{/each}
			</div>
			{#if game.pool.length > 40}<p class="muted">…and {game.pool.length - 40} more.</p>{/if}
			<form method="POST" action="?/autoDraft" use:enhance>
				<button class="btn" type="submit">Auto-draft the rest</button>
			</form>

		{:else if game.phase === 'placement'}
			<p class="muted">
				Placement closes {game.placementEndsAt ? new Date(game.placementEndsAt).toLocaleString() : 'when you start the battle'}.
				A side that never places gets an auto-placed fleet.
			</p>
			<div class="inline">
				{#each sides as s (s.side)}
					<form method="POST" action="?/autoPlace" use:enhance>
						<input type="hidden" name="side" value={s.side} />
						<button class="btn" type="submit">
							Auto-place {s.name}{s.placedAt ? ' (again)' : ''}
						</button>
					</form>
				{/each}
				<form method="POST" action="?/startBattle" use:enhance>
					<button class="btn primary" type="submit">Open the battle</button>
				</form>
			</div>

		{:else if game.phase === 'battle'}
			<p class="muted">Grant a bomb to either side, then aim it on the enemy board below.</p>
			<div class="inline">
				{#each sides as s (s.side)}
					{#each game.config.tiers as t (t.tier)}
						<form method="POST" action="?/grant" use:enhance>
							<input type="hidden" name="side" value={s.side} />
							<input type="hidden" name="tier" value={t.tier} />
							<button class="btn small" type="submit">+{t.name} → {s.name}</button>
						</form>
					{/each}
				{/each}
			</div>

		{:else if game.phase === 'finished'}
			<p class="ok">Side {game.winner} destroyed the other fleet.</p>
		{:else}
			<form method="POST" action="?/openPlacement" use:enhance>
				<button class="btn" type="submit">Open placement</button>
			</form>
		{/if}
	</section>

	<!-- ── Boards ──────────────────────────────────────────────────────── -->
	{#if sides.length === 2}
		<section class="osrs-panel">
			<div class="actbar">
				<span class="muted">Acting as</span>
				{#each sides as s (s.side)}
					<button
						class="btn small"
						class:active={actingSide === s.side}
						onclick={() => (actingSide = s.side)}
					>{s.name}</button>
				{/each}
			</div>

			<div class="boards">
				<div class="board">
					<h3>{acting?.name} — own water</h3>
					<BoardGrid
						size={game.config.size}
						fleet={acting?.fleet ?? []}
						shots={shotsAt(actingSide)}
						sunkShipIds={sunkIds(actingSide)}
					/>
					<p class="stat">
						{standing(actingSide)?.afloat ?? 0}/{standing(actingSide)?.totalCells ?? 0} afloat ·
						{standing(actingSide)?.lost ?? 0} ship{(standing(actingSide)?.lost ?? 0) === 1 ? '' : 's'} lost
					</p>
				</div>

				<div class="board">
					<h3>{enemy?.name} — target</h3>
					<BoardGrid
						size={game.config.size}
						fleet={enemy?.fleet ?? []}
						shots={shotsAt(enemy?.side ?? 0)}
						sunkShipIds={sunkIds(enemy?.side ?? 0)}
						mode={game.phase === 'battle' && selected ? 'target' : 'view'}
						span={selectedTier?.span ?? 1}
						target={targetAnchor}
						onpick={(x, y) => (targetAnchor = { x, y })}
					/>
					<p class="stat">
						{standing(actingSide)?.hits ?? 0} hits / {standing(actingSide)?.shotsFired ?? 0} shots ·
						{standing(actingSide)?.sunk ?? 0} sunk
					</p>
					<p class="note">The tester sees both fleets — a player never does.</p>
				</div>
			</div>

			{#if game.phase === 'battle'}
				<div class="fire">
					<h3>Arsenal — {myBombs.length} banked</h3>
					{#if myBombs.length === 0}
						<p class="muted">No bombs. Grant one above, or let a Dink drop arm one.</p>
					{:else}
						<div class="bombs">
							{#each myBombs as b (b.id)}
								{@const t = game.config.tiers.find((x) => x.tier === b.tier)}
								<button
									class="bomb"
									class:active={selected?.id === b.id}
									onclick={() => (selectedBomb = b.id)}
								>
									<strong>{t?.name ?? `Tier ${b.tier}`}</strong>
									<span>{t?.span}×{t?.span}</span>
									<span class="muted">{b.itemName ?? 'drop'}{b.value ? ` · ${gp(b.value)}` : ''}</span>
								</button>
							{/each}
						</div>

						<form method="POST" action="?/fire" use:enhance class="inline">
							<input type="hidden" name="arsenal_id" value={selected?.id ?? ''} />
							<input type="hidden" name="x" value={targetAnchor?.x ?? ''} />
							<input type="hidden" name="y" value={targetAnchor?.y ?? ''} />
							<span class="muted">
								{#if targetAnchor}
									{selectedTier?.name} · {selectedTier?.span}×{selectedTier?.span} · {cellLabel(`${targetAnchor.x},${targetAnchor.y}`)}
								{:else}
									Click the target board to aim.
								{/if}
							</span>
							<button class="btn primary" type="submit" disabled={!targetAnchor || !selected}>
								{targetAnchor ? `Fire at ${cellLabel(`${targetAnchor.x},${targetAnchor.y}`)}` : 'Fire'}
							</button>
						</form>
					{/if}
				</div>
			{/if}
		</section>

		<!-- ── Rosters ─────────────────────────────────────────────────── -->
		<section class="osrs-panel">
			<h2>Sides</h2>
			<div class="rosters">
				{#each sides as s (s.side)}
					<div>
						<h3 style="color: {s.color}">{s.name} <span class="muted">({s.members.length})</span></h3>
						<p class="muted small">
							Captain: {s.members.find((m) => m.userId === s.captainUserId)?.rsn ?? '—'}
						</p>
						<ul class="roster">
							{#each s.members as m (m.userId)}<li>{m.rsn ?? m.userId}</li>{/each}
						</ul>
					</div>
				{/each}
			</div>
		</section>
	{/if}
</div>

<style>
	.page { max-width: 72rem; margin: 0 auto; padding: 1rem; display: grid; gap: 1rem; }
	header { display: flex; align-items: flex-start; justify-content: space-between; gap: 1rem; flex-wrap: wrap; }
	h1 { font-family: var(--font-heading); color: var(--heading); text-shadow: var(--ts-strong); margin: 0.25rem 0; }
	h2 { font-family: var(--font-heading); color: var(--heading); font-size: 1.05rem; margin: 0 0 0.5rem; }
	h3 { font-family: var(--font-heading); font-size: 0.95rem; margin: 0 0 0.4rem; }
	.back { color: var(--muted); text-decoration: none; font-size: 0.85rem; }
	.back:hover { color: var(--accent); }
	.tags { display: flex; gap: 0.35rem; flex-wrap: wrap; }
	.pill { font-size: 0.72rem; padding: 0.1rem 0.4rem; border-radius: 999px; border: 1px solid var(--border-strong); background: var(--surface-alt); }
	.pill.accent { border-color: var(--accent); color: var(--accent); }
	.pill.test { border-color: var(--yellow); color: var(--yellow); }
	.pill.win { border-color: var(--success); color: var(--success); }
	.muted { color: var(--muted); }
	.small { font-size: 0.8rem; }
	.inline { display: flex; gap: 0.5rem; align-items: center; flex-wrap: wrap; }
	.grid2 { display: grid; grid-template-columns: repeat(auto-fit, minmax(12rem, 1fr)); gap: 0.6rem; margin-top: 0.6rem; }
	label { display: grid; gap: 0.2rem; font-size: 0.85rem; }
	input, select {
		background: var(--surface-alt); color: var(--text); border: 1px solid var(--border);
		border-radius: var(--radius); padding: 0.35rem 0.45rem; font-family: var(--font-body); font-size: 0.85rem;
	}
	/* Modifier only — app.css already gives every <button> the bronze OSRS frame,
	   and overriding it here is what made these read as unstyled. */
	.btn { text-decoration: none; display: inline-flex; align-items: center; }
	.btn:disabled { opacity: 0.45; cursor: not-allowed; }
	.btn.small { min-height: 30px; padding: 1px 10px; font-size: 0.8rem; }
	.btn.primary, .btn.active { color: var(--yellow); }
	.draftgrid { display: flex; flex-wrap: wrap; gap: 0.3rem; margin: 0.5rem 0; }
	.actbar { display: flex; align-items: center; gap: 0.5rem; margin-bottom: 0.75rem; flex-wrap: wrap; }
	.boards { display: grid; grid-template-columns: repeat(auto-fit, minmax(19rem, 1fr)); gap: 1.25rem; }
	.stat { font-size: 0.8rem; color: var(--muted); margin: 0.5rem 0 0; }
	.note { font-size: 0.75rem; color: var(--muted-soft); margin: 0.2rem 0 0; }
	.fire { margin-top: 1rem; border-top: 1px solid var(--border); padding-top: 0.75rem; }
	.bombs { display: flex; gap: 0.4rem; flex-wrap: wrap; margin-bottom: 0.6rem; max-height: 12rem; overflow-y: auto; }
	.bomb {
		display: grid; gap: 0.1rem; text-align: left; cursor: pointer;
		background: var(--surface-alt); color: var(--text); border: 1px solid var(--border-strong);
		border-radius: var(--radius); padding: 0.3rem 0.5rem; font-family: var(--font-body); font-size: 0.78rem;
	}
	.bomb.active { border-color: var(--accent); background: var(--accent-soft); }
	.rosters { display: grid; grid-template-columns: repeat(auto-fit, minmax(14rem, 1fr)); gap: 1rem; }
	.roster { list-style: none; padding: 0; margin: 0; font-size: 0.82rem; color: var(--text); columns: 2; }
	.err { color: var(--danger); background: var(--danger-bg); border: 1px solid var(--danger); padding: 0.5rem; border-radius: var(--radius); margin: 0; }
	.ok { color: var(--success); background: var(--success-bg); border: 1px solid var(--success); padding: 0.5rem; border-radius: var(--radius); margin: 0; }
</style>

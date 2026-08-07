<script lang="ts">
	import type { PageData, ActionData } from './$types';
	import { enhance } from '$app/forms';
	import BoardGrid from '$lib/battleship/BoardGrid.svelte';
	import { anchorFor, cellLabel } from '$lib/battleship/rules';

	let { data, form }: { data: PageData; form: ActionData } = $props();

	const game = $derived(data.game);
	const sides = $derived(game.sides);
	// Which side the tester is currently acting as. One admin plays both.
	let actingSide = $state(1);
	// The square the tester CLICKED; the stored top-left is derived from it below.
	let targetAnchor = $state<{ x: number; y: number } | null>(null);
	let selectedBomb = $state<string | null>(null);

	const acting = $derived(sides.find((s) => s.side === actingSide));
	const enemy = $derived(sides.find((s) => s.side !== actingSide));

	const myBombs = $derived(game.arsenal.filter((a) => a.side === actingSide && !a.spentAt));
	const selected = $derived(myBombs.find((b) => b.id === selectedBomb) ?? myBombs[0]);
	const selectedTier = $derived(game.config.tiers.find((t) => t.tier === selected?.tier));
	// The top-left the server stores, derived from the clicked square through the same
	// rule the board draws with, so a 3x3 wraps around the aim exactly as it does on the
	// player page.
	const shotAnchor = $derived(
		targetAnchor ? anchorFor(targetAnchor, selectedTier?.span ?? 1, game.config.size) : null
	);

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

	// ── Draft ────────────────────────────────────────────────────────────
	// Typing filters the pool. The board used to render the first 40 names and stop,
	// which at 80 signups meant half the pool was unpickable until it shrank — a captain
	// could call a name that simply wasn't on screen. Every name is rendered now, and
	// this is how you find one without scanning a wall of buttons.
	// The side whose pick it is, and that side's captain by name — the banner says both,
	// because "Side 1" is not what anyone calls their team out loud.
	const turnSide = $derived(sides.find((s) => s.side === game.draft.turn));
	const turnCaptain = $derived(
		turnSide?.members.find((m) => m.userId === turnSide.captainUserId)?.rsn ?? null
	);

	let poolFilter = $state('');
	const shownPool = $derived(
		poolFilter.trim()
			? game.pool.filter((p) => (p.rsn ?? '').toLowerCase().includes(poolFilter.trim().toLowerCase()))
			: game.pool
	);

	// The last pick, held open until dismissed. The draft is run from one screen with
	// both captains watching a stream, so each pick gets announced rather than silently
	// moving a name from one list to another.
	let lastPick = $state<
		{ rsn: string | null; sideName: string; sideColor: string; pickNumber: number; poolLeft: number } | null
	>(null);
	$effect(() => {
		const p = form && 'pick' in form ? form.pick : null;
		if (p) lastPick = p;
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
			<!-- Whose pick this is, in the fleet's own colour and its own name — not "Side 1".
			     Everyone clicking these buttons is doing it on behalf of a captain who is
			     watching over a stream, and picking for the wrong fleet cannot be undone
			     from this page. -->
			<div class="turnbanner" style="--side: {turnSide?.color ?? 'var(--accent)'}">
				<span class="turnlabel">Now picking for</span>
				<span class="turnname">{turnSide?.name ?? `Side ${game.draft.turn}`}</span>
				<span class="turnmeta">
					{#if turnCaptain}captain {turnCaptain} · {/if}pick #{game.draft.picks.length + 1} ·
					{game.pool.length} left in the pool
				</span>
			</div>

			<label class="poolfilter">
				Find a member
				<input bind:value={poolFilter} placeholder="type part of an RSN" autocomplete="off" />
			</label>
			<!-- The buttons carry the same colour, so the thing you click looks like the
			     fleet it feeds even if the banner has scrolled off. -->
			<div class="draftgrid" style="--side: {turnSide?.color ?? 'var(--accent)'}">
				{#each shownPool as p (p.userId)}
					<form method="POST" action="?/pick" use:enhance>
						<input type="hidden" name="side" value={game.draft.turn} />
						<input type="hidden" name="user_id" value={p.userId} />
						<button class="btn small pickbtn" type="submit">
							{p.rsn ?? 'unknown'}
						</button>
					</form>
				{/each}
			</div>
			{#if poolFilter.trim() && shownPool.length === 0}
				<p class="muted">Nobody in the pool matches "{poolFilter}".</p>
			{/if}
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
							<input type="hidden" name="x" value={shotAnchor?.x ?? ''} />
							<input type="hidden" name="y" value={shotAnchor?.y ?? ''} />
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

		<!-- ── Arsenal ─────────────────────────────────────────────────── -->
		<!-- EVERY bomb on both sides, spent and unspent. The firing panel above only ever
		     shows the acting side's unspent ones, so until now a bomb that should not exist
		     could only be removed with SQL. Removing one takes its craters with it. -->
		{#if game.arsenal.length}
			<section class="osrs-panel">
				<h2>All bombs <span class="muted">({game.arsenal.length})</span></h2>
				<p class="muted small">
					Remove a bomb that shouldn't have been minted — a mis-approved claim, a drop
					credited to the wrong person, a duplicate. If it was already fired its craters go
					with it, and its source is closed so it can't be minted again. There is no undo.
				</p>
				<ul class="arsenal">
					{#each game.arsenal as a (a.id)}
						{@const side = sides.find((s) => s.side === a.side)}
						<li class:spent={!!a.spentAt}>
							<span class="afleet" style="color: {side?.color}">{side?.name ?? `Side ${a.side}`}</span>
							<span class="atier">{game.config.tiers.find((t) => t.tier === a.tier)?.name ?? `Tier ${a.tier}`}</span>
							<span class="aitem">{a.itemName ?? '—'}</span>
							<span class="awho muted">
								{side?.members.find((m) => m.userId === a.earnedBy)?.rsn ?? 'unattributed'}
							</span>
							<span class="aval muted">{a.value ? gp(a.value) : ''}</span>
							<span class="asrc muted">{a.source ?? ''}</span>
							<span class="astate">{a.spentAt ? 'fired' : 'banked'}</span>
							<form method="POST" action="?/removeBomb" use:enhance>
								<input type="hidden" name="arsenal_id" value={a.id} />
								<button class="btn tiny danger" type="submit">remove</button>
							</form>
						</li>
					{/each}
				</ul>
			</section>
		{/if}

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

<!-- The pick announcement. A button rather than a div so it's dismissable by keyboard
     and needs no ARIA of its own — the whole overlay is the dismiss control. -->
{#if lastPick}
	<button type="button" class="pickoverlay" onclick={() => (lastPick = null)}>
		<span class="pickcard">
			<span class="picknum">Pick #{lastPick.pickNumber}</span>
			<span class="pickwho">{lastPick.rsn ?? 'unknown'}</span>
			<span class="pickto">drafted to <b style="color: {lastPick.sideColor}">{lastPick.sideName}</b></span>
			<span class="pickleft">
				{lastPick.poolLeft}
				{lastPick.poolLeft === 1 ? 'member' : 'members'} left in the pool
			</span>
			<span class="pickdismiss">click anywhere to dismiss</span>
		</span>
	</button>
{/if}

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
	/* Whose pick it is. Loud on purpose — this is streamed, and there is no undo. */
	.turnbanner {
		display: grid; gap: 0.1rem; justify-items: start;
		margin: 0.25rem 0 0.9rem; padding: 0.6rem 1rem;
		border-left: 5px solid var(--side);
		border-radius: 4px;
		background: color-mix(in srgb, var(--side) 14%, transparent);
	}
	.turnlabel { font-size: 0.72rem; letter-spacing: 0.09em; text-transform: uppercase; color: var(--muted); }
	.turnname { font-family: var(--font-heading); font-size: 1.6rem; line-height: 1.15; color: var(--side); }
	.turnmeta { font-size: 0.8rem; color: var(--muted); }

	/* The pick buttons wear the same colour as the banner. */
	.pickbtn { border-color: var(--side); box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--side) 45%, transparent); }

	.arsenal { list-style: none; padding: 0; margin: 0.6rem 0 0; display: grid; gap: 0.25rem; }
	.arsenal li {
		display: grid;
		grid-template-columns: 7rem 6.5rem minmax(6rem, 1fr) 8rem 5rem minmax(0, 8rem) 4rem auto;
		gap: 0.5rem; align-items: center;
		padding: 0.3rem 0.5rem; border-radius: 3px;
		background: rgb(255 255 255 / 0.03);
		font-size: 0.8rem;
	}
	.arsenal li.spent { opacity: 0.55; }
	.arsenal .afleet, .arsenal .atier, .arsenal .astate { font-family: var(--font-heading); }
	.arsenal .astate { font-size: 0.7rem; text-transform: uppercase; letter-spacing: 0.06em; }
	.arsenal span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
	.btn.tiny { min-height: 26px; padding: 0 8px; font-size: 0.72rem; }
	.btn.danger { color: #ef8a8a; }
	@media (max-width: 900px) {
		.arsenal li { grid-template-columns: 1fr auto; grid-auto-rows: min-content; }
		.arsenal .aval, .arsenal .asrc, .arsenal .awho { display: none; }
	}

	.poolfilter { display: grid; gap: 0.2rem; font-size: 0.8rem; color: var(--muted); max-width: 18rem; }
	.poolfilter input {
		background: var(--inset, #241f1a); color: var(--text); border: 1px solid var(--line, #4a4038);
		border-radius: 3px; padding: 0.35rem 0.5rem; font-family: var(--font-body); font-size: 0.9rem;
	}

	/* The pick announcement. Sized for a stream: readable to someone watching a shared
	   screen from across a Discord call, not just to the admin driving it. */
	.pickoverlay {
		position: fixed; inset: 0; z-index: 60;
		display: grid; place-items: center;
		background: rgb(0 0 0 / 0.72);
		border: none; border-image: none; border-radius: 0; min-height: 0;
		padding: 1rem; cursor: pointer;
		animation: pickfade 120ms ease-out;
	}
	.pickcard {
		display: grid; gap: 0.35rem; justify-items: center; text-align: center;
		padding: 1.75rem 2.75rem;
		background: var(--panel, #2b241d);
		border: 2px solid var(--line, #4a4038);
		border-radius: 6px;
		box-shadow: 0 12px 40px rgb(0 0 0 / 0.6);
	}
	.picknum { font-size: 0.85rem; letter-spacing: 0.08em; text-transform: uppercase; color: var(--muted); }
	.pickwho { font-family: var(--font-heading); font-size: 2.4rem; line-height: 1.1; color: var(--heading); }
	.pickto { font-size: 1.15rem; color: var(--text); }
	.pickleft { font-size: 0.9rem; color: var(--muted); }
	.pickdismiss { font-size: 0.75rem; color: var(--muted-soft); margin-top: 0.4rem; }
	@keyframes pickfade { from { opacity: 0; } to { opacity: 1; } }
	@media (prefers-reduced-motion: reduce) { .pickoverlay { animation: none; } }
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

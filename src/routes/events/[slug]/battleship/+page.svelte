<script lang="ts">
	import type { PageData, ActionData } from './$types';
	import { enhance } from '$app/forms';
	import { swrResource } from '$lib/swrResource.svelte';
	import Skeleton from '$lib/Skeleton.svelte';
	import TileSubmitModal from '$lib/TileSubmitModal.svelte';
	import BoardGrid from '$lib/battleship/BoardGrid.svelte';
	import {
		autoPlace,
		cellId,
		cellLabel,
		emptyFleet,
		shipCells,
		validatePlacement,
		type Ship
	} from '$lib/battleship/rules';
	import type { BattleshipPageResult } from '$lib/server/battleshipPage';

	let { data, form }: { data: PageData; form: ActionData } = $props();

	const EMPTY = { kind: 'ok', game: null } as unknown as BattleshipPageResult;
	const res = swrResource(() => data.battleship, EMPTY);
	const payload = $derived(res.value as BattleshipPageResult);
	const game = $derived(payload?.kind === 'ok' ? payload.game : null);

	const me = $derived(game ? game.sides.find((s) => s.side === game.viewerSide) : null);
	const foe = $derived(game ? game.sides.find((s) => s.side !== game.viewerSide) : null);

	const myBombs = $derived(
		game && game.viewerSide ? game.arsenal.filter((a) => a.side === game.viewerSide && !a.spentAt) : []
	);
	// A member fires bombs they earned; a captain can fire any of the side's, so nothing
	// goes stale when someone logs off. Mirrors the server rule exactly — the server is
	// still the one that enforces it.
	const firable = $derived(
		game?.viewerIsCaptain ? myBombs : myBombs.filter((b) => b.earnedBy === game?.viewerUserId)
	);

	let selectedBomb = $state<string | null>(null);
	let anchor = $state<{ x: number; y: number } | null>(null);
	// Did the last action come from the manual-claim form? Decides where its message goes.
	const isClaim = $derived(!!form && 'claim' in form && !!form.claim);
	let claimOpen = $state(false);
	const selected = $derived(firable.find((b) => b.id === selectedBomb) ?? firable[0]);
	const selectedTier = $derived(game?.config.tiers.find((t) => t.tier === selected?.tier));

	const shotsAt = (side: number | null | undefined) =>
		game && side != null ? game.shots.filter((s) => s.targetSide === side) : [];
	const sunkIdsFor = (side: number | null | undefined) => {
		if (!game || side == null) return [];
		const s = game.sides.find((x) => x.side === side);
		return (s?.fleetSummary ?? []).filter((f) => f.sunk).map((f) => f.id);
	};

	// ── Placement editor ────────────────────────────────────────────────
	// Runs entirely client-side against the SAME pure rules the server validates with,
	// so an illegal placement is impossible to submit and the preview can't disagree
	// with the eventual verdict.
	let draft = $state<Ship[]>([]);
	let placingId = $state<string | null>(null);
	let orient = $state<'h' | 'v'>('h');

	$effect(() => {
		if (!game || game.phase !== 'placement') return;
		if (draft.length) return;
		draft = me?.fleet?.length ? structuredClone($state.snapshot(me.fleet)) : emptyFleet(game.config.size);
		placingId = draft.find((s) => s.cells.length === 0)?.id ?? null;
	});

	const draftComplete = $derived(draft.length > 0 && draft.every((s) => s.cells.length === s.len));

	function placeAt(x: number, y: number) {
		if (!game || !placingId) return;
		const ship = draft.find((s) => s.id === placingId);
		if (!ship) return;
		const cells = shipCells({ x, y }, ship.len, orient, game.config.size);
		if (!cells) return;
		const others = draft.filter((s) => s.id !== ship.id);
		if (validatePlacement({ len: ship.len, cells }, others, game.config.size).ok !== true) return;
		ship.cells = cells;
		placingId = draft.find((s) => s.cells.length === 0)?.id ?? null;
	}

	function clearShip(id: string) {
		const s = draft.find((x) => x.id === id);
		if (s) s.cells = [];
		placingId = id;
	}

	function randomise() {
		if (!game) return;
		draft = autoPlace(game.config.size);
		placingId = null;
	}

	const gp = (n: number) => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}m` : n.toLocaleString());
	const standing = (side: number | null | undefined) =>
		game && side != null ? game.standings.find((s) => s.side === side) : undefined;

	const PHASE_BLURB: Record<string, string> = {
		signup: 'Signups are open. Join and wait for the captains to draft.',
		draft: 'The captains are drafting. You will be placed on a side shortly.',
		placement: 'Hide your fleet before the window closes.',
		battle: 'Kill bosses. Big drops become bombs. Sink their fleet.',
		finished: 'The battle is over.'
	};

	// Reset the aim whenever the payload refreshes, so a stale anchor can't be fired.
	$effect(() => {
		void game?.shots.length;
		anchor = null;
	});
</script>

<svelte:head><title>{game?.event.name ?? 'Battleship'}</title></svelte:head>

<div class="page">
	{#if !res.ready}
		<Skeleton height="2rem" />
		<Skeleton height="18rem" />
	{:else if payload?.kind === 'not_found'}
		<h1>Not found</h1>
		<p class="muted">There is no Battleship game at this address. <a href="/events">Back to events</a></p>
	{:else if game}
		<header>
			<div>
				<h1>{game.event.name}</h1>
				<p class="muted">{PHASE_BLURB[game.phase] ?? ''}</p>
			</div>
			{#if game.viewerSide}
				<div class="sideBadge" style="--c: {me?.color}">
					<span class="muted">You are</span>
					<strong>{me?.name}</strong>
					{#if game.viewerIsCaptain}<span class="pill">captain</span>{/if}
				</div>
			{/if}
		</header>

		{#if game.event.descriptionHtml}
			<!-- Shown in FULL, deliberately not collapsed: the /events card already
			     truncates to a 160-char teaser, so clicking in is how someone reads the
			     whole thing. -->
			<section class="card rules">
				<div class="description">{@html game.event.descriptionHtml}</div>
			</section>
		{/if}

		<!-- Claim results render NEXT TO the claim form instead — it lives at the bottom of
		     a long page, and feedback up here reads as "nothing happened". -->
		{#if form && 'error' in form && form.error && !isClaim}<p class="err">{form.error}</p>{/if}
		{#if form && 'report' in form && form.report && !isClaim}<p class="ok">{form.report}</p>{/if}

		{#if game.winner}
			<p class="banner">
				{game.sides.find((s) => s.side === game.winner)?.name} won —
				every ship on the other side is on the bottom.
			</p>
		{/if}

		<!-- ── Signup ─────────────────────────────────────────────────── -->
		{#if game.phase === 'signup'}
			{@const joined = game.pool.some((p) => p.userId === game.viewerUserId)}
			<section class="card">
				<h2>Signups</h2>
				<p class="muted">
					{game.pool.length} signed up so far.
					{#if game.event.signupClosesAt}
						Signups close {new Date(game.event.signupClosesAt).toLocaleString()}.
					{/if}
				</p>
				{#if joined}
					<p class="ok">You're in the pool. The captains will draft sides when signups close.</p>
					<form method="POST" action="?/leave" use:enhance>
						<button class="btn subtle" type="submit">Leave the event</button>
					</form>
					<p class="muted small">
						You can drop out any time before the draft starts — after that, ask an admin.
					</p>
				{:else}
					<form method="POST" action="?/join" use:enhance>
						<button class="btn primary" type="submit">Join the event</button>
					</form>
				{/if}
			</section>

		<!-- ── Draft ──────────────────────────────────────────────────── -->
		{:else if game.phase === 'draft'}
			<section class="card">
				<h2>Draft in progress</h2>
				<p class="muted">Side {game.draft.turn} is picking · {game.pool.length} still in the pool.</p>
				<div class="rosters">
					{#each game.sides as s (s.side)}
						<div>
							<h3 style="color: {s.color}">{s.name} <span class="muted">({s.members.length})</span></h3>
							<ul class="roster">{#each s.members as m (m.userId)}<li>{m.rsn ?? '—'}</li>{/each}</ul>
						</div>
					{/each}
				</div>
			</section>

		<!-- ── Placement ──────────────────────────────────────────────── -->
		{:else if game.phase === 'placement' && game.viewerSide}
			<section class="card">
				<h2>Hide your fleet</h2>
				<p class="muted">
					{#if game.placementEndsAt}
						The battle opens at {new Date(game.placementEndsAt).toLocaleTimeString()}.
					{/if}
					Ships may touch but not overlap. If you don't place, a random fleet is placed for you.
				</p>

				<div class="placewrap">
					<BoardGrid
						size={game.config.size}
						fleet={draft}
						mode="target"
						span={1}
						onpick={placeAt}
					/>

					<div class="shiplist">
						<div class="orient">
							<button class="btn small" class:active={orient === 'h'} onclick={() => (orient = 'h')}>Across</button>
							<button class="btn small" class:active={orient === 'v'} onclick={() => (orient = 'v')}>Down</button>
							<button class="btn small" onclick={randomise}>Random</button>
						</div>
						<ul>
							{#each draft as s (s.id)}
								<li class:done={s.cells.length === s.len} class:active={placingId === s.id}>
									<button class="shipbtn" onclick={() => (placingId = s.id)}>
										<strong>{s.name}</strong>
										<span class="muted">{s.len} long</span>
									</button>
									{#if s.cells.length}
										<span class="at">{cellLabel(s.cells[0])}</span>
										<button class="btn tiny" onclick={() => clearShip(s.id)}>clear</button>
									{/if}
								</li>
							{/each}
						</ul>

						<form method="POST" action="?/place" use:enhance>
							<input type="hidden" name="fleet" value={JSON.stringify(draft)} />
							<button class="btn primary" type="submit" disabled={!draftComplete}>
								{draftComplete ? 'Lock in this fleet' : 'Place every ship first'}
							</button>
						</form>
						{#if me?.placed}<p class="ok small">Your fleet is locked in. You can still re-place until the window closes.</p>{/if}
					</div>
				</div>
			</section>

		<!-- ── Battle ─────────────────────────────────────────────────── -->
		{:else if game.phase === 'battle' || game.phase === 'finished'}
			{#if game.viewerSide}
				<section class="card">
					<div class="boards">
						<div class="board">
							<h3>Your water</h3>
							<BoardGrid
								size={game.config.size}
								fleet={me?.fleet ?? []}
								shots={shotsAt(game.viewerSide)}
								sunkShipIds={sunkIdsFor(game.viewerSide)}
							/>
							<p class="stat">
								{standing(game.viewerSide)?.afloat ?? 0}/{standing(game.viewerSide)?.totalCells ?? 0} squares afloat
								· {standing(game.viewerSide)?.lost ?? 0} ships lost
							</p>
						</div>

						<div class="board">
							<h3>{foe?.name}</h3>
							<BoardGrid
								size={game.config.size}
								fleet={null}
								shots={shotsAt(foe?.side)}
								sunkShipIds={sunkIdsFor(foe?.side)}
								mode={game.phase === 'battle' && selected ? 'target' : 'view'}
								span={selectedTier?.span ?? 1}
								onpick={(x, y) => (anchor = { x, y })}
							/>
							<p class="stat">
								{standing(game.viewerSide)?.hits ?? 0} hits ·
								{standing(game.viewerSide)?.sunk ?? 0}/{foe?.fleetSummary.length ?? 0} of their ships sunk
							</p>
						</div>
					</div>

					{#if game.phase === 'battle'}
						<div class="fire">
							<h3>
								Your bombs
								{#if firable.length}<span class="muted">— {firable.length} ready to fire</span>{/if}
							</h3>
							{#if firable.length === 0}
								<p class="muted">
									No bombs banked. Any single drop worth
									{gp(game.config.tiers[0].min_value)}+ arms one automatically —
									{#each game.config.tiers as t, i (t.tier)}{i ? ', ' : ''}{gp(t.min_value)} = {t.span}×{t.span}{/each}.
								</p>
							{:else}
								<div class="bombs">
									{#each firable as b (b.id)}
										{@const t = game.config.tiers.find((x) => x.tier === b.tier)}
										<button class="bomb" class:active={selected?.id === b.id} onclick={() => (selectedBomb = b.id)}>
											<strong>{t?.name}</strong>
											<span>{t?.span}×{t?.span}</span>
											<span class="muted">{b.itemName ?? 'drop'}</span>
										</button>
									{/each}
								</div>
								<form method="POST" action="?/fire" use:enhance class="inline">
									<input type="hidden" name="arsenal_id" value={selected?.id ?? ''} />
									<input type="hidden" name="x" value={anchor?.x ?? ''} />
									<input type="hidden" name="y" value={anchor?.y ?? ''} />
									<span class="muted">
										{anchor
											? `Aiming ${selectedTier?.name} at ${cellLabel(cellId(anchor.x, anchor.y))}`
											: 'Click their board to aim.'}
									</span>
									<button class="btn primary" type="submit" disabled={!anchor || !selected}>Fire</button>
								</form>
							{/if}

							<!-- The whole side's banked ammunition. Everyone can SEE it; who may
							     fire what is the rule below (and enforced server-side). Without
							     this a member had no idea what their team was sitting on. -->
							<div class="team">
								<h3>
									Team arsenal
									<span class="muted">— {myBombs.length} banked</span>
								</h3>
								{#if myBombs.length === 0}
									<p class="muted small">Nothing banked yet.</p>
								{:else}
									<ul class="teamlist">
										{#each myBombs as b (b.id)}
											{@const t = game.config.tiers.find((x) => x.tier === b.tier)}
											{@const mine = b.earnedBy === game.viewerUserId}
											{@const canFire = mine || game.viewerIsCaptain}
											<li class:mine>
												<strong>{t?.name}</strong>
												<span class="muted">{t?.span}×{t?.span}</span>
												<span class="who">
													{mine ? 'you' : (me?.members.find((m) => m.userId === b.earnedBy)?.rsn ?? 'a teammate')}
												</span>
												<span class="muted item">{b.itemName ?? 'drop'}</span>
												{#if canFire}<span class="tag">yours to fire</span>{/if}
											</li>
										{/each}
									</ul>
								{/if}
								<p class="muted small">
									{#if game.viewerIsCaptain}
										You're captain — you can fire any of these, so nothing goes stale when
										someone's offline.
									{:else}
										You fire the bombs you earned. Your captain can fire any of the side's.
									{/if}
								</p>
							</div>

							<!-- Manual claim, for members who don't run Dink. Uses the shared
							     submission modal so proof capture (drag, paste, multi-image)
							     behaves exactly as it does everywhere else on the site. -->
							<div class="claim">
								<button class="btn subtle" onclick={() => (claimOpen = true)}>
									Not using Dink? Claim a drop
								</button>
								{#if isClaim && form && 'report' in form && form.report}
									<p class="ok small">{form.report}</p>
								{/if}
							</div>
						</div>
					{/if}
				</section>
			{:else}
				<section class="card">
					<h2>Spectating</h2>
					<p class="muted">You are not on a side in this game.</p>
					<div class="boards">
						{#each game.sides as s (s.side)}
							<div class="board">
								<h3 style="color: {s.color}">{s.name}</h3>
								<BoardGrid size={game.config.size} fleet={null} shots={shotsAt(s.side)} sunkShipIds={sunkIdsFor(s.side)} />
								<p class="stat">{s.fleetSummary.filter((f) => f.sunk).length}/{s.fleetSummary.length} ships sunk</p>
							</div>
						{/each}
					</div>
				</section>
			{/if}

			<section class="card">
				<h2>Fleets</h2>
				<div class="rosters">
					{#each game.sides as s (s.side)}
						<div>
							<h3 style="color: {s.color}">{s.name}</h3>
							<ul class="ships">
								{#each s.fleetSummary as f (f.id)}
									<li class:sunk={f.sunk}>{f.name} <span class="muted">({f.len})</span>{f.sunk ? ' — sunk' : ''}</li>
								{/each}
							</ul>
						</div>
					{/each}
				</div>
			</section>

		<!-- ── Everything else: setup, or placement seen by a non-participant ── -->
		{:else}
			<section class="card">
				<h2>{game.phase === 'placement' ? 'Fleets are being placed' : 'Not open yet'}</h2>
				<p class="muted">
					{#if game.phase === 'placement'}
						Both sides are hiding their ships. The battle opens
						{game.placementEndsAt
							? `at ${new Date(game.placementEndsAt).toLocaleTimeString()}`
							: 'shortly'}.
					{:else}
						This game hasn't opened for signups yet.
					{/if}
				</p>
				{#if game.sides.length}
					<div class="rosters">
						{#each game.sides as s (s.side)}
							<div>
								<h3 style="color: {s.color}">{s.name} <span class="muted">({s.members.length})</span></h3>
								<ul class="roster">{#each s.members as m (m.userId)}<li>{m.rsn ?? '—'}</li>{/each}</ul>
							</div>
						{/each}
					</div>
				{/if}
			</section>
		{/if}
	{/if}
</div>

{#if claimOpen && game}
	<TileSubmitModal
		tile={{ id: 'bomb', name: 'Claim a drop' }}
		submitUrl="?/claim"
		submitLabel="Submit"
		requireImage
		note="For members who don't run Dink. An admin reviews it, then the bomb appears in your arsenal. Value is the SINGLE drop, not a whole trip."
		onclose={() => (claimOpen = false)}
	>
		{#snippet fields()}
			<label>
				Drop value
				<input name="value" placeholder="5m" required />
			</label>
			<label>
				What dropped <span class="muted">(optional)</span>
				<input name="item" placeholder="Twisted bow" />
			</label>
		{/snippet}
	</TileSubmitModal>
{/if}

<style>
	.page { max-width: 68rem; margin: 0 auto; padding: 1rem; display: grid; gap: 1rem; }
	header { display: flex; align-items: flex-start; justify-content: space-between; gap: 1rem; flex-wrap: wrap; }
	h1 { font-family: var(--font-heading); color: var(--heading); text-shadow: var(--ts-strong); margin: 0; }
	h2 { font-family: var(--font-heading); color: var(--heading); font-size: 1.05rem; margin: 0 0 0.5rem; }
	h3 { font-family: var(--font-heading); font-size: 0.95rem; margin: 0 0 0.4rem; }
	.card { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius-lg); padding: 0.85rem; box-shadow: var(--shadow-card); }
	.muted { color: var(--muted); }
	.small { font-size: 0.8rem; }
	.sideBadge { display: flex; align-items: center; gap: 0.4rem; border: 1px solid var(--c, var(--border-strong)); border-radius: var(--radius); padding: 0.3rem 0.6rem; background: var(--surface-alt); }
	.pill { font-size: 0.7rem; border: 1px solid var(--accent); color: var(--accent); border-radius: 999px; padding: 0.05rem 0.35rem; }
	.banner { background: var(--success-bg); border: 1px solid var(--success); color: var(--success); padding: 0.6rem; border-radius: var(--radius); margin: 0; font-family: var(--font-heading); }
	.rules { display: grid; gap: 0.4rem; }
	.description :global(p) { margin: 0 0 0.6rem; }
	.description :global(p:last-child) { margin-bottom: 0; }
	.description :global(ul), .description :global(ol) { margin: 0 0 0.6rem; padding-left: 1.2rem; }
	.description :global(li) { margin-bottom: 0.2rem; }
	.description :global(strong) { color: var(--text); }
	.description :global(h1), .description :global(h2), .description :global(h3) {
		font-family: var(--font-heading); color: var(--heading); font-size: 1rem; margin: 0.8rem 0 0.35rem;
	}
	.description :global(hr) { border: 0; border-top: 1px solid var(--border); margin: 0.8rem 0; }
	.boards { display: grid; grid-template-columns: repeat(auto-fit, minmax(18rem, 1fr)); gap: 1.25rem; }
	.stat { font-size: 0.8rem; color: var(--muted); margin: 0.5rem 0 0; }
	.placewrap { display: grid; grid-template-columns: minmax(16rem, 2fr) minmax(12rem, 1fr); gap: 1.25rem; }
	@media (max-width: 720px) { .placewrap { grid-template-columns: 1fr; } }
	.shiplist ul { list-style: none; padding: 0; margin: 0.5rem 0; display: grid; gap: 0.3rem; }
	.shiplist li { display: flex; align-items: center; gap: 0.4rem; padding: 0.2rem 0.35rem; border: 1px solid transparent; border-radius: var(--radius); }
	.shiplist li.active { border-color: var(--accent); background: var(--accent-soft); }
	.shiplist li.done strong { color: var(--success); }
	.shipbtn { flex: 1; display: flex; gap: 0.4rem; align-items: baseline; background: none; border: none; color: var(--text); cursor: pointer; font-family: var(--font-body); font-size: 0.85rem; text-align: left; padding: 0; }
	.at { font-size: 0.75rem; color: var(--muted); }
	.orient { display: flex; gap: 0.3rem; }
	.rosters { display: grid; grid-template-columns: repeat(auto-fit, minmax(13rem, 1fr)); gap: 1rem; }
	.roster, .ships { list-style: none; padding: 0; margin: 0; font-size: 0.82rem; }
	.roster { columns: 2; }
	.ships li.sunk { color: var(--muted); text-decoration: line-through; }
	.fire { margin-top: 1rem; border-top: 1px solid var(--border); padding-top: 0.75rem; }
	.bombs { display: flex; gap: 0.4rem; flex-wrap: wrap; margin-bottom: 0.6rem; max-height: 11rem; overflow-y: auto; }
	.bomb { display: grid; gap: 0.1rem; text-align: left; cursor: pointer; background: var(--surface-alt); color: var(--text); border: 1px solid var(--border-strong); border-radius: var(--radius); padding: 0.3rem 0.5rem; font-family: var(--font-body); font-size: 0.78rem; }
	.bomb.active { border-color: var(--accent); background: var(--accent-soft); }
	.claim { margin-top: 0.9rem; border-top: 1px solid var(--border); padding-top: 0.6rem; display: grid; gap: 0.4rem; justify-items: start; }
	.team { margin-top: 1rem; border-top: 1px solid var(--border); padding-top: 0.75rem; }
	.teamlist { list-style: none; padding: 0; margin: 0 0 0.5rem; display: grid; gap: 0.25rem; max-height: 12rem; overflow-y: auto; }
	.teamlist li {
		display: flex; align-items: baseline; gap: 0.5rem; flex-wrap: wrap;
		font-size: 0.8rem; padding: 0.25rem 0.4rem; border-radius: var(--radius);
		background: var(--surface-alt); border: 1px solid var(--border);
	}
	.teamlist li.mine { border-color: var(--accent); }
	.teamlist .who { color: var(--text); }
	.teamlist .item { flex: 1 1 8rem; }
	.tag { font-size: 0.68rem; border: 1px solid var(--success); color: var(--success); border-radius: 999px; padding: 0.02rem 0.35rem; }
	.inline { display: flex; gap: 0.5rem; align-items: center; flex-wrap: wrap; }
	.btn { background: var(--surface-alt); color: var(--text); border: 1px solid var(--border-strong); border-radius: var(--radius); padding: 0.35rem 0.7rem; cursor: pointer; font-family: var(--font-body); font-size: 0.85rem; }
	.btn:hover { border-color: var(--accent); }
	.btn:disabled { opacity: 0.45; cursor: not-allowed; }
	.btn.small { font-size: 0.78rem; padding: 0.25rem 0.5rem; }
	.btn.tiny { font-size: 0.7rem; padding: 0.1rem 0.35rem; }
	.btn.primary, .btn.active { background: var(--accent-soft); border-color: var(--accent); color: var(--accent); }
	/* Leaving is a real option but not the thing we're nudging anyone toward. */
	.btn.subtle { color: var(--muted); border-color: var(--border); }
	.btn.subtle:hover { color: var(--danger); border-color: var(--danger); }
	.err { color: var(--danger); background: var(--danger-bg); border: 1px solid var(--danger); padding: 0.5rem; border-radius: var(--radius); margin: 0; }
	.ok { color: var(--success); background: var(--success-bg); border: 1px solid var(--success); padding: 0.5rem; border-radius: var(--radius); margin: 0; }
</style>

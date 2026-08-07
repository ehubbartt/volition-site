<script lang="ts">
	import type { PageData, ActionData } from './$types';
	import { enhance } from '$app/forms';
	import { invalidateAll } from '$app/navigation';
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
	// Which board is on screen. Defaults to the enemy's, because that's the one you ACT
	// on — firing is the whole job of this page, and a board you can't fire at is a
	// worse landing place than one you can.
	let boardView = $state<'foe' | 'mine'>('foe');
	// Only a captain is sent their own fleet. Read it off the payload rather than
	// re-deriving "am I the captain", so the UI can never offer a board the server
	// withheld — and so a spectating admin, who does get both, still sees both.
	const canSeeOwnFleet = $derived(!!me?.fleet);
	// If a captain's own board is on screen and the payload stops carrying the fleet
	// (role change, or a refresh that lands differently), fall back rather than render
	// an empty grid labelled "your waters".
	$effect(() => {
		if (boardView === 'mine' && !canSeeOwnFleet) boardView = 'foe';
	});
	/** Arming a bomb puts you on the board you have to aim it at. */
	function chooseBomb(id: string) {
		selectedBomb = id;
		boardView = 'foe';
	}

	// The page revalidates on navigation, not on a timer, so a draft pick or an enemy
	// shot lands without the open page knowing. Rather than have people guess at the
	// browser reload (which drops the bomb you had armed), give them a control that
	// re-fetches the payload in place.
	let refreshing = $state(false);
	let refreshedAt = $state<Date | null>(null);
	async function refresh() {
		if (refreshing) return;
		refreshing = true;
		try {
			await invalidateAll();
			refreshedAt = new Date();
		} finally {
			refreshing = false;
		}
	}
	// Did the last action come from the manual-claim form? Decides where its message goes.
	const isClaim = $derived(!!form && 'claim' in form && !!form.claim);
	let claimOpen = $state(false);
	const selected = $derived(firable.find((b) => b.id === selectedBomb) ?? firable[0]);
	const selectedTier = $derived(game?.config.tiers.find((t) => t.tier === selected?.tier));
	// Clamped exactly as the board and the server clamp it, so the readout, the highlight
	// and what actually gets hit can never disagree.
	const target = $derived.by(() => {
		if (!anchor || !game) return null;
		const max = Math.max(0, game.config.size - (selectedTier?.span ?? 1));
		return { x: Math.min(anchor.x, max), y: Math.min(anchor.y, max) };
	});

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

<!-- Re-fetch in place. Deliberately not a browser reload: that would throw away the
     bomb you have armed and the square you have aimed at. -->
{#snippet refreshBtn(label: string)}
	<span class="refreshwrap">
		<button class="btn refresh" onclick={refresh} disabled={refreshing}>
			{refreshing ? 'Refreshing…' : label}
		</button>
		{#if refreshedAt}
			<span class="refreshed">updated {refreshedAt.toLocaleTimeString()}</span>
		{/if}
	</span>
{/snippet}

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
					{#if game.viewerIsCaptain}<span class="osrs-badge">captain</span>{/if}
				</div>
			{/if}
		</header>

		{#if game.event.descriptionHtml}
			<!-- Shown in FULL, deliberately not collapsed: the /events card already
			     truncates to a 160-char teaser, so clicking in is how someone reads the
			     whole thing. -->
			<section class="osrs-panel rules">
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
			<section class="osrs-panel">
				<h2 class="osrs-titlebar">Signups</h2>
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
				<p class="muted small dinktip">
					Your drops only become bombs if Dink is reporting them —
					<a href="/dink-check">test your setup →</a> before the battle starts.
				</p>
			</section>

		<!-- ── Draft ──────────────────────────────────────────────────── -->
		{:else if game.phase === 'draft'}
			<section class="osrs-panel">
				<h2 class="osrs-titlebar">Draft in progress</h2>
				<p class="muted">Side {game.draft.turn} is picking · {game.pool.length} still in the pool.</p>
				<div class="rosters">
					{#each game.sides as s (s.side)}
						<div>
							<h3 style="color: {s.color}">{s.name} <span class="muted">({s.members.length})</span></h3>
							<ul class="roster">{#each s.members as m (m.userId)}<li>{m.rsn ?? '—'}</li>{/each}</ul>
						</div>
					{/each}
				</div>

				<!-- Who is still undrafted. Read-only on purpose: an admin makes the picks
				     from the tester, and this is here so the captains can follow along on
				     their own screen instead of squinting at a shared stream. -->
				{#if game.pool.length}
					<h3 class="poolhead">
						Still in the pool <span class="muted">({game.pool.length})</span>
					</h3>
					<ul class="roster pool">
						{#each game.pool as p (p.userId)}<li>{p.rsn ?? '—'}</li>{/each}
					</ul>
					<p class="hint">Picks are made by an admin — this list is here to follow, not to click.</p>
					<div class="refreshbar">{@render refreshBtn('Refresh the pool')}</div>
				{/if}
			</section>

		<!-- ── Placement ──────────────────────────────────────────────── -->
		{:else if game.phase === 'placement' && game.viewerSide && !game.viewerIsCaptain}
			<!-- A member never sees the placement editor: the fleet is the captain's secret,
			     and the server refuses a placement from anyone else regardless. -->
			<section class="osrs-panel">
				<h2 class="osrs-titlebar">Your captain is hiding the fleet</h2>
				<p class="muted">
					{#if game.placementEndsAt}
						The battle opens at {new Date(game.placementEndsAt).toLocaleTimeString()}.
					{/if}
					Only your captain places the ships and only they can see where they are — that's
					what keeps the positions off a screenshot. You'll be firing at the enemy board as
					soon as the battle opens.
				</p>
				<p class="muted small dinktip">
					Last chance to <a href="/dink-check">check your Dink setup →</a> — once the battle
					opens, untracked drops don't arm anything.
				</p>
				<div class="refreshbar">{@render refreshBtn('Refresh')}</div>
			</section>

		{:else if game.phase === 'placement' && game.viewerSide}
			<section class="osrs-panel">
				<h2 class="osrs-titlebar">Hide your fleet</h2>
				<p class="muted">
					{#if game.placementEndsAt}
						The battle opens at {new Date(game.placementEndsAt).toLocaleTimeString()}.
					{/if}
					Ships may touch but not overlap. If you don't place, a random fleet is placed for you.
				</p>

				<div class="placewrap">
					<div class="osrs-inset boardwell">
						<BoardGrid
							size={game.config.size}
							fleet={draft}
							mode="target"
							span={1}
							onpick={placeAt}
						/>
					</div>

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
						<p class="muted small dinktip">
							Last chance to <a href="/dink-check">check your Dink setup →</a> — once the
							battle opens, untracked drops don't arm anything.
						</p>
					</div>
				</div>
			</section>

		<!-- ── Battle ─────────────────────────────────────────────────── -->
		{:else if game.phase === 'battle' || game.phase === 'finished'}
			{#if game.viewerSide}
				<section class="osrs-panel">
					<!-- ONE board at a time. Two 25x25 grids side by side shrink each to
					     something you squint at, and worse, "which of these is mine?" was a
					     question you answered from a small heading. The switch makes the
					     answer the loudest thing on screen. -->
					<div class="switchrow">
						<div class="boardswitch" role="group" aria-label="Choose a board">
							<button
								class="switchbtn"
								class:active={boardView === 'foe'}
								aria-pressed={boardView === 'foe'}
								onclick={() => (boardView = 'foe')}
							>
								Their waters
								<span class="sub" style="color: {foe?.color}">{foe?.name}</span>
							</button>
							<!-- Only the captain gets this tab, because only the captain gets the
							     fleet. The server withholds it either way; hiding the button stops
							     a member clicking through to an empty grid and reading it as a bug. -->
							{#if canSeeOwnFleet}
								<button
									class="switchbtn"
									class:active={boardView === 'mine'}
									aria-pressed={boardView === 'mine'}
									onclick={() => (boardView = 'mine')}
								>
									Your waters
									<span class="sub" style="color: {me?.color}">{me?.name}</span>
								</button>
							{/if}
						</div>
						{@render refreshBtn('Refresh')}
					</div>

					{#if boardView === 'foe'}
						<div class="board">
							<h3 class="boardhead">
								<span class="who" style="color: {foe?.color}">{foe?.name}</span> — their waters
							</h3>
							<p class="boardnote">
								You're firing at this board. Their ships are hidden — you only see where
								shots have landed.
							</p>
							<div class="osrs-inset boardwell"><BoardGrid
								size={game.config.size}
								fleet={null}
								shots={shotsAt(foe?.side)}
								sunkShipIds={sunkIdsFor(foe?.side)}
								mode={game.phase === 'battle' && selected ? 'target' : 'view'}
								span={selectedTier?.span ?? 1}
								{target}
								onpick={(x, y) => (anchor = { x, y })}
							/></div>
							<p class="stat osrs-inset">
								{standing(game.viewerSide)?.hits ?? 0} hits ·
								{standing(game.viewerSide)?.sunk ?? 0}/{foe?.fleetSummary.length ?? 0} of their ships sunk
							</p>
							{#if !canSeeOwnFleet}
								<!-- A member can't see their own water, but they should still know how
								     their side is doing. Counts reveal no positions. -->
								<p class="stat osrs-inset">
									Your fleet: {standing(game.viewerSide)?.afloat ?? 0}/{standing(game.viewerSide)?.totalCells ?? 0}
									squares afloat · {standing(game.viewerSide)?.lost ?? 0}
									ship{(standing(game.viewerSide)?.lost ?? 0) === 1 ? '' : 's'} lost
								</p>
							{/if}
						</div>
					{:else}
						<div class="board">
							<h3 class="boardhead">
								<span class="who" style="color: {me?.color}">{me?.name}</span> — your waters
							</h3>
							<p class="boardnote">
								Your fleet, and every shot they've landed on it. You can't fire at this
								board.
							</p>
							<div class="osrs-inset boardwell"><BoardGrid
								size={game.config.size}
								fleet={me?.fleet ?? []}
								shots={shotsAt(game.viewerSide)}
								sunkShipIds={sunkIdsFor(game.viewerSide)}
							/></div>
							<p class="stat osrs-inset">
								{standing(game.viewerSide)?.afloat ?? 0}/{standing(game.viewerSide)?.totalCells ?? 0} squares afloat
								· {standing(game.viewerSide)?.lost ?? 0} ship{(standing(game.viewerSide)?.lost ?? 0) === 1 ? '' : 's'} lost
							</p>
						</div>
					{/if}

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
										<button class="bomb" class:active={selected?.id === b.id} onclick={() => chooseBomb(b.id)}>
											<strong>{t?.name}</strong>
											<span>{t?.span}×{t?.span}</span>
											<span class="muted">{b.itemName ?? 'drop'}</span>
										</button>
									{/each}
								</div>
								<form method="POST" action="?/fire" use:enhance class="inline">
									<input type="hidden" name="arsenal_id" value={selected?.id ?? ''} />
									<input type="hidden" name="x" value={target?.x ?? ''} />
									<input type="hidden" name="y" value={target?.y ?? ''} />
									<span class="muted">
										{target
											? `${selectedTier?.name} · ${selectedTier?.span}×${selectedTier?.span} · ${cellLabel(cellId(target.x, target.y))}`
											: 'Tap their board to choose a square.'}
									</span>
									<button class="btn primary" type="submit" disabled={!target || !selected}>
										{target ? `Fire at ${cellLabel(cellId(target.x, target.y))}` : 'Fire'}
									</button>
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
								<p class="muted small">
									Drops not turning into bombs?
									<a href="/dink-check">Check your Dink setup →</a>
								</p>
							</div>
						</div>
					{/if}
				</section>
			{:else}
				<section class="osrs-panel">
					<h2 class="osrs-titlebar">Spectating</h2>
					<p class="muted">You are not on a side in this game.</p>
					<div class="boards">
						{#each game.sides as s (s.side)}
							<div class="board">
								<h3 style="color: {s.color}">{s.name}</h3>
								<div class="osrs-inset boardwell">
									<BoardGrid size={game.config.size} fleet={null} shots={shotsAt(s.side)} sunkShipIds={sunkIdsFor(s.side)} />
								</div>
								<p class="stat osrs-inset">{s.fleetSummary.filter((f) => f.sunk).length}/{s.fleetSummary.length} ships sunk</p>
							</div>
						{/each}
					</div>
				</section>
			{/if}

			<section class="osrs-panel">
				<h2 class="osrs-titlebar">Fleets</h2>
				<div class="rosters">
					{#each game.sides as s (s.side)}
						{@const sunkCount = s.fleetSummary.filter((f) => f.sunk).length}
						<div>
							<h3 style="color: {s.color}">
								{s.name}
								<span class="muted">— {sunkCount}/{s.fleetSummary.length} sunk</span>
							</h3>
							<ul class="ships">
								{#each s.fleetSummary as f (f.id)}
									<li class:sunk={f.sunk} title={f.sunk ? `${f.name} — sunk` : f.name}>
										<span class="hull">{f.sunk ? '✗' : '▬'}</span>
										{f.name}<span class="muted">({f.len})</span>
									</li>
								{/each}
							</ul>
						</div>
					{/each}
				</div>
			</section>

		<!-- ── Everything else: setup, or placement seen by a non-participant ── -->
		{:else}
			<section class="osrs-panel">
				<h2 class="osrs-titlebar">{game.phase === 'placement' ? 'Fleets are being placed' : 'Not open yet'}</h2>
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
	/* This page leans on the shared OSRS layer in app.css — .osrs-panel (framed stone),
	   .osrs-titlebar (gold-underlined heading), .osrs-inset (recessed well) and the
	   GLOBAL bronze <button> frame. Nothing here re-implements those; the earlier
	   version overrode the button style with a flat rectangle, which is what made the
	   page read as unfinished next to the rest of the site. */
	.page { max-width: 70rem; margin: 0 auto; padding: 1rem; display: grid; gap: 1rem; }
	header { display: flex; align-items: flex-start; justify-content: space-between; gap: 1rem; flex-wrap: wrap; }
	h1 { font-family: var(--font-heading); color: var(--heading); text-shadow: var(--ts-strong); margin: 0; letter-spacing: 1px; }
	h3 { font-family: var(--font-heading); font-size: 0.95rem; margin: 0 0 0.45rem; color: var(--accent); text-shadow: var(--ts); }
	.muted { color: var(--muted); }
	.small { font-size: 0.8rem; }

	.sideBadge {
		display: flex; align-items: center; gap: 0.45rem;
		border: 4px solid transparent; border-image: url('/osrs/border-tiny.png') 4 / 4px round;
		background-color: var(--stone-fill); background-image: var(--stone-tile);
		background-blend-mode: var(--stone-blend);
		padding: 0.4rem 0.7rem;
	}
	.sideBadge strong { color: var(--c, var(--yellow)); text-shadow: var(--ts); }

	.banner {
		margin: 0; padding: 0.7rem 0.9rem; font-family: var(--font-heading); letter-spacing: 0.5px;
		color: var(--success); background: var(--success-bg);
		border: 4px solid transparent; border-image: url('/osrs/border-tiny.png') 4 / 4px round;
	}

	/* ── Boards ─────────────────────────────────────────────────────── */
	.boards { display: grid; grid-template-columns: repeat(auto-fit, minmax(19rem, 1fr)); gap: 1.25rem; }
	.boardwell { padding: 0.5rem; }
	/* Boards stay square and never outgrow their column. One at a time now, so it gets
	   the width two side-by-side grids used to share. */
	.board { min-width: 0; max-width: 44rem; margin: 0 auto; }

	.switchrow {
		display: flex; align-items: center; justify-content: space-between;
		gap: 0.75rem; flex-wrap: wrap; margin-bottom: 0.9rem;
	}
	.boardswitch { display: flex; gap: 0.4rem; flex-wrap: wrap; }
	.switchbtn {
		display: grid; gap: 0.1rem; text-align: left;
		padding: 0.4rem 0.9rem; min-height: 44px;
		font-family: var(--font-heading); font-size: 0.95rem;
		color: var(--muted); opacity: 0.75;
	}
	.switchbtn .sub { font-family: var(--font-body); font-size: 0.75rem; }
	.switchbtn.active { color: var(--yellow); opacity: 1; }

	.boardhead { margin: 0 0 0.15rem; font-family: var(--font-heading); font-size: 1.05rem; color: var(--heading); }
	.boardhead .who { font-weight: inherit; }
	.boardnote { margin: 0 0 0.5rem; font-size: 0.78rem; color: var(--muted); }

	.refreshwrap { display: inline-flex; align-items: center; gap: 0.5rem; }
	.refresh { font-size: 0.8rem; }
	.refreshed { font-size: 0.72rem; color: var(--muted-soft); }
	.refreshbar { margin-top: 0.6rem; }
	/* The readout under each grid, styled like an in-game info strip. */
	.stat {
		margin: 0.5rem 0 0; padding: 0.35rem 0.6rem; font-size: 0.8rem;
		color: var(--yellow); text-shadow: var(--ts);
	}

	/* ── Placement ──────────────────────────────────────────────────── */
	.placewrap { display: grid; grid-template-columns: minmax(16rem, 2fr) minmax(13rem, 1fr); gap: 1.25rem; }
	@media (max-width: 720px) { .placewrap { grid-template-columns: 1fr; } }
	.shiplist ul { list-style: none; padding: 0; margin: 0.6rem 0; display: grid; gap: 0.3rem; }
	.shiplist li {
		display: flex; align-items: center; gap: 0.5rem; padding: 0.3rem 0.5rem;
		border: 1px solid transparent; border-radius: 3px; background: rgba(0, 0, 0, 0.22);
	}
	.shiplist li.active { border-color: var(--gold-mid); background: rgba(255, 152, 31, 0.12); }
	.shiplist li.done strong { color: var(--success); }
	.shipbtn {
		flex: 1; display: flex; gap: 0.45rem; align-items: baseline; text-align: left;
		/* Deliberately NOT a bronze button — it's a list row, so strip the global frame. */
		background: none; border: none; border-image: none; min-height: 0; padding: 0;
		color: var(--text); font-family: var(--font-body); font-size: 0.85rem; cursor: pointer;
	}
	.shipbtn:hover { background: none; color: var(--accent); }
	.at { font-size: 0.75rem; color: var(--yellow); }
	.orient { display: flex; gap: 0.35rem; flex-wrap: wrap; }

	/* ── Rosters & fleets ───────────────────────────────────────────── */
	.rosters { display: grid; grid-template-columns: repeat(auto-fit, minmax(13rem, 1fr)); gap: 1rem; }
	.roster, .ships { list-style: none; padding: 0; margin: 0; font-size: 0.82rem; }
	.roster { columns: 2; }
	.roster li { padding: 0.1rem 0; }
	.poolhead { margin: 1.25rem 0 0.4rem; font-family: var(--font-heading); color: var(--heading); font-size: 0.95rem; }
	/* The undrafted pool runs long at 80 signups — more columns, so it stays one glance. */
	.roster.pool { columns: 4; }
	@media (max-width: 720px) { .roster.pool { columns: 2; } }
	.hint { font-size: 0.75rem; color: var(--muted-soft); margin: 0.6rem 0 0; }
	/* A big event has ~18 ships a side — one line each is a wall, so flow them into
	   as many columns as fit and lead with a hull/wreck glyph you can scan. */
	.ships { display: grid; grid-template-columns: repeat(auto-fill, minmax(9.5rem, 1fr)); gap: 0.1rem 0.75rem; }
	.ships li { display: flex; align-items: baseline; gap: 0.35rem; padding: 0.1rem 0; white-space: nowrap; }
	.ships li .muted { font-size: 0.75rem; }
	.ships li.sunk { color: var(--muted); }
	.ships li.sunk .hull { color: var(--danger); }
	.hull { color: var(--gold-mid); font-size: 0.7rem; }

	/* ── Arsenal ────────────────────────────────────────────────────── */
	.fire { margin-top: 1rem; }
	.bombs { display: flex; gap: 0.45rem; flex-wrap: wrap; margin-bottom: 0.7rem; max-height: 12rem; overflow-y: auto; padding: 0.15rem; }
	.bomb {
		display: grid; gap: 0.1rem; text-align: left; min-height: 0;
		padding: 0.4rem 0.6rem; font-family: var(--font-body); font-size: 0.78rem;
		color: var(--text);
	}
	.bomb strong { color: var(--yellow); font-family: var(--font-heading); }
	.bomb.active { box-shadow: 0 0 0 2px var(--accent); }
	.team { margin-top: 1rem; }
	.teamlist { list-style: none; padding: 0; margin: 0.5rem 0; display: grid; gap: 0.25rem; max-height: 13rem; overflow-y: auto; }
	.teamlist li {
		display: flex; align-items: baseline; gap: 0.55rem; flex-wrap: wrap;
		font-size: 0.8rem; padding: 0.3rem 0.5rem; border-radius: 3px;
		background: rgba(0, 0, 0, 0.25); border: 1px solid rgba(0, 0, 0, 0.4);
	}
	.teamlist li.mine { border-color: var(--gold-mid); background: rgba(255, 152, 31, 0.1); }
	.teamlist strong { color: var(--yellow); font-family: var(--font-heading); }
	.teamlist .who { color: var(--text); }
	.teamlist .item { flex: 1 1 8rem; color: var(--muted); }
	.tag { font-size: 0.68rem; color: var(--success); border: 1px solid var(--success); border-radius: 3px; padding: 0.02rem 0.35rem; }
	.claim { margin-top: 0.9rem; display: grid; gap: 0.5rem; justify-items: start; }
	.dinktip { margin: 0.6rem 0 0; }
	a { color: var(--accent); }
	a:hover { color: var(--yellow); }
	.inline { display: flex; gap: 0.6rem; align-items: center; flex-wrap: wrap; }

	/* ── Description ────────────────────────────────────────────────── */
	.rules { display: grid; gap: 0.4rem; }
	.description :global(p) { margin: 0 0 0.6rem; }
	.description :global(p:last-child) { margin-bottom: 0; }
	.description :global(ul), .description :global(ol) { margin: 0 0 0.6rem; padding-left: 1.2rem; }
	.description :global(li) { margin-bottom: 0.2rem; }
	.description :global(strong) { color: var(--yellow); }
	.description :global(h1), .description :global(h2), .description :global(h3) {
		font-family: var(--font-heading); color: var(--heading); font-size: 1rem; margin: 0.9rem 0 0.4rem;
	}
	.description :global(hr) { border: 0; border-top: 1px solid rgba(0, 0, 0, 0.5); margin: 0.9rem 0; }

	/* ── Messages ───────────────────────────────────────────────────── */
	.err, .ok {
		margin: 0; padding: 0.55rem 0.75rem; border-radius: 3px;
		border: 1px solid; font-size: 0.9rem;
	}
	.err { color: var(--danger); background: var(--danger-bg); border-color: var(--danger); }
	.ok { color: var(--success); background: var(--success-bg); border-color: var(--success); }

	/* Modifiers on top of the GLOBAL bronze button — never a replacement for it. */
	.btn.primary { color: var(--yellow); }
	.btn.subtle { color: var(--muted); }
	.btn.subtle:hover { color: var(--danger); }
	.btn.small { min-height: 30px; padding: 1px 10px; font-size: 0.8rem; }
</style>

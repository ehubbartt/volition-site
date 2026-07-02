<script lang="ts">
	import { enhance, deserialize } from '$app/forms';
	import { invalidateAll } from '$app/navigation';
	import BoardMap from '$lib/catan/BoardMap.svelte';
	import { TILE_TYPE_LABEL, type TileType } from '$lib/catan/board';
	import {
		armySize,
		canPlaceRoad,
		canPlaceSettlement,
		canUpgradeCity,
		COSTS,
		DEV_CARD_LABEL,
		legalRoadSpots,
		legalSettlementSpots,
		longestRoadLength,
		networkTileCounts,
		rollableCorners,
		setupState,
		subtractCost,
		teamVP,
		tradeRates,
		updateHolders,
		WINNING_VP,
		type DevCardType,
		type GameSnapshot,
		type Tokens,
		type VPBreakdown
	} from '$lib/catan/rules';
	import type { PageData, ActionData } from './$types';

	let { data, form }: { data: PageData; form: ActionData } = $props();

	const game = $derived(data.game);
	const TOKEN_TYPES: TileType[] = ['boss', 'skilling', 'raids', 'custom'];
	const TOKEN_SHORT: Record<string, string> = { boss: 'B', skilling: 'S', raids: 'R', custom: 'C', gold: 'G' };

	// ---- local game state: the page IS the game client ----
	// The pure rules run in the browser against this snapshot, so placements validate,
	// render, and advance the draft instantly; the server POST trails behind as the
	// authority (queued so requests can't race each other) and any rejection resyncs.
	// svelte-ignore state_referenced_locally
	let localSnap = $state<GameSnapshot>(structuredClone(data.game.snapshot));
	$effect(() => {
		localSnap = structuredClone(data.game.snapshot);
	});

	let actingId = $state('');
	const acting = $derived(localSnap.teams.find((t) => t.id === actingId) ?? localSnap.teams[0]);
	const actingCards = $derived(game.teams.find((t) => t.id === acting.id)?.devCards ?? []);
	const hand = $derived(actingCards.filter((c) => !c.played_at));

	type Mode = 'settle' | 'road' | 'city' | 'roll' | 'pker' | null;
	let mode = $state<Mode>(null);
	let pendingCard = $state('');
	let localError = $state('');

	interface TeamView {
		vp: VPBreakdown;
		publicVP: number;
		network: Record<TileType, number>;
		rates: Record<TileType, number>;
		longestRoad: number;
		army: number;
		rollable: string[];
	}

	function computeView(id: string): TeamView {
		const vp = teamVP(localSnap, id, { includeHidden: true });
		return {
			vp,
			publicVP: vp.total - vp.hiddenVP,
			network: networkTileCounts(localSnap, id),
			rates: tradeRates(localSnap, id),
			longestRoad: longestRoadLength(localSnap, id),
			army: armySize(localSnap, id),
			rollable: rollableCorners(localSnap, id, new Date())
		};
	}
	const views = $derived(new Map(localSnap.teams.map((t) => [t.id, computeView(t.id)])));
	function view(id: string): TeamView {
		return views.get(id) ?? computeView(id);
	}

	const draft = $derived(setupState(localSnap));
	const draftTeam = $derived(draft ? localSnap.teams.find((t) => t.id === draft.teamId) : null);
	const winner = $derived(localSnap.teams.find((t) => view(t.id).vp.total >= WINNING_VP) ?? null);

	const teamColors = $derived(Object.fromEntries(localSnap.teams.map((t) => [t.id, t.color])));
	const frozenVerts = $derived(game.freezes.map((f) => f.loc));
	const frozenSet = $derived(new Set(frozenVerts));

	const ownSettlements = $derived(
		localSnap.pieces.filter((p) => p.kind === 'settlement' && p.teamId === acting.id).map((p) => p.loc)
	);
	const rivalBuildings = $derived(
		localSnap.pieces
			.filter((p) => p.kind !== 'road' && p.teamId !== acting.id && !frozenSet.has(p.loc))
			.map((p) => p.loc)
	);
	const highlightVertices = $derived(
		mode === 'settle'
			? legalSettlementSpots(localSnap, acting.id)
			: mode === 'city'
				? ownSettlements
				: mode === 'roll'
					? view(acting.id).rollable
					: mode === 'pker'
						? rivalBuildings
						: []
	);
	const highlightEdges = $derived(mode === 'road' ? legalRoadSpots(localSnap, acting.id) : []);

	// ---- background submission queue ----
	let pending = $state(0);
	let dirty = false; // fast-path posts happened; reconcile with one invalidate when idle
	let queue: Promise<void> = Promise.resolve();

	function post(action: string, fields: Record<string, string>, opts: { refresh?: boolean } = {}) {
		pending++;
		queue = queue.then(async () => {
			try {
				const body = new FormData();
				for (const [k, v] of Object.entries(fields)) body.append(k, v);
				const res = await fetch(`?/${action}`, {
					method: 'POST',
					body,
					headers: { 'x-sveltekit-action': 'true' }
				});
				const result = deserialize(await res.text());
				if (result.type === 'failure' || result.type === 'error') {
					localError =
						result.type === 'failure'
							? ((result.data as { error?: string })?.error ?? 'Action failed')
							: 'Action failed';
					dirty = false;
					await invalidateAll(); // resync the local snapshot from server truth
				} else if (opts.refresh) {
					dirty = false;
					await invalidateAll();
				} else {
					dirty = true;
				}
			} catch {
				localError = 'Network error — resyncing…';
				dirty = false;
				await invalidateAll();
			} finally {
				pending--;
				if (pending === 0 && dirty) {
					dirty = false;
					void invalidateAll(); // one coalesced reconcile after a burst of placements
				}
			}
		});
	}

	function setMode(m: Mode) {
		mode = mode === m ? null : m;
		localError = '';
		if (mode !== 'pker') pendingCard = '';
	}

	function actAsDrafter() {
		if (!draft) return;
		actingId = draft.teamId;
		mode = draft.expect === 'settlement' ? 'settle' : 'road';
	}

	/** After a local placement: keep the snake draft moving without waiting on the server. */
	function afterPlacement() {
		if (draft) {
			actingId = draft.teamId;
			mode = draft.expect === 'settlement' ? 'settle' : 'road';
		} else if (mode === 'city' || (mode === 'road' && draftJustEnded())) {
			mode = null;
		}
	}
	function draftJustEnded() {
		return localSnap.pieces.filter((p) => p.kind === 'road').length === localSnap.teams.length * 2;
	}

	function pay(teamId: string, cost: Partial<Tokens>) {
		const t = localSnap.teams.find((x) => x.id === teamId);
		if (t) t.tokens = subtractCost(t.tokens, cost);
	}

	function clickVertex(v: string) {
		localError = '';
		if (mode === 'settle') {
			const verdict = canPlaceSettlement(localSnap, acting.id, v);
			if (!verdict.ok) return void (localError = verdict.reason);
			if (!verdict.free) pay(acting.id, COSTS.settlement);
			localSnap.pieces.push({ teamId: acting.id, kind: 'settlement', loc: v });
			localSnap.holders = updateHolders(localSnap);
			post('settle', { team: acting.id, loc: v });
			afterPlacement();
		} else if (mode === 'city') {
			const verdict = canUpgradeCity(localSnap, acting.id, v);
			if (!verdict.ok) return void (localError = verdict.reason);
			const piece = localSnap.pieces.find((p) => p.loc === v && p.kind === 'settlement');
			if (!piece) return;
			piece.kind = 'city';
			pay(acting.id, COSTS.city);
			post('city', { team: acting.id, loc: v });
			mode = null;
		} else if (mode === 'roll') {
			if (!view(acting.id).rollable.includes(v)) return void (localError = 'Not one of your (unfrozen) corners.');
			post('roll', { team: acting.id, loc: v }, { refresh: true });
			mode = null;
		} else if (mode === 'pker') {
			post('play', { team: acting.id, card: pendingCard, loc: v }, { refresh: true });
			mode = null;
			pendingCard = '';
		}
	}

	function clickEdge(e: string) {
		if (mode !== 'road') return;
		localError = '';
		const verdict = canPlaceRoad(localSnap, acting.id, e);
		if (!verdict.ok) return void (localError = verdict.reason);
		const team = localSnap.teams.find((t) => t.id === acting.id);
		const inSetup = draft !== null;
		if (!inSetup && team && team.freeRoads > 0) team.freeRoads -= 1;
		else if (!inSetup) pay(acting.id, COSTS.road);
		localSnap.pieces.push({ teamId: acting.id, kind: 'road', loc: e });
		localSnap.holders = updateHolders(localSnap);
		post('road', { team: acting.id, loc: e });
		afterPlacement();
	}

	function teamName(id: string | null) {
		return localSnap.teams.find((t) => t.id === id)?.name ?? '—';
	}

	function fmtDetail(detail: Record<string, unknown>) {
		return Object.entries(detail)
			.map(([k, v]) => `${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`)
			.join(' · ');
	}
</script>

<svelte:head>
	<title>{game.name} — Gielinor Catan tester</title>
</svelte:head>

<main>
	<header class="top">
		<div>
			<a href="/admin/catan" class="back">← test games</a>
			<h1>{game.name}</h1>
			<p class="hint">
				Dev deck: {game.deckRemaining} cards left · first to {WINNING_VP} VP wins
				{#if pending > 0}<span class="sync">· syncing…</span>{/if}
			</p>
		</div>
	</header>

	{#if winner}
		<p class="winner">🏆 {winner.name} has reached {WINNING_VP} VP (hidden VP included)!</p>
	{/if}

	{#if localError || form?.error}
		<p class="error">{localError || form?.error}</p>
	{/if}

	{#if draft && draftTeam}
		<p class="draft">
			Setup draft — <b style="color: {draftTeam.color}">{draftTeam.name}</b>
			places a <b>{draft.expect}</b>
			(round {draft.round} of 2, pick {draft.pick + 1}/{localSnap.teams.length * 2})
			{#if acting.id !== draft.teamId || !mode}
				<button onclick={actAsDrafter}>Place as {draftTeam.name}</button>
			{/if}
		</p>
	{/if}

	<!-- act-as-team selector -->
	<nav class="teams">
		{#each localSnap.teams as t (t.id)}
			<button
				class="team-tab"
				class:active={t.id === acting.id}
				style="--team: {t.color}"
				onclick={() => {
					actingId = t.id;
					mode = null;
					pendingCard = '';
					localError = '';
				}}
			>
				<span class="dot"></span>
				{t.name}
				<span class="vp-badge">{view(t.id).vp.total}</span>
			</button>
		{/each}
	</nav>

	<div class="layout">
		<section class="board-wrap">
			<BoardMap
				board={game.board}
				pieces={localSnap.pieces}
				{teamColors}
				{highlightVertices}
				{highlightEdges}
				frozenVertices={frozenVerts}
				onVertex={clickVertex}
				onEdge={clickEdge}
			/>
			{#if mode}
				<p class="mode-hint">
					{#if mode === 'settle'}Click a highlighted corner to place a settlement.
					{:else if mode === 'road'}Click a highlighted edge to place a road.
					{:else if mode === 'city'}Click one of your settlements to upgrade it.
					{:else if mode === 'roll'}Click one of your corners to roll a task from its tiles.
					{:else if mode === 'pker'}Click a rival corner to freeze it for 24h.
					{/if}
					<button class="linkish" onclick={() => setMode(null)}>cancel</button>
				</p>
			{/if}
		</section>

		<section class="panel" style="--team: {acting.color}">
			<h2><span class="dot"></span>{acting.name}</h2>

			<div class="tokens">
				{#each ['boss', 'skilling', 'raids', 'custom', 'gold'] as t (t)}
					<span class="token {t}" title={t}>{TOKEN_SHORT[t]} {acting.tokens[t as keyof Tokens]}</span>
				{/each}
				{#if acting.freeRoads > 0}
					<span class="token free">🛤 {acting.freeRoads} free</span>
				{/if}
			</div>

			<div class="actions">
				<button class:on={mode === 'settle'} onclick={() => setMode('settle')}>
					Settlement <small>{draft ? 'FREE' : '1B 1S 1C'}</small>
				</button>
				<button class:on={mode === 'road'} onclick={() => setMode('road')}>
					Road <small>{draft || acting.freeRoads > 0 ? 'FREE' : '1S 1C'}</small>
				</button>
				<button class:on={mode === 'city'} onclick={() => setMode('city')} disabled={!!draft}>
					City <small>2R 2S</small>
				</button>
				<button
					class:on={mode === 'roll'}
					onclick={() => setMode('roll')}
					disabled={!!draft || view(acting.id).rollable.length === 0}
				>
					Roll task
				</button>
				<form method="POST" action="?/draw" use:enhance>
					<input type="hidden" name="team" value={acting.id} />
					<button type="submit" disabled={!!draft || game.deckRemaining === 0}>
						Draw dev card <small>1B 1S 1C</small>
					</button>
				</form>
			</div>

			<h3>Engine</h3>
			<p class="hint">
				Adjacent tiles: {TOKEN_TYPES.map((t) => `${TOKEN_SHORT[t]}×${view(acting.id).network[t]}`).join(' · ')}
				<br />
				Trade rates: {TOKEN_TYPES.map((t) => `${TOKEN_SHORT[t]} ${view(acting.id).rates[t]}:1`).join(' · ')}
				· Gold 2:1
			</p>

			<h3>Active tasks ({game.activeTasks.filter((t) => t.team_id === acting.id).length})</h3>
			<ul class="tasks">
				{#each game.activeTasks.filter((t) => t.team_id === acting.id) as task (task.id)}
					<li>
						<span class="task-desc">
							<b>{task.task.amount} {task.task.unit}</b> — {task.task.label}
							<small
								>({TILE_TYPE_LABEL[task.task.type]} {task.task.rating}, pays ≥{Math.max(
									1,
									view(acting.id).network[task.task.type]
								)} {TOKEN_SHORT[task.task.type]})</small
							>
						</span>
						<form method="POST" action="?/complete" use:enhance>
							<input type="hidden" name="team" value={acting.id} />
							<input type="hidden" name="task" value={task.id} />
							<button type="submit" class="ok">Complete</button>
						</form>
						<form method="POST" action="?/abandon" use:enhance>
							<input type="hidden" name="team" value={acting.id} />
							<input type="hidden" name="task" value={task.id} />
							<button type="submit" class="danger">Abandon</button>
						</form>
					</li>
				{:else}
					<li class="hint">No active tasks — roll a corner.</li>
				{/each}
			</ul>

			<h3>Dev cards in hand ({hand.length})</h3>
			<ul class="cards">
				{#each hand as card (card.id)}
					<li>
						<b>{DEV_CARD_LABEL[card.card as DevCardType]}</b>
						{#if card.card === 'vp'}
							<small class="hint">secret +1 VP, reveals at game end</small>
						{:else if card.card === 'pker'}
							<button
								class:on={mode === 'pker' && pendingCard === card.id}
								onclick={() => {
									pendingCard = card.id;
									mode = 'pker';
								}}
							>
								Target a corner…
							</button>
						{:else if card.card === 'bond'}
							<form method="POST" action="?/play" use:enhance class="inline">
								<input type="hidden" name="team" value={acting.id} />
								<input type="hidden" name="card" value={card.id} />
								<select name="token_type">
									{#each TOKEN_TYPES as t (t)}<option value={t}>{TILE_TYPE_LABEL[t]}</option>{/each}
								</select>
								<button type="submit">Collect from all teams</button>
							</form>
						{:else if card.card === 'birdhouse'}
							<form method="POST" action="?/play" use:enhance class="inline">
								<input type="hidden" name="team" value={acting.id} />
								<input type="hidden" name="card" value={card.id} />
								<select name="take1">
									{#each TOKEN_TYPES as t (t)}<option value={t}>{TILE_TYPE_LABEL[t]}</option>{/each}
								</select>
								<select name="take2">
									{#each TOKEN_TYPES as t (t)}<option value={t}>{TILE_TYPE_LABEL[t]}</option>{/each}
								</select>
								<button type="submit">Take 2 from bank</button>
							</form>
						{:else if card.card === 'shortcut'}
							<form method="POST" action="?/play" use:enhance class="inline">
								<input type="hidden" name="team" value={acting.id} />
								<input type="hidden" name="card" value={card.id} />
								<button type="submit">Play (2 free roads)</button>
							</form>
						{/if}
					</li>
				{:else}
					<li class="hint">No cards in hand.</li>
				{/each}
			</ul>

			<h3>Economy</h3>
			<form method="POST" action="?/trade" use:enhance class="inline econ">
				<span>Bank/port:</span>
				<select name="give">
					{#each TOKEN_TYPES as t (t)}<option value={t}>{view(acting.id).rates[t]}× {TILE_TYPE_LABEL[t]}</option>{/each}
				</select>
				<span>→</span>
				<select name="get">
					{#each TOKEN_TYPES as t (t)}<option value={t}>{TILE_TYPE_LABEL[t]}</option>{/each}
				</select>
				<input type="number" name="count" value="1" min="1" max="20" />
				<input type="hidden" name="team" value={acting.id} />
				<button type="submit">Trade</button>
			</form>
			<form method="POST" action="?/gold" use:enhance class="inline econ">
				<span>Gold 2:1 →</span>
				<select name="get">
					{#each TOKEN_TYPES as t (t)}<option value={t}>{TILE_TYPE_LABEL[t]}</option>{/each}
				</select>
				<input type="number" name="count" value="1" min="1" max="20" />
				<input type="hidden" name="team" value={acting.id} />
				<button type="submit">Exchange</button>
			</form>

			<h3>Tester cheats</h3>
			<form method="POST" action="?/grant" use:enhance class="inline econ">
				{#each ['boss', 'skilling', 'raids', 'custom', 'gold'] as t (t)}
					<label class="grant"><span>{TOKEN_SHORT[t]}</span><input type="number" name="grant_{t}" value="0" /></label>
				{/each}
				<input type="hidden" name="team" value={acting.id} />
				<button type="submit">Grant</button>
			</form>
			<p class="hint">
				Grant simulates task/gold income without the grind (e.g. +2 gold for a raids purple).
				Negative numbers deduct.
			</p>
		</section>
	</div>

	<section class="wide">
		<h2>Standings</h2>
		<table>
			<thead>
				<tr>
					<th>Team</th>
					<th>VP (public)</th>
					<th>VP (true)</th>
					<th>Settlements</th>
					<th>Cities</th>
					<th>Longest road</th>
					<th>PKers played</th>
					<th>Tokens</th>
				</tr>
			</thead>
			<tbody>
				{#each [...localSnap.teams].sort((a, b) => view(b.id).vp.total - view(a.id).vp.total) as t (t.id)}
					{@const v = view(t.id)}
					<tr class:me={t.id === acting.id}>
						<td><span class="dot" style="--team: {t.color}"></span> {t.name}</td>
						<td>{v.publicVP}</td>
						<td><b>{v.vp.total}</b>{#if v.vp.hiddenVP}<small> ({v.vp.hiddenVP} hidden)</small>{/if}</td>
						<td>{v.vp.settlements}</td>
						<td>{v.vp.cities}</td>
						<td>{v.longestRoad}{#if v.vp.longestRoad}<span title="Longest Road (+2)"> 👑</span>{/if}</td>
						<td>{v.army}{#if v.vp.largestArmy}<span title="Bounty Hunter (+2)"> 👑</span>{/if}</td>
						<td class="hint">
							{['boss', 'skilling', 'raids', 'custom', 'gold']
								.map((k) => `${TOKEN_SHORT[k]}${t.tokens[k as keyof Tokens]}`)
								.join(' ')}
						</td>
					</tr>
				{/each}
			</tbody>
		</table>
	</section>

	<section class="wide">
		<h2>Action log</h2>
		<ul class="log">
			{#each game.log as row, i (i)}
				<li>
					<span class="when">{new Date(row.created_at).toLocaleTimeString()}</span>
					<span class="dot" style="--team: {teamColors[row.team_id ?? ''] ?? 'transparent'}"></span>
					<b>{teamName(row.team_id)}</b>
					<span class="what">{row.action}</span>
					<span class="hint">{fmtDetail(row.detail)}</span>
				</li>
			{:else}
				<li class="hint">Nothing yet.</li>
			{/each}
		</ul>
	</section>
</main>

<style>
	main {
		max-width: 1400px;
		margin: 0 auto;
		padding: 1rem 1rem 3rem;
	}
	h1 {
		font-family: var(--font-heading);
		text-shadow: var(--ts-strong);
		margin: 0.25rem 0;
	}
	h2,
	h3 {
		font-family: var(--font-heading);
		text-shadow: var(--ts);
	}
	.back {
		color: var(--muted);
		font-size: 0.9rem;
	}
	.hint {
		color: var(--muted);
		font-size: 0.9rem;
	}
	.sync {
		color: var(--yellow);
	}
	.error {
		color: var(--danger);
		background: var(--danger-bg);
		border: 1px solid var(--danger);
		border-radius: var(--radius);
		padding: 0.5rem 0.75rem;
	}
	.winner {
		color: var(--success);
		background: var(--success-bg);
		border: 1px solid var(--success);
		border-radius: var(--radius);
		padding: 0.6rem 0.9rem;
		font-family: var(--font-heading);
	}
	.draft {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		flex-wrap: wrap;
		color: var(--yellow);
		background: var(--accent-soft);
		border: 1px solid var(--accent);
		border-radius: var(--radius);
		padding: 0.5rem 0.75rem;
	}

	.teams {
		display: flex;
		flex-wrap: wrap;
		gap: 0.4rem;
		margin: 0.75rem 0;
	}
	.team-tab {
		display: inline-flex;
		align-items: center;
		gap: 0.4rem;
		background: var(--surface-alt);
		border: 1px solid var(--border);
		border-radius: var(--radius);
		color: var(--text);
		padding: 0.35rem 0.6rem;
		cursor: pointer;
	}
	.team-tab.active {
		border-color: var(--team);
		background: var(--surface);
	}
	.vp-badge {
		background: var(--surface);
		border: 1px solid var(--border-strong);
		border-radius: 999px;
		padding: 0 0.4rem;
		font-size: 0.8rem;
	}
	.dot {
		width: 10px;
		height: 10px;
		border-radius: 50%;
		background: var(--team);
		display: inline-block;
		flex: none;
	}

	.layout {
		display: grid;
		grid-template-columns: minmax(0, 1.4fr) minmax(320px, 1fr);
		gap: 1rem;
		align-items: start;
	}
	@media (max-width: 980px) {
		.layout {
			grid-template-columns: 1fr;
		}
	}
	.board-wrap {
		background: var(--surface-alt);
		border: 1px solid var(--border);
		border-radius: var(--radius-lg);
		padding: 0.5rem;
	}
	.mode-hint {
		text-align: center;
		color: var(--accent);
		margin: 0.25rem 0;
	}
	.linkish {
		background: none;
		border: none;
		color: var(--muted);
		text-decoration: underline;
		cursor: pointer;
	}

	.panel {
		background: var(--surface-alt);
		border: 1px solid var(--border);
		border-radius: var(--radius-lg);
		padding: 0.75rem 1rem;
	}
	.panel h2 {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		margin-top: 0;
	}
	.tokens {
		display: flex;
		flex-wrap: wrap;
		gap: 0.4rem;
	}
	.token {
		border: 1px solid var(--border-strong);
		border-radius: var(--radius);
		padding: 0.2rem 0.5rem;
		background: var(--surface);
		font-family: var(--font-heading);
	}
	.token.raids {
		border-color: #a97fe8;
	}
	.token.gold {
		border-color: var(--gold-bright, #d9b65e);
		color: var(--gold-bright, #d9b65e);
	}
	.token.free {
		border-color: var(--success);
	}
	.actions {
		display: flex;
		flex-wrap: wrap;
		gap: 0.4rem;
		margin: 0.5rem 0;
	}
	button {
		background: var(--surface);
		border: 1px solid var(--border-strong);
		border-radius: var(--radius);
		color: var(--text);
		padding: 0.35rem 0.6rem;
		cursor: pointer;
	}
	button:hover:not(:disabled) {
		border-color: var(--accent);
	}
	button:disabled {
		opacity: 0.45;
		cursor: default;
	}
	button.on {
		border-color: var(--accent);
		background: var(--accent-soft);
	}
	button.ok:hover {
		border-color: var(--success);
	}
	button.danger:hover {
		border-color: var(--danger);
		color: var(--danger);
	}
	button small,
	.actions small {
		color: var(--muted);
	}

	.tasks,
	.cards {
		list-style: none;
		padding: 0;
		margin: 0.25rem 0;
		display: grid;
		gap: 0.4rem;
	}
	.tasks li,
	.cards li {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		flex-wrap: wrap;
		background: var(--surface);
		border: 1px solid var(--border);
		border-radius: var(--radius);
		padding: 0.4rem 0.6rem;
	}
	.task-desc {
		margin-right: auto;
	}
	.inline {
		display: inline-flex;
		align-items: center;
		gap: 0.35rem;
		flex-wrap: wrap;
	}
	.econ {
		margin: 0.3rem 0;
	}
	select,
	input[type='number'] {
		background: var(--surface);
		border: 1px solid var(--border);
		border-radius: var(--radius);
		color: var(--text);
		padding: 0.25rem 0.35rem;
	}
	input[type='number'] {
		width: 4.2rem;
	}
	.grant {
		display: inline-flex;
		align-items: center;
		gap: 0.2rem;
	}
	.grant span {
		color: var(--muted);
	}

	.wide {
		margin-top: 1.25rem;
	}
	table {
		width: 100%;
		border-collapse: collapse;
	}
	th,
	td {
		text-align: left;
		padding: 0.35rem 0.5rem;
		border-bottom: 1px solid var(--border);
	}
	th {
		color: var(--muted);
		font-weight: normal;
		font-size: 0.85rem;
	}
	tr.me td {
		background: var(--accent-soft);
	}

	.log {
		list-style: none;
		padding: 0;
		display: grid;
		gap: 0.25rem;
	}
	.log li {
		display: flex;
		align-items: baseline;
		gap: 0.5rem;
		flex-wrap: wrap;
	}
	.log .when {
		color: var(--muted-soft);
		font-size: 0.8rem;
	}
	.log .what {
		color: var(--accent);
	}
</style>

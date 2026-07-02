<script lang="ts">
	import { tick } from 'svelte';
	import { enhance } from '$app/forms';
	import BoardMap from '$lib/catan/BoardMap.svelte';
	import { TILE_TYPE_LABEL, type TileType } from '$lib/catan/board';
	import { DEV_CARD_LABEL, WINNING_VP, type DevCardType } from '$lib/catan/rules';
	import type { PageData, ActionData } from './$types';

	let { data, form }: { data: PageData; form: ActionData } = $props();

	const game = $derived(data.game);
	const TOKEN_TYPES: TileType[] = ['boss', 'skilling', 'raids', 'custom'];
	const TOKEN_SHORT: Record<string, string> = { boss: 'B', skilling: 'S', raids: 'R', custom: 'C', gold: 'G' };

	let actingId = $state('');
	const acting = $derived(game.teams.find((t) => t.id === actingId) ?? game.teams[0]);

	type Mode = 'settle' | 'road' | 'city' | 'roll' | 'pker' | null;
	let mode = $state<Mode>(null);
	let pendingCard = $state('');
	let pendingLoc = $state('');
	let boardAction = $state('settle');
	let boardForm: HTMLFormElement | null = $state(null);

	const teamColors = $derived(Object.fromEntries(game.teams.map((t) => [t.id, t.color])));
	const frozenVerts = $derived(game.freezes.map((f) => f.loc));
	const frozenSet = $derived(new Set(frozenVerts));

	const ownSettlements = $derived(
		game.pieces.filter((p) => p.kind === 'settlement' && p.team_id === acting.id).map((p) => p.loc)
	);
	const rivalBuildings = $derived(
		game.pieces
			.filter((p) => p.kind !== 'road' && p.team_id !== acting.id && !frozenSet.has(p.loc))
			.map((p) => p.loc)
	);

	const highlightVertices = $derived(
		mode === 'settle'
			? acting.legalSettlements
			: mode === 'city'
				? ownSettlements
				: mode === 'roll'
					? acting.rollable
					: mode === 'pker'
						? rivalBuildings
						: []
	);
	const highlightEdges = $derived(mode === 'road' ? acting.legalRoads : []);

	function setMode(m: Mode) {
		mode = mode === m ? null : m;
		if (mode !== 'pker') pendingCard = '';
	}

	async function submitBoard(action: string, loc: string) {
		boardAction = action;
		pendingLoc = loc;
		await tick();
		boardForm?.requestSubmit();
	}

	function clickVertex(v: string) {
		if (mode === 'settle') submitBoard('settle', v);
		else if (mode === 'city') submitBoard('city', v);
		else if (mode === 'roll') submitBoard('roll', v);
		else if (mode === 'pker') submitBoard('play', v);
	}

	function clickEdge(e: string) {
		if (mode === 'road') submitBoard('road', e);
	}

	function hand(teamId: string) {
		const t = game.teams.find((x) => x.id === teamId);
		return (t?.devCards ?? []).filter((c) => !c.played_at);
	}

	function teamName(id: string | null) {
		return game.teams.find((t) => t.id === id)?.name ?? '—';
	}

	function fmtDetail(detail: Record<string, unknown>) {
		return Object.entries(detail)
			.map(([k, v]) => `${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`)
			.join(' · ');
	}

	const setupDone = $derived(acting.setup.settlements === 0 && acting.setup.roads === 0);
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
			</p>
		</div>
	</header>

	{#if game.winner}
		<p class="winner">🏆 {game.winner.name} has reached {WINNING_VP} VP (hidden VP included)!</p>
	{/if}

	{#if form?.error}
		<p class="error">{form.error}</p>
	{/if}

	<!-- act-as-team selector -->
	<nav class="teams">
		{#each game.teams as t (t.id)}
			<button
				class="team-tab"
				class:active={t.id === acting.id}
				style="--team: {t.color}"
				onclick={() => {
					actingId = t.id;
					mode = null;
					pendingCard = '';
				}}
			>
				<span class="dot"></span>
				{t.name}
				<span class="vp-badge">{t.vp.total}</span>
			</button>
		{/each}
	</nav>

	<div class="layout">
		<section class="board-wrap">
			<BoardMap
				board={game.board}
				pieces={game.snapshot.pieces}
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
					<span class="token {t}" title={t}>{TOKEN_SHORT[t]} {acting.tokens[t as keyof typeof acting.tokens]}</span>
				{/each}
				{#if acting.freeRoads > 0}
					<span class="token free">🛤 {acting.freeRoads} free</span>
				{/if}
			</div>

			{#if !setupDone}
				<p class="setup">
					Setup: {acting.setup.settlements} free settlement{acting.setup.settlements === 1 ? '' : 's'} +
					{acting.setup.roads} free road{acting.setup.roads === 1 ? '' : 's'} remaining
				</p>
			{/if}

			<div class="actions">
				<button class:on={mode === 'settle'} onclick={() => setMode('settle')}>
					Settlement <small>{acting.setup.settlements > 0 ? 'FREE' : '1B 1S 1C'}</small>
				</button>
				<button class:on={mode === 'road'} onclick={() => setMode('road')}>
					Road <small>{acting.setup.roads > 0 || acting.freeRoads > 0 ? 'FREE' : '1S 1C'}</small>
				</button>
				<button class:on={mode === 'city'} onclick={() => setMode('city')}>
					City <small>2R 2S</small>
				</button>
				<button class:on={mode === 'roll'} onclick={() => setMode('roll')} disabled={acting.rollable.length === 0}>
					Roll task
				</button>
				<form method="POST" action="?/draw" use:enhance>
					<input type="hidden" name="team" value={acting.id} />
					<button type="submit" disabled={game.deckRemaining === 0}>Draw dev card <small>1B 1S 1C</small></button>
				</form>
			</div>

			<h3>Engine</h3>
			<p class="hint">
				Adjacent tiles: {TOKEN_TYPES.map((t) => `${TOKEN_SHORT[t]}×${acting.network[t]}`).join(' · ')}
				<br />
				Trade rates: {TOKEN_TYPES.map((t) => `${TOKEN_SHORT[t]} ${acting.rates[t]}:1`).join(' · ')}
				· Gold 2:1
			</p>

			<h3>Active tasks ({game.activeTasks.filter((t) => t.team_id === acting.id).length})</h3>
			<ul class="tasks">
				{#each game.activeTasks.filter((t) => t.team_id === acting.id) as task (task.id)}
					<li>
						<span class="task-desc">
							<b>{task.task.amount} {task.task.unit}</b> — {task.task.label}
							<small>({TILE_TYPE_LABEL[task.task.type]} {task.task.rating}, pays ≥{Math.max(1, acting.network[task.task.type])} {TOKEN_SHORT[task.task.type]})</small>
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

			<h3>Dev cards in hand ({hand(acting.id).length})</h3>
			<ul class="cards">
				{#each hand(acting.id) as card (card.id)}
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
					{#each TOKEN_TYPES as t (t)}<option value={t}>{acting.rates[t]}× {TILE_TYPE_LABEL[t]}</option>{/each}
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
				{#each [...game.teams].sort((a, b) => b.vp.total - a.vp.total) as t (t.id)}
					<tr class:me={t.id === acting.id}>
						<td><span class="dot" style="--team: {t.color}"></span> {t.name}</td>
						<td>{t.publicVP}</td>
						<td><b>{t.vp.total}</b>{#if t.vp.hiddenVP}<small> ({t.vp.hiddenVP} hidden)</small>{/if}</td>
						<td>{t.vp.settlements}</td>
						<td>{t.vp.cities}</td>
						<td>{t.longestRoad}{#if t.vp.longestRoad}<span title="Longest Road (+2)"> 👑</span>{/if}</td>
						<td>{t.army}{#if t.vp.largestArmy}<span title="Bounty Hunter (+2)"> 👑</span>{/if}</td>
						<td class="hint">
							{['boss', 'skilling', 'raids', 'custom', 'gold']
								.map((k) => `${TOKEN_SHORT[k]}${t.tokens[k as keyof typeof t.tokens]}`)
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

	<!-- hidden form the board clicks submit through -->
	<form
		method="POST"
		action="?/{boardAction}"
		use:enhance={() =>
			async ({ update }) => {
				await update();
				if (mode === 'pker' || mode === 'city') {
					mode = null;
					pendingCard = '';
				}
			}}
		bind:this={boardForm}
		class="visually-hidden"
	>
		<input type="hidden" name="team" value={acting.id} />
		<input type="hidden" name="loc" value={pendingLoc} />
		<input type="hidden" name="card" value={pendingCard} />
	</form>
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
	.setup {
		color: var(--yellow);
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

	.visually-hidden {
		position: absolute;
		width: 1px;
		height: 1px;
		overflow: hidden;
		clip: rect(0 0 0 0);
	}
</style>

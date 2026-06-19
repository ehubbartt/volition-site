<script lang="ts">
	import type { PageData } from './$types';
	import BoardMap from '$lib/board/BoardMap.svelte';
	import BoardLeaderboard from '$lib/board/BoardLeaderboard.svelte';
	import BoardSubmitModal from '$lib/board/BoardSubmitModal.svelte';
	import BoardBossModal from '$lib/board/BoardBossModal.svelte';
	import BoardChoosePathModal from '$lib/board/BoardChoosePathModal.svelte';
	import BoardAckModal from '$lib/board/BoardAckModal.svelte';
	import BoardFireworks from '$lib/board/BoardFireworks.svelte';
	import BoardCompleteModal from '$lib/board/BoardCompleteModal.svelte';
	import Lightbox from '$lib/Lightbox.svelte';
	import { getBoardTopology } from '$lib/board/topology';
	import { parseDuoNodeId, duoPathId, DUO_SECTION_ROWS, DUO_FLOORS, type DuoSection } from '$lib/board/config';
	import { laneCountForFloor } from '$lib/board/progress';

	let { data }: { data: PageData } = $props();

	// The event codeword players must have in their WOM plug-in / mobile chat box.
	const EVENT_CODEWORD = 'VOLI';

	// First-visit acknowledgement gate: shown to players on the LIVE board until they confirm
	// they've read the rules (remembered via the per-event cookie). Skipped for the full admin
	// board view (adminView) — admins previewing-as-player still see it to test the flow.
	let ackConfirmed = $state(false);
	const ackOpen = $derived(
		!ackConfirmed && data.status === 'open' && !data.adminView && !data.boardAck
	);

	function confirmAck() {
		document.cookie = `${data.ackCookieName}=1; path=/; max-age=${60 * 60 * 24 * 365}; samesite=lax`;
		ackConfirmed = true;
	}

	const topology = getBoardTopology();
	const contentVisible = $derived(Object.keys(data.content).length > 0);
	const lockedFloors = $derived(contentVisible ? [] : [2, 3]);

	// Where to auto-center on load: the team's current frontier (the active tile, or the
	// section being chosen). Only the player/preview payload carries per-team nodeState —
	// the full admin board has none, so it stays at the default view. BoardMap reads this
	// once on mount and centers + zooms the floor on the centroid of those nodes.
	const focusTarget = $derived.by(() => {
		const states = data.nodeState;
		const active = topology.nodes.filter((n) => states[n.id] === 'active');
		const choosable = topology.nodes.filter((n) => states[n.id] === 'choosable');
		const frontier = active.length ? active : choosable;
		if (!frontier.length) return null;
		const floor = frontier[0].floor;
		const onFloor = frontier.filter((n) => n.floor === floor);
		const x = onFloor.reduce((s, n) => s + n.x, 0) / onFloor.length;
		const y = onFloor.reduce((s, n) => s + n.y, 0) / onFloor.length;
		return { floor, x, y };
	});

	// Admin-only view toggle (server-side preview): flips ?view=player so the load returns
	// the real player payload — the full board SKELETON with names/images blocked to "?"
	// for tiles the team hasn't revealed yet — and back to the full admin board.
	const toggleHref = $derived(
		data.previewAsPlayer
			? `/events/${data.event.slug}/board`
			: `/events/${data.event.slug}/board?view=player`
	);

	let openNodeId = $state<string | null>(null);
	// Boss tiles open the dedicated "boss room" (HP bar + deal-damage) instead of the
	// standard submit modal.
	const openIsBoss = $derived(openNodeId ? parseDuoNodeId(openNodeId)?.kind === 'boss' : false);

	// Boss-kill celebration. `celebrating` = fireworks for a non-final boss (then pan to the
	// next floor); `completed` = the final boss → fireworks + the "completed Duo Wolf" screen.
	// `recenterNonce` is bumped to make BoardMap re-focus the freshly-unlocked next floor.
	let celebrating = $state(false);
	let completed = $state(false);
	let recenterNonce = $state(0);

	function handleBossDefeat() {
		const ref = openNodeId ? parseDuoNodeId(openNodeId) : null;
		const isFinalBoss = !!ref && ref.kind === 'boss' && ref.floor >= DUO_FLOORS;
		openNodeId = null; // close the boss room so the celebration is front-and-centre
		if (isFinalBoss) {
			completed = true;
		} else {
			celebrating = true;
		}
	}

	// Non-final boss: once the fireworks finish, pan/zoom the board onto the next floor.
	function onCelebrationDone() {
		celebrating = false;
		recenterNonce += 1;
	}
	const openTile = $derived.by(() => {
		if (!openNodeId) return null;
		const c = data.content[openNodeId];
		if (!c) return null;
		return { id: openNodeId, name: c.name, img: c.img, faq_html: c.faq_html, autoClear: c.autoClear ?? null, prePic: c.prePic ?? null };
	});

	// Swap options for the open tile: the same-step tiles on adjacent paths. Only offered
	// when this is the team's active, not-yet-started path tile that hasn't been swapped and
	// the team still has swaps. Empty ⇒ the modal hides the swap UI.
	const swapOptions = $derived.by(() => {
		const id = openNodeId;
		if (!id || (data.swapsAvailable ?? 0) <= 0) return [];
		const ref = parseDuoNodeId(id);
		if (!ref || ref.kind !== 'path' || ref.section == null || ref.lane == null || ref.step == null) return [];
		if (data.nodeState[id] !== 'active') return [];
		const prog = data.nodeProgress[id];
		if (prog && prog.approved + prog.pending > 0) return [];
		if (data.swaps.some((s) => s.floor === ref.floor && s.section === ref.section && s.step === ref.step))
			return [];
		const opts: { to_lane: number; name: string; img: string | null }[] = [];
		const lanes = laneCountForFloor(ref.floor);
		for (let to = 0; to < lanes; to++) {
			if (to === ref.lane) continue; // any OTHER parallel path at this step
			const c = data.content[duoPathId(ref.floor, ref.section, to, ref.step)];
			if (c) opts.push({ to_lane: to, name: c.name, img: c.img });
		}
		return opts;
	});

	let openChoose = $state<{ floor: number; section: DuoSection } | null>(null);
	const openChooseLanes = $derived.by(() => {
		if (!openChoose) return [];
		const { floor, section } = openChoose;
		const lanes = [];
		for (let lane = 0; lane < laneCountForFloor(floor); lane++) {
			const tiles = [];
			for (let step = 0; step < DUO_SECTION_ROWS; step++) {
				const id = duoPathId(floor, section, lane, step);
				const c = data.content[id];
				if (c) tiles.push({ id, name: c.name, img: c.img, required: data.nodeProgress[id]?.required ?? 1 });
			}
			lanes.push({ lane, tiles });
		}
		return lanes;
	});

	function onNodeClick(id: string) {
		if (data.nodeState[id] === 'choosable') {
			const ref = parseDuoNodeId(id);
			if (ref && ref.kind === 'path' && ref.section) {
				openChoose = { floor: ref.floor, section: ref.section };
			}
			return;
		}
		if (data.content[id]) openNodeId = id;
	}

	function closeModal() {
		openNodeId = null;
	}

	let lightboxSrc = $state<string | null>(null);
</script>

<svelte:head>
	<title>{data.event.name} · Board · Volition</title>
	<!-- Tile item art is often hotlinked from external wikis (OSRS wiki, Fandom) that block
	     requests carrying a referrer. The board renders node art as SVG <image>, where the
	     per-img referrerpolicy attr isn't honored — so set it document-wide here instead.
	     Safe: SvelteKit's CSRF check uses the Origin header, not Referer. -->
	<meta name="referrer" content="no-referrer" />
</svelte:head>

<nav class="crumbs">
	<a href="/events/{data.event.slug}?view=teams">👥 View teams &amp; standings</a>
	<a href="/evidence-guide" target="_blank" rel="noopener">📋 Evidence guide</a>
</nav>

<section class="hero">
	<div class="hero-head">
		<h1>{data.event.name} · Board</h1>
		<span class="badge {data.event.status}">{data.event.status}</span>
		{#if !data.adminView && data.hasTeam}
			<span
				class="swaps-badge"
				title={`${data.swapsBase}/${data.swapsPerFloor} base swaps this floor${data.swapsBonus ? ` · ${data.swapsBonus} bonus` : ''} · resets after each floor boss`}
			>
				🔀 {data.swapsAvailable} swap{data.swapsAvailable === 1 ? '' : 's'}
			</span>
		{/if}
		{#if data.canToggleView}
			<a class="view-toggle" class:previewing={data.previewAsPlayer} href={toggleHref} data-sveltekit-noscroll>
				{data.previewAsPlayer ? '👁 Previewing as player — back to admin view' : '🧪 Preview as player'}
			</a>
		{/if}
	</div>
	{#if contentVisible}
		<p class="muted teaser">
			{#if data.status === 'open'}
				The climb has <strong>{topology.floors.length} floors</strong> — you're viewing one at a time
				(switch with the floor tabs, top-left). Each floor has <strong>3 sections (A → B → C)</strong>
				split by intermission tiles and ends in a <strong>boss</strong>; beat it to climb to the next.
				Pick a path, complete its tiles, then tackle the intermission before choosing the next. Click
				any tile for the rules and to submit your team's proof.
			{:else}
				Admin preview — the board is still sealed for players. Each of the {topology.floors.length}
				floors has 3 sections (A → B → C) + a boss. Click any tile to review its rules and proofs.
			{/if}
		</p>
	{:else}
		<p class="muted teaser">
			The board is sealed until the event begins. Tile contents will be revealed when your team
			reaches each section — for now, scroll and pan to see the shape of the climb.
		</p>
	{/if}
</section>

<div class="board-layout" class:has-side={data.leaderboard.length > 0}>
	<div class="board-main">
		<BoardMap
			{topology}
			{lockedFloors}
			content={data.content}
			nodeState={data.nodeState}
			nodeProgress={data.nodeProgress}
			teamMarkers={data.teamMarkers}
			focus={focusTarget}
			focusNonce={recenterNonce}
			{onNodeClick}
		/>
	</div>
	{#if data.leaderboard.length > 0}
		<BoardLeaderboard
			leaderboard={data.leaderboard}
			byClan={data.byClan}
			teamCount={data.teamCount}
			fill
		/>
	{/if}
</div>

{#if openTile && openIsBoss}
	<BoardBossModal
		tile={openTile}
		status={data.status}
		teamSubmissions={data.teamSubmissionsByTile[openTile.id] ?? []}
		community={data.completionsByTile[openTile.id] ?? []}
		communityCount={data.completionCountByTile[openTile.id] ?? 0}
		canSubmit={data.isClanMember && data.hasTeam && data.nodeState[openTile.id] === 'active'}
		isAdmin={data.adminView}
		testMode={data.previewAsPlayer}
		progress={data.nodeProgress[openTile.id] ?? null}
		onZoom={(url) => (lightboxSrc = url)}
		onclose={closeModal}
		onDefeat={handleBossDefeat}
	/>
{:else if openTile}
	<BoardSubmitModal
		tile={openTile}
		status={data.status}
		teamSubmissions={data.teamSubmissionsByTile[openTile.id] ?? []}
		community={data.completionsByTile[openTile.id] ?? []}
		communityCount={data.completionCountByTile[openTile.id] ?? 0}
		canSubmit={data.isClanMember && data.hasTeam && data.nodeState[openTile.id] === 'active'}
		isAdmin={data.adminView}
		testMode={data.previewAsPlayer}
		progress={data.nodeProgress[openTile.id] ?? null}
		swapsAvailable={data.swapsAvailable}
		swapOptions={swapOptions}
		onZoom={(url) => (lightboxSrc = url)}
		onclose={closeModal}
	/>
{/if}

{#if openChoose}
	<BoardChoosePathModal
		floor={openChoose.floor}
		section={openChoose.section}
		lanes={openChooseLanes}
		onclose={() => (openChoose = null)}
	/>
{/if}

{#if lightboxSrc}
	<Lightbox src={lightboxSrc} alt="DuoWolf proof" onclose={() => (lightboxSrc = null)} />
{/if}

{#if ackOpen}
	<BoardAckModal
		eventName={data.event.name}
		codeword={EVENT_CODEWORD}
		guideHref="/evidence-guide"
		onConfirm={confirmAck}
	/>
{/if}

{#if celebrating}
	<BoardFireworks oncomplete={onCelebrationDone} />
{/if}

{#if completed}
	<BoardFireworks loop />
	<BoardCompleteModal eventName={data.event.name} onclose={() => (completed = false)} />
{/if}

<style>
	.crumbs {
		display: flex;
		flex-wrap: wrap;
		gap: 0.4rem 1.25rem;
		margin-bottom: 0.75rem;
	}

	.crumbs a {
		color: rgba(255, 255, 255, 0.5);
		font-size: 0.95rem;
		text-decoration: none;
	}

	.crumbs a:hover {
		color: var(--accent);
	}

	.board-layout {
		display: grid;
		grid-template-columns: 1fr;
		gap: 0.75rem;
	}

	.board-layout.has-side {
		grid-template-columns: minmax(0, 1fr) 18rem;
	}

	/* Below ~900px the leaderboard drops under the board (full width, scrolls internally). */
	@media (max-width: 900px) {
		.board-layout.has-side {
			grid-template-columns: 1fr;
		}
	}

	.hero {
		margin-bottom: 1rem;
		padding: 1.1rem 1.4rem;
		background: linear-gradient(180deg, rgba(58, 48, 36, 0.7), rgba(40, 32, 24, 0.7));
		border: 1px solid var(--border);
		border-radius: var(--radius);
		box-shadow: var(--shadow-card);
	}

	.hero-head {
		display: flex;
		align-items: center;
		gap: 0.75rem;
		flex-wrap: wrap;
		margin-bottom: 0.4rem;
	}

	.hero h1 {
		margin: 0;
	}

	.teaser {
		max-width: 46rem;
		margin: 0;
	}

	.muted {
		color: var(--muted);
	}

	.badge {
		display: inline-block;
		padding: 0.1rem 0.55rem;
		font-size: 0.8rem;
		text-transform: uppercase;
		letter-spacing: 0.05em;
		border-radius: 3px;
		background: var(--surface-alt);
		border: 1px solid var(--border);
		color: var(--muted);
	}

	.badge.open {
		background: var(--accent-soft);
		border-color: var(--accent);
		color: var(--accent);
	}

	.swaps-badge {
		display: inline-block;
		padding: 0.1rem 0.55rem;
		font-size: 0.8rem;
		font-family: var(--font-heading);
		letter-spacing: 0.5px;
		border-radius: 3px;
		background: rgba(240, 210, 60, 0.12);
		border: 1px solid var(--yellow);
		color: var(--yellow);
		cursor: help;
	}

	.view-toggle {
		margin-left: auto;
		display: inline-block;
		padding: 0.3rem 0.7rem;
		font-size: 0.85rem;
		border: 1px dashed var(--accent);
		border-radius: 4px;
		color: var(--accent);
		text-decoration: none;
		white-space: nowrap;
	}

	.view-toggle:hover {
		background: var(--accent-soft);
		text-decoration: none;
	}

	.view-toggle.previewing {
		border-style: solid;
		background: var(--accent-soft);
	}
</style>

<script lang="ts">
	import type { PageData } from './$types';
	import BoardMap from '$lib/board/BoardMap.svelte';
	import BoardSubmitModal from '$lib/board/BoardSubmitModal.svelte';
	import BoardBossModal from '$lib/board/BoardBossModal.svelte';
	import BoardChoosePathModal from '$lib/board/BoardChoosePathModal.svelte';
	import Lightbox from '$lib/Lightbox.svelte';
	import { getBoardTopology } from '$lib/board/topology';
	import { parseDuoNodeId, duoPathId, DUO_SECTION_ROWS, type DuoSection } from '$lib/board/config';
	import { laneCountForFloor } from '$lib/board/progress';

	let { data }: { data: PageData } = $props();

	const topology = getBoardTopology();
	const contentVisible = $derived(Object.keys(data.content).length > 0);
	const lockedFloors = $derived(contentVisible ? [] : [2, 3]);

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
	const openTile = $derived.by(() => {
		if (!openNodeId) return null;
		const c = data.content[openNodeId];
		if (!c) return null;
		return { id: openNodeId, name: c.name, img: c.img, faq_html: c.faq_html, autoClear: c.autoClear ?? null };
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
</svelte:head>

<nav class="crumbs">
	<a href="/events/{data.event.slug}">← Back to {data.event.name}</a>
</nav>

<section class="hero">
	<div class="hero-head">
		<h1>{data.event.name} · Board</h1>
		<span class="badge {data.event.status}">{data.event.status}</span>
		{#if data.canToggleView}
			<a class="view-toggle" class:previewing={data.previewAsPlayer} href={toggleHref} data-sveltekit-noscroll>
				{data.previewAsPlayer ? '👁 Previewing as player — back to admin view' : '🧪 Preview as player'}
			</a>
		{/if}
	</div>
	{#if contentVisible}
		<p class="muted teaser">
			{#if data.status === 'open'}
				Pick a path, complete its tiles, then tackle the intermission tile before choosing the next.
				Click any tile for the rules and to submit your team's proof.
			{:else}
				Admin preview — the board is still sealed for players. Click any tile to review its rules and
				proofs.
			{/if}
		</p>
	{:else}
		<p class="muted teaser">
			The board is sealed until the event begins. Tile contents will be revealed when your team
			reaches each section — for now, scroll and pan to see the shape of the climb.
		</p>
	{/if}
</section>

<BoardMap
	{topology}
	{lockedFloors}
	content={data.content}
	nodeState={data.nodeState}
	nodeProgress={data.nodeProgress}
	{onNodeClick}
/>

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

<style>
	.crumbs {
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

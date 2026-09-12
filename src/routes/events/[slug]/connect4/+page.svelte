<script lang="ts">
	import { enhance } from '$app/forms';
	import BoardAckModal from '$lib/board/BoardAckModal.svelte';
	import {
		saveDraftFiles,
		loadDraftFiles,
		clearDraftFiles,
		sweepExpiredDrafts
	} from '$lib/board/draftStore';
	import type { PageData, ActionData } from './$types';
	import { invalidateAll } from '$app/navigation';
	import { onMount, tick } from 'svelte';
	import { swrResource } from '$lib/swrResource.svelte';
	import Skeleton from '$lib/Skeleton.svelte';
	import Connect4Board from '$lib/connect4/Connect4Board.svelte';
	import Connect4Board3D, { type HoverInfo } from '$lib/connect4/Connect4Board3D.svelte';
	import TileHoverCard, { type CardInfo } from '$lib/connect4/TileHoverCard.svelte';
	import WikiImage from '$lib/WikiImage.svelte';
	import { createClock, untilText } from '$lib/clock.svelte';
	// No monsterImageUrl: the source's own icon was dropped so the wiki budget goes on
	// the ITEM icons, which are what a player actually reads off the board.
	import { itemImageUrl, nameInitials } from '$lib/wikiImage';
	import {
		columnLabel,
		runCellSet,
		standings as computeStandings
	} from '$lib/connect4/rules';
	import { formatEhb } from '$lib/ehb';
	import { Playback, loadSeen, saveSeen, paceFor } from '$lib/connect4/playback.svelte';
	import { liveEvent } from '$lib/live.svelte';
	import type { Connect4PageResult } from '$lib/server/connect4Page';

	// The member board — the SPECTATOR half of the Connect Four event. The admin tester
	// (/admin/connect4/[slug]) drives the game; this page only watches it: same board,
	// same rail, same replay machinery, none of the crediting. Because nobody acts from
	// here there is no optimistic local state to protect — the server snapshot IS the
	// board, and the version poll keeps it honest (docs/LIVE-UPDATES.md).

	let { data, form }: { data: PageData; form: ActionData } = $props();

	// Set while a claim submission is in flight, so the button can say so.
	let submitting = $state(false);

	// ── Staged proof, kept across closing the tile ────────────────────────────
	// The reason this is not a bare <input type=file>: you screenshot the drop, then carry
	// on playing, then come back to submit. Staged images live in IndexedDB keyed by
	// column (via draftStore, the same store the DuoWolf board uses), so dropping one in
	// and clicking away does not lose it — reopen the column and it is still there.
	let staged = $state<{ file: File; url: string }[]>([]);
	let fileInput = $state<HTMLInputElement>();
	let dragging = $state(false);
	/** How many of a multi-drop tile's requirement this proof covers. */
	let quantity = $state(1);

	const draftKey = (col: number) => `c4:${game?.id ?? ''}:${col}`;

	/** Brief "got it" acknowledgement after a paste, so the action is not silent. */
	let pasted = $state(false);

	/**
	 * The claim being re-evidenced, when an admin has asked for a better screenshot. Held
	 * separately from `selected` because the two disagree on purpose: the column is showing
	 * its NEXT tile, while this is the one the player still holds.
	 */
	type Awaiting = NonNullable<typeof game>['awaiting'][number];
	let resubmit = $state<
		{ cell: string; col: number; deckIdx: number; tile: Awaiting['tile'] } | null
	>(null);
	function cancelResubmit() {
		resubmit = null;
	}
	function startResubmit(a: Awaiting) {
		resubmit = { cell: a.cell, col: a.col, deckIdx: a.deckIdx, tile: a.tile };
		selected = a.col; // keeps the staged-file drafts, which are keyed by column
		queueMicrotask(() =>
			document.querySelector('.claim-form')?.scrollIntoView({ behavior: 'smooth', block: 'center' })
		);
	}

	function addFiles(list: FileList | File[] | null) {
		const incoming = Array.from(list ?? []).filter((f) => f.type.startsWith('image/'));
		if (!incoming.length) return;
		staged = [...staged, ...incoming.map((f) => ({ file: f, url: URL.createObjectURL(f) }))];
		persist();
	}
	/**
	 * PASTE, the way every other submission form on the site takes it. A drop screenshot
	 * lives on the clipboard, and asking someone to save it to disk first — 240 people,
	 * many on one hand mid-raid — is the slowest possible way to claim a tile.
	 *
	 * Bound to the window rather than the drop zone: the claim form only exists for the
	 * one tile that is open, so there is nothing else on the page competing for the paste,
	 * and it works without the player having to click into the box first.
	 */
	function onPaste(e: ClipboardEvent) {
		if (selected === null) return;
		const items = e.clipboardData?.items;
		const files: File[] = [...(e.clipboardData?.files ?? [])];
		if (!files.length && items) {
			for (const it of items) {
				if (it.kind !== 'file') continue;
				const f = it.getAsFile();
				if (f) files.push(f);
			}
		}
		const images = files.filter((f) => f.type.startsWith('image/'));
		if (!images.length) return;
		// Only swallow the paste once we know it carried an image — a player pasting text
		// into a form field elsewhere must be left alone.
		e.preventDefault();
		addFiles(images);
		pasted = true;
		setTimeout(() => (pasted = false), 2500);
	}

	function removeStaged(i: number) {
		const gone = staged[i];
		if (gone) URL.revokeObjectURL(gone.url);
		staged = staged.filter((_, n) => n !== i);
		persist();
	}
	function persist() {
		if (selected === null || !game) return;
		void saveDraftFiles(draftKey(selected), staged.map((s) => s.file));
	}
	function clearStaged() {
		for (const s of staged) URL.revokeObjectURL(s.url);
		staged = [];
		if (fileInput) fileInput.value = '';
		if (selected !== null && game) void clearDraftFiles(draftKey(selected));
	}

	// Restore whatever was staged for the column being opened.
	$effect(() => {
		const col = selected;
		const id = game?.id;
		if (col === null || !id) return;
		let cancelled = false;
		void sweepExpiredDrafts();
		(async () => {
			const files = await loadDraftFiles(`c4:${id}:${col}`);
			if (cancelled) return;
			for (const s of staged) URL.revokeObjectURL(s.url);
			staged = files.map((f) => ({ file: f, url: URL.createObjectURL(f) }));
		})();
		return () => {
			cancelled = true;
		};
	});

	/** "4m ago" — the waiting room cares about recency, not wall-clock time. */
	function ago(iso: string): string {
		const ms = Date.now() - Date.parse(iso);
		if (!isFinite(ms) || ms < 0) return 'just now';
		const m = Math.floor(ms / 60000);
		if (m < 1) return 'just now';
		if (m < 60) return `${m}m ago`;
		const h = Math.floor(m / 60);
		return h < 24 ? `${h}h ago` : `${Math.floor(h / 24)}d ago`;
	}


	const EMPTY = { kind: 'ok', live: '', game: null } as unknown as Connect4PageResult;
	const res = swrResource(() => data.connect4, EMPTY);
	const payload = $derived(res.value as Connect4PageResult);
	const game = $derived(payload?.kind === 'ok' ? payload.game : null);

	// ── Evidence acknowledgement ──────────────────────────────────────────────
	// The same first-visit gate the DuoWolf board uses. It matters more here: this
	// event is scored entirely on manual proof, and an admin has to compare the drop's
	// in-game time against when the tile went up — which they can only do if the player
	// has chat timestamps on and knows the rule. Remembered per event in a cookie; a UX
	// nudge, not a security gate (the server validates every submission regardless).
	const EVENT_CODEWORD = 'HASBRO';
	let ackConfirmed = $state(false);
	const ackCookie = $derived(game ? `voli_c4_ack_${game.id}` : '');
	const ackOpen = $derived(
		!!game && game.phase === 'live' && !!game.viewerSide && !ackConfirmed
	);
	function confirmAck() {
		try {
			document.cookie = `${ackCookie}=1; path=/; max-age=${60 * 60 * 24 * 365}; samesite=lax`;
		} catch {
			/* cookies blocked — the gate simply reappears next visit */
		}
		ackConfirmed = true;
	}

	// A dealt board waiting on its announced start. Ticks once a second so the countdown
	// runs and the board opens itself on the stroke, with nobody reloading.
	const clock = createClock(1000);
	const opensIn = $derived(game?.startsAt ? new Date(game.startsAt).getTime() - clock.now : 0);
	const opened = $derived(!!game && game.phase === 'live' && opensIn <= 0);
	function fmtStart(iso: string | null): string {
		if (!iso) return '';
		const d = new Date(iso);
		return isFinite(d.getTime())
			? d.toLocaleString(undefined, {
					weekday: 'long',
					month: 'short',
					day: 'numeric',
					hour: 'numeric',
					minute: '2-digit'
				})
			: '';
	}

	const pieces = $derived(game?.pieces ?? []);
	const pieceIds = $derived(pieces.map((p) => p.id as string));

	// Scores and the run highlight are recomputed client-side from the pieces on show —
	// the rules module is pure and client-safe, and deriving them here means a freshly
	// polled piece lights its four-in-a-row the same instant it lands.
	// Awards are not pieces, so they must be handed to the scorer separately.
	const bonusTotals = $derived(
		(game?.bonus ?? []).reduce<Record<number, number>>((acc, b) => {
			acc[b.side] = (acc[b.side] ?? 0) + b.points;
			return acc;
		}, {})
	);
	const standings = $derived(game ? computeStandings(pieces, game.scoring, bonusTotals) : []);
	const runCells = $derived(runCellSet(standings.flatMap((s) => s.runs)));

	// ── playback ──────────────────────────────────────────────────────────────
	// Whatever landed since this browser last watched the board falls into place, in claim
	// order. The baseline is the LAST VISIT (localStorage, shared with the admin tester —
	// it is the same board), so coming back to a board that moved on shows what you missed
	// instead of silently swapping it.
	const playback = new Playback();
	let speed = $state(1);
	let replaying = $state(false);

	// The board this effect last acted on, so it doesn't re-run on polls that change
	// nothing and cancel a run it just started.
	let handled = '';

	$effect(() => {
		const ids = pieceIds;
		const slug = game?.slug;
		if (!slug || replaying) return;

		const key = ids.join('|');
		if (key === handled) return;
		handled = key;

		const seen = loadSeen(slug);
		const fresh = ids.filter((id) => !seen.has(id));
		if (fresh.length && fresh.length < ids.length) {
			// The new pieces are the tail of the list; start the run where they begin. The
			// ids are banked when the run ENDS, so a run cut short by a reload replays.
			playback.play(ids, ids.length - fresh.length, paceFor(fresh.length, speed));
		} else {
			// Nothing new, or a board this browser has never seen at all — a first visit
			// shows the board as it stands rather than replaying the entire event unasked.
			playback.showAll(ids.length);
			saveSeen(slug, ids);
		}
	});

	$effect(() => {
		if (game && playback.settled(pieceIds.length) && pieceIds.length) {
			saveSeen(game.slug, pieceIds);
		}
	});

	function replayAll() {
		replaying = true;
		playback.play(pieceIds, 0, paceFor(pieceIds.length, speed));
	}
	function stopReplay() {
		replaying = false;
		playback.skip(pieceIds.length);
		if (game) saveSeen(game.slug, pieceIds);
	}
	$effect(() => {
		if (replaying && !playback.playing) {
			replaying = false;
			if (game) saveSeen(game.slug, pieceIds);
		}
	});

	// Roster lookup for the ×N contributor list — the payload already carries every
	// seated member's name, so naming contributors costs no extra query.
	const rsnByUser = $derived(
		new Map((game?.sides ?? []).flatMap((sd) => sd.members.map((m) => [m.userId, m.rsn])))
	);

	// ── Confirm before submitting ─────────────────────────────────────────────
	// Submitting is not free: a claim takes the cell the moment it is posted, and on a ×N
	// tile it banks immediately — so a proof sent early, or twice, costs the side real
	// progress that only an admin can take back. The last step is therefore deliberate:
	// it restates what is being sent, and makes them say they are done.
	// ── Pets ──────────────────────────────────────────────────────────────────
	// A pet claims no cell — pets are filtered out of the tile pool, so they pay points
	// beside the board. Its own little form, with its own staged shot, so opening it can
	// never disturb a tile claim in progress.
	let petOpen = $state(false);
	let petName = $state('');
	let petShots = $state<{ file: File; url: string }[]>([]);
	let petSending = $state(false);
	let petInput = $state<HTMLInputElement | null>(null);
	function addPetFiles(list: FileList | null) {
		for (const f of Array.from(list ?? [])) {
			if (!f.type.startsWith('image/')) continue;
			petShots = [...petShots, { file: f, url: URL.createObjectURL(f) }];
		}
		if (petInput) petInput.value = '';
	}
	function clearPet() {
		for (const s of petShots) URL.revokeObjectURL(s.url);
		petShots = [];
		petName = '';
	}

	/** Proof screenshots currently open in the viewer, or null. */
	let viewing = $state<string[] | null>(null);

	let confirming = $state(false);
	let claimForm = $state<HTMLFormElement | null>(null);

	function askToConfirm() {
		if (!staged.length || submitting) return;
		confirming = true;
	}
	function confirmSubmit() {
		confirming = false;
		claimForm?.requestSubmit();
	}

	// ── Submission toast ──────────────────────────────────────────────────────
	// The confirmation under the form is easy to miss on a 600-cell board — it sits below
	// the fold once the claim panel is open, and a player who does not see it submits the
	// same screenshot again. That double-banks a ×N tile, which is exactly how one tile
	// completed on one player's duplicate. So the confirmation also arrives as a toast,
	// pinned where they are looking.
	let toast = $state<{ id: number; kind: 'ok' | 'warn'; text: string } | null>(null);
	let toastTimer: ReturnType<typeof setTimeout> | null = null;
	function say(kind: 'ok' | 'warn', text: string) {
		if (toastTimer) clearTimeout(toastTimer);
		toast = { id: Date.now(), kind, text };
		toastTimer = setTimeout(() => (toast = null), 9000);
	}

	let selected = $state<number | null>(null);
	const selectedTile = $derived(
		resubmit?.tile
			? { col: resubmit.col, deckIdx: resubmit.deckIdx, tile: resubmit.tile, progress: undefined }
			: selected === null
				? null
				: (game?.live[selected] ?? null)
	);

	/** The thing most often got wrong: a before+after tile sent with a single shot. */
	const shortOfPreShot = $derived(!!selectedTile?.tile.pre_shot && staged.length < 2);

	// One toast per action result. `form` is replaced wholesale by use:enhance, so tracking
	// the object identity is enough — resubmitting the same column twice still speaks.
	let toldAbout: unknown = null;
	$effect(() => {
		const f = form;
		if (!f || f === toldAbout) return;
		toldAbout = f;
		if (f.error) say('warn', f.error);
		else if (f.submitted && f.progress)
			say(
				'ok',
				`Sent for review — ${f.progress.have} of ${f.progress.need} for your side. Don't send it again; an admin will check it.`
			);
		else if (f.submitted && f.tileTaken)
			say('warn', 'Sent for review, but another side claimed this tile first — nothing was placed.');
		else if (f.submitted && f.pet)
			say('ok', `Pet sent for review — ${f.pet}. An admin will add the points shortly.`);
		else if (f.submitted)
			say('ok', "Sent for review — an admin will confirm it shortly. Don't send it again.");
	});

	// ── When a tile went up ───────────────────────────────────────────────────
	// A column deals its slice in order, so a tile went live the moment the piece BELOW it
	// landed — and the first slot in a column went live when the game opened. The same
	// rule the reviewer's timing check uses (`tileActiveSince`), computed here from the
	// piece log the payload already carries rather than asking the server again.
	function tileLiveAt(deckIdx: number): number | null {
		if (!game) return null;
		if (deckIdx % game.rows === 0) return game.startsAt ? Date.parse(game.startsAt) : null;
		const below = game.pieces.find((p) => p.deck_idx === deckIdx - 1);
		const at = below?.claimed_at ? Date.parse(below.claimed_at) : NaN;
		return Number.isFinite(at) ? at : null;
	}

	/** "just now" / "12m" / "3h 20m" — how long a tile has been the column's offer. */
	function upFor(deckIdx: number): string | null {
		const at = tileLiveAt(deckIdx);
		if (at == null) return null;
		const s = Math.max(0, Math.floor((clock.now - at) / 1000));
		if (s < 60) return 'just now';
		const m = Math.floor(s / 60);
		if (m < 60) return `${m}m ago`;
		const h = Math.floor(m / 60);
		return h < 24 ? `${h}h ${m % 60}m ago` : `${Math.floor(h / 24)}d ${h % 24}h ago`;
	}

	/** How long a freshly-dealt tile is worth flagging. */
	const NEW_FOR_MS = 15 * 60_000;
	/** Columns whose objective went up within the window — the rail marks them. */
	const freshCols = $derived.by(() => {
		const out = new Set<number>();
		for (const [col, slot] of (game?.live ?? []).entries()) {
			if (!slot) continue;
			const at = tileLiveAt(slot.deckIdx);
			if (at != null && clock.now - at < NEW_FOR_MS) out.add(col);
		}
		return out;
	});

	// ── The tiles-on-offer list ───────────────────────────────────────────────
	// The rail says what is on offer, but at 40 columns a token is too small to read and
	// a player has to hunt along it for the drop they actually got. This is the same 40
	// tiles as a plain list they can scan, filter and click — clicking is exactly what
	// clicking the rail does, so there is one selection and one claim form, not two.
	let tileFilter = $state('');
	// Three readings of the same 40 objectives. 'board' is the board's own order, which is
	// the only one that matches the rail above it; the other two answer the two questions
	// players actually ask — what just went up, and what can I get quickest.
	type OfferSort = 'board' | 'newest' | 'fastest';
	const SORTS: { key: OfferSort; label: string; hint: string }[] = [
		{ key: 'board', label: 'Board order', hint: 'Column A through to the last, same as the rail' },
		{ key: 'newest', label: 'Newest first', hint: 'Most recently dealt objectives first' },
		{ key: 'fastest', label: 'Fastest first', hint: 'Lowest expected hours to obtain first' }
	];
	let offerSort = $state<OfferSort>('board');
	const openTiles = $derived(
		(game?.live ?? [])
			.map((slot, col) => ({ slot, col }))
			.filter((t): t is { slot: NonNullable<typeof t.slot>; col: number } => !!t.slot)
	);
	const sortedTiles = $derived.by(() => {
		const list = [...openTiles];
		// A tile with no EHB and one with no known deal time both sort LAST rather than
		// first — an unknown is not a zero, and floating them to the top would be a lie.
		if (offerSort === 'fastest') {
			return list.sort((a, b) => (a.slot.tile.ehb ?? Infinity) - (b.slot.tile.ehb ?? Infinity));
		}
		if (offerSort === 'newest') {
			return list.sort(
				(a, b) => (tileLiveAt(b.slot.deckIdx) ?? -Infinity) - (tileLiveAt(a.slot.deckIdx) ?? -Infinity)
			);
		}
		return list;
	});
	const shownTiles = $derived.by(() => {
		const q = tileFilter.trim().toLowerCase();
		if (!q) return sortedTiles;
		return sortedTiles.filter((t) => {
			const tile = t.slot.tile;
			const hay = [
				columnLabel(t.col),
				tile.item_name,
				tile.source ?? '',
				...(tile.any_of?.map((m) => m.item_name) ?? [])
			]
				.join(' ')
				.toLowerCase();
			return hay.includes(q);
		});
	});

	/** Pick a column from the list, then put the claim form where they can see it. */
	async function pickTile(col: number) {
		cancelResubmit();
		selected = col;
		await tick();
		document
			.getElementById('c4-claim')
			?.scrollIntoView({ behavior: 'smooth', block: 'center' });
	}

	// ── 2D / 3D ───────────────────────────────────────────────────────────────
	// Same key as the admin tester: it is a preference about how boards look, not a
	// per-page mode.
	const VIEW_KEY = 'vs_c4_view';
	let view = $state<'flat' | '3d'>('flat');
	onMount(() => {
		try {
			if (localStorage.getItem(VIEW_KEY) === '3d') view = '3d';
			const z = Number(localStorage.getItem(ZOOM_KEY));
			if (ZOOMS.some((o) => o.px === z)) cellFloor = z;
		} catch {
			/* storage unavailable — flat and fit-to-page are the safe defaults */
		}
		// The board arrives after this mount (instant-nav), so match on the cookie NAME
		// rather than waiting for the payload to name the event.
		try {
			if (/(?:^|;\s*)voli_c4_ack_[^=]+=1/.test(document.cookie)) ackConfirmed = true;
		} catch {
			/* no cookies — the gate just shows again */
		}
	});
	function setView(v: 'flat' | '3d') {
		view = v;
		try {
			localStorage.setItem(VIEW_KEY, v);
		} catch {
			/* ignore */
		}
	}

	// ── Board zoom ────────────────────────────────────────────────────────────
	// A 40-column board fitted to the page gives each column about 22px, which is too
	// small to read the objective off its token. Zoom puts a FLOOR on the column width
	// instead of scaling anything: the rail, the labels and the frame all share that
	// floor, so they widen together and every token stays over its own column, and past
	// the container the whole unit scrolls sideways inside its own box. 0 is fit-to-page,
	// which is what the board has always done.
	const ZOOM_KEY = 'vs_c4_zoom';
	const ZOOMS = [
		{ px: 0, label: 'Fit' },
		{ px: 34, label: 'Big' },
		{ px: 48, label: 'Huge' }
	];
	let cellFloor = $state(0);
	function setZoom(px: number) {
		cellFloor = px;
		try {
			localStorage.setItem(ZOOM_KEY, String(px));
		} catch {
			/* ignore */
		}
	}

	// The 3D board raycasts its own hover and reports it here; the flat board draws its
	// own card. Same flag-not-cancel dance as everywhere: leaving the canvas for the card
	// must not clear the hover before the pointer reaches the wiki links.
	let hover3d = $state<HoverInfo | null>(null);
	let overCard3d = false;
	let hide3d: ReturnType<typeof setTimeout> | null = null;
	// Same warm-up as the flat board: wait before the first card opens, then swap without
	// waiting while one is already up, and drop a pending open the moment the pointer leaves.
	const HOVER_DELAY = 350;
	let show3d: ReturnType<typeof setTimeout> | null = null;
	function set3dHover(info: HoverInfo | null) {
		if (hide3d) clearTimeout(hide3d);
		if (info) {
			if (hover3d) {
				hover3d = info;
				return;
			}
			if (show3d) clearTimeout(show3d);
			show3d = setTimeout(() => {
				show3d = null;
				hover3d = info;
			}, HOVER_DELAY);
		} else {
			if (show3d) {
				clearTimeout(show3d);
				show3d = null;
			}
			hide3d = setTimeout(() => {
				if (!overCard3d) hover3d = null;
			}, 260);
		}
	}
	// `manual:submission:` is a MEMBER's approved screenshot; a bare `manual:` is an admin
	// placing the piece themselves. Both start 'manual:', so testing only that told every
	// player their own proof had been credited by hand.
	const claimedVia = (p: { drop_key?: string }) =>
		p.drop_key?.startsWith('manual:submission:')
			? 'from an approved screenshot'
			: p.drop_key?.startsWith('manual:')
				? 'credited by hand'
				: p.drop_key?.startsWith('test-')
					? 'simulated'
					: 'from a Dink drop';

	const hover3dCard = $derived.by((): CardInfo | null => {
		void clock.now; // so "up 12m ago" ticks while the card is open
		const h = hover3d;
		if (!h || !game) return null;
		if (h.kind === 'piece') {
			const p = h.piece;
			return {
				kind: 'piece',
				itemName: p.item_name ?? 'Unknown drop',
				source: p.source,
				where: `${columnLabel(p.col)}${p.row + 1}`,
				sideName: game.sides[p.side - 1]?.name ?? `side ${p.side}`,
				sideColor: game.sides[p.side - 1]?.color,
				byRsn: p.by_rsn,
				via: claimedVia(p),
				x: h.x,
				y: h.y
			};
		}
		return {
			kind: 'tile',
			itemName: h.tile.tile.item_name,
			source: h.tile.tile.source,
			ehb: h.tile.tile.ehb,
			anyOf: h.tile.tile.any_of?.map((m) => m.item_name) ?? null,
			qty: h.tile.tile.qty ?? null,
			progress: h.tile.progress ?? null,
			contributors:
				h.tile.contributors?.map((c) => ({
					rsn: rsnByUser.get(c.userId) ?? 'someone',
					side: c.side,
					qty: c.qty
				})) ?? null,
			upFor: upFor(h.tile.deckIdx),
			sideNames: game.sides.map((s) => s.name),
			where: `column ${columnLabel(h.tile.col)}`,
			x: h.x,
			y: h.y
		};
	});

	// ── live updates ──────────────────────────────────────────────────────────
	// Version-driven (docs/LIVE-UPDATES.md): poll the ~100-byte token and refetch the
	// board only when it moves, so an open board never shows a stale tile. Paused during
	// a replay — a refetch must not pull the board out from under a run mid-flight.
	let refreshedAt = $state<string>('');
	// THE STROKE OF THE START. Until then the payload carries no tiles at all — that is
	// what stops a board dealt the night before being read early — so when the countdown
	// runs out the page has to go and FETCH the board it has been waiting for. The version
	// poll cannot do it: nothing has changed on the board, so its token is unmoved, and
	// without this every player would sit looking at an empty rail until they reloaded.
	let fetchedOnOpen = $state(false);
	$effect(() => {
		if (opened && !fetchedOnOpen) {
			fetchedOnOpen = true;
			invalidateAll();
		}
	});

	async function refresh() {
		await invalidateAll();
		refreshedAt = new Date().toLocaleTimeString();
	}
	liveEvent(() => game?.id ?? '', {
		onChange: refresh,
		// The payload's own token baselines the poll (a getter, because the payload lands
		// after init) — without it, a credit between render and the first poll became the
		// baseline and the board sat stale until the NEXT change.
		initial: () => (payload?.kind === 'ok' ? payload.live : undefined),
		paused: () => !game || game.phase !== 'live' || playback.playing
	});
	onMount(() => {
		refreshedAt = new Date().toLocaleTimeString();
		window.addEventListener('paste', onPaste);
		return () => {
			window.removeEventListener('paste', onPaste);
			playback.stop();
		};
	});

	const mySide = $derived(
		game && game.viewerSide ? (game.sides[game.viewerSide - 1] ?? null) : null
	);
	const winnerSide = $derived(
		game && game.winner ? (game.sides[game.winner - 1] ?? null) : null
	);
</script>

<svelte:head><title>{game ? game.name : 'Connect Four'} — Connect Four</title></svelte:head>

<div class="page">
	{#if !res.ready}
		<Skeleton height="2rem" />
		<Skeleton height="6rem" />
		<Skeleton height="22rem" />
	{:else if payload?.kind === 'not_found' || !game}
		<section class="osrs-panel">
			<div class="osrs-titlebar">Connect Four</div>
			<div class="pad"><p class="muted">There's no game here.</p></div>
		</section>
	{:else}
		<header>
			<div>
				<a href="/events" class="back">← Events</a>
				<h1>{game.name}</h1>
			</div>
			<div class="head-right">
				<!-- The recording dot: a board that is live is the one state worth reading at a
				     glance, so it gets the camera's own shorthand. Only while actually live —
				     a blinking light on a finished game says the opposite of the truth. -->
				<span class="osrs-badge" class:live-badge={opened}>
					{#if opened}<span class="rec-dot" aria-hidden="true"></span>{/if}
					{game.phase}
				</span>
				{#if game.test}<span class="osrs-badge test">test</span>{/if}
				{#if mySide}
					<span class="pill" style="--c: {mySide.color}">You play for {mySide.name}</span>
				{/if}
				{#if refreshedAt && game.phase === 'live'}
					<span class="muted tiny">live · updated {refreshedAt}</span>
				{/if}
			</div>
		</header>

		{#if game.description}<p class="muted desc">{game.description}</p>{/if}

		{#if game.phase === 'finished'}
			<p class="ok">
				{#if winnerSide}
					Finished — <strong>{winnerSide.name}</strong> takes it.
				{:else}
					Finished — dead even.
				{/if}
			</p>
		{/if}

		<!-- ── standings ─────────────────────────────────────────────────────── -->
		<section class="scores">
			{#each game.sides as side, i (side.side)}
				{@const st = standings[i]}
				<div class="score" style="--c: {side.color}" class:winner={game.winner === side.side}>
					<div class="score-head">
						<span class="chip"></span>
						<strong>{side.name}</strong>
						<span class="muted tiny">{side.members.length} players</span>
					</div>
					<div class="total">{st?.total.toLocaleString() ?? 0}</div>
					<div class="muted tiny">
						{st?.tiles ?? 0} tiles ({st?.tilePoints.toLocaleString() ?? 0}) · lines
						{st?.linePoints.toLocaleString() ?? 0}{#if st?.bonusPoints} · bonus
							{st.bonusPoints.toLocaleString()}{/if}
						{#if (st?.longest ?? 0) >= 4} · longest {st?.longest} in a row{/if}
					</div>
				</div>
			{/each}
		</section>

		<!-- ── the board ─────────────────────────────────────────────────────── -->
		<section class="osrs-panel board-panel">
			<div class="osrs-titlebar">
				The board — {pieces.length} / {game.deckSize} claimed
			</div>
			<div class="pad">
				{#if game.phase === 'setup'}
					<p class="muted">
						The board opens when the game starts — check back once the event is underway.
					</p>
				{:else if !opened}
					<!-- Dealt, waiting on the clock. The tiles are not merely hidden here: the
					     payload does not carry them until the start, so both clans read the board
					     for the first time at the same second. -->
					<div class="countdown">
						<p class="big">Opens in {untilText(opensIn)}</p>
						<p class="muted">
							{fmtStart(game.startsAt)} — the 244 tiles go up then, for both clans at once.
							Drops from before that time don't count, so don't start early.
						</p>
						{#if game.viewerSide}
							<p class="muted tiny">
								You're on <strong>{game.sides[game.viewerSide - 1]?.name}</strong>. Nothing to
								do until the clock runs out.
							</p>
						{:else}
							<p class="warn tiny">
								You're not on a side yet — ask an admin to seat you before the start.
							</p>
						{/if}
					</div>
				{:else}
					<div class="playbar">
						{#if playback.playing}
							<button type="button" onclick={stopReplay}>Skip to the end</button>
							<span class="muted tiny">
								{(playback.revealed ?? 0) - playback.from} of {playback.to - playback.from} landing…
							</span>
							<span class="progress" aria-hidden="true">
								<span
									class="progress-fill"
									style="width: {playback.to > playback.from
										? (((playback.revealed ?? 0) - playback.from) / (playback.to - playback.from)) *
											100
										: 100}%"
								></span>
							</span>
						{:else}
							<button type="button" onclick={replayAll} disabled={!pieces.length}>
								▶ Replay
							</button>
							<label class="tiny">
								speed
								<select bind:value={speed}>
									<option value={1}>1×</option>
									<option value={2}>2×</option>
									<option value={4}>4×</option>
									<option value={8}>8×</option>
								</select>
							</label>
							<span class="muted tiny">{pieces.length} claims</span>
						{/if}
						{#if view === 'flat'}
							<span class="viewtoggle zoomtoggle" aria-label="Board size">
								{#each ZOOMS as z (z.px)}
									<button type="button" class:on={cellFloor === z.px} onclick={() => setZoom(z.px)}>
										{z.label}
									</button>
								{/each}
							</span>
						{/if}
						<span class="viewtoggle">
							<button type="button" class:on={view === 'flat'} onclick={() => setView('flat')}>
								Flat
							</button>
							<button type="button" class:on={view === '3d'} onclick={() => setView('3d')}>
								3D
							</button>
						</span>
					</div>

					{#key game.id}
						{#if view === '3d'}
							<Connect4Board3D
								{pieces}
								live={game.live}
								cols={game.cols}
								rows={game.rows}
								sideColors={game.sides.map((s) => s.color)}
								{runCells}
								{freshCols}
								revealed={playback.revealed}
								falling={playback.falling}
								{selected}
								onselect={(c) => {
									cancelResubmit();
									selected = selected === c ? null : c;
								}}
								onhover={set3dHover}
							/>
						{:else}
							<Connect4Board
								{pieces}
								live={game.live}
								cols={game.cols}
								rows={game.rows}
								sideColors={game.sides.map((s) => s.color)}
								sideNames={game.sides.map((s) => s.name)}
								{runCells}
								revealed={playback.revealed}
								falling={playback.falling}
								{selected}
								{cellFloor}
								{freshCols}
								rsnFor={(id) => rsnByUser.get(id) ?? null}
								upForSlot={(idx) => upFor(idx)}
								onselect={(c) => {
									cancelResubmit();
									selected = selected === c ? null : c;
								}}
							/>
						{/if}
					{/key}

					{#if selectedTile}
						<div class="tile-detail" id="c4-claim">
							<WikiImage
								src={itemImageUrl(selectedTile.tile.any_of?.[0]?.item_name ?? selectedTile.tile.item_name)}
								fallback={nameInitials(selectedTile.tile.item_name)}
								alt=""
								size={40}
							/>
							<div>
								<strong>{columnLabel(selectedTile.col)} — {selectedTile.tile.item_name}</strong>
								<div class="muted tiny">
									{#if selectedTile.tile.source}
										{selectedTile.tile.source}
									{/if}
									{#if selectedTile.tile.pre_shot}
										<strong class="pre-flag">📷 before + after</strong> ·
									{/if}
									{#if selectedTile.tile.ehb} · {formatEhb(selectedTile.tile.ehb)} to obtain{/if}
									{#if selectedTile.tile.qty && selectedTile.tile.qty > 1}
										· first side to {selectedTile.tile.qty} drops
										{#if selectedTile.progress}
											({game.sides[0]?.name} {selectedTile.progress[1]}/{selectedTile.tile.qty},
											{game.sides[1]?.name} {selectedTile.progress[2]}/{selectedTile.tile.qty})
										{/if}
									{/if}
								</div>
								{#if selectedTile.tile.any_of?.length}
									<div class="muted tiny">
										any of: {selectedTile.tile.any_of.map((m) => m.item_name).join(', ')}
									</div>
								{/if}
							</div>
						</div>

						{#if game.phase === 'live' && game.viewerSide}
							<!-- Claims are PROOF submissions, not credits: this posts a screenshot to
							     the same /admin/submissions queue every other event uses, and an admin
							     approves it. Nothing lands on the board from here. -->
							<form
								bind:this={claimForm}
								method="POST"
								action="?/submitClaim"
								enctype="multipart/form-data"
								class="claim-form"
								use:enhance={({ formData }) => {
									submitting = true;
									// The staged files are the submission — the visible input is only
									// one way to add them, and after a reopen they came from IndexedDB
									// rather than a picker, so the input itself may be empty.
									formData.delete('proof');
									for (const st of staged) formData.append('proof', st.file);
									return async ({ update, result }) => {
										if (result.type === 'success') clearStaged();
										await update({ reset: false });
										submitting = false;
									};
								}}
							>
								<input type="hidden" name="col" value={selectedTile.col} />
								{#if resubmit}
									<input type="hidden" name="resubmit" value="1" />
									<p class="redo-head">
										Replacing the proof for <strong>{selectedTile.tile.item_name}</strong> at
										{resubmit.cell} — you still hold it.
										<button type="button" class="link-like" onclick={cancelResubmit}>cancel</button>
									</p>
								{/if}
								<!-- Said BEFORE the drop zone, because by the time you are picking a file
								     it is already too late to have taken the other shot. -->
								{#if selectedTile.tile.pre_shot}
									<p class="pre-warn">
										📷 <strong>This tile needs a BEFORE screenshot too.</strong>
										Send one showing your count <em>before</em> you start{#if selectedTile.tile.pre_note}
											{' '}({selectedTile.tile.pre_note}){/if}, and one after — both in the same
										submission. Without a before, an admin cannot tell what you earned during the
										event.
									</p>
								{/if}
								{#if pasted}<p class="ok tiny">Pasted from your clipboard.</p>{/if}

								<!-- Drop zone. Staged images survive closing the tile, so you can
								     screenshot the drop now and submit when you are done playing. -->
								<div
									class="dropzone"
									class:over={dragging}
									role="button"
									tabindex="0"
									ondragover={(e) => {
										e.preventDefault();
										dragging = true;
									}}
									ondragleave={() => (dragging = false)}
									ondrop={(e) => {
										e.preventDefault();
										dragging = false;
										addFiles(e.dataTransfer?.files ?? null);
									}}
									onclick={() => fileInput?.click()}
									onkeydown={(e) => {
										if (e.key === 'Enter' || e.key === ' ') fileInput?.click();
									}}
								>
									{#if staged.length}
										<div class="thumbs">
											{#each staged as st, i (st.url)}
												<div class="thumb">
													<img src={st.url} alt="Staged proof {i + 1}" />
													<button
														type="button"
														class="thumb-x"
														title="Remove"
														onclick={(e) => {
															e.stopPropagation();
															removeStaged(i);
														}}>✕</button>
												</div>
											{/each}
										</div>
										<p class="muted tiny">
											{staged.length} staged — paste or drop more if you need to. Saved on this
											device, so you can close this and come back to it.
										</p>
									{:else}
										<p class="muted tiny">
											<strong>Paste</strong> a screenshot (Ctrl&nbsp;+&nbsp;V), drop one here, or
											click to pick one. Make sure the <strong>in-game clock</strong> is
											visible — an admin checks the drop landed after this tile went up.
										</p>
									{/if}
								</div>
								<input
									bind:this={fileInput}
									type="file"
									name="proof"
									accept="image/*"
									multiple
									class="hidden-input"
									onchange={(e) => addFiles(e.currentTarget.files)}
								/>

								{#if (selectedTile.tile.qty ?? 1) > 1}
									<!-- Multi-drop tiles are the thing people misread: one proof does not
									     finish a "×N" tile unless it shows N of them. Say the count. -->
									<label class="qty-pick">
										<span>
											This tile needs <strong>{selectedTile.tile.qty}</strong> drops. How many
											does this screenshot cover?
										</span>
										<input
											name="quantity"
											type="number"
											min="1"
											max={selectedTile.tile.qty}
											bind:value={quantity}
										/>
									</label>
								{/if}

								<div class="claim-actions">
									<!-- type=button: the confirm step submits the form, not this click. -->
									<button type="button" disabled={submitting || !staged.length} onclick={askToConfirm}>
										{submitting ? 'Sending…' : 'Submit this drop for review'}
									</button>
									{#if staged.length}
										<button type="button" class="link-ish" onclick={clearStaged}>Clear</button>
									{/if}
								</div>
							</form>
							{#if form?.error}<p class="err tiny">{form.error}</p>{/if}
							{#if form?.submitted && form?.progress}
								<!-- A ×N tile is not finished by one drop. Say exactly where the side is,
								     so nobody is left wondering whether the submission counted. -->
								<p class="ok tiny">
									Sent for review — <strong>{form.progress.have} of {form.progress.need}</strong> for
									your side. The tile stays on the board until you reach {form.progress.need}.
								</p>
							{:else if form?.submitted && form?.tileTaken}
								<p class="err tiny">
									Sent for review, but another side claimed this tile first — nothing was placed.
								</p>
							{:else if form?.submitted}
								<p class="ok tiny">Sent for review — an admin will confirm it shortly.</p>
							{/if}
						{/if}
					{:else if game.phase === 'live'}
						<p class="muted tiny hint">
							Got a drop above a column? Click that tile and send your screenshot — an admin
							checks it and your side's piece falls into place.
						</p>
					{/if}
				{/if}
			</div>
		</section>

		<!-- ── what is on offer ──────────────────────────────────────────────
		     The rail in one readable column. Same selection as clicking the rail. -->
		{#if game.phase === 'live' && openTiles.length}
			<section class="osrs-panel">
				<div class="osrs-titlebar">Tiles on offer — {openTiles.length}</div>
				<div class="pad">
					<div class="offer-head">
						<p class="muted tiny">
							Every objective currently up for grabs, one per column. Click one to send your
							screenshot — the same as clicking its token above the board.
						</p>
						<div class="offer-tools">
							<span class="viewtoggle sorttoggle" aria-label="Sort the tiles on offer">
								{#each SORTS as srt (srt.key)}
									<button
										type="button"
										class:on={offerSort === srt.key}
										title={srt.hint}
										onclick={() => (offerSort = srt.key)}
									>
										{srt.label}
									</button>
								{/each}
							</span>
							<input
								class="offer-filter"
								type="search"
								placeholder="Filter by item, boss or column…"
								bind:value={tileFilter}
								aria-label="Filter the tiles on offer"
							/>
						</div>
					</div>
					{#if shownTiles.length}
						<ul class="offers">
							{#each shownTiles as t (t.col)}
								{@const tile = t.slot.tile}
								<li>
									<button type="button" class:on={selected === t.col} onclick={() => pickTile(t.col)}>
										<span class="col-tag">{columnLabel(t.col)}</span>
									{#if freshCols.has(t.col)}<span class="new-tag">NEW</span>{/if}
										<WikiImage
											src={itemImageUrl(tile.any_of?.[0]?.item_name ?? tile.item_name)}
											fallback={nameInitials(tile.item_name)}
											alt=""
											size={26}
										/>
										<span class="offer-name">
											<strong>{tile.item_name}</strong>
											<span class="muted tiny">
												{#if tile.source}{tile.source}{/if}
												{#if tile.ehb} · {formatEhb(tile.ehb)} to obtain{/if}
												{#if tile.any_of?.length}
													· any of: {tile.any_of.map((m) => m.item_name).join(', ')}
												{/if}
												{#if upFor(t.slot.deckIdx)}
													· up {upFor(t.slot.deckIdx)}
												{/if}
											</span>
										</span>
										{#if (tile.qty ?? 1) > 1 && t.slot.progress}
											<!-- A ×N tile is a race between two banks, so the row that offers it
											     says where both sides stand. Read off the same numbers the hover
											     card and the claim form use. -->
											<span class="offer-prog">
												{#each game.sides as sd (sd.side)}
													<span
														class="pp"
														class:won={(t.slot.progress?.[sd.side] ?? 0) >= (tile.qty ?? 1)}
														style="--c: {sd.color}"
													>
														{sd.name}
														{t.slot.progress?.[sd.side] ?? 0}/{tile.qty}
													</span>
												{/each}
											</span>
										{/if}
										{#if (tile.qty ?? 1) > 1}
											<span class="offer-qty">×{tile.qty}</span>
										{/if}
										{#if tile.pre_shot}
											<span class="offer-pre" title="Needs a BEFORE screenshot as well as an after">
												before + after
											</span>
										{/if}
									</button>
								</li>
							{/each}
						</ul>
					{:else}
						<p class="muted tiny">Nothing on offer matches “{tileFilter}”.</p>
					{/if}
				</div>
			</section>
		{/if}

		<!-- ── pets ──────────────────────────────────────────────────────────
		     Points beside the board. Pets are deliberately not on the tile list — nobody
		     can be asked to farm one — so this is the only way to claim one, and it had
		     no member-facing route at all until now. -->
		{#if game.viewerSide && (game.phase === 'live' || game.phase === 'finished')}
			<section class="osrs-panel">
				<div class="osrs-titlebar">Got a pet?</div>
				<div class="pad">
					<p class="muted tiny">
						Pets aren't on the board — they can't be farmed to order, so they pay
						<strong>{game.scoring.pet_points} points</strong> to your side instead of claiming a
						cell. Send the drop screenshot and an admin will add the points.
					</p>

					{#if !petOpen}
						<button type="button" onclick={() => (petOpen = true)}>Submit a pet</button>
					{:else}
						<form
							method="POST"
							action="?/submitPet"
							enctype="multipart/form-data"
							class="pet-form"
							use:enhance={({ formData }) => {
								petSending = true;
								formData.delete('proof');
								for (const st of petShots) formData.append('proof', st.file);
								return async ({ update, result }) => {
									if (result.type === 'success') {
										clearPet();
										petOpen = false;
									}
									await update({ reset: false });
									petSending = false;
								};
							}}
						>
							<label class="tiny">
								<span>Which pet?</span>
								<input name="pet" bind:value={petName} maxlength="80" placeholder="e.g. Nexling" />
							</label>

							<input
								bind:this={petInput}
								type="file"
								name="proof"
								accept="image/*"
								multiple
								class="hidden-input"
								onchange={(e) => addPetFiles(e.currentTarget.files)}
							/>
							<button type="button" class="link-ish" onclick={() => petInput?.click()}>
								Add a screenshot
							</button>

							{#if petShots.length}
								<div class="pet-shots">
									{#each petShots as st, i (st.url)}<img src={st.url} alt="Screenshot {i + 1}" />{/each}
								</div>
							{/if}

							<div class="claim-actions">
								<button type="submit" disabled={petSending || !petShots.length || !petName.trim()}>
									{petSending ? 'Sending…' : 'Send the pet for review'}
								</button>
								<button
									type="button"
									class="link-ish"
									onclick={() => {
										clearPet();
										petOpen = false;
									}}
								>
									Cancel
								</button>
							</div>
						</form>
					{/if}

					{#if game.bonus.length}
						<ul class="pets">
							{#each game.bonus.slice(-8).reverse() as bn (bn.id)}
								<li>
									<span class="chip" style="--c: {game.sides[bn.side - 1]?.color}"></span>
									<strong>{bn.itemName ?? bn.kind}</strong>
									<span class="muted tiny">{bn.byRsn ?? 'someone'} · +{bn.points}</span>
								</li>
							{/each}
						</ul>
					{/if}
				</div>
			</section>
		{/if}

		<!-- ── awaiting approval ─────────────────────────────────────────────
		     Claims already standing on the board that nobody has reviewed yet. Public on
		     purpose: both clans can see what is contested and what is settled. -->
		{#if game.awaiting.length}
			<section class="osrs-panel">
				<div class="osrs-titlebar">Waiting on an admin — {game.awaiting.length}</div>
				<div class="pad">
					<p class="muted tiny">
						These tiles are already held by whoever submitted first. An admin still has to
						check the proof: approved, the piece just stops flashing; rejected outright, it
						comes off the board and the tile goes back into play.
					</p>
					<ul class="awaiting">
						{#each game.awaiting as a (a.cell)}
							<li class:mine={a.needsBetterProof}>
								<span class="chip" style="--c: {game.sides[a.side - 1]?.color}"></span>
								<strong>{a.cell}</strong>
								<span>{a.itemName ?? '—'}</span>
								<span class="muted tiny">{a.rsn ?? 'someone'} · {ago(a.at)}</span>
								{#if a.needsBetterProof}
									<div class="redo">
										<strong>An admin needs a better screenshot.</strong>
										{#if a.note}<span class="muted"> “{a.note}”</span>{/if}
										<span>
											You still hold this tile — nobody can take it while you sort the shot out.
										</span>
										<!-- A button, not directions. The column has ALREADY moved on to a new
										     tile, so "click column K" sent people to the wrong objective; this
										     reopens the claim they actually hold. -->
										<button type="button" class="redo-btn" onclick={() => startResubmit(a)}>
											Send a better screenshot
										</button>
									</div>
								{/if}
							</li>
						{/each}
					</ul>
				</div>
			</section>
		{/if}

		<!-- ── the log ───────────────────────────────────────────────────────── -->
		{#if pieces.length}
			<section class="osrs-panel">
				<div class="osrs-titlebar">Latest claims</div>
				<div class="table-wrap">
					<table class="osrs-table">
						<thead>
							<tr><th>Cell</th><th>Side</th><th>Tile</th><th>By</th><th>Proof</th></tr>
						</thead>
						<tbody>
							{#each [...pieces].reverse().slice(0, 60) as p (p.id)}
								{@const shots = p.submission_id ? (game.proofs[p.submission_id] ?? []) : []}
								<tr>
									<td>{columnLabel(p.col)}{p.row + 1}</td>
									<td>
										<span class="pill" style="--c: {game.sides[p.side - 1]?.color}">
											{game.sides[p.side - 1]?.name ?? `side ${p.side}`}
										</span>
									</td>
									<td>{p.item_name}</td>
									<td>{p.by_rsn ?? '—'}</td>
									<!-- The receipts. "by hand" said nothing a player could check; the
									     screenshot is the thing the claim was actually settled on, and both
									     clans being able to see it is what makes a manual-proof race
									     credible. -->
									<td class="tiny muted">
										{#if shots.length}
											<button type="button" class="proof-btn" onclick={() => (viewing = shots)}>
												<img src={shots[0]} alt="" loading="lazy" />
												{#if shots.length > 1}<span>+{shots.length - 1}</span>{/if}
											</button>
										{:else if p.drop_key?.startsWith('manual:submission:')}
											<span title="The screenshot is no longer on file">—</span>
										{:else if p.drop_key?.startsWith('manual:')}
											credited by an admin
										{:else if p.drop_key?.startsWith('test-')}
											simulated
										{:else}
											Dink
										{/if}
									</td>
								</tr>
							{/each}
						</tbody>
					</table>
				</div>
			</section>
		{/if}
	{/if}
</div>

<!-- Proof viewer. Opened from the claims log — every member can see what any claim was
     settled on. -->
{#if viewing}
	<div
		class="modal-back"
		role="button"
		tabindex="-1"
		onclick={() => (viewing = null)}
		onkeydown={(e) => e.key === 'Escape' && (viewing = null)}
	>
		<div
			class="shots"
			role="dialog"
			aria-modal="true"
			aria-label="Submitted screenshots"
			onclick={(e) => e.stopPropagation()}
			onkeydown={(e) => e.stopPropagation()}
		>
			{#each viewing as url, i (url)}
				<a href={url} target="_blank" rel="noopener noreferrer">
					<img src={url} alt="Submitted screenshot {i + 1}" />
				</a>
			{/each}
			<div class="modal-actions">
				<span class="muted tiny">Click a shot to open it full size.</span>
				<button type="button" onclick={() => (viewing = null)}>Close</button>
			</div>
		</div>
	</div>
{/if}

<!-- The last chance to stop. Restates what is about to be sent, because the two ways
     people get this wrong — sending before the tile is actually finished, and sending the
     same shot twice — are both invisible once the claim is in. -->
{#if confirming && selectedTile && game}
	<div
		class="modal-back"
		role="button"
		tabindex="-1"
		onclick={() => (confirming = false)}
		onkeydown={(e) => e.key === 'Escape' && (confirming = false)}
	>
		<div
			class="modal"
			role="dialog"
			aria-modal="true"
			aria-label="Confirm your submission"
			onclick={(e) => e.stopPropagation()}
			onkeydown={(e) => e.stopPropagation()}
		>
			<h3>Send this for review?</h3>

			<div class="sum">
				<div class="sum-row">
					<span class="sum-k">Tile</span>
					<span><strong>{selectedTile.tile.item_name}</strong> — column {columnLabel(selectedTile.col)}</span>
				</div>
				{#if (selectedTile.tile.qty ?? 1) > 1}
					<div class="sum-row">
						<span class="sum-k">Needs</span>
						<span>
							{selectedTile.tile.qty} drops · this proof says it covers <strong>{quantity}</strong>
							{#if selectedTile.progress}
								· your side is on {selectedTile.progress[game.viewerSide ?? 1]}/{selectedTile.tile.qty}
							{/if}
						</span>
					</div>
				{/if}
				<div class="sum-row">
					<span class="sum-k">Sending</span>
					<span>{staged.length} screenshot{staged.length === 1 ? '' : 's'}</span>
				</div>
			</div>

			{#if staged.length}
				<div class="sum-shots">
					{#each staged as st, i (st.url)}<img src={st.url} alt="Screenshot {i + 1}" />{/each}
				</div>
			{/if}

			{#if shortOfPreShot}
				<p class="modal-warn">
					📷 <strong>This tile needs a BEFORE screenshot as well as an after</strong>, and you are
					sending only one.
					{#if selectedTile.tile.pre_note}
						The before shot should show {selectedTile.tile.pre_note}.
					{/if}
					Send both together — you cannot go back for the before shot later.
				</p>
			{/if}

			<p class="modal-ask">
				Are you sure you have <strong>everything you need to complete this tile</strong>? Once it is
				sent it holds the cell until an admin reviews it, and sending the same screenshot twice
				counts against your side twice.
			</p>

			<div class="modal-actions">
				<button type="button" class="link-ish" onclick={() => (confirming = false)}>
					Not yet — go back
				</button>
				<button type="button" class="go" onclick={confirmSubmit}>Yes, submit it</button>
			</div>
		</div>
	</div>
{/if}

<!-- Pinned to the viewport, so it is visible wherever they are on a 600-cell board. -->
{#if toast}
	{#key toast.id}
		<div class="toast" class:warn={toast.kind === 'warn'} role="status" aria-live="polite">
			<span>{toast.text}</span>
			<button type="button" class="toast-x" onclick={() => (toast = null)} aria-label="Dismiss">
				×
			</button>
		</div>
	{/key}
{/if}

{#if hover3dCard}
	<TileHoverCard
		info={hover3dCard}
		onkeep={() => {
			overCard3d = true;
			if (hide3d) clearTimeout(hide3d);
		}}
		onrelease={() => {
			overCard3d = false;
			set3dHover(null);
		}}
	/>
{/if}

{#if ackOpen && game}
	<BoardAckModal
		eventName={game.name}
		codeword={EVENT_CODEWORD}
		guideHref="/evidence-guide"
		confirmLabel="Confirm & view the board"
		onConfirm={confirmAck}
	>
		{#snippet extra()}
			I understand a drop only counts if I got it <strong>after the tile went up</strong> —
			an admin compares the in-game time in my screenshot against when it appeared, so my
			shot has to show the clock.
		{/snippet}
	</BoardAckModal>
{/if}

<style>
	.page {
		max-width: 82rem;
		margin: 0 auto;
		padding: 1rem;
		display: grid;
		gap: 1rem;
	}
	/* Grid items default to min-width:auto, so the board's own min-width (25 columns at
	   the phone cell floor ≈ 700px) would widen this whole column and push the page
	   sideways instead of scrolling inside the board's box. */
	.page > * {
		min-width: 0;
	}
	.table-wrap {
		overflow-x: auto;
		overscroll-behavior-x: contain;
	}
	header {
		display: flex;
		justify-content: space-between;
		align-items: flex-end;
		gap: 1rem;
		flex-wrap: wrap;
	}
	h1 {
		margin: 0.2rem 0 0;
	}
	.back {
		font-size: 0.8rem;
		color: var(--muted);
	}
	.head-right {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		flex-wrap: wrap;
	}
	.osrs-badge.test {
		color: var(--yellow);
	}
	.desc {
		margin: -0.5rem 0 0;
	}

	.scores {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(14rem, 1fr));
		gap: 0.75rem;
	}
	.score {
		border: 1px solid var(--border);
		border-left: 4px solid var(--c);
		border-radius: var(--radius);
		background: var(--surface);
		padding: 0.6rem 0.8rem;
	}
	.score.winner {
		box-shadow: 0 0 0 2px var(--accent);
	}
	.score-head {
		display: flex;
		align-items: center;
		gap: 0.4rem;
	}
	.chip {
		width: 0.9rem;
		height: 0.9rem;
		border-radius: 50%;
		background:
			radial-gradient(circle at 36% 30%, rgba(255, 255, 255, 0.5) 0%, transparent 45%),
			var(--c);
	}
	.total {
		font-family: var(--font-heading);
		font-size: 1.7rem;
		color: var(--heading);
		line-height: 1.1;
	}

	.board-panel .pad {
		padding: 0.75rem;
	}
	.pad {
		padding: 0.75rem;
	}
	.tile-detail {
		display: flex;
		align-items: center;
		gap: 0.6rem;
		margin-top: 0.6rem;
		padding: 0.5rem 0.6rem;
		background: var(--surface-alt);
		border: 1px solid var(--border);
		border-radius: var(--radius);
		flex-wrap: wrap;
	}
	.hint {
		margin: 0.5rem 0 0;
	}
	.playbar {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		flex-wrap: wrap;
		margin-bottom: 0.5rem;
	}
	.progress {
		flex: 1;
		min-width: 6rem;
		height: 4px;
		background: var(--surface-alt);
		border-radius: 999px;
		overflow: hidden;
	}
	.progress-fill {
		display: block;
		height: 100%;
		background: var(--accent);
		transition: width 0.12s linear;
	}
	.viewtoggle {
		display: inline-flex;
		margin-left: auto;
	}
	/* Only ONE of the two strips pushes off the left — otherwise the second one is shoved
	   against the first with no gap between the pair. */
	.zoomtoggle + .viewtoggle {
		margin-left: 0.6rem;
	}
	.viewtoggle button {
		min-height: 0;
		padding: 0.15rem 0.6rem;
		font-size: 0.78rem;
		opacity: 0.6;
	}
	.viewtoggle button.on {
		opacity: 1;
		color: var(--accent);
	}
	.pill {
		font-size: 0.7rem;
		padding: 0.05rem 0.4rem;
		border-radius: 999px;
		border: 1px solid var(--c);
		color: var(--c);
	}
	.tiny {
		font-size: 0.75rem;
	}
	label.tiny {
		display: inline-flex;
		align-items: center;
		gap: 0.3rem;
	}
	.muted {
		color: var(--muted);
	}
	.ok {
		margin: 0;
		padding: 0.5rem 0.75rem;
		border: 1px solid var(--success);
		border-radius: var(--radius);
		color: var(--success);
		background: var(--success-bg);
	}
	.claim-form {
		display: grid;
		gap: 0.4rem;
		margin-top: 0.6rem;
		padding: 0.6rem;
		border: 1px solid var(--border);
		border-radius: var(--radius);
		background: var(--surface-alt);
	}
	.claim-form p { margin: 0; }
	.pre-warn {
		padding: 0.45rem 0.6rem;
		border: 1px solid var(--warning, #d9a441);
		border-left-width: 4px;
		border-radius: var(--radius);
		background: color-mix(in srgb, var(--warning, #d9a441) 12%, transparent);
		font-size: 0.85rem;
		line-height: 1.35;
	}
	.pre-flag { color: var(--warning, #d9a441); }
	.redo-head {
		font-size: 0.85rem;
	}
	.redo-btn {
		margin-top: 0.3rem;
	}
	.link-like {
		background: none;
		border: 0;
		padding: 0;
		color: var(--accent);
		text-decoration: underline;
		cursor: pointer;
		font: inherit;
	}
	.err { color: var(--danger); }
	.ok { color: var(--success); }
	.offer-head {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.5rem;
		justify-content: space-between;
	}
	.offer-head p {
		margin: 0;
		flex: 1 1 16rem;
	}
	.offer-tools {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.5rem;
	}
	.sorttoggle {
		margin-left: 0;
	}
	.new-tag {
		flex: none;
		font-size: 0.62rem;
		font-weight: 700;
		letter-spacing: 0.04em;
		color: var(--danger);
	}
	.offer-filter {
		flex: 0 1 15rem;
		min-height: 0;
		padding: 0.2rem 0.5rem;
		font-size: 0.8rem;
	}
	/* Capped and scrolled: 40 objectives as one long list would push the board and the
	   claim form off the screen, which is the opposite of the point. */
	.offers {
		list-style: none;
		margin: 0.5rem 0 0;
		padding: 0;
		display: grid;
		gap: 0.25rem;
		max-height: 21rem;
		overflow-y: auto;
		overscroll-behavior-y: contain;
	}
	.offers button {
		width: 100%;
		display: flex;
		align-items: center;
		gap: 0.5rem;
		text-align: left;
		min-height: 0;
		padding: 0.3rem 0.5rem;
		border-image: none;
		border: 1px solid var(--border);
		border-radius: 3px;
		background: rgba(0, 0, 0, 0.18);
	}
	.offers button:hover {
		border-color: var(--accent);
	}
	.offers button.on {
		border-color: var(--accent);
		box-shadow: 0 0 0 2px var(--accent-soft);
	}
	.col-tag {
		flex: 0 0 2.2rem;
		font-weight: 700;
		color: var(--accent);
		font-size: 0.8rem;
	}
	.offer-name {
		display: grid;
		min-width: 0;
		line-height: 1.25;
	}
	.offer-name strong,
	.offer-name span {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.offer-prog {
		margin-left: auto;
		flex: none;
		display: flex;
		gap: 0.3rem;
		font-size: 0.68rem;
		white-space: nowrap;
	}
	.offer-prog .pp {
		padding: 0.02rem 0.32rem;
		border: 1px solid var(--c);
		border-radius: 999px;
		color: var(--c);
	}
	/* A side that has reached the total holds the tile — it should not read the same as
	   one still counting. */
	.offer-prog .pp.won {
		background: color-mix(in srgb, var(--c) 24%, transparent);
		font-weight: 700;
	}
	/* Only ONE child takes the auto margin, or the badges after it bunch to the left. */
	.offer-prog + .offer-qty {
		margin-left: 0;
	}
	.offer-qty {
		margin-left: auto;
		flex: none;
		font-weight: 700;
		font-size: 0.8rem;
		color: var(--yellow);
	}
	/* Sits after the qty badge, so it must not also claim the auto margin. */
	.offer-pre {
		flex: none;
		font-size: 0.66rem;
		padding: 0.05rem 0.35rem;
		border-radius: 999px;
		border: 1px solid var(--danger);
		color: var(--danger);
	}
	.offer-qty + .offer-pre {
		margin-left: 0;
	}
	.offers li:has(.offer-pre):not(:has(.offer-qty)) .offer-pre {
		margin-left: auto;
	}
	.awaiting { list-style: none; margin: 0; padding: 0; display: grid; gap: 0.35rem; }
	.awaiting li {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		flex-wrap: wrap;
		padding: 0.3rem 0.4rem;
		border-radius: 3px;
		background: var(--surface-alt);
	}
	.awaiting li.mine { background: var(--danger-bg); }
	.awaiting .chip {
		width: 0.7rem;
		height: 0.7rem;
		border-radius: 50%;
		background: var(--c);
		flex: none;
	}
	.redo { flex-basis: 100%; font-size: 0.82rem; }
	.dropzone {
		border: 1px dashed var(--border);
		border-radius: var(--radius);
		padding: 0.6rem;
		cursor: pointer;
		background: var(--surface);
	}
	.dropzone.over { border-color: var(--accent); background: var(--accent-soft); }
	.dropzone p { margin: 0; }
	.hidden-input { display: none; }
	.thumbs { display: flex; gap: 0.4rem; flex-wrap: wrap; margin-bottom: 0.35rem; }
	.thumb { position: relative; }
	.thumb img {
		width: 4.5rem;
		height: 4.5rem;
		object-fit: cover;
		border-radius: 3px;
		border: 1px solid var(--border);
	}
	.thumb-x {
		position: absolute;
		top: -0.35rem;
		right: -0.35rem;
		min-height: 0;
		padding: 0 0.3rem;
		font-size: 0.7rem;
		background: var(--surface);
		border: 1px solid var(--border);
		border-radius: 999px;
		color: var(--danger);
	}
	.qty-pick { display: grid; gap: 0.2rem; font-size: 0.82rem; color: var(--muted); }
	.qty-pick input { width: 5rem; }
	.claim-actions { display: flex; gap: 0.5rem; align-items: center; }
	.link-ish {
		background: none;
		border: none;
		color: var(--muted);
		font-size: 0.8rem;
		cursor: pointer;
	}
	.pet-form {
		display: grid;
		gap: 0.5rem;
		justify-items: start;
		margin-top: 0.5rem;
	}
	.pet-form label {
		display: inline-flex;
		align-items: center;
		gap: 0.4rem;
	}
	.pet-shots {
		display: flex;
		flex-wrap: wrap;
		gap: 0.35rem;
	}
	.pet-shots img {
		width: 84px;
		height: 84px;
		object-fit: cover;
		border: 1px solid var(--border);
		border-radius: 3px;
	}
	.pets {
		list-style: none;
		margin: 0.6rem 0 0;
		padding: 0;
		display: grid;
		gap: 0.25rem;
		font-size: 0.85rem;
	}
	.pets li {
		display: flex;
		align-items: center;
		gap: 0.45rem;
	}
	.proof-btn {
		border-image: none;
		border: 1px solid var(--border);
		border-radius: 3px;
		background: rgba(0, 0, 0, 0.2);
		min-height: 0;
		margin: 0;
		padding: 1px;
		display: inline-flex;
		align-items: center;
		gap: 0.25rem;
		cursor: pointer;
	}
	.proof-btn:hover {
		border-color: var(--accent);
	}
	.proof-btn img {
		display: block;
		width: 44px;
		height: 30px;
		object-fit: cover;
		border-radius: 2px;
	}
	.proof-btn span {
		padding-right: 0.25rem;
		font-size: 0.7rem;
		color: var(--muted);
	}
	.shots {
		width: min(52rem, 100%);
		max-height: calc(100vh - 2rem);
		overflow-y: auto;
		padding: 0.8rem;
		border: 1px solid var(--border);
		border-radius: 4px;
		background: var(--panel, #241f16);
		cursor: default;
	}
	.shots img {
		display: block;
		max-width: 100%;
		margin: 0 auto 0.6rem;
		border: 1px solid var(--border);
		border-radius: 3px;
	}
	.modal-back {
		position: fixed;
		inset: 0;
		z-index: 70;
		display: grid;
		place-items: center;
		padding: 1rem;
		background: rgba(0, 0, 0, 0.62);
	}
	.modal {
		width: min(30rem, 100%);
		max-height: calc(100vh - 2rem);
		overflow-y: auto;
		padding: 1rem 1.1rem 0.9rem;
		border: 1px solid var(--border);
		border-radius: 4px;
		background: var(--panel, #241f16);
		box-shadow: 0 10px 40px rgba(0, 0, 0, 0.6);
		text-align: left;
		cursor: default;
	}
	.modal h3 {
		margin: 0 0 0.6rem;
		color: var(--heading);
	}
	.sum {
		display: grid;
		gap: 0.3rem;
		font-size: 0.85rem;
	}
	.sum-row {
		display: flex;
		gap: 0.5rem;
		align-items: baseline;
	}
	.sum-k {
		flex: 0 0 4.5rem;
		color: var(--muted);
		font-size: 0.75rem;
		text-transform: uppercase;
		letter-spacing: 0.03em;
	}
	.sum-shots {
		display: flex;
		flex-wrap: wrap;
		gap: 0.35rem;
		margin: 0.6rem 0 0;
	}
	.sum-shots img {
		width: 92px;
		height: 92px;
		object-fit: cover;
		border: 1px solid var(--border);
		border-radius: 3px;
	}
	.modal-warn {
		margin: 0.7rem 0 0;
		padding: 0.5rem 0.6rem;
		border: 1px solid var(--danger);
		border-radius: 3px;
		background: rgba(180, 60, 60, 0.12);
		font-size: 0.82rem;
		line-height: 1.35;
	}
	.modal-ask {
		margin: 0.7rem 0 0;
		font-size: 0.85rem;
		line-height: 1.4;
	}
	.modal-actions {
		display: flex;
		align-items: center;
		justify-content: flex-end;
		gap: 0.8rem;
		margin-top: 0.9rem;
	}
	.modal-actions .go {
		border-color: var(--success, #6aa84f);
		color: var(--success, #6aa84f);
	}
	.live-badge {
		display: inline-flex;
		align-items: center;
		gap: 0.35rem;
	}
	.rec-dot {
		width: 0.5em;
		height: 0.5em;
		border-radius: 50%;
		background: #ff3b30;
		box-shadow: 0 0 4px rgba(255, 59, 48, 0.9);
	}
	/* Held still for anyone who has asked not to be blinked at — the dot itself still
	   says live, it simply stops pulsing. */
	@media (prefers-reduced-motion: no-preference) {
		.rec-dot {
			animation: rec-blink 1.6s ease-in-out infinite;
		}
	}
	@keyframes rec-blink {
		0%,
		45% {
			opacity: 1;
		}
		55%,
		100% {
			opacity: 0.15;
		}
	}
	.toast {
		position: fixed;
		left: 50%;
		bottom: 1.1rem;
		transform: translateX(-50%);
		z-index: 60;
		display: flex;
		align-items: center;
		gap: 0.6rem;
		max-width: min(34rem, calc(100vw - 2rem));
		padding: 0.55rem 0.8rem;
		border: 1px solid var(--success, #6aa84f);
		border-radius: 4px;
		background: #1d2417;
		color: var(--text);
		font-size: 0.85rem;
		line-height: 1.3;
		box-shadow: 0 4px 18px rgba(0, 0, 0, 0.55);
	}
	.toast.warn {
		border-color: var(--danger);
		background: #2a1a1a;
	}
	.toast-x {
		border-image: none;
		border: 0;
		background: none;
		min-height: 0;
		margin: 0;
		padding: 0 0.2rem;
		font-size: 1.1rem;
		line-height: 1;
		color: var(--muted);
		cursor: pointer;
	}
	@media (prefers-reduced-motion: no-preference) {
		.toast {
			animation: c4-toast-in 160ms ease-out;
		}
	}
	@keyframes c4-toast-in {
		from {
			opacity: 0;
			transform: translate(-50%, 8px);
		}
		to {
			opacity: 1;
			transform: translate(-50%, 0);
		}
	}
</style>

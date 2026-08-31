// Client half of the live-updates pattern (docs/LIVE-UPDATES.md): poll the tiny
// GET /api/live/[eventId] version token and call onChange() only when it moves. A page
// opts in with one call during component init; the transport can become SSE later
// without touching any page, because the version token is the whole contract.
//
// Behaviour the pages rely on:
//  - `paused` is consulted every tick — refetches must never interrupt a replay
//    animation or clobber optimistic local state, so pages gate here.
//  - Hidden tabs don't poll (and poll immediately on becoming visible again).
//  - Errors back off (×2 up to 30s) and never surface: the board keeps showing its
//    current data, the next poll retries.
//  - `eventId` may be a getter for pages that navigate between events without a
//    remount; the baseline resets when the id changes.

import { onDestroy } from 'svelte';
import { browser } from '$app/environment';

const MAX_BACKOFF_MS = 30_000;

export function liveEvent(
	eventId: string | (() => string),
	opts: {
		onChange: () => void | Promise<void>;
		intervalMs?: number;
		paused?: () => boolean;
		/** Version token computed with the page payload, so a change that lands between
		 *  render and the first poll is still caught. Pass a GETTER when the payload
		 *  arrives asynchronously (instant-nav pages): it is consulted at baseline time —
		 *  first unpaused tick, and again on an id change — not at init. Omitted, or
		 *  returning undefined: the first poll is the baseline, and a change that landed
		 *  before it is silently absorbed. */
		initial?: string | (() => string | undefined);
	}
): void {
	if (!browser) return;

	const base = opts.intervalMs ?? 3000;
	const id = () => (typeof eventId === 'function' ? eventId() : eventId);
	const initialOf = () => (typeof opts.initial === 'function' ? opts.initial() : opts.initial);

	let delay = base;
	let currentId: string | undefined;
	let version: string | undefined = typeof opts.initial === 'string' ? opts.initial : undefined;
	let timer: ReturnType<typeof setTimeout> | undefined;
	let inflight = false;
	let stopped = false;

	function schedule(): void {
		if (stopped) return;
		clearTimeout(timer);
		timer = setTimeout(tick, delay);
	}

	async function tick(): Promise<void> {
		if (stopped || inflight) return schedule();
		if (document.hidden || opts.paused?.()) return schedule();
		const target = id();
		if (currentId === undefined) {
			currentId = target; // first tick: the payload token (if any) baselines this id
			if (version === undefined) version = initialOf();
		} else if (target !== currentId) {
			currentId = target;
			// New event: re-baseline from ITS payload token, not from the next poll — a
			// change landing between that payload and the first poll must still fire.
			version = initialOf();
		}
		inflight = true;
		try {
			const res = await fetch(`/api/live/${target}`, { headers: { accept: 'application/json' } });
			if (!res.ok) throw new Error(String(res.status));
			const { version: v } = (await res.json()) as { version: string };
			delay = base;
			const changed = version !== undefined && v !== version;
			version = v;
			if (changed && !stopped && target === id()) await opts.onChange();
		} catch {
			delay = Math.min(delay * 2, MAX_BACKOFF_MS);
		} finally {
			inflight = false;
			schedule();
		}
	}

	function onVisibility(): void {
		if (!document.hidden && !inflight) {
			clearTimeout(timer);
			void tick();
		}
	}

	document.addEventListener('visibilitychange', onVisibility);
	schedule();

	onDestroy(() => {
		stopped = true;
		clearTimeout(timer);
		document.removeEventListener('visibilitychange', onVisibility);
	});
}

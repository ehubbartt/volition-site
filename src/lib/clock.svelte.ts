// A ticking `now` for anything that has to change on its own: a countdown to an event's
// start, or a board that must open the moment the clock passes it without the page being
// reloaded. Derive from `clock.now` and the UI re-renders on each tick.
//
// Pick the coarsest interval that reads right — a "Sat, 1:00 pm" badge only needs to
// notice the minute turn over, and a per-second tick on a page 240 people have open is
// 240 renders a second for nothing.
export function createClock(everyMs = 1000) {
	let now = $state(Date.now());
	$effect(() => {
		const id = setInterval(() => (now = Date.now()), everyMs);
		return () => clearInterval(id);
	});
	return {
		get now() {
			return now;
		}
	};
}

/** `ms` as "2d 4h", "4h 12m", "12m 30s", or "any moment now" once it runs out. */
export function untilText(ms: number): string {
	if (ms <= 0) return 'any moment now';
	const s = Math.floor(ms / 1000);
	const d = Math.floor(s / 86400);
	const h = Math.floor((s % 86400) / 3600);
	const m = Math.floor((s % 3600) / 60);
	if (d) return `${d}d ${h}h`;
	if (h) return `${h}h ${m}m`;
	if (m) return `${m}m ${s % 60}s`;
	return `${s}s`;
}

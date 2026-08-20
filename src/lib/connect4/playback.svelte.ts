// CLIENT-SAFE — the board's playback clock.
//
// One mechanism serves both things the board animates:
//
//   - COMING BACK TO THE BOARD. Whatever has been claimed since your last visit falls into
//     place in the order it was claimed, so you can see what happened rather than finding
//     a board that has silently changed under you.
//   - REPLAYING THE WHOLE EVENT. The same walk, starting from an empty board.
//
// Both are "reveal pieces 0..n one at a time", so both are this class with a different
// starting index. The board renders `revealed` pieces and plays the drop animation on
// whichever id is currently `falling`.
//
// Which pieces you have already seen is remembered per event in localStorage, because the
// interesting baseline is your LAST VISIT, not this page load.

const SEEN_PREFIX = 'vs_c4_seen:';

/** Piece ids this browser has already watched land, for one event. */
export function loadSeen(slug: string): Set<string> {
	if (typeof localStorage === 'undefined') return new Set();
	try {
		const raw = localStorage.getItem(SEEN_PREFIX + slug);
		const ids = raw ? (JSON.parse(raw) as unknown) : null;
		return new Set(Array.isArray(ids) ? ids.filter((v): v is string => typeof v === 'string') : []);
	} catch {
		return new Set(); // corrupt or unavailable storage must never break the board
	}
}

export function saveSeen(slug: string, ids: string[]): void {
	if (typeof localStorage === 'undefined') return;
	try {
		localStorage.setItem(SEEN_PREFIX + slug, JSON.stringify(ids));
	} catch {
		/* quota or private mode — the board just replays more next time */
	}
}

/** How long a piece spends falling, in ms. Matches the CSS keyframe. */
export const FALL_MS = 550;

export class Playback {
	/**
	 * How many pieces of the ordered list are on the board right now. `null` means "all of
	 * them" and is the starting value ON PURPOSE: the server renders this component with no
	 * effects, so a numeric default would ship HTML with an empty board and flash it full
	 * on hydration.
	 */
	revealed = $state<number | null>(null);
	/** The piece currently dropping, if any — the board animates exactly this one. */
	falling = $state<string | null>(null);
	playing = $state(false);
	/** Where this run started, so the UI can show progress over the run rather than the board. */
	from = $state(0);
	to = $state(0);

	#timer: ReturnType<typeof setTimeout> | null = null;
	#clear: ReturnType<typeof setTimeout> | null = null;
	#ids: string[] = [];
	#interval = 260;

	/** Show everything with no animation — the normal state of a board nobody is watching. */
	showAll(total: number) {
		this.stop();
		this.revealed = total;
		this.falling = null;
	}

	/** True once a run has finished (or never started) with the whole board on screen. */
	settled(total: number): boolean {
		return !this.playing && (this.revealed === null || this.revealed >= total);
	}

	/**
	 * Walk from `from` to `ids.length`, revealing one piece per tick.
	 *
	 * `ids` is every piece in claim order; `from` is how many were already on the board
	 * when the run started (0 to replay the whole event).
	 */
	play(ids: string[], from: number, interval = 260) {
		this.stop();
		this.#ids = ids;
		this.#interval = Math.max(40, interval);
		this.from = Math.max(0, Math.min(from, ids.length));
		this.to = ids.length;
		this.revealed = this.from;
		if (this.from >= this.to) {
			// Nothing new to show — leave the board settled rather than flashing a run.
			this.falling = null;
			return;
		}
		this.playing = true;
		this.#step();
	}

	#step = () => {
		if ((this.revealed ?? 0) >= this.to) {
			this.playing = false;
			this.falling = null;
			return;
		}
		this.revealed = (this.revealed ?? 0) + 1;
		const id = this.#ids[this.revealed - 1] ?? null;
		this.falling = id;
		// Stop flagging it as falling once the animation is done, so a piece that lands
		// while the run continues doesn't keep re-triggering its keyframe.
		if (this.#clear) clearTimeout(this.#clear);
		this.#clear = setTimeout(() => {
			if (this.falling === id) this.falling = null;
		}, FALL_MS);
		this.#timer = setTimeout(this.#step, this.#interval);
	};

	/** Cut the run short and leave the board wherever it got to. */
	stop() {
		if (this.#timer) clearTimeout(this.#timer);
		if (this.#clear) clearTimeout(this.#clear);
		this.#timer = null;
		this.#clear = null;
		this.playing = false;
	}

	/** Abandon the run and jump to the finished board. */
	skip(total: number) {
		this.showAll(total);
	}
}

/**
 * A sensible tick for a run of `count` pieces: slow enough to follow when a couple of
 * tiles landed while you were away, fast enough that replaying a whole event is watchable
 * rather than a coffee break.
 */
export function paceFor(count: number, speed = 1): number {
	const base = count <= 6 ? 320 : count <= 25 ? 200 : count <= 80 ? 120 : 70;
	return Math.max(40, Math.round(base / speed));
}

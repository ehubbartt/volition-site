// CLIENT-SAFE — a Svelte action for hotlinked wiki images.
//
// Two different failures blank a tile, and they need opposite responses:
//
//  1. THE WIKI THROTTLED US. We hotlink icons straight from the OSRS Wiki, and when the
//     browser fires a burst of image requests (a 250-tile board does exactly that), its
//     Cloudflare front drops a few. Retrying the SAME url a moment later fixes it, and a
//     naive `onerror` that hides the element latches those tiles blank until a manual
//     refresh.
//  2. THE URL IS WRONG. Wiki file names are case-sensitive past the first letter, and our
//     item names come from the OSRS item database in a different case ("Staff of the dead"
//     vs "Staff_of_the_Dead.png"). Retrying that url will never work — a DIFFERENT
//     spelling has to be tried.
//
// `onerror` carries no status code, so the two are indistinguishable at the point of
// failure. The policy is therefore: try every candidate spelling once, fast (that clears
// case mismatches within a frame or two), and only then start backing off and retrying the
// whole list (which clears throttling). The element is hidden only once both are exhausted.
//
// Usage:  <img src={url} use:retryImage />
//         <img src={first} use:retryImage={{ sources: [first, second] }} />

export function retryImage(
	node: HTMLImageElement,
	opts: {
		max?: number;
		sources?: string[];
		onfail?: () => void;
		onshown?: (shown: boolean) => void;
	} = {}
): {
	destroy(): void;
	update(o: { max?: number; sources?: string[]; onfail?: () => void; onshown?: (s: boolean) => void }): void;
} {
	let max = opts.max ?? 3;
	// Called once every spelling has been tried and re-tried. The caller can then put
	// SOMETHING in the space — a tile whose name the wiki has no file for (half this
	// event's board is written as "Any Barrows Helm" rather than as an item) should read
	// as itself, not as a hole.
	let onfail = opts.onfail;
	// Called with false the moment a candidate fails and true when one loads, so the caller
	// can put its stand-in up straight away. Waiting for the whole walk to finish meant
	// several seconds of the browser's broken-image glyph on every tile the wiki has no
	// file for — the one thing worse to look at than a gap.
	let onshown = opts.onshown;
	// Strip any prior cache-buster so retries don't stack them.
	const clean = (u: string) => u.replace(/([?&])r=\d+(&|$)/, (_, p1, p2) => (p2 === '&' ? p1 : '')).replace(/[?&]$/, '');
	let sources = (opts.sources?.length ? opts.sources : [node.src]).map(clean).filter(Boolean);

	let index = 0; // which candidate we're on
	let round = 0; // how many full passes over the candidates we've made
	let timer: ReturnType<typeof setTimeout> | null = null;

	// The element stays hidden until an image actually LOADS. `src` is set while hidden, so
	// a candidate that 404s is never drawn as a broken icon on the way past.
	const show = (url: string, bust: number) => {
		node.src = bust ? url + (url.includes('?') ? '&' : '?') + 'r=' + bust : url;
	};

	const onLoad = () => {
		node.style.display = '';
		onshown?.(true);
	};

	const onError = () => {
		node.style.display = 'none';
		onshown?.(false);
		index += 1;
		if (index >= sources.length) {
			// Every spelling failed this round. Another pass, backed off, in case it was
			// the wiki throttling rather than a bad name.
			index = 0;
			round += 1;
			if (round > max) {
				onfail?.(); // genuinely missing — it is already hidden
				return;
			}
			if (timer) clearTimeout(timer);
			// 300ms, 600ms, 900ms — spreads retries past the throttle window.
			timer = setTimeout(() => show(sources[index], round), 300 * round);
			return;
		}
		// Next spelling, immediately — a case mismatch shouldn't cost the user a wait.
		show(sources[index], round);
	};

	node.addEventListener('error', onError);
	node.addEventListener('load', onLoad);
	// A cached image can be complete before this action ever runs, and fires no `load`.
	if (node.complete && node.naturalWidth > 0) onLoad();
	return {
		update(next: {
			max?: number;
			sources?: string[];
			onfail?: () => void;
			onshown?: (s: boolean) => void;
		}) {
			max = next.max ?? max;
			onfail = next.onfail ?? onfail;
			onshown = next.onshown ?? onshown;
			if (next.sources?.length) {
				const mapped = next.sources.map(clean).filter(Boolean);
				// Only restart the walk if the candidate list actually changed, or a
				// re-render would re-request an image that had already settled.
				if (mapped.join('|') !== sources.join('|')) {
					sources = mapped;
					index = 0;
					round = 0;
				}
			}
		},
		destroy() {
			if (timer) clearTimeout(timer);
			node.removeEventListener('error', onError);
			node.removeEventListener('load', onLoad);
		}
	};
}

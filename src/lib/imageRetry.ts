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
	opts: { max?: number; sources?: string[] } = {}
): { destroy(): void; update(o: { max?: number; sources?: string[] }): void } {
	let max = opts.max ?? 3;
	// Strip any prior cache-buster so retries don't stack them.
	const clean = (u: string) => u.replace(/([?&])r=\d+(&|$)/, (_, p1, p2) => (p2 === '&' ? p1 : '')).replace(/[?&]$/, '');
	let sources = (opts.sources?.length ? opts.sources : [node.src]).map(clean).filter(Boolean);

	let index = 0; // which candidate we're on
	let round = 0; // how many full passes over the candidates we've made
	let timer: ReturnType<typeof setTimeout> | null = null;

	const show = (url: string, bust: number) => {
		node.style.display = '';
		node.src = bust ? url + (url.includes('?') ? '&' : '?') + 'r=' + bust : url;
	};

	const onError = () => {
		index += 1;
		if (index >= sources.length) {
			// Every spelling failed this round. Another pass, backed off, in case it was
			// the wiki throttling rather than a bad name.
			index = 0;
			round += 1;
			if (round > max) {
				node.style.display = 'none'; // genuinely missing → collapse the element
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
	return {
		update(next: { max?: number; sources?: string[] }) {
			max = next.max ?? max;
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
		}
	};
}

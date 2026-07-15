// CLIENT-SAFE — a Svelte action for hotlinked wiki images.
//
// We hotlink icons straight from the OSRS Wiki (no server egress). When the browser
// fires a burst of image requests, the wiki's Cloudflare front occasionally throttles
// a few, and a naive `onerror` that hides the element latches those tiles blank until
// a MANUAL page refresh re-requests them. This action instead retries a failed image a
// few times with backoff (cache-busting each attempt so the browser actually re-fetches
// rather than replaying a cached failure), and only hides it after the retries are
// exhausted. A transient wiki hiccup now self-heals within a second or two.
//
// Usage:  <img src={url} use:retryImage />   or   <img use:retryImage={{ max: 4 }} />
export function retryImage(
	node: HTMLImageElement,
	opts: { max?: number } = {}
): { destroy(): void } {
	const max = opts.max ?? 3;
	// The pristine URL to retry (strip any prior ?r= cache-buster so retries don't stack).
	const base = node.src.replace(/([?&])r=\d+(&|$)/, (_, p1, p2) => (p2 === '&' ? p1 : '')).replace(/[?&]$/, '');
	let tries = 0;
	let timer: ReturnType<typeof setTimeout> | null = null;

	const onError = () => {
		if (tries >= max) {
			node.style.display = 'none'; // genuinely missing file → collapse the element
			return;
		}
		tries += 1;
		if (timer) clearTimeout(timer);
		// 300ms, 600ms, 900ms — spreads retries past the throttle window.
		timer = setTimeout(() => {
			node.style.display = ''; // in case a prior attempt hid it
			node.src = base + (base.includes('?') ? '&' : '?') + 'r=' + tries;
		}, 300 * tries);
	};

	node.addEventListener('error', onError);
	return {
		destroy() {
			if (timer) clearTimeout(timer);
			node.removeEventListener('error', onError);
		}
	};
}

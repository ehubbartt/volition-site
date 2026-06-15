// CLIENT-ONLY capability probes for the 3D card views (PackOpener / PackDisplay3D /
// CardInspector3D). Lets the UI (a) fall back to static art and (b) warn users whose
// browser/OS settings make the three.js packs static or SLOW — and tell them what to
// change. All best-effort: if a probe can't run we return the optimistic value so we
// never warn or degrade without cause.

export type WebglTier = 'ok' | 'software' | 'none';

// OS/browser "Reduce motion" accessibility setting. When on, the idle 3D packs render
// as static images (PackDisplay3D) and the crate reel lands instantly.
export function prefersReducedMotion(): boolean {
	if (typeof window === 'undefined') return false;
	return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
}

// Renderer strings that mean WebGL is running on the CPU (no GPU acceleration) — the
// usual reason the 3D "loads super slowly". Fixed by turning on hardware acceleration.
const SOFTWARE_RENDERER_RE =
	/swiftshader|llvmpipe|software|microsoft basic render|mesa offscreen|apple paravirtual/i;

let cached: { tier: WebglTier; renderer: string | null } | null = null;

// Probe WebGL once per session: 'none' (unavailable), 'software' (CPU-rendered → slow),
// or 'ok'. Reads the UNMASKED renderer where the browser exposes it (some privacy modes
// hide it → we stay optimistic and report 'ok'). Memoized; the probe context is freed
// immediately so it doesn't count against the browser's live-context cap.
export function detectWebgl(): { tier: WebglTier; renderer: string | null } {
	if (cached) return cached;
	if (typeof document === 'undefined') return { tier: 'ok', renderer: null };

	let gl: WebGLRenderingContext | WebGL2RenderingContext | null = null;
	try {
		const c = document.createElement('canvas');
		gl = (c.getContext('webgl2') ||
			c.getContext('webgl')) as WebGL2RenderingContext | WebGLRenderingContext | null;
	} catch {
		gl = null;
	}
	if (!gl) {
		cached = { tier: 'none', renderer: null };
		return cached;
	}

	let renderer: string | null = null;
	try {
		const dbg = gl.getExtension('WEBGL_debug_renderer_info');
		renderer = dbg
			? (gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) as string)
			: (gl.getParameter(gl.RENDERER) as string);
	} catch {
		renderer = null;
	}
	try {
		gl.getExtension('WEBGL_lose_context')?.loseContext();
	} catch {
		/* ignore */
	}

	const software = !!renderer && SOFTWARE_RENDERER_RE.test(renderer);
	cached = { tier: software ? 'software' : 'ok', renderer };
	return cached;
}

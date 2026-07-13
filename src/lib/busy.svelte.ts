import type { SubmitFunction } from '@sveltejs/kit';

// Shared pending-state for pages with several plain `use:enhance` forms (join/leave/
// invite…). One instance covers sibling forms: `submit(key)` marks that form in flight
// until the action settles, so buttons can disable + swap labels instead of appearing
// frozen during the server round-trip (and double-submits are blocked). Calling
// `update()` with no args preserves bare use:enhance semantics (reset + invalidate).
export function createBusy() {
	let key = $state<string | null>(null);
	return {
		get key() {
			return key;
		},
		get active() {
			return key !== null;
		},
		is(k: string) {
			return key === k;
		},
		submit(k: string): SubmitFunction {
			return () => {
				key = k;
				return async ({ update }) => {
					try {
						await update();
					} finally {
						key = null;
					}
				};
			};
		}
	};
}

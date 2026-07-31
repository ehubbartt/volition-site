import { memberEndpoint } from '$lib/server/apiEndpoint';
import { buildBattleshipPage } from '$lib/server/battleshipPage';
import type { RequestHandler } from './$types';

// Re-checks the session itself (the client-side guard is UX only) and returns the
// REDACTED game — the enemy fleet never leaves the server.
export const GET: RequestHandler = memberEndpoint((user, event) =>
	buildBattleshipPage(user, event.params.slug!)
);

import { memberEndpoint } from '$lib/server/apiEndpoint';
import { buildConnect4Page } from '$lib/server/connect4Page';
import type { RequestHandler } from './$types';

// Re-checks the session itself (the client-side guard is UX only) and returns the
// REDACTED game — the undealt deck never leaves the server.
export const GET: RequestHandler = memberEndpoint((user, event) =>
	buildConnect4Page(user, event.params.slug!)
);

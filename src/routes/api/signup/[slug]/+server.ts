import { memberEndpoint } from '$lib/server/apiEndpoint';
import { buildSignupPage } from '$lib/server/signupPage';
import type { RequestHandler } from './$types';

// Re-checks the session itself (the client-side guard is UX only). Returns the count and
// the names, never anyone else's answers — those only ever go to the admin roster.
export const GET: RequestHandler = memberEndpoint((user, event) =>
	buildSignupPage(user, event.params.slug!)
);

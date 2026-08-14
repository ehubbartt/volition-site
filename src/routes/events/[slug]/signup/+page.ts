import { instantLoad } from '$lib/instantLoad';
import type { SignupPageResult } from '$lib/server/signupPage';
import type { PageLoad } from './$types';

// Type-only import above is erased at build time (see docs/PAGES.md).
export const load: PageLoad = instantLoad<SignupPageResult, 'signup'>({
	key: 'signup',
	// An RSN is what makes a signup useful to whoever builds the event afterwards — a list
	// of Discord names you cannot match to accounts is not a roster.
	guard: 'onboarded',
	url: ({ params }) => `/api/signup/${params.slug}`
});

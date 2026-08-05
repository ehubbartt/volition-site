import { redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';

// The rank hub lands on its first tab — gear-claim approval.
export const load: PageServerLoad = async () => {
	throw redirect(307, '/admin/ranks/claims');
};

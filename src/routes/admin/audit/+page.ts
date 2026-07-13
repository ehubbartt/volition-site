import { instantLoad } from '$lib/instantLoad';
import type { buildAudit } from '$lib/server/admin/audit';
import type { PageLoad } from './$types';

// Type-only import above is erased at build time. The 'admin' guard is UX only —
// the /api/admin endpoint re-checks the role on every fetch.
export type AuditData = Awaited<ReturnType<typeof buildAudit>>;

export const load: PageLoad = instantLoad<AuditData, 'audit'>({
	key: 'audit',
	guard: 'admin',
	// "Load older" pagination: forward the ?before cursor to the endpoint.
	url: ({ url }) =>
		'/api/admin/audit' +
		(url.searchParams.get('before')
			? `?before=${encodeURIComponent(url.searchParams.get('before')!)}`
			: '')
});

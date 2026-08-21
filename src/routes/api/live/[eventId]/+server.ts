import { memberEndpoint } from '$lib/server/apiEndpoint';
import { liveVersion } from '$lib/server/liveVersion';
import type { RequestHandler } from './$types';

// Version token for the live-updates poll (docs/LIVE-UPDATES.md). Member-gated and
// no-store (both via memberEndpoint); the payload is an opaque ~100-byte token that
// clients compare for equality — nothing redacted from board payloads rides in it.
export const GET: RequestHandler = memberEndpoint(async (_user, event) => ({
	version: await liveVersion(event.params.eventId!)
}));

// See https://svelte.dev/docs/kit/types#app
import type { SessionUser } from '$lib/server/auth';
import type { Ban } from '$lib/server/bans';

declare global {
	namespace App {
		// interface Error {}
		interface Locals {
			user: SessionUser | null;
			sessionId: string | null;
			ban: Ban | null;
		}
		// interface PageData {}
		// interface PageState {}
		// interface Platform {}
	}
}

export {};

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
			// True when the REAL session user is a super admin, regardless of any
			// view-as preview applied to `user` (see hooks.server.ts). Lets the
			// view-as switcher keep working while previewing a lower role.
			realSuperAdmin: boolean;
			// Validated site theme from the vs_theme cookie (see $lib/themes).
			theme: string;
		}
		// interface PageData {}
		// interface PageState {}
		// interface Platform {}
	}
}

export {};

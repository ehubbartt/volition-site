import { generateState } from 'arctic';
import { discord } from '$lib/server/discord';
import { redirect } from '@sveltejs/kit';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = ({ cookies, url }) => {
	const state = generateState();
	const authUrl = discord().createAuthorizationURL(state, null, ['identify']);

	cookies.set('vs_oauth_state', state, {
		path: '/',
		httpOnly: true,
		secure: process.env.NODE_ENV === 'production',
		sameSite: 'lax',
		maxAge: 60 * 10
	});

	// Optional post-login return path (e.g. an onboarding link the visitor opened
	// while signed out). Only same-origin absolute paths are honoured — never a
	// scheme/host (`//evil`) — so this can't become an open redirect.
	const next = url.searchParams.get('next');
	if (next && next.startsWith('/') && !next.startsWith('//')) {
		cookies.set('vs_oauth_next', next, {
			path: '/',
			httpOnly: true,
			secure: process.env.NODE_ENV === 'production',
			sameSite: 'lax',
			maxAge: 60 * 10
		});
	}

	// Temporary diagnostics: the host the state cookie is set on + the redirect_uri
	// sent to Discord. Compare with the callback log to spot a host mismatch.
	console.log(
		`[oauth] login host=${url.host} redirect_uri=${authUrl.searchParams.get('redirect_uri')}`
	);

	throw redirect(302, authUrl.toString());
};

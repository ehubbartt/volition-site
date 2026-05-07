import { generateState } from 'arctic';
import { discord } from '$lib/server/discord';
import { redirect } from '@sveltejs/kit';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = ({ cookies }) => {
	const state = generateState();
	const url = discord().createAuthorizationURL(state, null, ['identify']);

	cookies.set('vs_oauth_state', state, {
		path: '/',
		httpOnly: true,
		secure: process.env.NODE_ENV === 'production',
		sameSite: 'lax',
		maxAge: 60 * 10
	});

	throw redirect(302, url.toString());
};

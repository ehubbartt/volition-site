import { redirect } from '@sveltejs/kit';

// Personal bingo moved under the events section — keep the old URL working for
// anyone's bookmarks/history (the feature predates release, so this is belt and
// braces rather than a compatibility promise).
export const load = () => {
	redirect(301, '/events/personal-bingo');
};

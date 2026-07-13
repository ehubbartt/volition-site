import { loadPendingReview, loadReviewedSubmissions } from '$lib/server/submissions';

// Data for /admin/submissions (instant navigation): the unified review queue.
// view/test/search come from the page's query string (parsed in the endpoint).

export async function buildSubmissions(opts: {
	view: 'pending' | 'reviewed';
	test: boolean;
	search: string;
}) {
	const { view, test, search } = opts;

	// The reviewed history is only fetched when that tab is active — but when it is,
	// run it alongside the pending pass instead of after it (both are heavy).
	const [{ items, events, stats }, reviewed] = await Promise.all([
		loadPendingReview({ test }),
		view === 'reviewed' ? loadReviewedSubmissions({ test, search }) : Promise.resolve(null)
	]);

	return { view, test, items, events, stats, reviewed, search };
}

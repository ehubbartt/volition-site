// ACTIONS ONLY — the gamba page has no server load. Its data comes from
// /api/gamba (built in $lib/server/gambaPage.ts) via the universal load in
// +page.ts, so navigating here never waits on the server.
export { actions } from '$lib/server/gambaPage';

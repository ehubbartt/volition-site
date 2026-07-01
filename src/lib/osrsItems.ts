// CLIENT-SAFE helper for OSRS Wiki item icons. Kept as a named re-export for existing callers;
// the URL logic now lives in the shared $lib/wikiImage module (item icon file = "<Item>.png").
export { itemImageUrl as itemIconUrl } from '$lib/wikiImage';

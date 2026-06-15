// CLIENT-SAFE RSN <-> URL-slug helpers. Player profiles are addressed by RSN
// (e.g. /u/Zezima). OSRS names are 1-12 chars of letters, numbers and spaces;
// in URLs we render spaces as underscores (OSRS treats space and underscore as
// interchangeable), so "So Saradomin" -> "So_Saradomin". encodeURIComponent is a
// no-op for valid RSN characters but guards against anything unexpected.

export function rsnToSlug(rsn: string): string {
	return encodeURIComponent(rsn.trim().replace(/ /g, '_'));
}

export function slugToRsn(slug: string): string {
	return decodeURIComponent(slug).replace(/_/g, ' ').trim();
}

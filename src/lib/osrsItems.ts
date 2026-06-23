// CLIENT-SAFE helper for OSRS Wiki item icons. The wiki stores each item's inventory
// icon at /images/{File}.png, where {File} is the item name with the first letter
// upper-cased and spaces as underscores (apostrophes %27-encoded, parentheses kept).
// These direct icon URLs need no cache hash. They're hotlinked straight from the
// browser (same approach as the DuoWolf tile images), so no server egress is involved;
// callers should set referrerpolicy="no-referrer" and handle onerror for the odd 404.
export function itemIconUrl(itemName: string): string {
	const cleaned = itemName.trim();
	const file = (cleaned.charAt(0).toUpperCase() + cleaned.slice(1))
		.replace(/ /g, '_')
		.replace(/'/g, '%27');
	return `https://oldschool.runescape.wiki/images/${file}.png`;
}

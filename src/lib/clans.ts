// To add a new clan: append a row below. The onboarding form, /me editor,
// event detail sectioning + search, stats, and demo data all read from this
// list. No DB migration needed — the clan_allegiance column has no enum
// constraint (see db/migrations/0003_clans_no_check.sql).
export const CLAN_OPTIONS = [
	{ value: 'volition', label: 'Volition' },
	{ value: 'iron_refuge', label: 'Iron Refuge' },
	{ value: '07_irons', label: '07 Irons' },
	{ value: 'ironclad', label: 'IronClad' },
	{ value: 'other_mixed', label: 'Other / Mixed' }
] as const;

export type ClanValue = (typeof CLAN_OPTIONS)[number]['value'];

export const CLAN_LABEL: Record<ClanValue, string> = Object.fromEntries(
	CLAN_OPTIONS.map((c) => [c.value, c.label])
) as Record<ClanValue, string>;

/**
 * The clan Volition is facing in the current clan-vs-clan event, as shown wherever a
 * roster is split into two camps.
 *
 * What that camp actually holds is EVERYONE WHO IS NOT VOLITION: the split is computed
 * from the Volition player list, never from IronClad membership. That is the right rule
 * for seating a two-clan event — anyone who is not ours is theirs — but it means a
 * third clan's player would be labelled IronClad too. One line to change when the
 * opponent changes; revisit the split itself if an event ever has three camps.
 */
export const OPPONENT_LABEL = CLAN_LABEL.ironclad;

export function isValidClan(value: string): value is ClanValue {
	return CLAN_OPTIONS.some((c) => c.value === value);
}

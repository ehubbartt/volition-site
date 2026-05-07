export const CLAN_OPTIONS = [
	{ value: 'volition', label: 'Volition' },
	{ value: 'iron_refuge', label: 'Iron Refuge' },
	{ value: 'reborn_iron', label: 'Reborn Iron' },
	{ value: 'other_mixed', label: 'Other / Mixed' }
] as const;

export type ClanValue = (typeof CLAN_OPTIONS)[number]['value'];

export const CLAN_LABEL: Record<ClanValue, string> = Object.fromEntries(
	CLAN_OPTIONS.map((c) => [c.value, c.label])
) as Record<ClanValue, string>;

export function isValidClan(value: string): value is ClanValue {
	return CLAN_OPTIONS.some((c) => c.value === value);
}

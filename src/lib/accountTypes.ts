export const ACCOUNT_TYPES = [
	{ value: 'ironman', label: 'Ironman', icon: '/icons/ironman.png' },
	{ value: 'hcim', label: 'Hardcore Ironman', icon: '/icons/hcim.png' },
	{ value: 'uim', label: 'Ultimate Ironman', icon: '/icons/uim.png' },
	{ value: 'gim', label: 'Group Ironman', icon: '/icons/gim.png' },
	{ value: 'gim_unranked', label: 'Group Ironman (unranked)', icon: '/icons/gim_unranked.png' }
] as const;

export type AccountType = (typeof ACCOUNT_TYPES)[number]['value'];

export const ACCOUNT_TYPE_LABEL: Record<AccountType, string> = Object.fromEntries(
	ACCOUNT_TYPES.map((a) => [a.value, a.label])
) as Record<AccountType, string>;

export const ACCOUNT_TYPE_ICON: Record<AccountType, string> = Object.fromEntries(
	ACCOUNT_TYPES.map((a) => [a.value, a.icon])
) as Record<AccountType, string>;

export function isValidAccountType(value: string): value is AccountType {
	return ACCOUNT_TYPES.some((a) => a.value === value);
}

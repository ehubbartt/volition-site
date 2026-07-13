// Site theme registry — the single source of truth for every selectable theme.
//
// How theming works (see docs/FRONTEND.md "Theming"):
// - A theme is a value of the `data-theme` attribute on <html>, set server-side in
//   hooks.server.ts from the `vs_theme` cookie so SSR paints the right theme with no
//   flash. app.css holds one `:root[data-theme='…']` block per theme that overrides
//   the design tokens; components never know themes exist — they read tokens.
// - The picker on /me writes the cookie via the `saveTheme` action and flips the
//   attribute client-side for instant feedback.
//
// Adding a theme = add an entry here + a token block in app.css. Nothing else.

export interface ThemeOption {
	value: string;
	label: string;
	description: string;
	/** Small preview swatches for the picker: [surface, accent, highlight]. */
	swatches: [string, string, string];
}

export const THEMES: ThemeOption[] = [
	{
		value: 'default',
		label: 'Old School',
		description: 'The classic bronze-and-stone look.',
		swatches: ['#3a3024', '#ff981f', '#ffff00']
	},
	{
		value: 'ember',
		label: 'Emberforge',
		description: 'Volcanic reds with molten orange.',
		swatches: ['#3a2420', '#ff7a1a', '#ffd23d']
	},
	{
		value: 'royal',
		label: 'Clan Hall',
		description: 'Royal purple with gold trim.',
		swatches: ['#332b47', '#a58cff', '#ffdf87']
	}
];

export const DEFAULT_THEME = 'default';
export const THEME_COOKIE = 'vs_theme';

export function isTheme(v: unknown): v is string {
	return typeof v === 'string' && THEMES.some((t) => t.value === v);
}

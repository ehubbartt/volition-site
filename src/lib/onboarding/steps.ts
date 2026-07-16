// CLIENT-SAFE onboarding step registry. The onboarding flow is an ordered list of
// steps per variant; the stepper renders whatever list the variant resolves to.
//
// Version B ("site-owned join") is the FULL sequence. Version A ("post-join tour",
// built later) is B with the "starting bits" removed — the verify + profile steps
// and the in-game `join` handoff. Trimming B → A is intended to be exactly this:
// delete those ids from the `a` array below. Keep each step self-contained so
// removing one never breaks the others (no step depends on an earlier step's data
// beyond what's persisted on the token row).

export type OnboardingVariant = 'a' | 'b';

export type StepId =
	| 'welcome' // intro to the flow
	| 'verify' // RSN → WiseOldMan requirement gate (B only)
	| 'profile' // clan allegiance + account type (B only)
	| 'intro' // the 5-field introduction (posted to Discord)
	| 'temple' // TempleOSRS collection-log sync setup
	| 'dink' // Dink plugin config URL
	| 'rank' // check my rank
	| 'rewards' // open a loot crate + a free white pack
	| 'join' // "hop in clan chat in-game" handoff (B only)
	| 'next'; // what's-next / explore

export interface StepMeta {
	id: StepId;
	/** Full title shown at the top of the step. */
	title: string;
	/** Short label for the progress rail. */
	short: string;
}

export const STEP_META: Record<StepId, StepMeta> = {
	welcome: { id: 'welcome', title: 'Welcome — let’s get you verified', short: 'Welcome' },
	verify: { id: 'verify', title: 'Verify your account', short: 'Verify' },
	profile: { id: 'profile', title: 'Set up your profile', short: 'Profile' },
	intro: { id: 'intro', title: 'Introduce yourself', short: 'Intro' },
	temple: { id: 'temple', title: 'Set up TempleOSRS', short: 'Temple' },
	dink: { id: 'dink', title: 'Set up Dink', short: 'Dink' },
	rank: { id: 'rank', title: 'Check your rank', short: 'Rank' },
	rewards: { id: 'rewards', title: 'Open your welcome rewards', short: 'Rewards' },
	join: { id: 'join', title: 'Join the clan in-game', short: 'Join' },
	next: { id: 'next', title: "You're all set — what's next?", short: "What's next" }
};

// The ordered step list per variant. Version A is deliberately a TAIL/subset of B
// (no verify/profile/join) so the same components and server handlers serve both.
// The 'welcome' step now folds in verify + account-type for Version B (one combined
// first screen). The 'verify' / 'profile' StepIds are retained for meta/back-compat but
// are no longer separate entries in either sequence.
export const VARIANT_STEPS: Record<OnboardingVariant, StepId[]> = {
	b: ['welcome', 'intro', 'temple', 'dink', 'rank', 'rewards', 'join', 'next'],
	a: ['welcome', 'temple', 'dink', 'rank', 'intro', 'rewards', 'next']
};

export function stepsForVariant(variant: OnboardingVariant): StepId[] {
	return VARIANT_STEPS[variant] ?? VARIANT_STEPS.b;
}

export function isValidVariant(v: string): v is OnboardingVariant {
	return v === 'a' || v === 'b';
}

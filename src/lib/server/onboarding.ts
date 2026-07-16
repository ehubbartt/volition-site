// SERVER-ONLY — site-owned new-member onboarding (Version B). One vs_onboarding_tokens
// row is one onboarding run, minted by the bot's /onboard-test-a|b admin commands (or
// site-side by mintOnboardingToken). The flow is a resumable, ordered list of steps
// (src/lib/onboarding/steps.ts); this module loads/binds/advances a session and
// implements the step side effects that aren't just a reused primitive:
//   - verify: RSN → WiseOldMan requirement gate (2000+ total & 150+ EHB)
//   - intro:  post the 5-field introduction to Discord via the bot bridge
//   - rewards: grant a free loot crate roll + a white welcome pack
// Everything else (rank check, Dink, Temple, profile) reuses the existing primitives
// from the caller (the route actions), so no logic is duplicated here.

import { db } from './db';
import type { SessionUser } from './auth';
import {
	stepsForVariant,
	isValidVariant,
	type OnboardingVariant,
	type StepId
} from '$lib/onboarding/steps';
import { fetchPlayerRankInputs } from './rankData';
import { grantUserPack } from './gamba';
import { getLootConfig, rollLoot, type LootResult } from './lootcrate';
import { grantPlayerVp } from './playerStats';
import { sendBotMessage } from './botBridge';

// New-member join requirement, mirrored from the Discord verify flow (createVerifyMessage.js).
export const MIN_TOTAL_LEVEL = 2000;
export const MIN_EHB = 150;

const TOKEN_COLS =
	'token, discord_id, variant, user_id, current_step, completed_steps, data, expires_at, started_at, completed_at';

export interface OnboardingRow {
	token: string;
	discord_id: string;
	variant: string;
	user_id: string | null;
	current_step: string | null;
	completed_steps: StepId[];
	data: Record<string, unknown>;
	expires_at: string;
	started_at: string | null;
	completed_at: string | null;
}

export type OnboardingLoad =
	| { ok: true; session: OnboardingSession }
	| { ok: false; reason: 'not_found' | 'expired' | 'wrong_user' };

// The resolved view the route + stepper render from.
export interface OnboardingSession {
	token: string;
	variant: OnboardingVariant;
	steps: StepId[];
	currentStep: StepId;
	completed: StepId[];
	data: Record<string, unknown>;
}

function rowToSession(row: OnboardingRow): OnboardingSession {
	const variant: OnboardingVariant = isValidVariant(row.variant) ? row.variant : 'b';
	const steps = stepsForVariant(variant);
	const completed = (Array.isArray(row.completed_steps) ? row.completed_steps : []).filter(
		(s): s is StepId => steps.includes(s as StepId)
	);
	// Current step = the persisted one if it's still in the sequence, else the first
	// not-yet-completed step, else the last (finished).
	let currentStep: StepId | null =
		row.current_step && steps.includes(row.current_step as StepId)
			? (row.current_step as StepId)
			: null;
	if (!currentStep) currentStep = steps.find((s) => !completed.includes(s)) ?? steps[steps.length - 1];
	return {
		token: row.token,
		variant,
		steps,
		currentStep,
		completed,
		data: row.data && typeof row.data === 'object' ? row.data : {}
	};
}

async function fetchRow(token: string): Promise<OnboardingRow | null> {
	const { data } = await db().from('vs_onboarding_tokens').select(TOKEN_COLS).eq('token', token).maybeSingle();
	return (data as OnboardingRow | null) ?? null;
}

// Load an onboarding session for the signed-in user, binding the row to them on first
// open. The link is for a specific discord_id; a different signed-in user is refused.
export async function loadOnboarding(token: string, user: SessionUser): Promise<OnboardingLoad> {
	const row = await fetchRow(token);
	if (!row) return { ok: false, reason: 'not_found' };
	if (new Date(row.expires_at).getTime() < Date.now()) return { ok: false, reason: 'expired' };
	if (row.discord_id !== user.discord_id) return { ok: false, reason: 'wrong_user' };

	// First open: stamp started_at + bind the vs_users id + seed current_step.
	if (!row.started_at || row.user_id !== user.id || !row.current_step) {
		const steps = stepsForVariant(isValidVariant(row.variant) ? row.variant : 'b');
		const patch: Record<string, unknown> = { user_id: user.id };
		if (!row.started_at) patch.started_at = new Date().toISOString();
		if (!row.current_step) patch.current_step = steps[0];
		await db().from('vs_onboarding_tokens').update(patch).eq('token', token);
		Object.assign(row, patch);
	}
	return { ok: true, session: rowToSession(row) };
}

// Mark a step complete and advance current_step to the next unfinished step. Stamps
// completed_at when the last step is reached. Idempotent per step.
export async function completeStep(
	token: string,
	user: SessionUser,
	step: StepId,
	extraData?: Record<string, unknown>
): Promise<OnboardingLoad> {
	const row = await fetchRow(token);
	if (!row) return { ok: false, reason: 'not_found' };
	if (row.discord_id !== user.discord_id) return { ok: false, reason: 'wrong_user' };

	const variant: OnboardingVariant = isValidVariant(row.variant) ? row.variant : 'b';
	const steps = stepsForVariant(variant);
	const completed = new Set<StepId>(
		(Array.isArray(row.completed_steps) ? row.completed_steps : []).filter((s) => steps.includes(s as StepId)) as StepId[]
	);
	completed.add(step);
	const next = steps.find((s) => !completed.has(s)) ?? steps[steps.length - 1];
	const allDone = steps.every((s) => completed.has(s));

	const mergedData = { ...(row.data ?? {}), ...(extraData ?? {}) };
	await db()
		.from('vs_onboarding_tokens')
		.update({
			completed_steps: [...completed],
			current_step: next,
			data: mergedData,
			...(allDone && !row.completed_at ? { completed_at: new Date().toISOString() } : {})
		})
		.eq('token', token);

	return {
		ok: true,
		session: rowToSession({ ...row, completed_steps: [...completed], current_step: next, data: mergedData })
	};
}

// Jump the pointer to a step without completing it (Back / rail navigation). Only
// allowed to a step already reached (completed) or the current one — no skipping ahead.
export async function gotoStep(token: string, user: SessionUser, step: StepId): Promise<OnboardingLoad> {
	const row = await fetchRow(token);
	if (!row) return { ok: false, reason: 'not_found' };
	if (row.discord_id !== user.discord_id) return { ok: false, reason: 'wrong_user' };
	const session = rowToSession(row);
	const idx = session.steps.indexOf(step);
	const curIdx = session.steps.indexOf(session.currentStep);
	if (idx < 0 || (idx > curIdx && !session.completed.includes(step))) return { ok: true, session };
	await db().from('vs_onboarding_tokens').update({ current_step: step }).eq('token', token);
	return { ok: true, session: { ...session, currentStep: step } };
}

// ── Mint (site-side; the bot mints the real test links) ──────────────────────
function mintTokenString(): string {
	const arr = new Uint8Array(24);
	crypto.getRandomValues(arr);
	return Array.from(arr, (b) => b.toString(16).padStart(2, '0')).join('');
}

export async function mintOnboardingToken(opts: {
	discordId: string;
	variant: OnboardingVariant;
	createdBy?: string;
}): Promise<string> {
	const token = mintTokenString();
	const { error } = await db().from('vs_onboarding_tokens').insert({
		token,
		discord_id: opts.discordId,
		variant: opts.variant,
		created_by: opts.createdBy ?? null
	});
	if (error) throw new Error(`mint onboarding token: ${error.message}`);
	return token;
}

// ── Step side effects ────────────────────────────────────────────────────────

export interface VerifyResult {
	ok: boolean;
	rsn: string;
	totalLevel: number | null;
	ehb: number;
	womId: number | null;
	meets: boolean;
	reason?: 'not_found' | 'below_requirements';
}

// Version B verify: look the RSN up on WiseOldMan and gate on 2000+ total & 150+ EHB.
// Reuses fetchPlayerRankInputs (its ehb + totalLevel come from WOM). An admin can force
// past a below-requirements result at the route layer.
export async function verifyRsn(rsn: string): Promise<VerifyResult> {
	const trimmed = rsn.trim();
	try {
		const inputs = await fetchPlayerRankInputs(trimmed, undefined, []);
		const totalLevel = inputs.totalLevel;
		const ehb = inputs.ehb;
		const meets = (totalLevel ?? 0) >= MIN_TOTAL_LEVEL && ehb >= MIN_EHB;
		// A missing WOM player returns 0/null total level and no womId.
		if (!inputs.womId && !totalLevel) {
			return { ok: false, rsn: trimmed, totalLevel, ehb, womId: inputs.womId ?? null, meets: false, reason: 'not_found' };
		}
		return {
			ok: true,
			rsn: trimmed,
			totalLevel,
			ehb,
			womId: inputs.womId ?? null,
			meets,
			reason: meets ? undefined : 'below_requirements'
		};
	} catch (e) {
		console.error('[onboarding] verifyRsn failed:', e instanceof Error ? e.message : e);
		return { ok: false, rsn: trimmed, totalLevel: null, ehb: 0, womId: null, meets: false, reason: 'not_found' };
	}
}

// Ensure a players row exists for this member (Version B replaces the bot's verify,
// which normally creates it). Idempotent; 0 starting VP, same as createPlayer.
export async function ensurePlayerRow(discordId: string, rsn: string, womId: number | null): Promise<void> {
	const { data: existing } = await db().from('players').select('id').eq('discord_id', discordId).maybeSingle();
	if (existing) return;
	const { error } = await db()
		.from('players')
		.insert({ discord_id: discordId, rsn, wom_id: womId ?? null, points: 0 });
	if (error) console.error('[onboarding] ensurePlayerRow failed:', error.message);
}

// Post the introduction into Discord via the bridge (the bot owns the channel + format).
export interface IntroFields {
	basic_info: string;
	stats_info: string;
	clan_history: string;
	goals_interests: string;
	additional_info: string;
}
export async function postIntroToDiscord(user: SessionUser, fields: IntroFields): Promise<boolean> {
	return sendBotMessage('post_intro', {
		discord_id: user.discord_id,
		username: user.discord_username,
		rsn: user.rsn,
		...fields
	});
}

// ── Welcome rewards: a free loot crate roll + a white welcome pack ────────────
export interface RewardOutcome {
	crate: LootResult | null;
	whitePack: boolean;
}

// Grant the white welcome pack straight into inventory so the rewards step can rip it
// open IN-FLOW. Not gated on welcome_pack_granted — the flag stops the pack being
// granted a SECOND time elsewhere, but here we want a real, openable pack every time
// the member reaches this step (and so repeat testing always has one to open). We still
// set the flag so the home/onboarding-elsewhere paths don't double-grant.
async function grantWhitePack(user: SessionUser): Promise<boolean> {
	const id = await whitePackId();
	if (!id) return false;
	const ok = await grantUserPack(user.id, id, 1);
	if (ok && !user.welcome_pack_granted) {
		await db().from('vs_users').update({ welcome_pack_granted: true }).eq('id', user.id);
	}
	return ok;
}

// Roll a welcome loot crate and apply its VP (item/role rewards are handled by the
// gamba open flow in normal play; the onboarding gift keeps it to VP for simplicity).
async function grantWelcomeCrate(user: SessionUser): Promise<LootResult | null> {
	try {
		const result = rollLoot(await getLootConfig(), false, false); // VP-only roll for the gift
		const vp = result.kind === 'vp' ? result.amount : 0;
		if (vp > 0) await grantPlayerVp(user.discord_id, user.rsn, vp);
		return result;
	} catch (e) {
		console.error('[onboarding] grantWelcomeCrate failed:', e instanceof Error ? e.message : e);
		return null;
	}
}

export async function grantOnboardingRewards(user: SessionUser): Promise<RewardOutcome> {
	const [crate, whitePack] = await Promise.all([grantWelcomeCrate(user), grantWhitePack(user)]);
	return { crate, whitePack };
}

// The crate reel filler cells (every possible reward bucket) — same source the gamba
// crate uses, so the onboarding reel spins through real tiers/items. For CrateReveal.
export interface OnboardCrateCell {
	label: string;
	image: string | null;
	colorHex: string;
}
export async function onboardingCrateReel(): Promise<OnboardCrateCell[]> {
	const cfg = await getLootConfig();
	const cells: OnboardCrateCell[] = cfg.vpTiers.map((t) => ({
		label: t.label,
		image: t.image ?? null,
		colorHex: `#${t.color ?? '808080'}`
	}));
	for (const i of cfg.items ?? []) {
		if (i.enabled === false) continue;
		cells.push({ label: i.name, image: i.image ?? null, colorHex: `#${i.color ?? '00FF00'}` });
	}
	if (cfg.roleReward?.enabled) {
		cells.push({
			label: cfg.roleReward.label ?? 'Role',
			image: cfg.roleReward.image ?? null,
			colorHex: `#${cfg.roleReward.color ?? '800080'}`
		});
	}
	return cells;
}

// The white welcome pack's id (for opening it in-flow). Null if the pack isn't set up.
export async function whitePackId(): Promise<string | null> {
	const { data } = await db()
		.from('vs_card_packs')
		.select('id')
		.ilike('name', 'white%')
		.order('created_at', { ascending: true })
		.limit(1)
		.maybeSingle();
	return (data as { id: string } | null)?.id ?? null;
}

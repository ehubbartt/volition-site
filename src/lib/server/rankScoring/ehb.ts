// Ironman EHB (Efficient Hours Bossed) — a self-contained port of Wise Old Man's
// IRONMAN rate table, used to re-derive EHB for group-ironman members instead of
// trusting the EHB WOM hands us for them.
//
// WHY: our clan is all-ironman. Regular irons already appear on WOM typed as `ironman`,
// so WOM scores their EHB on iron rates. Group ironman accounts, however, are not always
// typed that way on WOM, so their `player.ehb` can come back computed on MAIN rates —
// which understates the iron grind and scores GIMs unfairly against the rest of the clan.
// For accounts the site knows are GIM (self-selected `account_type`), we throw away WOM's
// EHB and recompute it from the member's boss KCs using the iron rates below.
//
// SOURCE: wise-old-man/wise-old-man
//   server/src/api/modules/efficiency/configs/ehb/ironman.ehb.ts
// Ported verbatim (metric key = WOM Boss enum value, rate = kills per efficient hour).
// The ironman EHB config carries no bonuses — it's a flat boss→rate table — so the
// computation is a straight sum of kills / rate. Keep this table in sync if WOM revises
// their rates; a boss we don't list simply contributes nothing (never a crash).

// Boss metric key (WOM snapshot `data.bosses.<key>.kills`) → kills per efficient hour.
export const IRONMAN_EHB_RATES: Record<string, number> = {
	abyssal_sire: 44,
	alchemical_hydra: 29,
	amoxliatl: 71,
	araxxor: 38,
	artio: 50,
	barrows_chests: 22,
	brutus: 250,
	bryophyta: 9,
	callisto: 142,
	calvarion: 45,
	cerberus: 54,
	chambers_of_xeric_challenge_mode: 3,
	chambers_of_xeric: 3.5,
	chaos_elemental: 48,
	chaos_fanatic: 80,
	commander_zilyana: 30,
	corporeal_beast: 10,
	crazy_archaeologist: 95,
	dagannoth_prime: 100,
	dagannoth_rex: 100,
	dagannoth_supreme: 100,
	deranged_archaeologist: 95,
	doom_of_mokhaiotl: 18,
	duke_sucellus: 37,
	general_graardor: 31,
	giant_mole: 97,
	grotesque_guardians: 34,
	hespori: 50,
	kalphite_queen: 37,
	king_black_dragon: 75,
	kraken: 90,
	kreearra: 30,
	kril_tsutsaroth: 32,
	lunar_chests: 18,
	mimic: 50,
	nex: 20,
	nightmare: 11,
	obor: 12,
	phantom_muspah: 27,
	phosanis_nightmare: 9.3,
	sarachnis: 67,
	scorpia: 80,
	scurrius: 60,
	shellbane_gryphon: 95,
	skotizo: 38,
	sol_heredit: 2.7,
	spindel: 50,
	the_corrupted_gauntlet: 7.2,
	the_hueycoatl: 20,
	the_gauntlet: 10,
	the_leviathan: 27,
	the_royal_titans: 55,
	the_whisperer: 21,
	theatre_of_blood_hard_mode: 3,
	theatre_of_blood: 3.2,
	thermonuclear_smoke_devil: 100,
	tombs_of_amascut_expert: 3,
	tombs_of_amascut: 3.7,
	tzkal_zuk: 1,
	tztok_jad: 2.2,
	vardorvis: 37,
	venenatis: 80,
	vetion: 39,
	vorkath: 34,
	yama: 18,
	zulrah: 42
};

// Site `account_type` values that are group-ironman accounts. These are the accounts we
// re-score on iron rates. Regular ironman/hcim/uim already get iron EHB from WOM, so they
// aren't included — extend this set if that ever stops being true.
const IRONMAN_EHB_ACCOUNT_TYPES = new Set(['gim', 'gim_unranked']);

export function usesIronmanEhb(accountType: string | null | undefined): boolean {
	return accountType != null && IRONMAN_EHB_ACCOUNT_TYPES.has(accountType);
}

// EHB from a boss-KC map (metric key → kills) using the iron rates. Mirrors WOM's own
// sum: for each ranked boss, hours += kills / rate. Unranked/absent bosses (WOM reports
// -1, or the key is missing) and any boss not in the rate table contribute nothing.
export function computeIronmanEhb(bossKills: Record<string, number> | null | undefined): number {
	if (!bossKills) return 0;
	let hours = 0;
	for (const [metric, rate] of Object.entries(IRONMAN_EHB_RATES)) {
		if (rate <= 0) continue;
		const kills = bossKills[metric];
		if (typeof kills === 'number' && kills > 0) hours += kills / rate;
	}
	return hours;
}

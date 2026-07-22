<script lang="ts">
	import type { Snippet } from 'svelte';
	import RankBadge from '$lib/RankBadge.svelte';
	import InfoTip from '$lib/InfoTip.svelte';
	import ItemInfoModal from '$lib/ItemInfoModal.svelte';
	import { rankLabel, rankColor, rankImg, RANK_ORDER, RANK_LABEL, type RankValue } from '$lib/ranks';
	import { itemIconUrl } from '$lib/osrsItems';
	import { itemImageUrl, wikiPageUrl } from '$lib/wikiImage';
	import { retryImage } from '$lib/imageRetry';
	import { formatEhb } from '$lib/ehb';

	// Shared Rank tab body for /me and /u/[rsn]: rank badge + composite, progress to
	// the next rank, the weighted component breakdown, gear pieces, and combat
	// achievements. Read-only — /me injects its "Check my rank" form via the
	// `actions` snippet and its error/cooldown lines via `status`.
	interface RankComponent {
		key: string;
		label: string;
		weight: number;
		normalized: number;
		raw: number;
		cap: number;
	}
	interface GearPiece {
		name: string;
		iconItem: string | null; // display / wiki
		checkItem?: string | null; // clog check name — the manual-claim target
		earned: number;
		max: number;
		status?: 'complete' | 'partial' | 'none';
		owned: boolean; // complete
		missing?: string[]; // partial: remaining check items (display names)
		components?: { name: string; names?: string[]; qty: number }[]; // all pieces that make up this entry
		assembled?: boolean; // built from parts → modal shows the component breakdown
		claimable?: boolean; // untrackable via the clog — click-to-claim when onClaim is set
		note?: string | null; // optional explanatory note shown in the item modal
	}
	interface GearGroup {
		tier: string;
		label: string;
		pieces: GearPiece[];
	}
	interface CADetailView {
		tasksCompleted: number;
		wikiPoints: number;
		highestTier: string;
	}
	interface RankBreakdownView {
		rank: RankValue;
		composite: number;
		nextRank: RankValue | null;
		nextThreshold: number | null;
		nextRankProgress: number;
		components: RankComponent[];
		gearGrid: GearGroup[];
		gearOwned: number;
		gearTotal: number;
		caDetail: CADetailView | null;
		templeAvailable: boolean;
		wikisyncAvailable: boolean;
		fetchedAt: string | null;
	}

	// The rank advisor payload (from /api/rank-advice). Kept in sync with rankAdvice.ts.
	interface AdviceComponent {
		key: string;
		label: string;
		weight: number;
		normalized: number;
		potential: number;
		compositeGain: number;
		atCap: boolean;
		advice: string;
		estHours: number | null;
	}
	interface AdviceGearTarget {
		entry: string;
		iconItem: string | null;
		points: number;
		hours: number | null;
		pointsPerHour: number | null;
		fromBoss: boolean;
		compositeGain: number;
		fillsClog: boolean;
		missing: string[];
	}
	interface AdviceStep {
		key: string;
		title: string;
		detail: string;
		compositeGain: number;
		estHours: number | null;
	}
	interface RankAdvice {
		available: true;
		composite: number;
		rank: RankValue;
		nextRank: RankValue | null;
		nextThreshold: number | null;
		gap: number;
		components: AdviceComponent[];
		gearTargets: AdviceGearTarget[];
		steps: AdviceStep[];
		fetchedAt?: string | null;
	}
	type AdviceResponse = RankAdvice | { available: false; reason: string };

	let {
		rank,
		currentRank = null,
		emptyText = '',
		showSetupTips = false,
		onClaim,
		adviceEndpoint,
		actions,
		status
	}: {
		rank: RankBreakdownView | null;
		currentRank?: string | null;
		/** Shown when there's no breakdown yet; pass '' to show nothing. */
		emptyText?: string;
		/** Second-person "set this up" hints under zero-score components (/me only). */
		showSetupTips?: boolean;
		/** Click-to-claim for untrackable gear tiles (/me passes this; /u omits it).
		 * Receives the CHECK item name the claim should target. */
		onClaim?: (itemName: string) => void;
		/** When set (/me only), enables the "How do I rank up?" advisor, fetched from here. */
		adviceEndpoint?: string;
		actions?: Snippet;
		status?: Snippet;
	} = $props();

	// --- Rank advisor + rank-ladder reference ---------------------------------
	let showAllRanks = $state(false);
	let advice = $state<RankAdvice | null>(null);
	let adviceOn = $state(false); // whether the bar overlays + panel are shown
	let adviceLoading = $state(false);
	let adviceError = $state<string | null>(null);

	// A distinct colour per component so each score bar's "what you could do" overlay —
	// and its recommendation card — reads as its own lever.
	const COMP_COLOR: Record<string, string> = {
		gear: '#e0457b',
		ehb: '#ff9500',
		ca: '#4aa6b5',
		clog: '#7bbf6a',
		level: '#b06bd6',
		time: '#8d8d8d'
	};
	// Fast lookup of the advice for a given component key while rendering the bars.
	const adviceByKey = $derived(new Map((advice?.components ?? []).map((c) => [c.key, c])));

	async function toggleAdvice() {
		if (!adviceEndpoint) return;
		if (adviceOn) {
			adviceOn = false;
			return;
		}
		if (advice) {
			adviceOn = true;
			return;
		}
		adviceLoading = true;
		adviceError = null;
		try {
			const res = await fetch(adviceEndpoint);
			if (!res.ok) throw new Error(`Advisor request failed (${res.status})`);
			const data = (await res.json()) as AdviceResponse;
			if (!data.available) {
				adviceError =
					data.reason === 'no_rsn'
						? 'Set your RSN and check your rank first.'
						: 'Check your rank first, then ask for advice.';
			} else {
				advice = data;
				adviceOn = true;
			}
		} catch (e) {
			adviceError = e instanceof Error ? e.message : 'Could not load advice.';
		} finally {
			adviceLoading = false;
		}
	}

	const fmtHours = (h: number | null) => (h != null ? formatEhb(h) : null);

	// The rank badge to show as "working toward" — the next rank, or the current one at
	// max rank. Null before any breakdown is loaded.
	const targetRank = $derived(rank ? (rank.nextRank ?? rank.rank) : null);
	const targetImg = $derived(targetRank ? rankImg(targetRank) : null);

	const pct = (n: number) => `${Math.round(n * 100)}%`;
	// Near-threshold honesty: the composite gets one decimal so 34.9% can't display as
	// the 35% threshold it hasn't crossed, and next-rank progress FLOORS so 99.6% reads
	// 99% — never a premature 100% while the rank genuinely hasn't ticked over.
	const pct1 = (n: number) => `${Math.round(n * 1000) / 10}%`;
	const pctFloor = (n: number) => `${Math.floor(n * 100)}%`;
	const num = (n: number) => Math.round(n).toLocaleString();
	const TIER_LABEL: Record<string, string> = {
		none: 'None',
		easy: 'Easy',
		medium: 'Medium',
		hard: 'Hard',
		elite: 'Elite',
		master: 'Master',
		grandmaster: 'Grandmaster'
	};
	const tierLabel = (t: string | undefined | null) => (t ? (TIER_LABEL[t] ?? t) : 'None');
	const fmtWhen = (iso: string | null) =>
		iso
			? new Date(iso).toLocaleString(undefined, {
					month: 'short',
					day: 'numeric',
					hour: 'numeric',
					minute: '2-digit'
				})
			: null;

	// Gear tile → item info modal (shared ItemInfoModal): facts + wiki link, and for
	// claimable-but-unowned pieces the claim shortcut (when the page provides onClaim).
	let infoPiece = $state<{ piece: GearPiece; tierLabel: string } | null>(null);

	// ⓘ explainer per component: where the number comes from + how it's scored.
	// Keys match rankScoring's ComponentKey.
	const COMP_TIPS: Record<string, string> = {
		gear: "Read from your TempleOSRS collection log: each set or piece in the clan's gear table is worth points — alternatives of an item count once, and multi-quantity pieces give partial credit. The bar is your gear points out of the table's total.",
		ehb: "Efficient hours bossed, read from the clan's WiseOldMan group roster. The bar fills toward the configured EHB cap; hours past the cap don't add more score.",
		ca: 'Scored on tier-completion rewards, not in-game CA points: fully finishing a tier (Easy → Grandmaster, in order) banks that tier\'s reward — partly-finished tiers count for nothing. The cap is all six tier rewards, so this bar only moves when you complete a whole tier. Task completion is read from the RuneLite WikiSync plugin.',
		time: "Months since you were added to the clan's WiseOldMan group. The bar fills toward the configured months cap.",
		clog: 'Collection-log slots completed, read from your TempleOSRS profile. The bar fills toward the configured slots cap.',
		level: 'Total level from your latest WiseOldMan snapshot. Only levels above the configured minimum score — the bar measures where you sit between that minimum and the cap.'
	};

	// "Set this up" hint for a zero-score component: what's missing and where to fix it.
	// Temple/WikiSync availability separates "source unreachable/unsynced" from a genuine 0.
	interface SetupTip {
		text: string;
		href?: string;
		link?: string;
		ext?: boolean;
	}
	function setupTip(key: string): SetupTip | null {
		if (!rank) return null;
		const temple = rank.templeAvailable;
		switch (key) {
			case 'gear':
				return {
					text: temple
						? 'No gear points yet — your Temple collection log looks empty. Sync your collection log to TempleOSRS, then re-check.'
						: "Couldn't read your TempleOSRS profile. Sync your collection log to Temple, then re-check.",
					href: '/temple-guide',
					link: 'Temple setup guide'
				};
			case 'clog':
				return {
					text: temple
						? 'No collection-log slots found — sync your collection log to TempleOSRS, then re-check.'
						: "Couldn't read your TempleOSRS profile. Sync your collection log to Temple, then re-check.",
					href: '/temple-guide',
					link: 'Temple setup guide'
				};
			case 'ca':
				return rank.wikisyncAvailable
					? { text: 'No fully-completed tier yet — finish every task in a tier (Easy first) to bank its reward.' }
					: {
							text: "Couldn't read your combat achievements — install RuneLite's WikiSync plugin and log in once so your progress syncs, then re-check.",
							href: 'https://runelite.net/plugin-hub/show/wikisync',
							link: 'Get WikiSync',
							ext: true
						};
			case 'ehb':
				return {
					text: "No EHB found — you may not be on the clan's WiseOldMan group yet, or your WOM profile has never been updated. Ask a staff member to add you, then re-check.",
					href: 'https://wiseoldman.net',
					link: 'wiseoldman.net',
					ext: true
				};
			case 'time':
				return {
					text: "No clan join date found — you may not be on the clan's WiseOldMan group yet. Ask a staff member to add you, then re-check.",
					href: 'https://wiseoldman.net',
					link: 'wiseoldman.net',
					ext: true
				};
			case 'level':
				return {
					text: 'No total level found — your WiseOldMan profile has no snapshot yet. Look yourself up on wiseoldman.net and hit Update, then re-check.',
					href: 'https://wiseoldman.net',
					link: 'wiseoldman.net',
					ext: true
				};
			default:
				return null;
		}
	}
</script>

<section class="rank-panel">
	<div class="rank-head">
		<div class="rank-id">
			<RankBadge rank={rank?.rank ?? currentRank} size={40} />
			<div>
				<span class="rank-label">Clan rank</span>
				<strong class="rank-name" style="color:{rankColor(rank?.rank ?? currentRank)}">
					{rank ? rankLabel(rank.rank) : currentRank ? rankLabel(currentRank) : 'Not calculated yet'}
				</strong>
				{#if rank}
					<span class="composite">Composite score {pct1(rank.composite)}</span>
				{/if}
			</div>
		</div>
		{#if actions}{@render actions()}{/if}
	</div>

	{#if status}{@render status()}{/if}

	{#if rank}
		<!-- Overall progress toward the next rank (within the current tier's band), with
		     the badge you're working toward and the rank-up advisor. -->
		<div class="next-rank">
			<div class="next-main">
				<div class="next-progress">
					<div class="comp-top">
						<span class="comp-label">
							{#if rank.nextRank}
								Progress to {rankLabel(rank.nextRank)}
							{:else}
								Max rank achieved
							{/if}
						</span>
						<span class="comp-weight">{pctFloor(rank.nextRankProgress)}</span>
					</div>
					<div class="osrs-bar next-bar">
						<span class="osrs-bar-fill" style="width:{pct(rank.nextRankProgress)}"></span>
					</div>
					{#if rank.nextRank && rank.nextThreshold !== null}
						<span class="next-hint muted"
							>Composite {pct1(rank.composite)} · {rankLabel(rank.nextRank)} at {pct1(rank.nextThreshold)}</span
						>
					{/if}
				</div>
				<!-- The rank you're working toward (or your current top badge at max rank). -->
				<div class="next-target" title={rank.nextRank ? `Working toward ${rankLabel(targetRank)}` : 'Max rank'}>
					{#if targetImg}
						<img src={targetImg} alt={rankLabel(targetRank)} width="46" height="46" />
					{:else}
						<RankBadge rank={targetRank} size={46} />
					{/if}
					<span class="next-target-lbl" style="color:{rankColor(targetRank)}">
						{rank.nextRank ? `Next: ${rankLabel(targetRank)}` : rankLabel(targetRank)}
					</span>
				</div>
			</div>

			<div class="rank-tools">
				{#if adviceEndpoint && rank.nextRank}
					<button type="button" class="tool-btn advise" onclick={toggleAdvice} disabled={adviceLoading}>
						{#if adviceLoading}Charting…{:else if adviceOn}Hide rank-up route{:else}Suggest rank-up route{/if}
					</button>
				{/if}
				<button type="button" class="tool-btn" onclick={() => (showAllRanks = true)}>All clan ranks</button>
			</div>
			{#if adviceError}<p class="advise-err">{adviceError}</p>{/if}
		</div>

		<div class="comps">
			{#each rank.components as c (c.key)}
				{@const a = adviceOn ? adviceByKey.get(c.key) : undefined}
				<div class="comp" class:maxed={c.raw >= c.cap}>
					<div class="comp-top">
						<span class="comp-label">
							{c.label}
							{#if COMP_TIPS[c.key]}
								<InfoTip tip={COMP_TIPS[c.key]} label="How {c.label.toLowerCase()} is scored" />
							{/if}
						</span>
						<span class="comp-weight">{pct(c.weight)} of score</span>
					</div>
					<div class="osrs-bar">
						<span class="osrs-bar-fill" style="width:{pct(c.normalized)}"></span>
						{#if a && a.potential > a.normalized + 0.001}
							<span
								class="osrs-bar-potential"
								style="left:{pct(a.normalized)}; width:{pct(a.potential - a.normalized)}; background:{COMP_COLOR[
									c.key
								]}"
							></span>
						{/if}
					</div>
					<div class="comp-foot">
						<span class="comp-raw">{num(c.raw)} / {num(c.cap)}</span>
						<span class="comp-norm">{pct(c.normalized)}</span>
					</div>
					{#if a && !a.atCap && a.advice}
						<p class="comp-advice" style="border-left-color:{COMP_COLOR[c.key]}">
							{a.advice}
							{#if a.estHours}<span class="muted"> · ~{fmtHours(a.estHours)}</span>{/if}
						</p>
					{/if}
					{#if showSetupTips && c.raw <= 0}
						{@const fix = setupTip(c.key)}
						{#if fix}
							<p class="comp-fix">
								{fix.text}
								{#if fix.href}
									{#if fix.ext}
										<a href={fix.href} target="_blank" rel="noreferrer noopener">{fix.link} ↗</a>
									{:else}
										<a href={fix.href}>{fix.link} →</a>
									{/if}
								{/if}
							</p>
						{/if}
					{/if}
				</div>
			{/each}
		</div>

		{#if adviceOn && advice}
				<div class="plan">
					<div class="plan-head">
						<h4>Your rank-up route{advice.nextRank ? ` to ${rankLabel(advice.nextRank)}` : ''}</h4>
						{#if advice.nextRank}<span class="plan-gap muted">need +{pct1(advice.gap)} composite</span>{/if}
					</div>
					{#if advice.steps.length}
						<ol class="plan-steps">
							{#each advice.steps as s (s.key)}
								<li>
									<span class="plan-dot" style="background:{COMP_COLOR[s.key]}"></span>
									<div class="plan-step-body">
										<div class="plan-step-top">
											<strong>{s.title}</strong>
											<span class="plan-gain">+{pct1(s.compositeGain)}{#if s.estHours}<span class="muted"> · ~{fmtHours(s.estHours)}</span>{/if}</span>
										</div>
										<p class="muted small">{s.detail}</p>
									</div>
								</li>
							{/each}
						</ol>
					{:else}
						<p class="muted small">You're maxed on every actionable component — the rest is time in the clan.</p>
					{/if}

					{#if advice.gearTargets.length}
						<p class="plan-sub">Best gear to chase <span class="muted">(easiest first)</span></p>
						<div class="gear-targets">
							{#each advice.gearTargets as t (t.entry)}
								<div class="gtarget" class:boss={t.fromBoss}>
									<div class="gtarget-img">
										{#if t.iconItem}
											<img src={itemIconUrl(t.iconItem)} alt={t.entry} loading="lazy" referrerpolicy="no-referrer" use:retryImage />
										{/if}
									</div>
									<div class="gtarget-body">
										<strong>{t.entry}</strong>
										<span class="gtarget-meta muted">
											{t.points} pts · <span class="src {t.fromBoss ? 'boss' : 'nonboss'}">{t.fromBoss ? 'boss' : 'non-boss'}</span>{#if t.hours != null} · {fmtHours(t.hours)}{#if t.pointsPerHour != null} · {t.pointsPerHour} pts/h{/if}{/if}
										</span>
									</div>
								</div>
							{/each}
						</div>
					{/if}
					<p class="plan-foot muted small">Estimates only — EHB assumes efficient play, and some items (crafted/upgraded gear) have no obtain-time data.</p>
				</div>
			{/if}

			{#if rank.gearGrid.length}
			<details class="gear-detail" open>
				<summary>Gear pieces · {rank.gearOwned} / {rank.gearTotal} earned</summary>
				{#each rank.gearGrid as group (group.tier)}
					<p class="tier-head muted">{group.label}</p>
					<div class="gear-grid">
						{#each group.pieces as p (p.name)}
							<!-- Every tile opens the item info modal (wiki link, points, tracking);
							     claimable pieces get their claim shortcut INSIDE the modal. -->
							<button
								type="button"
								class="gtile"
								class:owned={p.owned}
								class:partial={p.status === 'partial'}
								title="{p.name} · {p.owned
									? `${p.earned}/${p.max} pts`
									: p.status === 'partial'
										? `in progress — need ${(p.missing ?? []).join(', ')}`
										: `0/${p.max} pts`} — click for details"
								onclick={() => (infoPiece = { piece: p, tierLabel: group.label })}
							>
								<div class="gtile-img">
									{#if p.iconItem}
										<img
											src={itemIconUrl(p.iconItem)}
											alt={p.name}
											loading="lazy"
											referrerpolicy="no-referrer"
											use:retryImage
										/>
									{/if}
								</div>
								<span class="gtile-pts">{p.owned ? `${p.earned}/${p.max}` : p.max}</span>
								<!-- Partial pieces are shown by the dashed outline alone (no ribbon). -->
								{#if p.status !== 'partial' && p.claimable}<span class="gtile-flag">claim</span>{/if}
							</button>
						{/each}
					</div>
				{/each}
			</details>
		{/if}

		{#if rank.caDetail}
			<div class="ca-detail">
				<h4>Combat achievements</h4>
				<div class="ca-stats">
					<div class="ca-stat">
						<span class="ca-num">{tierLabel(rank.caDetail.highestTier)}</span>
						<span class="ca-lbl">Highest tier</span>
					</div>
					<div class="ca-stat">
						<span class="ca-num">{num(rank.caDetail.tasksCompleted)}</span>
						<span class="ca-lbl">Tasks done</span>
					</div>
					<div
						class="ca-stat"
						title="Total combat-achievement points as tracked in-game — each completed CA task awards points based on its tier. This is a different number from the rank score above, which only counts fully-completed tier rewards."
					>
						<span class="ca-num">{num(rank.caDetail.wikiPoints)}</span>
						<span class="ca-lbl">CA points</span>
					</div>
				</div>
			</div>
		{/if}

		<p class="rank-foot muted small">
			Data as of {fmtWhen(rank.fetchedAt) ?? 'unknown'}.
			{#if !rank.templeAvailable || !rank.wikisyncAvailable}
				Some sources were unavailable ({[
					!rank.templeAvailable ? 'TempleOSRS' : null,
					!rank.wikisyncAvailable ? 'WikiSync' : null
				]
					.filter(Boolean)
					.join(', ')}) — re-check after syncing to improve accuracy.
			{/if}
		</p>
	{:else if emptyText}
		<p class="muted small">{emptyText}</p>
	{/if}
</section>

{#if infoPiece}
	{@const p = infoPiece.piece}
	<ItemInfoModal
		name={p.name}
		image={itemImageUrl(p.iconItem ?? p.name)}
		rows={[
			{ label: 'Tier', value: infoPiece.tierLabel },
			{
				label: 'Rank points',
				value: p.owned ? `${p.earned} / ${p.max}` : `0 / ${p.max} (not yet earned)`
			},
			{
				label: 'Status',
				value: p.owned ? 'Complete' : p.status === 'partial' ? 'In progress' : 'Missing'
			},
			{
				label: 'Tracked via',
				value: p.claimable ? 'Manual claim (not in the collection log)' : 'Temple collection log'
			}
		]}
		wikiPages={[p.iconItem ?? p.name]}
		onclose={() => (infoPiece = null)}
	>
		{#if p.note}<p class="modal-note">{p.note}</p>{/if}
		{#if p.assembled && (p.components ?? []).length}
			{@const comps = p.components ?? []}
			{@const missingSet = new Set(p.missing ?? [])}
			<!-- have: complete → all owned; none → none owned (no `missing` data is recorded
			     for a 0-check entry, so status must decide); partial → not in the missing set. -->
			{@const have = (n: string) =>
				p.status === 'complete' ? true : p.status === 'partial' ? !missingSet.has(n) : false}
			{@const haveCount = comps.filter((c) => have(c.name)).length}
			<div class="modal-missing">
				<p class="mm-head">
					{#if p.status === 'complete'}Made from — you have all of these:
					{:else}Components ({haveCount}/{comps.length} owned) — no points until you have every piece:
					{/if}
				</p>
				<ul class="component-list">
					{#each comps as c (c.name)}
						<li class:have={have(c.name)} class:needed={!have(c.name)}>
							<span class="comp-mark">{have(c.name) ? '✓' : '✗'}</span>
							<span class="comp-alts">
								{#each c.names ?? [c.name] as alt, i (alt)}
									{#if i > 0}<span class="comp-or"> or </span>{/if}
									<a href={wikiPageUrl(alt)} target="_blank" rel="noreferrer noopener">{alt} ↗</a>
								{/each}
								{#if c.qty > 1}<span class="comp-qty"> ×{c.qty}</span>{/if}
							</span>
							{#if !have(c.name)}<span class="comp-tag">needed</span>{/if}
						</li>
					{/each}
				</ul>
			</div>
		{/if}
		{#if p.claimable && !p.owned && onClaim}
			<button
				type="button"
				class="modal-claim"
				onclick={() => {
					const item = p.checkItem ?? p.iconItem ?? p.name;
					infoPiece = null;
					onClaim(item);
				}}
			>
				Claim this item with proof
			</button>
		{/if}
	</ItemInfoModal>
{/if}

<!-- All clan ranks reference: every rung of the ladder with its badge, low → high. -->
{#if showAllRanks}
	<!-- svelte-ignore a11y_click_events_have_key_events -->
	<!-- svelte-ignore a11y_no_static_element_interactions -->
	<div class="ranks-backdrop" onclick={(e) => e.target === e.currentTarget && (showAllRanks = false)}>
		<div class="ranks-modal" role="dialog" aria-label="Clan ranks" aria-modal="true">
			<button type="button" class="ranks-close" aria-label="Close" onclick={() => (showAllRanks = false)}>×</button>
			<h3>Clan ranks</h3>
			<p class="muted small">The full ladder, lowest to highest. Your current rank is highlighted.</p>
			<ul class="ranks-list">
				{#each RANK_ORDER as r, i (r)}
					{@const current = (rank?.rank ?? currentRank)?.toLowerCase() === r}
					<li class:current>
						<span class="ranks-num muted">{i + 1}</span>
						<RankBadge rank={r} size={34} />
						<span class="ranks-name" style="color:{rankColor(r)}">{RANK_LABEL[r]}</span>
						{#if current}<span class="ranks-you">you</span>{/if}
					</li>
				{/each}
			</ul>
		</div>
	</div>
{/if}

<style>
	.rank-panel {
		padding: 1.1rem 1.2rem;
		background: var(--surface-alt);
		border: 1px solid var(--border);
		border-radius: var(--radius);
		max-width: 40rem;
		/* The card is narrower than the page — center it instead of hugging the left. */
		margin-inline: auto;
	}
	.rank-head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 1rem;
		flex-wrap: wrap;
		padding-bottom: 1rem;
		margin-bottom: 1rem;
		border-bottom: 1px solid var(--border);
	}
	.composite {
		display: block;
		font-size: 0.82rem;
		color: var(--muted);
		margin-top: 0.15rem;
	}
	.rank-id {
		display: flex;
		align-items: center;
		gap: 0.7rem;
	}
	.rank-label {
		display: block;
		font-size: 0.78rem;
		color: var(--muted);
	}
	.rank-name {
		font-family: var(--font-heading);
		font-size: 1.25rem;
		text-shadow: var(--ts);
	}

	/* Overall next-rank progress (sits above the component breakdown) */
	.next-rank {
		margin-bottom: 1.1rem;
		padding-bottom: 1rem;
		border-bottom: 1px solid var(--border);
	}
	.next-bar {
		height: 0.8rem; /* the headline bar reads slightly heavier than the components */
	}
	.next-hint {
		display: block;
		margin-top: 0.35rem;
		font-size: 0.78rem;
	}

	/* Weighted component breakdown */
	.comps {
		display: flex;
		flex-direction: column;
		gap: 0.85rem;
	}
	/* A component at its cap (e.g. 980/980 CAs) gets a green outline so maxed stats
	   read at a glance. */
	.comp.maxed {
		border: 1.5px solid var(--success);
		border-radius: 6px;
		padding: 0.5rem 0.65rem;
		background: rgba(106, 168, 79, 0.08);
	}
	.comp.maxed .comp-raw {
		color: var(--success);
	}
	.comp-top {
		display: flex;
		align-items: baseline;
		justify-content: space-between;
		gap: 0.5rem;
		margin-bottom: 0.3rem;
	}
	.comp-label {
		font-size: 0.92rem;
		color: var(--text);
	}
	.comp-weight {
		font-size: 0.74rem;
		color: var(--muted);
	}
	/* Zero-score setup hint: what's missing for this component and where to fix it. */
	.comp-fix {
		margin: 0.35rem 0 0;
		padding: 0.4rem 0.6rem;
		background: var(--danger-bg);
		border: 1px solid var(--border);
		border-left: 3px solid var(--accent);
		border-radius: 4px;
		font-size: 0.78rem;
		line-height: 1.45;
		color: var(--muted);
	}
	.comp-fix a {
		white-space: nowrap;
	}
	/* composite bars use the shared .osrs-bar / .osrs-bar-fill utility (app.css) */
	.comp-foot {
		display: flex;
		align-items: baseline;
		justify-content: space-between;
		gap: 0.5rem;
		margin-top: 0.25rem;
	}
	.comp-raw {
		font-size: 0.78rem;
		color: var(--muted);
	}
	.comp-norm {
		font-size: 0.78rem;
		font-family: var(--font-heading);
		color: var(--accent);
	}

	/* Gear pieces (collapsible) */
	.gear-detail {
		margin-top: 1.1rem;
		border-top: 1px solid var(--border);
		padding-top: 1rem;
	}
	.gear-detail summary {
		cursor: pointer;
		font-size: 0.9rem;
		color: var(--text);
	}
	.tier-head {
		margin: 1rem 0 0.5rem;
		text-transform: uppercase;
		letter-spacing: 0.05em;
		font-size: 0.72rem;
	}
	.gear-grid {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(50px, 1fr));
		gap: 0.35rem;
	}
	.gtile {
		display: flex;
		flex-direction: column;
		align-items: center;
		text-align: center;
		gap: 0.1rem;
		padding: 0.3rem 0.15rem;
		background: var(--surface);
		border: 1px solid var(--border);
		border-radius: var(--radius);
		opacity: 0.32;
		filter: grayscale(1);
	}
	.gtile.owned {
		opacity: 1;
		filter: none;
		border-color: var(--border-strong);
	}
	/* In-progress: partly assembled — visibly distinct from both owned and missing
	   (dimmed but colour retained, amber outline) and scores no points yet. */
	.gtile.partial {
		opacity: 0.85;
		filter: none;
		border-color: var(--accent);
		border-style: dashed;
	}
	.gtile-img {
		height: 30px;
		display: flex;
		align-items: center;
		justify-content: center;
	}
	.gtile-img img {
		max-width: 34px;
		max-height: 30px;
		object-fit: contain;
	}
	.gtile-pts {
		font-size: 0.6rem;
		color: var(--muted);
	}
	.gtile.owned .gtile-pts {
		color: var(--accent);
		font-family: var(--font-heading);
	}
	/* Tiles are <button>s (click → item info modal); reset the global bronze button
	   styling so they keep the collection-log-grid look. The "claim" ribbon marks
	   untrackable pieces. */
	.gtile {
		position: relative;
		border-image: none;
		min-height: 0;
		font: inherit;
		cursor: pointer;
	}
	.gtile:hover,
	.gtile:focus {
		border-color: var(--accent);
	}
	.gtile-flag {
		position: absolute;
		top: 2px;
		right: 2px;
		padding: 0 0.25rem;
		font-size: 0.5rem;
		text-transform: uppercase;
		letter-spacing: 0.05em;
		border-radius: 3px;
		background: var(--accent);
		color: #1c1710;
	}
	/* The claim shortcut inside the item modal (only on /me for unowned claimables). */
	.modal-claim {
		width: 100%;
		margin-top: 0.5rem;
	}
	.modal-note {
		margin: 0.2rem 0 0.5rem;
		padding: 0.5rem 0.7rem;
		font-size: 0.82rem;
		line-height: 1.4;
		color: var(--muted);
		background: var(--surface);
		border: 1px solid var(--border);
		border-radius: 3px;
	}
	/* Component breakdown inside the item modal for assembled gear. */
	.modal-missing {
		margin: 0.2rem 0 0.4rem;
	}
	.modal-missing .mm-head {
		margin: 0 0 0.3rem;
		font-size: 0.8rem;
		color: var(--muted);
	}
	.component-list {
		list-style: none;
		margin: 0;
		padding: 0;
		font-size: 0.85rem;
	}
	.component-list li {
		display: flex;
		align-items: baseline;
		gap: 0.4rem;
		padding: 0.12rem 0;
	}
	.component-list .comp-mark {
		width: 1em;
		font-weight: 700;
	}
	.component-list li.have .comp-mark {
		color: var(--success, #6aa84f);
	}
	.component-list li.needed .comp-mark {
		color: var(--danger);
	}
	/* Needed pieces read as clearly not-yet-owned: dimmed, accent link, a "needed" tag. */
	.component-list li.needed a {
		color: var(--accent);
	}
	.component-list li.have a {
		color: var(--text);
	}
	/* OR-alternatives for a slot (e.g. "Ahrim's helm or Blue moon helm"): the
	   separator is muted so the accepted variants read as one either/or option. */
	.comp-or {
		color: var(--text-muted, #888);
		font-style: italic;
	}
	.comp-qty {
		color: var(--text-muted, #888);
	}
	.comp-tag {
		font-size: 0.62rem;
		text-transform: uppercase;
		letter-spacing: 0.04em;
		color: var(--danger);
		border: 1px solid var(--danger);
		border-radius: 3px;
		padding: 0 0.25rem;
	}

	/* Combat achievements summary */
	.ca-detail {
		margin-top: 1.1rem;
		border-top: 1px solid var(--border);
		padding-top: 1rem;
	}
	.ca-detail h4 {
		margin: 0 0 0.6rem;
		font-size: 0.92rem;
		color: var(--text);
	}
	.ca-stats {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(7rem, 1fr));
		gap: 0.75rem;
	}
	.ca-stat {
		display: flex;
		flex-direction: column;
		gap: 0.15rem;
		padding: 0.6rem 0.8rem;
		background: var(--surface);
		border: 1px solid var(--border);
		border-radius: var(--radius);
	}
	.ca-num {
		font-family: var(--font-heading);
		font-size: 1.05rem;
		color: var(--accent);
		text-shadow: var(--ts);
	}
	.ca-lbl {
		font-size: 0.74rem;
		color: var(--muted);
	}

	.rank-foot {
		margin: 1.1rem 0 0;
		line-height: 1.45;
	}
	.muted {
		color: var(--muted);
	}
	.small {
		font-size: 0.85rem;
	}

	/* --- Next-rank target badge + rank tools --- */
	.next-main {
		display: flex;
		align-items: center;
		gap: 1rem;
	}
	.next-progress {
		flex: 1;
		min-width: 0;
	}
	.next-target {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 0.2rem;
		flex-shrink: 0;
		text-align: center;
	}
	.next-target img {
		object-fit: contain;
		image-rendering: -webkit-optimize-contrast;
	}
	.next-target-lbl {
		font-family: var(--font-heading);
		font-size: 0.72rem;
		text-shadow: var(--ts);
	}
	.rank-tools {
		display: flex;
		flex-wrap: wrap;
		gap: 0.5rem;
		margin-top: 0.8rem;
	}
	.tool-btn {
		min-height: 0;
		padding: 0.35rem 0.7rem;
		font-size: 0.8rem;
		font-family: var(--font-body);
		background: var(--surface);
		border: 1px solid var(--border-strong);
		border-image: none;
		border-radius: 4px;
		color: var(--text);
		cursor: pointer;
	}
	.tool-btn:hover:not(:disabled) {
		border-color: var(--accent);
	}
	.tool-btn.advise {
		border-color: var(--accent);
		color: var(--accent);
	}
	.tool-btn.advise:hover:not(:disabled) {
		background: var(--accent-soft);
	}
	.tool-btn:disabled {
		opacity: 0.6;
		cursor: default;
	}
	.advise-err {
		margin: 0.5rem 0 0;
		font-size: 0.8rem;
		color: var(--danger);
	}

	/* --- The "what you could do" overlay segment on each score bar --- */
	.osrs-bar {
		position: relative;
	}
	.osrs-bar-potential {
		position: absolute;
		top: 0;
		bottom: 0;
		opacity: 0.5;
		border-right: 2px solid rgba(255, 255, 255, 0.65);
		background-image: repeating-linear-gradient(
			45deg,
			rgba(255, 255, 255, 0.18) 0,
			rgba(255, 255, 255, 0.18) 4px,
			transparent 4px,
			transparent 8px
		);
		pointer-events: none;
	}
	.comp-advice {
		margin: 0.35rem 0 0;
		padding: 0.3rem 0.55rem;
		border-left: 3px solid var(--accent);
		background: var(--surface);
		border-radius: 4px;
		font-size: 0.78rem;
		line-height: 1.4;
		color: var(--text);
	}

	/* --- Rank-up plan panel --- */
	.plan {
		margin-top: 1.1rem;
		padding: 0.9rem 1rem;
		border: 1px solid var(--accent);
		border-radius: var(--radius);
		background: var(--accent-soft);
	}
	.plan-head {
		display: flex;
		align-items: baseline;
		justify-content: space-between;
		gap: 0.5rem;
		flex-wrap: wrap;
		margin-bottom: 0.6rem;
	}
	.plan-head h4 {
		margin: 0;
		font-size: 0.98rem;
		color: var(--text);
	}
	.plan-gap {
		font-size: 0.78rem;
	}
	.plan-steps {
		list-style: none;
		margin: 0 0 0.5rem;
		padding: 0;
		display: flex;
		flex-direction: column;
		gap: 0.55rem;
	}
	.plan-steps li {
		display: flex;
		gap: 0.55rem;
	}
	.plan-dot {
		width: 0.7rem;
		height: 0.7rem;
		border-radius: 999px;
		margin-top: 0.28rem;
		flex-shrink: 0;
	}
	.plan-step-body {
		min-width: 0;
		flex: 1;
	}
	.plan-step-top {
		display: flex;
		align-items: baseline;
		justify-content: space-between;
		gap: 0.5rem;
	}
	.plan-step-top strong {
		font-size: 0.88rem;
	}
	.plan-gain {
		font-family: var(--font-heading);
		font-size: 0.78rem;
		color: var(--accent);
		white-space: nowrap;
	}
	.plan-step-body p {
		margin: 0.1rem 0 0;
		line-height: 1.4;
	}
	.plan-sub {
		margin: 0.6rem 0 0.4rem;
		font-size: 0.82rem;
		color: var(--text);
	}
	.gear-targets {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(9.5rem, 1fr));
		gap: 0.4rem;
	}
	.gtarget {
		display: flex;
		align-items: center;
		gap: 0.45rem;
		padding: 0.35rem 0.45rem;
		background: var(--surface);
		border: 1px solid var(--border);
		border-radius: var(--radius);
	}
	.gtarget-img {
		width: 30px;
		height: 28px;
		display: flex;
		align-items: center;
		justify-content: center;
		flex-shrink: 0;
	}
	.gtarget-img img {
		max-width: 30px;
		max-height: 28px;
		object-fit: contain;
	}
	.gtarget-body {
		min-width: 0;
		display: flex;
		flex-direction: column;
		gap: 0.05rem;
	}
	.gtarget-body strong {
		font-size: 0.78rem;
		line-height: 1.15;
	}
	.gtarget-meta {
		font-size: 0.68rem;
	}
	.gtarget.boss {
		border-color: var(--border-strong);
	}
	.gtarget-meta .src {
		font-family: var(--font-heading);
		text-transform: uppercase;
		font-size: 0.6rem;
		letter-spacing: 0.03em;
	}
	.gtarget-meta .src.boss {
		color: var(--danger);
	}
	.gtarget-meta .src.nonboss {
		color: var(--success, #6aa84f);
	}
	.plan-foot {
		margin: 0.7rem 0 0;
		line-height: 1.4;
	}

	/* --- All clan ranks modal --- */
	.ranks-backdrop {
		position: fixed;
		inset: 0;
		background: rgba(0, 0, 0, 0.72);
		z-index: 100;
		display: flex;
		align-items: flex-start;
		justify-content: center;
		padding: 2rem 1rem 4rem;
		overflow-y: auto;
	}
	.ranks-modal {
		position: relative;
		width: 100%;
		max-width: 24rem;
		padding: 1.4rem;
		background: linear-gradient(180deg, rgba(58, 48, 36, 0.98), rgba(40, 32, 24, 0.98));
		border: 1px solid var(--border);
		border-radius: var(--radius);
		box-shadow: var(--shadow-card);
		color: var(--text);
	}
	.ranks-modal h3 {
		margin: 0 0 0.2rem;
		font-size: 1.2rem;
	}
	.ranks-close {
		position: absolute;
		top: 6px;
		right: 8px;
		width: 32px;
		height: 32px;
		min-height: 0;
		padding: 0;
		display: flex;
		align-items: center;
		justify-content: center;
		font-size: 1.4rem;
		background: transparent;
		border-color: transparent;
		color: var(--muted);
	}
	.ranks-list {
		list-style: none;
		margin: 0.8rem 0 0;
		padding: 0;
		display: flex;
		flex-direction: column;
		gap: 0.2rem;
	}
	.ranks-list li {
		display: flex;
		align-items: center;
		gap: 0.6rem;
		padding: 0.3rem 0.5rem;
		border-radius: 4px;
	}
	.ranks-list li.current {
		background: var(--accent-soft);
		border: 1px solid var(--accent);
	}
	.ranks-num {
		width: 1.4rem;
		font-size: 0.75rem;
		text-align: right;
	}
	.ranks-name {
		font-family: var(--font-heading);
		font-size: 0.95rem;
		text-shadow: var(--ts);
	}
	.ranks-you {
		margin-left: auto;
		font-size: 0.62rem;
		text-transform: uppercase;
		letter-spacing: 0.05em;
		color: var(--accent);
		border: 1px solid var(--accent);
		border-radius: 3px;
		padding: 0 0.3rem;
	}
</style>

<script lang="ts">
	import type { Snippet } from 'svelte';
	import RankBadge from '$lib/RankBadge.svelte';
	import InfoTip from '$lib/InfoTip.svelte';
	import ItemInfoModal from '$lib/ItemInfoModal.svelte';
	import { rankLabel, rankColor, type RankValue } from '$lib/ranks';
	import { itemIconUrl } from '$lib/osrsItems';
	import { itemImageUrl, wikiPageUrl } from '$lib/wikiImage';

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

	let {
		rank,
		currentRank = null,
		emptyText = '',
		showSetupTips = false,
		onClaim,
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
		actions?: Snippet;
		status?: Snippet;
	} = $props();

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
		<!-- Overall progress toward the next rank (within the current tier's band). -->
		<div class="next-rank">
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

		<div class="comps">
			{#each rank.components as c (c.key)}
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
					<div class="osrs-bar"><span class="osrs-bar-fill" style="width:{pct(c.normalized)}"></span></div>
					<div class="comp-foot">
						<span class="comp-raw">{num(c.raw)} / {num(c.cap)}</span>
						<span class="comp-norm">{pct(c.normalized)}</span>
					</div>
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
											onerror={(e) => ((e.currentTarget as HTMLImageElement).style.visibility = 'hidden')}
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
</style>

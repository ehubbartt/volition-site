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
	import { SIGNATURE_TIERS, earnedSignatureTier, nextSignatureTier } from '$lib/rankSignature';
	import { fly, slide } from 'svelte/transition';
	import { enhance } from '$app/forms';

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
		signature: SignatureView;
		fetchedAt: string | null;
		// A staff member adjusted this player's scoring by hand (docs/RANKS.md, manual
		// adjustments). Said out loud so a rank the visible numbers don't produce never
		// looks like a bug — `rankPinned` is the strongest form, a rank set outright.
		adjusted?: boolean;
		rankPinned?: boolean;
	}
	// Signature ranks: how many whole categories are maxed + which tier that earns.
	interface SignatureView {
		completed: number;
		total: number;
		earnedKey: string | null;
		categories: { key: string; label: string; complete: boolean }[];
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

	// --- Admin in-place editing (staff adjustments, docs/RANKS.md) -------------
	interface OverrideView {
		rank_override: string | null;
		ca_tier_override: string | null;
		gear_points_bonus: number;
		ehb_bonus: number;
		clog_bonus: number;
		months_bonus: number;
		total_level_override: number | null;
		reason: string;
	}
	interface GrantedItem {
		id: number;
		item_name: string;
		quantity: number;
		source: string;
	}
	interface AdminEditView {
		override: OverrideView | null;
		/** The admin who last adjusted them, for the standing note. */
		setBy: string | null;
		caTiers: string[];
		rankOptions: { value: string; label: string }[];
		granted: GrantedItem[];
		/** Lowercased item name → how many the gear table can use (only items above 1). */
		quantityCaps: Record<string, number>;
	}

	let {
		rank,
		currentRank = null,
		emptyText = '',
		showSetupTips = false,
		onClaim,
		adviceEndpoint,
		actions,
		status,
		signaturePref = undefined,
		signatureActionUrl,
		adminEdit = null
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
		/** Self-only (/me): the member's current "show my signature rank in Discord" choice.
		 * Passing it (with signatureActionUrl) enables the header toggle — but only when a
		 * signature rank is actually earned. Public /u profiles omit both. */
		signaturePref?: boolean;
		/** Form-action URL the header toggle POSTs to (e.g. "?/setSignaturePref"). */
		signatureActionUrl?: string;
		/** ADMIN ONLY (/u/[rsn]): turns the panel into an editor. Every score bar, the rank
		 * badge, and every gear tile gain an edit affordance that POSTs to this page's
		 * adjust / pinRank / grantItem / revokeGrant actions. Null (the default, and always
		 * for members) renders the panel exactly as before. See docs/RANKS.md. */
		adminEdit?: AdminEditView | null;
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
		time: '#8d8d8d',
		tcg: '#d9a441'
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

	// Signature ranks: the tier the member currently holds + the next one to chase. Resolved
	// from the shared tier list so the ladder, the earned badge, and the count all agree.
	const sigEarned = $derived(rank ? earnedSignatureTier(rank.signature.completed) : null);
	const sigNext = $derived(rank ? nextSignatureTier(rank.signature.completed) : null);
	// Badge files are wired later; fall back to a coloured chip if one 404s so nothing breaks.
	let sigImgFailed = $state<Record<string, boolean>>({});

	// The header "which rank do I show in-game" toggle (self-only, and only once a signature
	// rank is actually earned). `prefOn` drives the animated headline swap; it flips
	// optimistically and persists via the form action, rolling back if the save fails.
	let prefOn = $state(signaturePref === true);
	let sigSaving = $state(false);
	let sigError = $state(false);
	const canToggleSignature = $derived(!!signatureActionUrl && sigEarned != null);
	const showSig = $derived(prefOn && sigEarned != null);

	async function toggleSignature() {
		if (!signatureActionUrl || sigSaving) return;
		const next = !prefOn;
		prefOn = next; // optimistic — the badge swaps immediately
		sigSaving = true;
		sigError = false;
		try {
			const body = new FormData();
			body.set('prefer', next ? '1' : '0');
			const res = await fetch(signatureActionUrl, {
				method: 'POST',
				body,
				headers: { 'x-sveltekit-action': 'true' }
			});
			if (!res.ok) throw new Error(`save failed (${res.status})`);
		} catch {
			prefOn = !next; // roll back on failure
			sigError = true;
		} finally {
			sigSaving = false;
		}
	}

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

	// --- Admin editing state ---------------------------------------------------
	// Which editor is open: a component key, 'rank' for the pin, or null. One at a time —
	// these are inline panels, so several open at once would push the page around.
	let editing = $state<string | null>(null);
	let saving = $state(false);
	const toggleEdit = (key: string) => (editing = editing === key ? null : key);

	// What each component's editor edits. `tcg` is deliberately absent: the Volition TCG
	// count comes from the site's own card tables, so it is always exactly knowable and
	// there is nothing an adjustment could legitimately correct.
	const EDITABLE: Record<string, { label: string; hint: string; step: string; unit: string }> = {
		gear: {
			label: 'Gear points to add',
			hint: 'Prefer granting the actual item on its tile below when you know what it is — that way the gear grid shows it too.',
			step: '1',
			unit: 'points'
		},
		ehb: { label: 'EHB to add', hint: 'Added to their efficient hours bossed.', step: '0.1', unit: 'hours' },
		clog: {
			label: 'Collection log slots to add',
			hint: 'Added to their finished-slot count.',
			step: '1',
			unit: 'slots'
		},
		time: {
			label: 'Months in clan to add',
			hint: 'For a join date that reset when they left and came back.',
			step: '0.5',
			unit: 'months'
		},
		level: {
			label: 'Total level',
			hint: 'Replaces the fetched total level outright. Leave blank to use the fetched one.',
			step: '1',
			unit: ''
		}
	};

	// The value each editor starts on — what's currently adjusted, so opening an editor
	// shows the live state rather than a blank box.
	function currentAdjustment(key: string): string {
		const o = adminEdit?.override;
		if (!o) return '';
		if (key === 'ca') return o.ca_tier_override ?? '';
		if (key === 'gear') return String(o.gear_points_bonus || '');
		if (key === 'ehb') return String(Number(o.ehb_bonus) || '');
		if (key === 'clog') return String(o.clog_bonus || '');
		if (key === 'time') return String(Number(o.months_bonus) || '');
		if (key === 'level') return o.total_level_override == null ? '' : String(o.total_level_override);
		if (key === 'rank') return o.rank_override ?? '';
		return '';
	}
	/** Is this component currently carrying an adjustment? Drives the "adjusted" flag. */
	const isAdjusted = (key: string) => currentAdjustment(key) !== '';

	/** Manual gear credited for a tile's check item, if any (drives the tile's grant editor). */
	function grantFor(itemName: string | null): GrantedItem | null {
		if (!itemName || !adminEdit) return null;
		const key = itemName.toLowerCase();
		return adminEdit.granted.find((g) => g.item_name.toLowerCase() === key) ?? null;
	}

	// Shared enhance handler for every editor: close on success, and let the page's own
	// load refresh the panel behind it so the new score is visible immediately.
	function editSubmit() {
		saving = true;
		return async ({ result, update }: { result: { type: string }; update: (o?: { reset?: boolean }) => Promise<void> }) => {
			saving = false;
			await update({ reset: false });
			if (result.type === 'success') {
				editing = null;
				infoPiece = null;
			}
		};
	}

	// ⓘ explainer per component: where the number comes from + how it's scored.
	// Keys match rankScoring's ComponentKey. The CA percentages are the tier-completion
	// rewards (10/20/50/100/300/500 of 980) from rankScoring/combatAchievements.json —
	// update them together if those rewards ever change.
	const COMP_TIPS: Record<string, string> = {
		gear: "Read from your TempleOSRS collection log: each set or piece in the clan's gear table is worth points — alternatives of an item count once, and multi-quantity pieces give partial credit. The bar is your gear points out of the table's total.",
		ehb: "Efficient hours bossed, read from the clan's WiseOldMan group roster. The bar fills toward the configured EHB cap; hours past the cap don't add more score.",
		ca: 'Only fully-completed tiers score. Tasks done part-way into a tier add NOTHING until every task in it is finished — the bar jumps when you complete a whole tier and sits still in between. Each tier banks its share of the bar on completion: Elite 10%, Master 31%, Grandmaster 51% (Easy, Medium and Hard together make up the first 8%). Tiers complete in order, Easy first. Task completion is read from the RuneLite WikiSync plugin.',
		time: "Months since you were added to the clan's WiseOldMan group. The bar fills toward the configured months cap.",
		clog: 'Collection-log slots completed, read from your TempleOSRS profile. The bar fills toward the configured slots cap.',
		level: 'Total level from your latest WiseOldMan snapshot. Only levels above the configured minimum score — the bar measures where you sit between that minimum and the cap.',
		tcg: 'Your Volition TCG collection: how many card variants you own out of every obtainable one — each finish (Holo / Reverse / Normal) is its own slot, matching the Collection tab. Event-only elemental cards are excluded. A full set is 100%.'
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
			case 'tcg':
				return {
					text: 'No Volition TCG cards yet — open packs to start your collection, then re-check.',
					href: '/gamba',
					link: 'Open packs'
				};
			default:
				return null;
		}
	}
</script>

<section class="rank-panel">
	<div class="rank-head">
		<div class="rank-id">
			<!-- The headline rank swaps between the composite clan rank and the earned
			     signature rank when the toggle flips — keyed so each swap animates in. -->
			{#key showSig}
				<div class="rank-headline" in:fly={{ y: -8, duration: 240 }}>
					{#if showSig && sigEarned}
						<span class="headline-badge">
							{#if sigEarned.img && !sigImgFailed[sigEarned.key]}
								<img src={sigEarned.img} alt={sigEarned.label} width="40" height="40" onerror={() => (sigImgFailed[sigEarned.key] = true)} />
							{:else}
								<span class="sig-badge-fallback" style="background:{sigEarned.color}">{sigEarned.required}</span>
							{/if}
						</span>
					{:else}
						<RankBadge rank={rank?.rank ?? currentRank} size={40} />
					{/if}
					<div>
						<span class="rank-label">{showSig ? 'Signature rank' : 'Clan rank'}</span>
						<strong
							class="rank-name"
							style="color:{showSig && sigEarned ? sigEarned.color : rankColor(rank?.rank ?? currentRank)}"
						>
							{#if showSig && sigEarned}
								{sigEarned.label}
							{:else}
								{rank ? rankLabel(rank.rank) : currentRank ? rankLabel(currentRank) : 'Not calculated yet'}
							{/if}
						</strong>
						{#if rank}
							<span class="composite">Composite score {pct1(rank.composite)}</span>
						{/if}
					</div>
				</div>
			{/key}
			<!-- Admins edit the rank where they read it: click the badge's pencil to pin it. -->
			{#if adminEdit}
				<button
					type="button"
					class="edit-btn"
					class:on={editing === 'rank'}
					class:active={isAdjusted('rank')}
					aria-expanded={editing === 'rank'}
					title={isAdjusted('rank') ? 'This rank is pinned by staff — edit' : 'Pin this rank by hand'}
					onclick={() => toggleEdit('rank')}
				>
					{isAdjusted('rank') ? '📌 pinned' : '✎ pin rank'}
				</button>
			{/if}
		</div>
		{#if actions}{@render actions()}{/if}
	</div>

	{#if adminEdit && editing === 'rank'}
		<form
			method="POST"
			action="?/pinRank"
			class="editor"
			transition:slide={{ duration: 150 }}
			use:enhance={editSubmit}
		>
			<p class="editor-hint">
				A hard override: this rank is what they get, whatever the score below says, until it's
				removed. Blunt — adjust the individual scores first if one of them is simply wrong.
			</p>
			<div class="editor-row">
				<label>
					Rank
					<select name="value">
						<option value="">No pin — score them normally</option>
						{#each adminEdit.rankOptions as r (r.value)}
							<option value={r.value} selected={adminEdit.override?.rank_override === r.value}>{r.label}</option>
						{/each}
					</select>
				</label>
				<label class="grow">
					Reason <span class="lbl-note">— covers every adjustment on this member</span>
					<input type="text" name="reason" maxlength="300" value={adminEdit.override?.reason ?? ''} placeholder="Why is this being set by hand?" />
				</label>
				<button type="submit" disabled={saving}>{saving ? 'Saving…' : 'Save'}</button>
			</div>
		</form>
	{/if}

	<!-- In-game rank display toggle (self-only, shown only once a signature rank is earned):
	     Clan ↔ Signature, with an animated slider. What an admin sets in-game via /sync. -->
	{#if canToggleSignature && sigEarned}
		<div class="rank-mode">
			<span class="rank-mode-lbl" class:active={!prefOn}>Clan rank</span>
			<button
				type="button"
				role="switch"
				aria-checked={prefOn}
				aria-label="Show my {sigEarned.label} signature rank in Discord instead of my clan rank"
				class="rank-switch"
				class:on={prefOn}
				style="--sig:{sigEarned.color}"
				disabled={sigSaving}
				onclick={toggleSignature}
			>
				<span class="rank-switch-knob"></span>
			</button>
			<span class="rank-mode-lbl" class:active={prefOn} style={prefOn ? `color:${sigEarned.color}` : ''}>
				{sigEarned.label}
			</span>
			{#if sigError}<span class="rank-mode-err">save failed</span>{/if}
		</div>
	{/if}

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

		<!-- One line saying the panel is being edited by staff, plus the way out of all of
		     it at once. Only an admin sees this; the member's own note lives in the footer. -->
		{#if adminEdit?.override}
			<form method="POST" action="?/clearAdjustments" class="adjusted-note" use:enhance={editSubmit}>
				<span>
					<strong>Staff-adjusted{adminEdit.setBy ? ` by ${adminEdit.setBy}` : ''}.</strong>
					{adminEdit.override.reason}
				</span>
				<button
					type="submit"
					disabled={saving}
					onclick={(e) => {
						if (!confirm('Remove every staff adjustment on this member and re-score them on the raw data?')) e.preventDefault();
					}}>Remove all</button
				>
			</form>
		{/if}

		<div class="comps">
			{#each rank.components as c (c.key)}
				{@const a = adviceOn ? adviceByKey.get(c.key) : undefined}
				<div class="comp" class:maxed={c.cap > 0 && c.raw >= c.cap}>
					<div class="comp-top">
						<span class="comp-label">
							{c.label}
							{#if COMP_TIPS[c.key]}
								<InfoTip tip={COMP_TIPS[c.key]} label="How {c.label.toLowerCase()} is scored" />
							{/if}
						</span>
						<span class="comp-weight">
							{pct(c.weight)} of score
							<!-- Admin: adjust THIS component, in place. Only the components an
							     adjustment can legitimately correct get a control — the TCG count
							     comes from the site's own card tables, so it's always exact. -->
							{#if adminEdit && (c.key === 'ca' || EDITABLE[c.key])}
								<button
									type="button"
									class="edit-btn"
									class:on={editing === c.key}
									class:active={isAdjusted(c.key)}
									aria-expanded={editing === c.key}
									title="Adjust {c.label.toLowerCase()} by hand"
									onclick={() => toggleEdit(c.key)}
								>
									{isAdjusted(c.key) ? '✎ adjusted' : '✎'}
								</button>
							{/if}
						</span>
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

					{#if adminEdit && editing === c.key}
						<form
							method="POST"
							action="?/adjust"
							class="editor"
							transition:slide={{ duration: 150 }}
							use:enhance={editSubmit}
						>
							<input type="hidden" name="field" value={c.key} />
							{#if c.key === 'ca'}
								<p class="editor-hint">
									Treats them as having banked every tier reward up to this one — for a group
									ironman who holds the tier in game without every task done. Only ever raises
									the score.
								</p>
								<div class="editor-row">
									<label>
										Combat achievement tier
										<select name="value">
											<option value="">Score from WikiSync (default)</option>
											{#each adminEdit.caTiers as t (t)}
												<option value={t} selected={adminEdit.override?.ca_tier_override === t}>{tierLabel(t)}</option>
											{/each}
										</select>
									</label>
									<label class="grow">
										Reason <span class="lbl-note">— covers every adjustment on this member</span>
										<input type="text" name="reason" maxlength="300" value={adminEdit.override?.reason ?? ''} placeholder="Why is this being set by hand?" />
									</label>
									<button type="submit" disabled={saving}>{saving ? 'Saving…' : 'Save'}</button>
								</div>
							{:else}
								{@const e = EDITABLE[c.key]}
								<p class="editor-hint">{e.hint}</p>
								<div class="editor-row">
									<label>
										{e.label}
										<input
											type="number"
											name="value"
											step={e.step}
											value={currentAdjustment(c.key)}
											placeholder={c.key === 'level' ? 'Use the fetched level' : '0'}
										/>
									</label>
									<label class="grow">
										Reason <span class="lbl-note">— covers every adjustment on this member</span>
										<input type="text" name="reason" maxlength="300" value={adminEdit.override?.reason ?? ''} placeholder="Why is this being set by hand?" />
									</label>
									<button type="submit" disabled={saving}>{saving ? 'Saving…' : 'Save'}</button>
								</div>
							{/if}
						</form>
					{/if}
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

		<!-- Signature ranks: prestige for fully completing whole categories -->
		<div class="sig">
			<div class="sig-head">
				<h4>Signature ranks</h4>
				<span class="sig-count">{rank.signature.completed} / {rank.signature.total} categories maxed</span>
			</div>
			<p class="muted small sig-intro">
				Fully complete whole categories — maxing a bar above — to earn a <strong>signature rank</strong>: a
				prestige badge that sits on top of your clan rank.
				{#if sigEarned}
					You hold <strong style="color:{sigEarned.color}">{sigEarned.label}</strong>.
				{:else if sigNext}
					Max {sigNext.required - rank.signature.completed} more to earn
					<strong style="color:{sigNext.color}">{sigNext.label}</strong>.
				{/if}
			</p>

			<div class="osrs-bar sig-bar">
				<span class="osrs-bar-fill" style="width:{pct(rank.signature.completed / rank.signature.total)}"></span>
			</div>

			<div class="sig-tiers">
				{#each SIGNATURE_TIERS as t (t.key)}
					{@const earned = rank.signature.completed >= t.required}
					{@const toGo = Math.max(0, t.required - rank.signature.completed)}
					<div class="sig-tier" class:earned>
						<div class="sig-badge">
							{#if t.img && !sigImgFailed[t.key]}
								<img src={t.img} alt={t.label} width="44" height="44" onerror={() => (sigImgFailed[t.key] = true)} />
							{:else}
								<span class="sig-badge-fallback" style="background:{t.color}">{t.required}</span>
							{/if}
						</div>
						<div class="sig-tier-body">
							<strong class="sig-name" style="color:{t.color}">{t.label}</strong>
							<span class="sig-req muted">{t.required} of {rank.signature.total} categories maxed</span>
							<span class="sig-blurb muted small">{t.blurb}</span>
						</div>
						<span class="sig-status" class:on={earned}>{earned ? '✓ earned' : `${toGo} to go`}</span>
					</div>
				{/each}
			</div>

			<details class="sig-cats">
				<summary>Which categories count · {rank.signature.completed}/{rank.signature.total} done</summary>
				<ul class="sig-cat-list">
					{#each rank.signature.categories as c (c.key)}
						<li class:done={c.complete}>
							<span class="sig-mark">{c.complete ? '✓' : '○'}</span>
							{c.label}
						</li>
					{/each}
				</ul>
			</details>
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
											<img
											src={itemIconUrl(t.iconItem)[0]}
											alt={t.entry}
											loading="lazy"
											referrerpolicy="no-referrer"
											use:retryImage={{ sources: itemIconUrl(t.iconItem) }}
										/>
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
											src={itemIconUrl(p.iconItem)[0]}
											alt={p.name}
											use:retryImage={{ sources: itemIconUrl(p.iconItem) }}
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
			{#if rank.rankPinned}
				This rank was set by staff, so it won't move with the score below.
			{:else if rank.adjusted}
				Staff have adjusted this player's scoring to account for something the tracked data
				can't show.
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

		<!-- Admin: credit this exact item to the member, from the tile itself. The count
		     matters — several gear entries are quantity checks, so four Zenyte shards is a
		     different credit from one. -->
		{#if adminEdit}
			{@const item = p.checkItem ?? p.iconItem ?? p.name}
			{@const granted = grantFor(item)}
			<div class="modal-admin">
				{#if granted}
					<p class="modal-admin-head">
						Credited by hand:
						<strong>{granted.item_name}{granted.quantity > 1 ? ` ×${granted.quantity}` : ''}</strong>
						<span class="muted">({granted.source === 'admin' ? 'staff grant' : 'approved claim'})</span>
					</p>
				{/if}
				{#if !granted || granted.source === 'admin'}
					{@const cap = adminEdit.quantityCaps[item.toLowerCase()] ?? 1}
					<form method="POST" action="?/grantItem" class="modal-grant" use:enhance={editSubmit}>
						<input type="hidden" name="item_name" value={item} />
						<label>
							Count
							<input type="number" name="quantity" min="1" max={cap} step="1" value={granted?.quantity ?? 1} />
							<!-- Only worth saying for the entries that actually count more than one
							     (Zenyte shard 4, Tormented synapse 3); everywhere else it's noise. -->
							{#if cap > 1}<small class="cap-hint">up to {cap} count toward the gear table</small>{/if}
						</label>
						<label class="grow">
							Reason
							<input
								type="text"
								name="reason"
								required
								maxlength="300"
								placeholder="e.g. dropped before the collection log existed"
							/>
						</label>
						<button type="submit" disabled={saving}>{granted ? 'Update' : 'Grant'}</button>
					</form>
					{#if granted}
						<form method="POST" action="?/revokeGrant" use:enhance={editSubmit}>
							<input type="hidden" name="id" value={granted.id} />
							<button class="modal-revoke" type="submit" disabled={saving}>Revoke this grant</button>
						</form>
					{/if}
				{:else}
					<p class="muted small">
						This came from a claim the member submitted — review it under Admin → Ranks → Gear
						Claims.
					</p>
				{/if}
			</div>
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
	/* Swapping headline rank (clan ↔ signature). */
	.rank-headline {
		display: flex;
		align-items: center;
		gap: 0.7rem;
	}
	.headline-badge {
		width: 40px;
		height: 40px;
		display: flex;
		align-items: center;
		justify-content: center;
		flex-shrink: 0;
	}
	.headline-badge img {
		object-fit: contain;
		image-rendering: -webkit-optimize-contrast;
	}

	/* In-game rank display toggle. */
	.rank-mode {
		display: flex;
		align-items: center;
		gap: 0.55rem;
		flex-wrap: wrap;
		margin: 0.85rem 0 0.2rem;
		font-size: 0.82rem;
	}
	.rank-mode-lbl {
		color: var(--muted);
		transition: color 0.2s ease;
	}
	.rank-mode-lbl.active {
		color: var(--text);
		font-family: var(--font-heading);
	}
	.rank-switch {
		position: relative;
		width: 46px;
		height: 24px;
		min-height: 0;
		padding: 0;
		border-radius: 999px;
		border: 1px solid var(--border-strong);
		border-image: none;
		background: var(--surface);
		cursor: pointer;
		transition: background 0.25s ease, border-color 0.25s ease;
	}
	.rank-switch.on {
		background: color-mix(in srgb, var(--sig) 35%, var(--surface));
		border-color: var(--sig);
	}
	.rank-switch:disabled {
		opacity: 0.6;
		cursor: default;
	}
	.rank-switch-knob {
		position: absolute;
		top: 2px;
		left: 2px;
		width: 18px;
		height: 18px;
		border-radius: 999px;
		background: var(--muted);
		box-shadow: 0 1px 2px rgba(0, 0, 0, 0.5);
		/* The slide IS the swap animation. */
		transition: transform 0.25s cubic-bezier(0.34, 1.56, 0.64, 1), background 0.25s ease;
	}
	.rank-switch.on .rank-switch-knob {
		transform: translateX(22px);
		background: var(--sig);
	}
	.rank-mode-err {
		font-size: 0.74rem;
		color: var(--danger);
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

	/* --- Signature ranks panel --- */
	.sig {
		margin-top: 1.2rem;
		padding-top: 1rem;
		border-top: 1px solid var(--border);
	}
	.sig-head {
		display: flex;
		align-items: baseline;
		justify-content: space-between;
		gap: 0.5rem;
		flex-wrap: wrap;
	}
	.sig-head h4 {
		margin: 0;
		font-size: 0.98rem;
		color: var(--text);
	}
	.sig-count {
		font-family: var(--font-heading);
		font-size: 0.8rem;
		color: var(--accent);
	}
	.sig-intro {
		margin: 0.35rem 0 0.6rem;
		line-height: 1.5;
	}
	.sig-bar {
		height: 0.7rem;
		margin-bottom: 0.9rem;
	}
	.sig-tiers {
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
	}
	.sig-tier {
		display: flex;
		align-items: center;
		gap: 0.7rem;
		padding: 0.5rem 0.65rem;
		background: var(--surface);
		border: 1px solid var(--border);
		border-radius: var(--radius);
		opacity: 0.62;
	}
	/* An earned tier reads bright with its accent outline; unearned ones sit dimmed. */
	.sig-tier.earned {
		opacity: 1;
		border-color: var(--border-strong);
		background: var(--surface-alt);
	}
	.sig-badge {
		flex-shrink: 0;
		width: 44px;
		height: 44px;
		display: flex;
		align-items: center;
		justify-content: center;
	}
	.sig-badge img {
		object-fit: contain;
		image-rendering: -webkit-optimize-contrast;
	}
	.sig-badge-fallback {
		display: flex;
		align-items: center;
		justify-content: center;
		width: 34px;
		height: 34px;
		border-radius: 999px;
		font-family: var(--font-heading);
		font-size: 1rem;
		color: #1c1710;
		box-shadow: 0 0 0 1px rgba(0, 0, 0, 0.4);
	}
	.sig-tier-body {
		flex: 1;
		min-width: 0;
		display: flex;
		flex-direction: column;
		gap: 0.05rem;
	}
	.sig-name {
		font-family: var(--font-heading);
		font-size: 0.95rem;
		text-shadow: var(--ts);
	}
	.sig-req {
		font-size: 0.72rem;
	}
	.sig-blurb {
		line-height: 1.35;
	}
	.sig-status {
		flex-shrink: 0;
		font-size: 0.72rem;
		color: var(--muted);
		text-align: right;
	}
	.sig-status.on {
		color: var(--success, #6aa84f);
		font-family: var(--font-heading);
	}
	.sig-cats {
		margin-top: 0.7rem;
	}
	.sig-cats summary {
		cursor: pointer;
		font-size: 0.82rem;
		color: var(--muted);
	}
	.sig-cat-list {
		list-style: none;
		margin: 0.5rem 0 0;
		padding: 0;
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(9rem, 1fr));
		gap: 0.25rem 0.75rem;
		font-size: 0.85rem;
	}
	.sig-cat-list li {
		display: flex;
		align-items: baseline;
		gap: 0.4rem;
		color: var(--muted);
	}
	.sig-cat-list li.done {
		color: var(--text);
	}
	.sig-cat-list .sig-mark {
		width: 1em;
		font-weight: 700;
		color: var(--muted);
	}
	.sig-cat-list li.done .sig-mark {
		color: var(--success, #6aa84f);
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

	/* --- Admin in-place editing (only rendered when adminEdit is passed) ------- */
	/* The pencil that opens each editor. Deliberately quiet until something IS
	   adjusted, so an admin reading a profile sees the member's data, not a toolbar. */
	.edit-btn {
		margin-left: 0.4rem;
		padding: 0.05rem 0.35rem;
		border: 1px solid var(--border);
		border-radius: 4px;
		background: none;
		color: var(--muted);
		font: inherit;
		font-size: 0.72rem;
		cursor: pointer;
		vertical-align: middle;
	}
	.edit-btn:hover,
	.edit-btn.on {
		color: var(--accent);
		border-color: var(--accent);
	}
	.edit-btn.active {
		color: #d9a441;
		border-color: #d9a441;
	}
	.editor {
		margin: 0.5rem 0 0.75rem;
		padding: 0.7rem 0.8rem;
		border: 1px solid var(--accent);
		border-radius: 6px;
		background: var(--surface);
	}
	.editor-hint {
		margin: 0 0 0.6rem;
		font-size: 0.78rem;
		line-height: 1.4;
		color: var(--muted);
		max-width: 68ch;
	}
	.editor-row {
		display: flex;
		flex-wrap: wrap;
		gap: 0.6rem;
		align-items: flex-end;
	}
	.editor-row label,
	.modal-grant label {
		display: flex;
		flex-direction: column;
		gap: 0.25rem;
		font-size: 0.78rem;
		color: var(--muted);
	}
	.editor-row .grow,
	.modal-grant .grow {
		flex: 1;
		min-width: 12rem;
	}
	.editor-row input,
	.editor-row select,
	.modal-grant input {
		padding: 0.35rem 0.5rem;
		border: 1px solid var(--border);
		border-radius: 4px;
		background: var(--bg);
		color: var(--text);
		font: inherit;
		font-size: 0.85rem;
	}
	.editor-row button,
	.modal-grant button {
		padding: 0.38rem 0.9rem;
		border: 1px solid var(--accent);
		border-radius: 4px;
		background: none;
		color: var(--accent);
		font: inherit;
		font-size: 0.85rem;
		cursor: pointer;
	}
	.editor-row button:disabled,
	.modal-grant button:disabled {
		opacity: 0.5;
		cursor: default;
	}
	/* The standing "this member is adjusted" line above the score bars. */
	.adjusted-note {
		display: flex;
		flex-wrap: wrap;
		gap: 0.6rem;
		align-items: center;
		justify-content: space-between;
		margin-bottom: 0.75rem;
		padding: 0.5rem 0.7rem;
		border: 1px solid #d9a441;
		border-radius: 6px;
		font-size: 0.82rem;
		color: var(--muted);
	}
	.adjusted-note strong {
		color: #d9a441;
	}
	.adjusted-note button {
		padding: 0.25rem 0.6rem;
		border: 1px solid var(--danger, #d9534f);
		border-radius: 4px;
		background: none;
		color: var(--danger, #d9534f);
		font: inherit;
		font-size: 0.78rem;
		cursor: pointer;
	}
	/* The grant controls inside a gear tile's modal. */
	.modal-admin {
		margin-top: 0.6rem;
		padding-top: 0.6rem;
		border-top: 1px solid var(--border);
	}
	.modal-admin-head {
		margin: 0 0 0.5rem;
		font-size: 0.82rem;
	}
	.modal-grant {
		display: flex;
		flex-wrap: wrap;
		gap: 0.5rem;
		align-items: flex-end;
	}
	.modal-grant input[type='number'] {
		width: 4.5rem;
	}
	/* The scope note beside "Reason" — one reason is stored per member, not per field. */
	.lbl-note {
		font-weight: normal;
		opacity: 0.75;
	}
	.cap-hint {
		font-size: 0.7rem;
		color: var(--muted);
		white-space: nowrap;
	}
	.modal-revoke {
		margin-top: 0.5rem;
		padding: 0.25rem 0.6rem;
		border: 1px solid var(--danger, #d9534f);
		border-radius: 4px;
		background: none;
		color: var(--danger, #d9534f);
		font: inherit;
		font-size: 0.78rem;
		cursor: pointer;
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

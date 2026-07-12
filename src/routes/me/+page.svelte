<script lang="ts">
	import type { PageData, ActionData } from './$types';
	import CardInspector3D from '$lib/cards/CardInspector3D.svelte';
	import type { UserCard } from '$lib/cards/rarity';
	import { CLAN_LABEL } from '$lib/clans';
	import type { ClanValue } from '$lib/clans';
	import { rsnToSlug } from '$lib/rsn';
	import { itemIconUrl } from '$lib/osrsItems';
	import { rankLabel, rankColor } from '$lib/ranks';
	import { formatGP } from '$lib/gp';
	import OsrsCounter from '$lib/OsrsCounter.svelte';
	import WalletList from '$lib/WalletList.svelte';
	import RankBadge from '$lib/RankBadge.svelte';
	import ConfirmDialog from '$lib/ConfirmDialog.svelte';
	import Skeleton from '$lib/Skeleton.svelte';
	import ProfileBanner from '$lib/profile/ProfileBanner.svelte';
	import ProfileTabs from '$lib/profile/ProfileTabs.svelte';
	import ProfilePanel from '$lib/profile/ProfilePanel.svelte';
	import CollectionPanel from '$lib/profile/CollectionPanel.svelte';
	import StatsPanel from '$lib/profile/StatsPanel.svelte';
	import EmptyState from '$lib/profile/EmptyState.svelte';
	import { swrResource } from '$lib/swrResource.svelte';
	import { enhance } from '$app/forms';
	import { invalidateAll } from '$app/navigation';
	import { page } from '$app/stores';
	import { THEMES } from '$lib/themes';

	let { data: pageData, form }: { data: PageData; form: ActionData } = $props();

	// The profile payload is STREAMED (see +page.ts) so navigation lands instantly.
	// Resolve into state and shadow under the old `data` name (merging the layout's
	// `user`, which is available immediately) so every reference below keeps
	// working; revalidations after actions keep the previous data on screen.
	type Me = NonNullable<PageData['me']['cached']>;
	const EMPTY_ME = {
		clanOptions: [],
		accountTypes: [],
		currentRank: null,
		rankBreakdown: null,
		vp_balance: 0,
		gold_balance: 0,
		wallet: [],
		walletGpValue: 0,
		collection: [],
		collectionOwned: 0,
		collectionTotal: 0,
		myStats: null,
		crateStats: null,
		packs: []
	} as unknown as Me;
	const meRes = swrResource(() => pageData.me, EMPTY_ME);
	const data = $derived({ user: pageData.user!, ...meRes.value });
	const meReady = $derived(meRes.ready);

	// Wallet → GP conversion (posts to the gamba action; reloads /me on success).
	let walletConverting = $state(false);
	let walletMsg = $state<string | null>(null);
	let convertOpen = $state(false);
	let convertForm = $state<HTMLFormElement>();

	type Tab = 'profile' | 'rank' | 'collection' | 'stats' | 'wallet';
	// Initial tab can be deep-linked via ?tab= (e.g. /me?tab=collection from the gamba page).
	const TABS: Tab[] = ['profile', 'rank', 'collection', 'stats', 'wallet'];
	const requestedTab = $page.url.searchParams.get('tab') as Tab | null;
	let tab = $state<Tab>(requestedTab && TABS.includes(requestedTab) ? requestedTab : 'profile');

	// Collection card the viewer modal is showing (null = closed).
	let viewing = $state<UserCard | null>(null);

	let clanLabel = $derived(
		data.user.clan_allegiance ? CLAN_LABEL[data.user.clan_allegiance as ClanValue] : null
	);
	let walletTotal = $derived(data.wallet.reduce((sum, w) => sum + w.quantity, 0));
	let packTotal = $derived(data.packs.reduce((sum, p) => sum + p.quantity, 0));

	let tabs = $derived([
		{ id: 'profile', label: 'Profile' },
		{ id: 'rank', label: 'Rank' },
		{ id: 'collection', label: 'Collection', count: data.collectionOwned },
		{ id: 'stats', label: 'Stats' },
		{ id: 'wallet', label: 'Wallet', count: walletTotal }
	]);


	// "Check my rank" — refreshes the cached breakdown from live data and writes the rank.
	// After the action, the page load re-runs and data.rankBreakdown re-renders below.
	let checkingRank = $state(false);
	let rank = $derived(data.rankBreakdown);
	const pct = (n: number) => `${Math.round(n * 100)}%`;
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

	// Site theme picker: flip <html data-theme> instantly for live feedback, then
	// submit to ?/saveTheme so the vs_theme cookie makes it stick across visits
	// (SSR re-renders with the same attribute — see hooks.server.ts + $lib/themes).
	let theme = $state(pageData.theme ?? 'default');
	let themeForm = $state<HTMLFormElement>();
	function pickTheme(v: string) {
		theme = v;
		document.documentElement.dataset.theme = v;
		themeForm?.requestSubmit();
	}
</script>

<svelte:head>
	<title>Profile · Volition</title>
</svelte:head>

<section class="profile">
	<ProfileBanner
		accountType={data.user.account_type}
		name={data.user.rsn ?? data.user.discord_username}
		username={data.user.discord_username}
		{clanLabel}
		vp={meReady ? data.vp_balance : 0}
	/>

	{#if data.user.rsn}
		<p class="profile-link muted">
			<a href="/u/{rsnToSlug(data.user.rsn)}">View your public profile →</a>
		</p>
	{/if}

	{#if !meReady}
		<div class="me-skeleton">
			<Skeleton height="2.4rem" width="24rem" radius="6px" />
			<Skeleton height="18rem" radius="10px" />
		</div>
	{:else}
	<ProfileTabs {tabs} active={tab} onselect={(id) => (tab = id as Tab)} />

	{#if tab === 'profile'}
		<ProfilePanel>
			{#if form?.success}
				<div class="success">Saved.</div>
			{:else if form?.error}
				<div class="error">{form.error}</div>
			{/if}

			<form method="POST" action="?/saveProfile" class="edit">
				<label>
					<span>OSRS RSN</span>
					<input name="rsn" type="text" maxlength="12" required value={data.user.rsn ?? ''} />
				</label>

				<fieldset class="account-picker">
					<legend>Account type</legend>
					<div class="account-options">
						{#each data.accountTypes as opt}
							<label class="account-option" title={opt.label}>
								<input
									type="radio"
									name="account_type"
									value={opt.value}
									checked={data.user.account_type === opt.value}
									required
								/>
								<span class="opt-card">
									<img src={opt.icon} alt={opt.label} class="opt-icon" />
								</span>
							</label>
						{/each}
					</div>
				</fieldset>

				<label>
					<span>Clan allegiance</span>
					<select name="clan_allegiance" required>
						<option value="" disabled selected={!data.user.clan_allegiance}>Pick a clan…</option>
						{#each data.clanOptions as opt}
							<option value={opt.value} selected={data.user.clan_allegiance === opt.value}>
								{opt.label}
							</option>
						{/each}
					</select>
				</label>

				<button type="submit" class="primary">Save</button>
			</form>

			<!-- Site theme — applies instantly, persists via cookie (see $lib/themes). -->
			<div class="theme-block">
				<h3>Site theme</h3>
				<p class="muted small">How Volition looks for you in this browser.</p>
				<form
					method="POST"
					action="?/saveTheme"
					class="themes"
					bind:this={themeForm}
					use:enhance={() => {
						return async ({ update }) => {
							await update({ reset: false });
						};
					}}
				>
					{#each THEMES as t (t.value)}
						<label class="theme-option" class:selected={theme === t.value}>
							<input
								type="radio"
								name="theme"
								value={t.value}
								checked={theme === t.value}
								onchange={() => pickTheme(t.value)}
							/>
							<span class="swatches">
								{#each t.swatches as c (c)}<span class="sw" style="background:{c}"></span>{/each}
							</span>
							<span class="theme-name">{t.label}</span>
							<span class="theme-desc muted">{t.description}</span>
						</label>
					{/each}
				</form>
				{#if form && 'themeSaved' in form && form.themeSaved}
					<p class="success small theme-msg">Theme saved.</p>
				{:else if form && 'themeError' in form && form.themeError}
					<p class="error small theme-msg">{form.themeError}</p>
				{/if}
			</div>

			<!-- Deliberately NOT use:enhance: the full document load this causes is what
	     wipes the client-side swr cache on logout (see clearSwrCache in swr.ts). -->
	<form method="POST" action="/auth/logout" class="logout">
				<button type="submit">Sign out</button>
			</form>
		</ProfilePanel>
	{:else if tab === 'rank'}
		<ProfilePanel>
			<section class="rank-panel">
				<div class="rank-head">
					<div class="rank-id">
						<RankBadge rank={rank?.rank ?? data.currentRank} size={40} />
						<div>
							<span class="rank-label">Clan rank</span>
							<strong class="rank-name" style="color:{rankColor(rank?.rank ?? data.currentRank)}">
								{rank ? rankLabel(rank.rank) : 'Not calculated yet'}
							</strong>
							{#if rank}
								<span class="composite">Composite score {pct(rank.composite)}</span>
							{/if}
						</div>
					</div>
					<form
						method="POST"
						action="?/checkRank"
						use:enhance={() => {
							checkingRank = true;
							return async ({ update }) => {
								await update({ reset: false });
								checkingRank = false;
							};
						}}
					>
						<button type="submit" class="check-btn" disabled={checkingRank || !data.user.rsn}>
							{checkingRank ? 'Checking…' : rank ? 'Re-check rank' : 'Check my rank'}
						</button>
					</form>
				</div>

				{#if !data.user.rsn}
					<p class="muted small">Set your RSN on the Profile tab, then check your rank.</p>
				{:else if form?.rankError}
					<p class="rank-error">{form.rankError}</p>
				{:else if form?.rankOk && form?.rankNote}
					<p class="rank-note muted small">{form.rankNote}</p>
				{/if}

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
							<span class="comp-weight">{pct(rank.nextRankProgress)}</span>
						</div>
						<div class="osrs-bar next-bar">
							<span class="osrs-bar-fill" style="width:{pct(rank.nextRankProgress)}"></span>
						</div>
						{#if rank.nextRank && rank.nextThreshold !== null}
							<span class="next-hint muted"
								>Composite {pct(rank.composite)} · {rankLabel(rank.nextRank)} at {pct(rank.nextThreshold)}</span
							>
						{/if}
					</div>

					<div class="comps">
						{#each rank.components as c (c.key)}
							<div class="comp">
								<div class="comp-top">
									<span class="comp-label">{c.label}</span>
									<span class="comp-weight">{pct(c.weight)} of score</span>
								</div>
								<div class="osrs-bar"><span class="osrs-bar-fill" style="width:{pct(c.normalized)}"></span></div>
								<div class="comp-foot">
									<span class="comp-raw">{num(c.raw)} / {num(c.cap)}</span>
									<span class="comp-norm">{pct(c.normalized)}</span>
								</div>
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
										<div class="gtile" class:owned={p.owned} title="{p.name} · {p.owned ? `${p.earned}/${p.max}` : `0/${p.max}`} pts">
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
										</div>
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
									title="Your total combat-achievement points as tracked in-game — each completed CA task awards points based on its tier."
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
				{:else if data.user.rsn}
					<p class="muted small">
						Pull your live stats from WiseOldMan, TempleOSRS and WikiSync to compute your clan rank
						and see exactly how each section contributes.
					</p>
				{/if}
			</section>
		</ProfilePanel>
	{:else if tab === 'collection'}
		<ProfilePanel>
			<CollectionPanel
				packs={data.packs}
				collection={data.collection}
				collectionOwned={data.collectionOwned}
				collectionTotal={data.collectionTotal}
				emptyHint="Open a pack to start collecting."
				noCardsText="No cards yet — open a pack to start collecting."
				onview={(card) => (viewing = card)}
			/>
		</ProfilePanel>
	{:else if tab === 'stats'}
		<ProfilePanel>
			<StatsPanel
				vp={data.vp_balance}
				cards={data.myStats}
				crateStats={data.crateStats}
				collectionOwned={data.collectionOwned}
				collectionTotal={data.collectionTotal}
				{packTotal}
				{walletTotal}
			/>
		</ProfilePanel>
	{:else if tab === 'wallet'}
		<ProfilePanel>
			<div class="wallet-head">
				<OsrsCounter
					value={data.gold_balance}
					label="Wallet balance"
					format="gp"
					title="Your spendable wallet balance"
				/>
				{#if data.walletGpValue > 0}
					<button
						type="button"
						class="convert-btn"
						disabled={walletConverting}
						onclick={() => (convertOpen = true)}
					>
						{walletConverting ? 'Converting…' : `Convert ${formatGP(data.walletGpValue)}`}
					</button>
					<form
						bind:this={convertForm}
						hidden
						method="POST"
						action="/gamba?/convertWallet"
						use:enhance={() => {
							walletConverting = true;
							walletMsg = null;
							return async ({ result }) => {
								walletConverting = false;
								convertOpen = false;
								if (result.type === 'success' && (result.data as { convertOk?: boolean })?.convertOk) {
									const g = Number((result.data as { gained?: number }).gained ?? 0);
									walletMsg = `Converted ${formatGP(g)} into your balance.`;
								} else if (result.type === 'failure') {
									walletMsg =
										((result.data as { convertError?: string })?.convertError) ??
										'Could not convert your wallet.';
								} else if (result.type === 'error') {
									walletMsg = 'Something went wrong converting your wallet.';
								}
								await invalidateAll();
							};
						}}
					></form>
					<ConfirmDialog
						bind:open={convertOpen}
						title="Convert wallet items?"
						message={`Convert all wallet items (${formatGP(data.walletGpValue)}) into a spendable balance?\n\nThis is PERMANENT — these items can no longer be claimed in-game. The balance can only be used for Volition products: buying packs and event buy-ins.`}
						confirmLabel={`Convert ${formatGP(data.walletGpValue)}`}
						busyLabel="Converting…"
						busy={walletConverting}
						danger
						onconfirm={() => convertForm?.requestSubmit()}
					/>
				{/if}
			</div>
			{#if walletMsg}<p class="wallet-msg">{walletMsg}</p>{/if}

			{#if data.wallet.length === 0}
				<EmptyState
					title="No unpaid items in your wallet."
					hint="Items you win from gamble boxes show up here. Convert them into a spendable balance, or have them paid out in-game."
				/>
			{:else}
				<WalletList items={data.wallet} />
				<p class="muted small wallet-total">Wallet value: <strong>{formatGP(data.walletGpValue)}</strong></p>
			{/if}
		</ProfilePanel>
	{/if}
	{/if}
</section>

{#if viewing}
	<CardInspector3D card={viewing} onClose={() => (viewing = null)} />
{/if}

<style>
	.me-skeleton {
		display: flex;
		flex-direction: column;
		gap: 1rem;
		margin-top: 1rem;
	}

	.profile {
		max-width: 900px;
		margin: 0 auto;
	}

	.profile-link {
		margin: 0.75rem 0 0;
		font-size: 0.85rem;
	}

	form.edit {
		display: flex;
		flex-direction: column;
		gap: 1rem;
		max-width: 32rem;
	}

	form.logout {
		margin-top: 1.5rem;
		padding-top: 1.5rem;
		border-top: 1px solid var(--border);
		max-width: 32rem;
	}

	/* ── Site theme picker ── */
	.theme-block {
		margin-top: 1.5rem;
		padding-top: 1.25rem;
		border-top: 1px solid var(--border);
	}
	.theme-block h3 {
		margin: 0 0 0.2rem;
	}
	.themes {
		display: flex;
		gap: 0.6rem;
		flex-wrap: wrap;
		margin-top: 0.6rem;
	}
	.theme-option {
		display: flex;
		flex-direction: column;
		gap: 0.3rem;
		padding: 0.7rem 0.85rem;
		min-width: 11rem;
		background: var(--surface-alt);
		border: 1px solid var(--border);
		border-radius: var(--radius);
		cursor: pointer;
		transition: border-color 0.12s;
	}
	.theme-option:hover {
		border-color: var(--border-strong);
	}
	.theme-option.selected {
		border-color: var(--accent);
		background: var(--accent-soft);
	}
	.theme-option input {
		display: none;
	}
	.swatches {
		display: flex;
		gap: 4px;
	}
	.sw {
		width: 18px;
		height: 18px;
		border-radius: 4px;
		border: 1px solid rgba(0, 0, 0, 0.5);
	}
	.theme-name {
		font-family: var(--font-heading);
		color: var(--text);
	}
	.theme-desc {
		font-size: 0.78rem;
	}
	.theme-msg {
		margin-top: 0.6rem;
		display: inline-block;
	}

	label {
		display: flex;
		flex-direction: column;
		gap: 0.35rem;
	}

	label span {
		font-size: 0.85rem;
		color: var(--muted);
	}

	.error {
		background: var(--danger-bg);
		border: 1px solid var(--danger);
		color: var(--danger);
		padding: 0.6rem 0.8rem;
		border-radius: 4px;
		margin-bottom: 1rem;
		max-width: 32rem;
	}

	.success {
		background: var(--success-bg);
		border: 1px solid var(--success);
		color: var(--success);
		padding: 0.6rem 0.8rem;
		border-radius: 4px;
		margin-bottom: 1rem;
		max-width: 32rem;
	}

	button.primary {
		border-color: var(--accent);
		font-family: var(--font-heading);
		align-self: flex-start;
	}

	button.primary:hover {
		background: var(--accent-soft);
	}

	.account-picker {
		border: none;
		padding: 0;
		margin: 0;
	}

	.account-picker legend {
		font-size: 0.85rem;
		color: var(--muted);
		padding: 0;
		margin-bottom: 0.45rem;
	}

	.account-options {
		display: flex;
		flex-wrap: wrap;
		gap: 0.5rem;
	}

	.account-option {
		display: block;
		gap: 0;
		cursor: pointer;
	}

	.account-option input {
		position: absolute;
		opacity: 0;
		width: 0;
		height: 0;
		pointer-events: none;
	}

	.opt-card {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 56px;
		height: 56px;
		background: var(--surface-alt);
		border: 1px solid var(--border);
		border-radius: var(--radius);
		text-shadow: var(--ts);
		transition: border-color 0.15s, background 0.15s, box-shadow 0.15s;
	}

	.account-option:hover .opt-card {
		border-color: var(--border-strong);
	}

	.account-option input:checked + .opt-card {
		border-color: var(--accent);
		background: var(--accent-soft);
		box-shadow: inset 0 0 0 1px rgba(255, 152, 31, 0.3);
	}

	.account-option input:focus-visible + .opt-card {
		box-shadow: 0 0 0 3px rgba(255, 152, 31, 0.3);
	}

	.opt-icon {
		width: 30px;
		height: 30px;
		image-rendering: pixelated;
		image-rendering: crisp-edges;
		object-fit: contain;
	}

	.muted {
		color: var(--muted);
	}

	.wallet-head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 1rem;
		flex-wrap: wrap;
		margin-bottom: 0.9rem;
	}
	.convert-btn {
		border: 1px solid #e9c349;
		background: rgba(255, 215, 0, 0.1);
		color: #e9c349;
		padding: 0.5rem 0.9rem;
		border-radius: var(--radius);
		cursor: pointer;
	}
	.convert-btn:hover:not(:disabled) {
		background: rgba(255, 215, 0, 0.2);
	}
	.convert-btn:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}
	.wallet-msg {
		color: #7fd18a;
		margin: 0 0 0.8rem;
		font-size: 0.9rem;
	}
	.wallet-total {
		margin-top: 0.75rem;
		text-align: right;
	}

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
	/* .check-btn uses the base OSRS bronze button styling from app.css. */
	.rank-error {
		margin: 0 0 0.85rem;
		color: var(--danger);
		font-size: 0.9rem;
	}
	.rank-note {
		margin: 0 0 0.85rem;
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
	.small {
		font-size: 0.85rem;
	}
</style>

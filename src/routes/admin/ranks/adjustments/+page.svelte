<script lang="ts">
	import { enhance } from '$app/forms';
	import { goto, invalidateAll } from '$app/navigation';
	import RanksTabs from '$lib/admin/RanksTabs.svelte';
	import { RANK_LABEL, type RankValue } from '$lib/ranks';
	import type { ActionData, PageData } from './$types';

	let { data, form }: { data: PageData; form: ActionData } = $props();

	let search = $state('');
	let busy = $state(false);
	let showFallback = $state(false);

	const sel = $derived(data.selected);
	const ov = $derived(data.selectedOverride);

	let filtered = $derived.by(() => {
		const q = search.trim().toLowerCase();
		const list = q
			? data.rosterOnly.filter((p) => p.rsn.toLowerCase().includes(q) || String(p.discord_id ?? '').includes(q))
			: data.rosterOnly;
		return list.slice(0, 120);
	});

	function selectPlayer(rsn: string) {
		goto(`?rsn=${encodeURIComponent(rsn)}`, { invalidateAll: true, keepFocus: true });
	}

	function act() {
		busy = true;
		return async ({
			result,
			update
		}: {
			result: { type: string };
			update: (opts?: { reset?: boolean }) => Promise<void>;
		}) => {
			busy = false;
			await update({ reset: false });
			if (result.type === 'success') await invalidateAll();
		};
	}

	const rankLabel = (r: string | null) => (r ? (RANK_LABEL[r as RankValue] ?? r) : '—');
	const tierLabel = (t: string) => t.charAt(0).toUpperCase() + t.slice(1);
	const signed = (n: number) => (n > 0 ? `+${n}` : `${n}`);
	const fmtDate = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString() : '—');
	/** Members with a site account are edited on their profile; roster-only ones aren't there. */
	const profileHref = (o: { user_id: string | null; profile_rsn: string | null; display_rsn: string | null }) =>
		o.user_id && o.profile_rsn ? `/u/${encodeURIComponent(o.profile_rsn)}` : null;

	// One-line summary of what an adjustment row actually does, for the record.
	function describe(o: (typeof data.overrides)[number]): string {
		const bits: string[] = [];
		if (o.rank_override) bits.push(`rank pinned to ${rankLabel(o.rank_override)}`);
		if (o.ca_tier_override) bits.push(`CA tier ${tierLabel(o.ca_tier_override)}`);
		if (o.gear_points_bonus) bits.push(`${signed(o.gear_points_bonus)} gear pts`);
		if (Number(o.ehb_bonus)) bits.push(`${signed(Number(o.ehb_bonus))} EHB`);
		if (o.clog_bonus) bits.push(`${signed(o.clog_bonus)} clog slots`);
		if (Number(o.months_bonus)) bits.push(`${signed(Number(o.months_bonus))} months`);
		if (o.total_level_override != null) bits.push(`total level ${o.total_level_override}`);
		return bits.length ? bits.join(' · ') : 'no active change';
	}
</script>

<svelte:head>
	<title>Manual Adjustments · Volition Admin</title>
</svelte:head>

<section>
	<RanksTabs />

	<p class="muted intro">
		Every rank score and gear item set by hand, clan-wide. <strong>Editing happens on the member's
		own profile</strong> — open them and click the score bar, rank badge or gear tile you want to
		change. This page is the record of what's been done, and the way back to each member.
	</p>

	{#if form?.saveError}<p class="toast bad">{form.saveError}</p>{/if}
	{#if form?.grantError}<p class="toast bad">{form.grantError}</p>{/if}
	{#if form?.warning}<p class="toast warn">{form.warning}</p>{/if}
	{#if form && !form.warning && (form.saveOk || form.clearOk || form.revokeOk)}
		<p class="toast good">Saved{form.rsn ? ` and ${form.rsn} re-scored` : ''}.</p>
	{/if}

	<h2 class="list-title">Adjusted scores ({data.overrides.length})</h2>
	{#if data.overrides.length === 0}
		<p class="muted">Nothing has been adjusted by hand.</p>
	{:else}
		<div class="table-wrap">
			<table>
				<thead>
					<tr><th>Player</th><th>Adjustment</th><th>Current rank</th><th>Reason</th><th>Adjusted by</th><th>Updated</th><th></th></tr>
				</thead>
				<tbody>
					{#each data.overrides as o (o.id)}
						{@const href = profileHref(o)}
						<tr>
							<td>
								{#if href}
									<a {href}>{o.display_rsn || o.rsn}</a>
								{:else}
									<button class="link" onclick={() => selectPlayer(o.display_rsn || o.rsn)}>
										{o.display_rsn || o.rsn}
									</button>
									<span class="tag">no profile</span>
								{/if}
							</td>
							<td>{describe(o)}</td>
							<td>{rankLabel(o.current_rank)}</td>
							<td class="reason-cell">{o.reason}</td>
							<td class="nowrap">
								{o.updated_by_name ?? '—'}
								<!-- Only worth saying when a DIFFERENT admin started it; otherwise it's noise. -->
								{#if o.created_by_name && o.created_by_name !== o.updated_by_name}
									<span class="muted sub">first set by {o.created_by_name}</span>
								{/if}
							</td>
							<td class="nowrap">{fmtDate(o.updated_at)}</td>
							<td>
								{#if href}
									<a class="edit-link" {href}>Edit on profile →</a>
								{:else}
									<form method="POST" action="?/clearOverride" use:enhance={act}>
										<input type="hidden" name="rsn" value={o.rsn} />
										<input type="hidden" name="discord_id" value={o.discord_id ?? ''} />
										<button
											class="danger small-btn"
											disabled={busy}
											onclick={(e) => {
												if (!confirm(`Remove the adjustment for ${o.display_rsn || o.rsn}?`)) e.preventDefault();
											}}>Remove</button
										>
									</form>
								{/if}
							</td>
						</tr>
					{/each}
				</tbody>
			</table>
		</div>
	{/if}

	<h2 class="list-title">Granted items ({data.grants.length})</h2>
	{#if data.grants.length === 0}
		<p class="muted">No items have been granted by hand.</p>
	{:else}
		<div class="table-wrap">
			<table>
				<thead>
					<tr><th>Player</th><th>Item</th><th>Counts toward</th><th>Reason</th><th>Granted by</th><th>Granted</th><th></th></tr>
				</thead>
				<tbody>
					{#each data.grants as g (g.id)}
						<tr>
							<td>
								{#if g.rsn}<a href="/u/{encodeURIComponent(g.rsn)}">{g.rsn}</a>{:else}{g.discord_username ?? '(unknown)'}{/if}
							</td>
							<td>{g.item_name}{#if g.quantity > 1}<span class="qty-badge">×{g.quantity}</span>{/if}</td>
							<td>{g.entry} <span class="muted">({g.points} pts)</span></td>
							<td class="reason-cell">{g.note ?? '—'}</td>
							<td class="nowrap">{g.granted_by_name ?? '—'}</td>
							<td class="nowrap">{fmtDate(g.reviewed_at)}</td>
							<td>
								<form method="POST" action="?/revokeGrant" use:enhance={act}>
									<input type="hidden" name="id" value={g.id} />
									<input type="hidden" name="rsn" value={g.rsn ?? ''} />
									<button
										class="danger small-btn"
										disabled={busy}
										onclick={(e) => {
											if (!confirm(`Revoke ${g.item_name} from ${g.rsn ?? 'this member'}?`)) e.preventDefault();
										}}>Revoke</button
									>
								</form>
							</td>
						</tr>
					{/each}
				</tbody>
			</table>
		</div>
	{/if}

	<!-- The one thing that can't be done from a profile: adjusting a clan-roster member who
	     never made a site account, and so has no profile page to open. -->
	<h2 class="list-title">
		Roster members with no site account
		<button class="toggle" onclick={() => (showFallback = !showFallback)}>
			{showFallback ? 'Hide' : `Show (${data.rosterOnly.length})`}
		</button>
	</h2>
	<p class="muted small fallback-note">
		These members are on the clan roster but never signed in, so they have no profile to edit on.
		They're scored from WOM, TempleOSRS and WikiSync alone — no gear claims and no TCG — and this
		form is the only way to adjust them. Items can't be granted to them at all; use a gear-points
		adjustment instead.
	</p>

	{#if showFallback}
		<div class="layout">
			<aside class="picker">
				<input class="search" type="search" placeholder="Search RSN or Discord ID…" bind:value={search} />
				<ul class="players">
					{#each filtered as p (p.rsn)}
						<li>
							<button class="player" class:active={sel?.rsn === p.rsn} onclick={() => selectPlayer(p.rsn)}>
								<span class="p-name">{p.rsn}</span>
								{#if p.adjusted}<span class="dot" title="Has an adjustment"></span>{/if}
							</button>
						</li>
					{:else}
						<li class="muted empty">No players match.</li>
					{/each}
				</ul>
			</aside>

			<div class="content">
				{#if !sel}
					<p class="muted">Pick a player to adjust.</p>
				{:else}
					<form method="POST" action="?/saveOverride" use:enhance={act} class="card">
						<input type="hidden" name="rsn" value={sel.rsn} />
						<input type="hidden" name="discord_id" value={sel.discord_id ?? ''} />
						<h3>{sel.rsn}</h3>

						<div class="grid">
							<label>
								Combat achievement tier
								<select name="ca_tier_override">
									<option value="">Score from WikiSync (default)</option>
									{#each data.caTiers as t (t)}
										<option value={t} selected={ov?.ca_tier_override === t}>{tierLabel(t)}</option>
									{/each}
								</select>
							</label>
							<label>
								Gear points
								<input type="number" name="gear_points_bonus" step="1" value={ov?.gear_points_bonus ?? 0} />
							</label>
							<label>
								EHB
								<input type="number" name="ehb_bonus" step="0.1" value={ov?.ehb_bonus ?? 0} />
							</label>
							<label>
								Collection log slots
								<input type="number" name="clog_bonus" step="1" value={ov?.clog_bonus ?? 0} />
							</label>
							<label>
								Months in clan
								<input type="number" name="months_bonus" step="0.5" value={ov?.months_bonus ?? 0} />
							</label>
							<label>
								Total level
								<input type="number" name="total_level_override" step="1" value={ov?.total_level_override ?? ''} placeholder="Use the fetched level" />
							</label>
							<label>
								Rank pin
								<select name="rank_override">
									<option value="">No pin — score them normally</option>
									{#each data.rankOptions as r (r.value)}
										<option value={r.value} selected={ov?.rank_override === r.value}>{r.label}</option>
									{/each}
								</select>
							</label>
						</div>

						<label class="reason">
							Reason (required)
							<input type="text" name="reason" required maxlength="300" value={ov?.reason ?? ''} placeholder="Why is this being set by hand?" />
						</label>

						<div class="actions">
							<button type="submit" disabled={busy}>Save &amp; re-score</button>
							{#if ov}
								<button
									type="submit"
									formaction="?/clearOverride"
									class="danger"
									disabled={busy}
									onclick={(e) => {
										if (!confirm(`Remove all adjustments for ${sel.rsn}?`)) e.preventDefault();
									}}>Remove adjustment</button
								>
							{/if}
						</div>
					</form>
				{/if}
			</div>
		</div>
	{/if}
</section>

<style>
	.intro {
		max-width: 72ch;
	}
	.toast {
		padding: 0.6rem 0.85rem;
		border-radius: 8px;
		border: 1px solid var(--border);
		margin: 0 0 1rem;
	}
	.toast.good {
		border-color: var(--accent);
		color: var(--accent);
	}
	.toast.bad {
		border-color: #d9534f;
		color: #d9534f;
	}
	.toast.warn {
		border-color: #d9a441;
		color: #d9a441;
	}
	.list-title {
		display: flex;
		align-items: center;
		gap: 0.6rem;
		margin: 1.75rem 0 0.6rem;
		font-size: 1.05rem;
	}
	.toggle {
		padding: 0.2rem 0.6rem;
		border: 1px solid var(--border);
		border-radius: 4px;
		background: none;
		color: var(--muted);
		font: inherit;
		font-size: 0.78rem;
		cursor: pointer;
	}
	.toggle:hover {
		color: var(--accent);
		border-color: var(--accent);
	}
	.fallback-note {
		max-width: 72ch;
		margin: 0 0 0.9rem;
	}
	.table-wrap {
		overflow-x: auto;
	}
	table {
		width: 100%;
		border-collapse: collapse;
		font-size: 0.85rem;
	}
	th,
	td {
		text-align: left;
		padding: 0.45rem 0.6rem;
		border-bottom: 1px solid var(--border);
		vertical-align: top;
	}
	th {
		color: var(--muted);
		font-weight: 600;
	}
	.reason-cell {
		max-width: 34ch;
	}
	.nowrap {
		white-space: nowrap;
	}
	.edit-link {
		white-space: nowrap;
		font-size: 0.8rem;
	}
	.tag {
		margin-left: 0.35rem;
		font-size: 0.68rem;
		color: var(--muted);
	}
	.qty-badge {
		color: var(--accent);
		margin-left: 0.3rem;
	}
	.link {
		border: 0;
		background: none;
		padding: 0;
		color: var(--accent);
		cursor: pointer;
		font: inherit;
	}
	.layout {
		display: grid;
		grid-template-columns: minmax(200px, 260px) 1fr;
		gap: 1.25rem;
		align-items: start;
	}
	@media (max-width: 780px) {
		.layout {
			grid-template-columns: 1fr;
		}
	}
	.picker {
		border: 1px solid var(--border);
		border-radius: 10px;
		padding: 0.75rem;
	}
	.search {
		width: 100%;
		padding: 0.45rem 0.6rem;
		border-radius: 6px;
		border: 1px solid var(--border);
		background: var(--bg);
		color: var(--text);
	}
	.players {
		list-style: none;
		margin: 0.55rem 0 0;
		padding: 0;
		max-height: 26rem;
		overflow-y: auto;
	}
	.player {
		display: flex;
		align-items: center;
		gap: 0.4rem;
		width: 100%;
		padding: 0.35rem 0.5rem;
		border: 0;
		border-radius: 6px;
		background: none;
		color: var(--text);
		text-align: left;
		cursor: pointer;
		font-size: 0.9rem;
	}
	.player:hover,
	.player.active {
		background: var(--surface-2, rgba(255, 255, 255, 0.07));
	}
	.player.active {
		color: var(--accent);
	}
	.p-name {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.dot {
		width: 7px;
		height: 7px;
		border-radius: 50%;
		background: var(--accent);
		flex: none;
	}
	.empty {
		padding: 0.5rem;
		font-size: 0.85rem;
	}
	.card {
		border: 1px solid var(--border);
		border-radius: 10px;
		padding: 1rem;
	}
	.card h3 {
		margin: 0 0 0.75rem;
	}
	.grid {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
		gap: 0.9rem;
	}
	label {
		display: flex;
		flex-direction: column;
		gap: 0.3rem;
		font-size: 0.9rem;
	}
	input[type='text'],
	input[type='number'],
	select {
		padding: 0.4rem 0.55rem;
		border-radius: 6px;
		border: 1px solid var(--border);
		background: var(--bg);
		color: var(--text);
		font: inherit;
	}
	.reason {
		margin-top: 0.9rem;
	}
	.actions {
		display: flex;
		align-items: center;
		gap: 0.6rem;
		margin-top: 1rem;
		flex-wrap: wrap;
	}
	button[type='submit'],
	.small-btn {
		padding: 0.45rem 0.9rem;
		border-radius: 6px;
		border: 1px solid var(--accent);
		background: none;
		color: var(--accent);
		cursor: pointer;
		font: inherit;
	}
	button[disabled] {
		opacity: 0.5;
		cursor: default;
	}
	.danger {
		border-color: #d9534f;
		color: #d9534f;
	}
	.small-btn {
		padding: 0.25rem 0.6rem;
		font-size: 0.8rem;
	}
	.small {
		font-size: 0.82rem;
	}
	/* "first set by X" under the last editor, when they're different people. */
	.sub {
		display: block;
		font-size: 0.72rem;
	}
</style>

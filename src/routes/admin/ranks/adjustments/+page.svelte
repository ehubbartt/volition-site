<script lang="ts">
	import { enhance } from '$app/forms';
	import { goto, invalidateAll } from '$app/navigation';
	import RanksTabs from '$lib/admin/RanksTabs.svelte';
	import { RANK_LABEL, type RankValue } from '$lib/ranks';
	import type { ActionData, PageData } from './$types';

	let { data, form }: { data: PageData; form: ActionData } = $props();

	let search = $state('');
	let onlyAdjusted = $state(false);
	let busy = $state(false);

	const sel = $derived(data.selected);
	const ov = $derived(data.selectedOverride);

	let filtered = $derived.by(() => {
		const q = search.trim().toLowerCase();
		let list = data.players;
		if (onlyAdjusted) list = list.filter((p) => p.adjusted);
		if (q)
			list = list.filter(
				(p) =>
					p.rsn.toLowerCase().includes(q) ||
					(p.discord_username?.toLowerCase().includes(q) ?? false) ||
					String(p.discord_id ?? '').includes(q)
			);
		return list.slice(0, 120);
	});

	function selectPlayer(rsn: string) {
		goto(`?rsn=${encodeURIComponent(rsn)}`, { invalidateAll: true, keepFocus: true });
	}

	// Every form on this page behaves the same: re-load so the lists and the member's
	// fresh rank reflect the write, and keep the server's message on screen.
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
			// reset:false keeps what the admin typed on screen when a save is rejected.
			await update({ reset: false });
			if (result.type === 'success') await invalidateAll();
		};
	}

	const rankLabel = (r: string | null) => (r ? (RANK_LABEL[r as RankValue] ?? r) : '—');
	const tierLabel = (t: string) => t.charAt(0).toUpperCase() + t.slice(1);
	const signed = (n: number) => (n > 0 ? `+${n}` : `${n}`);
	const fmtDate = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString() : '—');

	// One-line summary of what an adjustment row actually does, for the tracking table.
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
		The escape hatch for members the automated scoring can't score correctly. Adjustments nudge
		the scoring inputs (or pin the rank outright); grants credit gear the collection log can't
		prove. Both are staff-only, both need a reason, and every change is recorded in the audit log.
	</p>

	{#if form?.saveError}<p class="toast bad">{form.saveError}</p>{/if}
	{#if form?.grantError}<p class="toast bad">{form.grantError}</p>{/if}
	{#if form?.warning}<p class="toast warn">{form.warning}</p>{/if}
	{#if form?.saveOk && !form?.warning}<p class="toast good">Adjustment saved and {form.rsn} re-scored.</p>{/if}
	{#if form?.clearOk && !form?.warning}<p class="toast good">Adjustment removed and {form.rsn} re-scored.</p>{/if}
	{#if form?.grantOk && !form?.warning}<p class="toast good">Item granted and {form.rsn} re-scored.</p>{/if}
	{#if form?.revokeOk && !form?.warning}<p class="toast good">Grant revoked{form.rsn ? ` and ${form.rsn} re-scored` : ''}.</p>{/if}

	<div class="layout">
		<aside class="picker">
			<input class="search" type="search" placeholder="Search RSN, Discord name or ID…" bind:value={search} />
			<label class="only"><input type="checkbox" bind:checked={onlyAdjusted} /> Only adjusted</label>
			<ul class="players">
				{#each filtered as p (p.rsn)}
					<li>
						<button class="player" class:active={sel?.rsn === p.rsn} onclick={() => selectPlayer(p.rsn)}>
							<span class="p-name">{p.rsn}</span>
							{#if p.adjusted}<span class="dot" title="Has an adjustment"></span>{/if}
							{#if !p.id}<span class="no-acct" title="No site account — adjustable, but items can't be granted">roster</span>{/if}
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
				<header class="who">
					<h2>{sel.rsn}</h2>
					<span class="muted">
						{sel.discord_username ?? 'no site account'}{sel.account_type ? ` · ${sel.account_type}` : ''}
					</span>
				</header>

				<!-- Scoring adjustments -->
				<form method="POST" action="?/saveOverride" use:enhance={act} class="card">
					<input type="hidden" name="rsn" value={sel.rsn} />
					<h3>Scoring adjustments</h3>
					<p class="muted hint">
						These feed the normal formula, so the caps, curves and thresholds still apply and the
						member keeps climbing on their own from the adjusted baseline. Prefer them over a pin.
					</p>

					<div class="grid">
						<label>
							Combat achievement tier
							<select name="ca_tier_override">
								<option value="">Score from WikiSync (default)</option>
								{#each data.caTiers as t (t)}
									<option value={t} selected={ov?.ca_tier_override === t}>{tierLabel(t)}</option>
								{/each}
							</select>
							<small>Treats them as holding every tier reward up to this one. Only ever raises the score — this is the group-ironman Grandmaster case.</small>
						</label>

						<label>
							Gear points
							<input type="number" name="gear_points_bonus" step="1" value={ov?.gear_points_bonus ?? 0} />
							<small>Added to their gear total. Prefer granting the actual item below when you know what it is.</small>
						</label>

						<label>
							EHB
							<input type="number" name="ehb_bonus" step="0.1" value={ov?.ehb_bonus ?? 0} />
							<small>Added to efficient hours bossed.</small>
						</label>

						<label>
							Collection log slots
							<input type="number" name="clog_bonus" step="1" value={ov?.clog_bonus ?? 0} />
							<small>Added to their finished-slot count.</small>
						</label>

						<label>
							Months in clan
							<input type="number" name="months_bonus" step="0.5" value={ov?.months_bonus ?? 0} />
							<small>Added to time in clan — for a join date that reset.</small>
						</label>

						<label>
							Total level
							<input type="number" name="total_level_override" step="1" value={ov?.total_level_override ?? ''} placeholder="Use the fetched level" />
							<small>Replaces the fetched total level outright.</small>
						</label>
					</div>

					<label class="pin">
						Rank pin
						<select name="rank_override">
							<option value="">No pin — score them normally</option>
							{#each data.rankOptions as r (r.value)}
								<option value={r.value} selected={ov?.rank_override === r.value}>{r.label}</option>
							{/each}
						</select>
						<small>
							A hard override: this rank is what they get, whatever the composite says, until it's
							removed. Blunt — reach for the adjustments above first.
						</small>
					</label>

					<label class="reason">
						Reason (required)
						<input type="text" name="reason" required maxlength="300" value={ov?.reason ?? ''} placeholder="e.g. GIM — holds Grandmaster CA in game, WikiSync can't see it" />
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
									if (!confirm(`Remove all adjustments for ${sel.rsn} and re-score them on the raw data?`)) e.preventDefault();
								}}>Remove adjustment</button
							>
							<span class="muted small">Set {fmtDate(ov.updated_at)}</span>
						{/if}
					</div>
				</form>

				<!-- Item grants -->
				<form method="POST" action="?/grantItem" use:enhance={act} class="card">
					<input type="hidden" name="rsn" value={sel.rsn} />
					<h3>Grant a gear item</h3>
					<p class="muted hint">
						Credits an item they own but can't prove — a drop from before the in-game collection
						log existed, say. Any item in the gear table, not just the ones members may claim.
					</p>

					{#if !sel.id}
						<p class="muted">
							{sel.rsn} has no site account, so an item can't be attached to them. Use the gear-points
							adjustment above instead.
						</p>
					{:else}
						<div class="grant-row">
							<label class="grow">
								Item
								<input type="text" name="item_name" list="gear-items" required placeholder="Start typing an item name…" />
							</label>
							<label class="qty">
								Count
								<input type="number" name="quantity" min="1" step="1" value="1" />
							</label>
						</div>
						<datalist id="gear-items">
							{#each data.gearItems as g (g.item)}
								<option value={g.item}>{g.entry} · {g.points} pts</option>
							{/each}
						</datalist>
						<label class="reason">
							Reason (required)
							<input type="text" name="reason" required maxlength="300" placeholder="e.g. 4 Zenyte shards dropped pre-collection-log, screenshots in #staff" />
						</label>
						<div class="actions"><button type="submit" disabled={busy}>Grant &amp; re-score</button></div>

						{#if data.selectedApproved.length}
							<h4>Already credited</h4>
							<ul class="credited">
								{#each data.selectedApproved as c (c.id)}
									<li>
										<span class="item">{c.item_name}</span>
										{#if c.quantity > 1}<span class="qty-badge">×{c.quantity}</span>{/if}
										<span class="src" class:admin={c.source === 'admin'}>{c.source === 'admin' ? 'granted' : 'claimed'}</span>
									</li>
								{/each}
							</ul>
						{/if}
					{/if}
				</form>
			{/if}
		</div>
	</div>

	<!-- The record: what's been adjusted by hand, across the clan -->
	<h2 class="list-title">Active adjustments ({data.overrides.length})</h2>
	{#if data.overrides.length === 0}
		<p class="muted">Nothing has been adjusted by hand.</p>
	{:else}
		<div class="table-wrap">
			<table>
				<thead>
					<tr><th>Player</th><th>Adjustment</th><th>Current rank</th><th>Reason</th><th>Updated</th></tr>
				</thead>
				<tbody>
					{#each data.overrides as o (o.id)}
						<tr>
							<td><button class="link" onclick={() => selectPlayer(o.display_rsn || o.rsn)}>{o.display_rsn || o.rsn}</button></td>
							<td>{describe(o)}</td>
							<td>{rankLabel(o.current_rank)}</td>
							<td class="reason-cell">{o.reason}</td>
							<td class="nowrap">{fmtDate(o.updated_at)}</td>
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
					<tr><th>Player</th><th>Item</th><th>Counts toward</th><th>Reason</th><th>Granted</th><th></th></tr>
				</thead>
				<tbody>
					{#each data.grants as g (g.id)}
						<tr>
							<td><button class="link" onclick={() => selectPlayer(g.rsn ?? '')} disabled={!g.rsn}>{g.rsn ?? g.discord_username ?? '(unknown)'}</button></td>
							<td>{g.item_name}{#if g.quantity > 1}<span class="qty-badge">×{g.quantity}</span>{/if}</td>
							<td>{g.entry} <span class="muted">({g.points} pts)</span></td>
							<td class="reason-cell">{g.note ?? '—'}</td>
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
</section>

<style>
	.intro {
		max-width: 70ch;
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
	.only {
		display: flex;
		/* Overrides the column layout the form labels below use. */
		flex-direction: row;
		align-items: center;
		gap: 0.4rem;
		margin: 0.55rem 0;
		font-size: 0.85rem;
		color: var(--muted);
	}
	.players {
		list-style: none;
		margin: 0;
		padding: 0;
		max-height: 30rem;
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
	.player:hover {
		background: var(--surface-2, rgba(255, 255, 255, 0.06));
	}
	.player.active {
		color: var(--accent);
		background: var(--surface-2, rgba(255, 255, 255, 0.08));
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
	.no-acct {
		margin-left: auto;
		font-size: 0.68rem;
		color: var(--muted);
		flex: none;
	}
	.empty {
		padding: 0.5rem;
		font-size: 0.85rem;
	}
	.who {
		display: flex;
		align-items: baseline;
		gap: 0.6rem;
		flex-wrap: wrap;
		margin-bottom: 0.75rem;
	}
	.who h2 {
		margin: 0;
	}
	.card {
		border: 1px solid var(--border);
		border-radius: 10px;
		padding: 1rem;
		margin-bottom: 1.25rem;
	}
	.card h3 {
		margin: 0 0 0.35rem;
	}
	.card h4 {
		margin: 1rem 0 0.4rem;
		font-size: 0.9rem;
	}
	.hint {
		margin: 0 0 0.9rem;
		font-size: 0.85rem;
		max-width: 70ch;
	}
	.grid {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
		gap: 0.9rem;
	}
	label {
		display: flex;
		flex-direction: column;
		gap: 0.3rem;
		font-size: 0.9rem;
	}
	label small {
		color: var(--muted);
		font-size: 0.75rem;
		line-height: 1.35;
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
	.pin,
	.reason {
		margin-top: 0.9rem;
	}
	.grant-row {
		display: flex;
		gap: 0.75rem;
		align-items: flex-end;
	}
	.grow {
		flex: 1;
	}
	.qty input {
		width: 5.5rem;
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
		font-size: 0.8rem;
	}
	.credited {
		list-style: none;
		margin: 0;
		padding: 0;
		display: flex;
		flex-wrap: wrap;
		gap: 0.4rem;
	}
	.credited li {
		display: flex;
		align-items: center;
		gap: 0.35rem;
		border: 1px solid var(--border);
		border-radius: 999px;
		padding: 0.2rem 0.6rem;
		font-size: 0.8rem;
	}
	.qty-badge {
		color: var(--accent);
		font-size: 0.8rem;
		margin-left: 0.3rem;
	}
	.src {
		color: var(--muted);
		font-size: 0.7rem;
	}
	.src.admin {
		color: #d9a441;
	}
	.list-title {
		margin: 1.75rem 0 0.6rem;
		font-size: 1.05rem;
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
	.link {
		border: 0;
		background: none;
		padding: 0;
		color: var(--accent);
		cursor: pointer;
		font: inherit;
	}
	.link[disabled] {
		color: var(--muted);
		cursor: default;
	}
</style>

<script lang="ts">
	import type { PageData, ActionData } from './$types';
	import { enhance } from '$app/forms';
	import AccountIcon from '$lib/AccountIcon.svelte';
	import BoardLeaderboard from '$lib/board/BoardLeaderboard.svelte';
	import { CLAN_OPTIONS } from '$lib/clans';
	import { createBusy } from '$lib/busy.svelte';

	let { data, form }: { data: PageData; form: ActionData } = $props();

	// One shared pending-state for all the plain signup/team/invite forms below: any
	// in-flight action disables the whole group (no double-submits) and swaps the
	// clicked button's label so the round-trip is visible.
	const busy = createBusy();

	let signedUp = $derived(!!data.mySignup);
	let onTeam = $derived(!!data.mySignup?.team_id);

	let poolQuery = $state('');
	let teamQuery = $state('');
	let editingTeamName = $state(false);
	let descExpanded = $state(false);

	// Admin manage tools (pair / remove). adminSignups is [] for non-admins.
	let pairA = $state('');
	let pairB = $state('');
	let removeUser = $state('');
	let adminSolo = $derived(data.adminSignups.filter((p) => !p.team_id));

	const CLAN_ORDER: Array<{ key: string; label: string }> = [
		...CLAN_OPTIONS.map((c) => ({ key: c.value, label: c.label })),
		{ key: 'unknown', label: 'Unknown' }
	];

	const TEAM_GROUP_ORDER: Array<{ key: string; label: string }> = [
		...CLAN_OPTIONS.map((c) => ({ key: c.value, label: c.label })),
		{ key: 'mixed', label: 'Mixed clans' }
	];

	function matchesQuery(haystack: (string | null | undefined)[], q: string): boolean {
		const needle = q.trim().toLowerCase();
		if (!needle) return true;
		return haystack.some((s) => s && s.toLowerCase().includes(needle));
	}

	let filteredSoloPool = $derived(
		data.soloPool.filter((p) =>
			matchesQuery([p.rsn, p.discord_username, p.clan_label], poolQuery)
		)
	);

	let poolByClan = $derived.by(() => {
		const groups = new Map<string, typeof filteredSoloPool>();
		for (const p of filteredSoloPool) {
			const k = p.clan_allegiance ?? 'unknown';
			const arr = groups.get(k) ?? [];
			arr.push(p);
			groups.set(k, arr);
		}
		return CLAN_ORDER.filter((c) => groups.has(c.key)).map((c) => ({
			key: c.key,
			label: c.label,
			players: groups.get(c.key)!
		}));
	});

	function teamGroupKey(members: { clan_allegiance: string | null }[]): string {
		const clans = new Set(members.map((m) => m.clan_allegiance ?? 'unknown'));
		if (clans.size === 1) return [...clans][0];
		return 'mixed';
	}

	let filteredTeams = $derived(
		data.teams.filter((t) => {
			const haystack: (string | null)[] = [t.name];
			for (const m of t.members) {
				haystack.push(m.rsn, m.discord_username, m.clan_label);
			}
			return matchesQuery(haystack, teamQuery);
		})
	);

	let teamsByClan = $derived.by(() => {
		const groups = new Map<string, typeof filteredTeams>();
		for (const t of filteredTeams) {
			const k = teamGroupKey(t.members);
			const arr = groups.get(k) ?? [];
			arr.push(t);
			groups.set(k, arr);
		}
		return TEAM_GROUP_ORDER.filter((c) => groups.has(c.key)).map((c) => ({
			key: c.key,
			label: c.label,
			teams: groups.get(c.key)!
		}));
	});
</script>

<svelte:head>
	<title>{data.event.name} · Volition</title>
</svelte:head>

<nav class="crumbs">
	<a href="/events">← All events</a>
</nav>

<section class="hero">
	<div class="hero-head">
		<h1>{data.event.name}</h1>
		<span class="badge {data.event.status}">{data.event.status}</span>
	</div>
	{#if data.host && (data.host.discord_username || data.host.rsn)}
		<p class="host muted small">Hosted by {data.host.discord_username ? `@${data.host.discord_username}` : data.host.rsn} — message them with questions.</p>
	{/if}
	{#if data.event.description_html}
		{@const isLong = (data.event.description?.length ?? 0) > 220}
		<div
			class="description-wrap"
			class:collapsed={isLong && !descExpanded}
		>
			<div class="muted description">{@html data.event.description_html}</div>
		</div>
		{#if isLong}
			<button
				type="button"
				class="link-btn description-toggle"
				onclick={() => (descExpanded = !descExpanded)}
			>
				{descExpanded ? 'Show less' : 'Show more'}
			</button>
		{/if}
	{/if}
	{#if data.event.signup_closes_at}
		<p class="muted small-meta">
			⏱ Signups close {new Date(data.event.signup_closes_at).toLocaleString()}
		</p>
	{/if}
	<a class="board-link" href="/events/{data.event.slug}/board">View board →</a>
</section>

{#if form?.error}
	<div class="error">{form.error}</div>
{/if}

<section class="grid">
	<div class="main">
		{#if data.isAdmin && !data.eventLive}
			<div class="card admin-card">
				<h2>Manage event <span class="admin-tag">admin</span></h2>

				<form
					method="POST"
					action="?/adminPairUsers"
					class="admin-tool"
					use:enhance={() => {
						return async ({ result, update }) => {
							await update();
							if (result.type === 'success') {
								pairA = '';
								pairB = '';
							}
						};
					}}
				>
					<span class="admin-label">Pair two solo players</span>
					<div class="admin-row">
						<select name="user_a" bind:value={pairA}>
							<option value="">Player A…</option>
							{#each adminSolo as p}
								<option value={p.user_id}>{p.name}</option>
							{/each}
						</select>
						<select name="user_b" bind:value={pairB}>
							<option value="">Player B…</option>
							{#each adminSolo as p}
								<option value={p.user_id}>{p.name}</option>
							{/each}
						</select>
						<button type="submit" class="primary" disabled={!pairA || !pairB || pairA === pairB}>
							Pair
						</button>
					</div>
					{#if adminSolo.length < 2}
						<p class="muted small">Need at least two solo (un-teamed) players to pair.</p>
					{/if}
				</form>

				<form
					method="POST"
					action="?/adminRemoveSignup"
					class="admin-tool"
					use:enhance={() => {
						return async ({ result, update }) => {
							await update();
							if (result.type === 'success') {
								removeUser = '';
							}
						};
					}}
				>
					<span class="admin-label">Remove a player from the event</span>
					<div class="admin-row">
						<select name="user_id" bind:value={removeUser}>
							<option value="">Player…</option>
							{#each data.adminSignups as p}
								<option value={p.user_id}>{p.name}{p.team_id ? ' · on a team' : ''}</option>
							{/each}
						</select>
						<button type="submit" class="danger" disabled={!removeUser}>Remove</button>
					</div>
					<p class="muted small">
						Removing a teamed player disbands their duo — their partner returns to the pool.
					</p>
				</form>
			</div>
		{/if}

		{#if data.eventLive}
			{#if !onTeam}
				<div class="card solo-cta">
					<h2>🐺 Play solo</h2>
					{#if signedUp}
						<p class="muted">
							Signups are closed and you didn't pair into a duo — no problem. Join the climb as a
							team of one and play solo.
						</p>
						<form method="POST" action="?/goSolo" use:enhance={busy.submit('solo')}>
							<button type="submit" class="primary" disabled={busy.active}>
								{busy.is('solo') ? 'Joining…' : 'Play solo (team of one)'}
							</button>
						</form>
					{:else}
						<p class="muted">
							You're not signed up for this event, so you can't join the climb. Catch the next one!
						</p>
					{/if}
				</div>
			{/if}

			<div class="teams-view-head">
				<div>
					<h2>Teams &amp; progress</h2>
					{#if data.standings?.myEntry}
						<p class="muted">
							Your team <strong>{data.standings.myEntry.name}</strong> —
							<strong class="my-stage"
								>{data.standings.myEntry.finished
									? '🏁 Finished'
									: data.standings.myEntry.stageLabel}</strong
							> (rank #{data.standings.myEntry.rank} of {data.standings.teamCount})
						</p>
					{/if}
				</div>
				{#if onTeam}
					<a class="board-open" href="/events/{data.event.slug}/board">Go to board →</a>
				{/if}
			</div>
			{#if data.standings}
				<BoardLeaderboard
					leaderboard={data.standings.leaderboard}
					byClan={data.standings.byClan}
					teamCount={data.standings.teamCount}
					maxHeight="40rem"
				/>
			{/if}
		{/if}

		{#if !signedUp}
			{#if !data.eventLive}
				<div class="card join-card">
					<h2>Join this event</h2>
					<p class="muted">
						Once you join, you'll show up in the player pool. Other players can invite you to
						duo, or you can invite them.
					</p>
					<form method="POST" action="?/joinEvent" use:enhance={busy.submit('join')}>
						<button type="submit" class="primary" disabled={busy.active}>
							{busy.is('join') ? 'Joining…' : 'Join event'}
						</button>
					</form>
				</div>
			{/if}
		{:else}
			{#if onTeam}
			<div class="card team-card">
				<div class="team-card-head">
					<h2>Your team</h2>
					{#if !editingTeamName && !data.eventLive}
						<button
							type="button"
							class="link-btn"
							onclick={() => (editingTeamName = true)}
							title="Edit team name"
						>
							{data.mySignup?.team_name ? 'Rename' : 'Set name'}
						</button>
					{/if}
				</div>

				{#if editingTeamName}
					<form
						method="POST"
						action="?/setTeamName"
						class="team-name-form"
						use:enhance={() => {
							return async ({ result, update }) => {
								await update();
								if (result.type === 'success') {
									editingTeamName = false;
								}
							};
						}}
					>
						<input
							name="name"
							type="text"
							maxlength="32"
							placeholder="Team name (32 chars max)"
							value={data.mySignup?.team_name ?? ''}
							autocomplete="off"
						/>
						<div class="team-name-actions">
							<button type="submit" class="primary">Save</button>
							<button type="button" onclick={() => (editingTeamName = false)}>Cancel</button>
						</div>
					</form>
				{:else}
					<p class="team-name">
						{data.mySignup?.team_name ?? 'Unnamed team'}
					</p>
				{/if}

				<ul class="team-members">
					{#each data.myTeam as m}
						<li>
							<AccountIcon type={m.account_type} />
							<span class="rsn">{m.rsn ?? m.discord_username}</span>
							{#if m.isMe}<span class="you">you</span>{/if}
							<span class="muted">— {m.discord_username}</span>
						</li>
					{/each}
				</ul>
				<form method="POST" action="?/leaveTeam" use:enhance={busy.submit('leaveTeam')}>
					<button type="submit" class="danger" disabled={busy.active}>
						{busy.is('leaveTeam') ? 'Leaving…' : 'Leave team'}
					</button>
				</form>
			</div>
		{:else if !data.eventLive}
			<div class="card signup-card">
				<div class="signup-row">
					<div>
						<h2>You're signed up</h2>
						<p class="muted">
							You're in the player pool. Invite a player or accept an invite to form a duo. No
							partner? You can <strong>play solo</strong> as a team of one.
						</p>
					</div>
					<div class="signup-actions">
						<form method="POST" action="?/goSolo" use:enhance={busy.submit('solo')}>
							<button type="submit" class="primary" disabled={busy.active}>
								{busy.is('solo') ? 'Joining…' : 'Play solo'}
							</button>
						</form>
						<form method="POST" action="?/leaveEvent" use:enhance={busy.submit('leaveEvent')}>
							<button type="submit" class="danger" disabled={busy.active}>
								{busy.is('leaveEvent') ? 'Leaving…' : 'Leave event'}
							</button>
						</form>
					</div>
				</div>
			</div>

			{#if data.incomingInvites.length > 0}
				<div class="card">
					<h2>Pending invites for you</h2>
					<ul class="invite-list">
						{#each data.incomingInvites as inv}
							<li>
								<div class="who">
									<AccountIcon type={inv.from?.account_type} />
									<strong>{inv.from?.rsn ?? inv.from?.discord_username ?? 'Unknown'}</strong>
									{#if inv.from?.discord_username}
										<span class="muted">— {inv.from.discord_username}</span>
									{/if}
								</div>
								<div class="actions">
									<form method="POST" action="?/acceptInvite" use:enhance={busy.submit(`accept:${inv.id}`)}>
										<input type="hidden" name="invite_id" value={inv.id} />
										<button type="submit" class="primary" disabled={busy.active}>
											{busy.is(`accept:${inv.id}`) ? 'Accepting…' : 'Accept'}
										</button>
									</form>
									<form method="POST" action="?/declineInvite" use:enhance={busy.submit(`decline:${inv.id}`)}>
										<input type="hidden" name="invite_id" value={inv.id} />
										<button type="submit" disabled={busy.active}>
											{busy.is(`decline:${inv.id}`) ? 'Declining…' : 'Decline'}
										</button>
									</form>
								</div>
							</li>
						{/each}
					</ul>
				</div>
			{/if}

			{#if data.outgoingInvites.length > 0}
				<div class="card">
					<h2>Invites you've sent</h2>
					<ul class="invite-list">
						{#each data.outgoingInvites as inv}
							<li>
								<div class="who">
									<span class="muted">Waiting on</span>
									<AccountIcon type={inv.to?.account_type} />
									<strong>{inv.to?.rsn ?? inv.to?.discord_username ?? 'Unknown'}</strong>
								</div>
								<form method="POST" action="?/cancelInvite" use:enhance={busy.submit(`cancel:${inv.id}`)}>
									<input type="hidden" name="invite_id" value={inv.id} />
									<button type="submit" disabled={busy.active}>
										{busy.is(`cancel:${inv.id}`) ? 'Cancelling…' : 'Cancel'}
									</button>
								</form>
							</li>
						{/each}
					</ul>
				</div>
			{/if}
			{/if}

			{#if !data.eventLive}
			<div class="card">
				<div class="section-head">
					<h2>Player pool ({data.soloPool.length})</h2>
					<input
						class="search-input"
						type="search"
						placeholder="Search by RSN, Discord, or clan…"
						bind:value={poolQuery}
					/>
				</div>
				<p class="muted">
					{#if onTeam}
						Players without a duo — you're already on a team, so you can't invite, but here's who's still waiting.
					{:else}
						Players without a duo. Invite anyone to team up.
					{/if}
				</p>

				{#if data.soloPool.length === 0}
					<p class="muted">No one waiting right now — invite a friend to sign up!</p>
				{:else if filteredSoloPool.length === 0}
					<p class="muted">No players match "{poolQuery}".</p>
				{:else}
					{#each poolByClan as group}
						<div class="clan-group">
							<h3 class="clan-heading">
								<span class="clan-name">{group.label}</span>
								<span class="clan-count">{group.players.length}</span>
							</h3>
							<ul class="pool">
								{#each group.players as p}
									<li>
										<div class="who">
											<AccountIcon type={p.account_type} />
											<strong>{p.rsn ?? p.discord_username}</strong>
											<span class="muted">— {p.discord_username}</span>
										</div>
										{#if !onTeam}
											<form method="POST" action="?/inviteUser" use:enhance={busy.submit(`invite:${p.user_id}`)}>
												<input type="hidden" name="user_id" value={p.user_id} />
												<button type="submit" class="primary" disabled={busy.active}>
													{busy.is(`invite:${p.user_id}`) ? 'Inviting…' : 'Invite'}
												</button>
											</form>
										{/if}
									</li>
								{/each}
							</ul>
						</div>
					{/each}
				{/if}
			</div>
			{/if}
		{/if}

		{#if data.teams.length > 0}
			<div class="card">
				<div class="section-head">
					<h2>Teams ({data.teams.length})</h2>
					<input
						class="search-input"
						type="search"
						placeholder="Search by team name, member, or clan…"
						bind:value={teamQuery}
					/>
				</div>

				{#if filteredTeams.length === 0}
					<p class="muted">No teams match "{teamQuery}".</p>
				{:else}
					{#each teamsByClan as group}
						<div class="clan-group">
							<h3 class="clan-heading">
								<span class="clan-name">{group.label}</span>
								<span class="clan-count">{group.teams.length}</span>
							</h3>
							<ul class="teams">
								{#each group.teams as t}
									<li>
										<div class="team-row">
											<div class="team-name-row">
												<strong class="team-row-name">{t.name ?? 'Unnamed team'}</strong>
											</div>
											<div class="team-pair">
												{#each t.members as m}
													<span class="team-member">
														<AccountIcon type={m.account_type} />
														<strong>{m.rsn ?? m.discord_username}</strong>
														{#if m.clan_label}
															<span class="clan-tag">{m.clan_label}</span>
														{/if}
													</span>
												{/each}
											</div>
										</div>
									</li>
								{/each}
							</ul>
						</div>
					{/each}
				{/if}
			</div>
		{/if}
	</div>

	<aside class="sidebar">
		<div class="card stats">
			<h2>Stats</h2>
			<div class="stat-row">
				<span class="muted">Total signups</span>
				<strong>{data.stats.totalSignups}</strong>
			</div>
			<div class="stat-row">
				<span class="muted">Duos formed</span>
				<strong>{data.stats.teamCount}</strong>
			</div>
			<div class="stat-row">
				<span class="muted">Solo players</span>
				<strong>{data.stats.soloCount}</strong>
			</div>

			{#if data.stats.clanBreakdown.length > 0}
				<h3>By clan</h3>
				<ul class="clan-list">
					{#each data.stats.clanBreakdown as c}
						<li>
							<span>{c.label}</span>
							<strong>{c.count}</strong>
						</li>
					{/each}
				</ul>
			{/if}
		</div>
	</aside>
</section>

<style>
	.crumbs {
		margin-bottom: 0.75rem;
	}

	.crumbs a {
		color: rgba(255, 255, 255, 0.5);
		font-size: 0.95rem;
		text-decoration: none;
	}

	.crumbs a:hover {
		color: var(--accent);
	}

	.hero {
		margin-bottom: 1.5rem;
		padding: 1.25rem 1.5rem;
		background: linear-gradient(180deg, rgba(58, 48, 36, 0.7), rgba(40, 32, 24, 0.7));
		border: 1px solid var(--border);
		border-radius: var(--radius);
		box-shadow: var(--shadow-card);
	}

	.hero-head {
		display: flex;
		align-items: center;
		gap: 0.75rem;
		flex-wrap: wrap;
		margin-bottom: 0.5rem;
	}

	.hero h1 {
		margin: 0;
	}

	.description {
		max-width: 50rem;
		margin: 0;
	}

	.description :global(h1),
	.description :global(h2),
	.description :global(h3) {
		margin: 1rem 0 0.4rem;
	}

	.description :global(h1) {
		font-size: 1.3rem;
	}

	.description :global(h2) {
		font-size: 1.1rem;
	}

	.description :global(h3) {
		font-size: 0.95rem;
	}

	.description :global(p) {
		margin: 0 0 0.65rem;
	}

	.description :global(ul),
	.description :global(ol) {
		margin: 0.25rem 0 0.7rem;
		padding-left: 1.3rem;
	}

	.description :global(li) {
		margin-bottom: 0.2rem;
	}

	.description :global(blockquote) {
		margin: 0.6rem 0;
		padding: 0.4rem 0.85rem;
		border-left: 3px solid var(--accent);
		background: rgba(255, 152, 31, 0.06);
		color: var(--text);
	}

	.description :global(blockquote p) {
		margin: 0;
	}

	.description :global(code) {
		padding: 0.05rem 0.35rem;
		background: var(--surface-alt);
		border: 1px solid var(--border);
		border-radius: 3px;
		font-size: 0.9em;
	}

	.description :global(pre) {
		padding: 0.6rem 0.8rem;
		background: var(--surface-alt);
		border: 1px solid var(--border);
		border-radius: var(--radius);
		overflow-x: auto;
	}

	.description :global(pre code) {
		padding: 0;
		background: transparent;
		border: 0;
	}

	.description :global(hr) {
		border: none;
		border-top: 1px solid var(--border);
		margin: 1rem 0;
	}

	.description :global(:first-child) {
		margin-top: 0;
	}

	.description :global(:last-child) {
		margin-bottom: 0;
	}

	.description-wrap {
		margin: 0.6rem 0 0.3rem;
		overflow: hidden;
		transition: max-height 0.25s ease;
	}

	.description-wrap.collapsed {
		max-height: 9rem;
		-webkit-mask-image: linear-gradient(to bottom, black 60%, transparent 100%);
		mask-image: linear-gradient(to bottom, black 60%, transparent 100%);
	}

	.description-toggle {
		font-size: 0.9rem;
		padding: 0;
		margin-bottom: 0.25rem;
	}

	.small-meta {
		font-size: 0.95rem;
		margin: 0;
	}

	.board-link {
		display: inline-block;
		margin-top: 0.75rem;
		padding: 0.4rem 0.8rem;
		background: var(--accent-soft);
		border: 1px solid var(--accent);
		border-radius: var(--radius);
		font-family: var(--font-heading);
		font-size: 0.95rem;
		color: var(--accent);
		text-decoration: none;
		text-shadow: var(--ts);
		letter-spacing: 1px;
	}

	.board-link:hover {
		background: var(--accent);
		color: #000;
		text-decoration: none;
		text-shadow: none;
	}

	.muted {
		color: var(--muted);
	}

	.badge {
		display: inline-block;
		padding: 0.1rem 0.55rem;
		font-size: 0.8rem;
		text-transform: uppercase;
		letter-spacing: 0.05em;
		border-radius: 3px;
		background: var(--surface-alt);
		border: 1px solid var(--border);
		color: var(--muted);
	}

	.badge.open {
		background: var(--accent-soft);
		border-color: var(--accent);
		color: var(--accent);
	}

	.error {
		background: var(--danger-bg);
		border: 1px solid var(--danger);
		color: var(--danger);
		padding: 0.6rem 0.8rem;
		border-radius: 4px;
		margin-bottom: 1rem;
	}

	.admin-card {
		border-color: rgba(255, 152, 31, 0.45);
		background: linear-gradient(180deg, rgba(255, 152, 31, 0.08), rgba(40, 32, 24, 0.6));
	}
	.admin-tag {
		font-size: 0.62rem;
		text-transform: uppercase;
		letter-spacing: 0.06em;
		color: var(--accent);
		border: 1px solid rgba(255, 152, 31, 0.5);
		border-radius: 3px;
		padding: 0.05rem 0.4rem;
		vertical-align: middle;
	}
	.admin-tool {
		margin-top: 0.85rem;
	}
	.admin-label {
		display: block;
		font-size: 0.85rem;
		color: var(--muted);
		margin-bottom: 0.35rem;
	}
	.admin-row {
		display: flex;
		flex-wrap: wrap;
		gap: 0.5rem;
		align-items: center;
	}
	.admin-row select {
		flex: 1 1 8rem;
		min-width: 0;
		padding: 0.4rem 0.5rem;
		background: var(--surface-alt);
		color: var(--text);
		border: 1px solid var(--border-strong);
		border-radius: 4px;
		font-family: inherit;
	}
	.admin-row .danger {
		border-color: var(--danger);
		color: var(--danger);
	}
	.admin-row .danger:hover:not(:disabled) {
		background: var(--danger-bg);
	}
	.small {
		font-size: 0.8rem;
		margin: 0.4rem 0 0;
	}

	.grid {
		display: grid;
		gap: 1.25rem;
		grid-template-columns: 1fr;
	}

	@media (min-width: 56rem) {
		.grid {
			grid-template-columns: 1fr 18rem;
		}
	}

	.main {
		display: flex;
		flex-direction: column;
		gap: 1.25rem;
	}

	.card {
		padding: 1.25rem;
		background: linear-gradient(180deg, rgba(58, 48, 36, 0.85), rgba(40, 32, 24, 0.85));
		border: 1px solid var(--border);
		border-radius: var(--radius);
		box-shadow: var(--shadow-card);
	}

	.card h2 {
		margin-top: 0;
		margin-bottom: 0.75rem;
	}

	.card h3 {
		margin: 1rem 0 0.5rem;
		font-size: 0.9rem;
		color: var(--muted);
		text-transform: uppercase;
		letter-spacing: 0.05em;
	}

	.invite-list,
	.pool,
	.teams,
	.team-members {
		list-style: none;
		padding: 0;
		margin: 0;
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
	}

	.invite-list li,
	.pool li {
		display: flex;
		justify-content: space-between;
		align-items: center;
		gap: 0.75rem;
		padding: 0.6rem 0.75rem;
		background: var(--surface-alt);
		border: 1px solid var(--border);
		border-radius: 3px;
	}

	.who {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		flex-wrap: wrap;
	}

	.team-members li {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		padding: 0.6rem 0.75rem;
		background: var(--surface-alt);
		border: 1px solid var(--border);
		border-radius: 3px;
	}

	.team-card .team-members {
		margin-bottom: 1.25rem;
	}

	.team-card-head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 0.5rem;
		margin-bottom: 0.5rem;
	}

	.team-card-head h2 {
		margin: 0;
	}

	.link-btn {
		background: transparent;
		border: none;
		color: var(--accent);
		padding: 0;
		font-size: 0.9rem;
		cursor: pointer;
		text-shadow: 1px 1px #000;
		min-height: 0;
	}

	.link-btn:hover {
		text-decoration: underline;
		background: transparent;
	}

	.team-name {
		font-family: var(--font-heading);
		font-size: 1.1rem;
		color: var(--yellow);
		text-shadow: var(--ts-strong);
		margin: 0 0 0.85rem;
	}

	.team-name-form {
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
		margin-bottom: 1rem;
	}

	.team-name-form input {
		font-family: var(--font-heading);
		font-size: 1rem;
	}

	.team-name-actions {
		display: flex;
		gap: 0.4rem;
	}

	.signup-row {
		display: flex;
		align-items: flex-start;
		justify-content: space-between;
		gap: 1rem;
		flex-wrap: wrap;
	}

	.signup-row h2 {
		margin-bottom: 0.4rem;
	}

	.signup-row p {
		margin: 0;
		max-width: 38rem;
	}

	.signup-row form {
		flex-shrink: 0;
	}

	.section-head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 0.75rem;
		margin-bottom: 0.5rem;
		flex-wrap: wrap;
	}

	.section-head h2 {
		margin: 0;
	}

	.search-input {
		flex: 1 1 14rem;
		min-width: 12rem;
		max-width: 22rem;
		font-size: 0.95rem;
	}

	.clan-group {
		margin-top: 0.85rem;
	}

	.clan-group:first-of-type {
		margin-top: 0.5rem;
	}

	.clan-heading {
		display: flex;
		align-items: baseline;
		gap: 0.5rem;
		margin: 0 0 0.45rem;
		padding-bottom: 0.25rem;
		border-bottom: 1px solid var(--border);
		font-size: 0.95rem;
		color: var(--accent);
		text-shadow: var(--ts);
		letter-spacing: 1px;
	}

	.clan-name {
		text-transform: uppercase;
	}

	.clan-count {
		font-size: 0.85rem;
		color: var(--muted);
		font-family: var(--font-body);
	}

	.team-row {
		display: flex;
		flex-direction: column;
		gap: 0.35rem;
		padding: 0.65rem 0.75rem;
		background: var(--surface-alt);
		border: 1px solid var(--border);
		border-radius: 3px;
	}

	.team-name-row {
		display: flex;
		align-items: baseline;
		gap: 0.5rem;
	}

	.team-row-name {
		font-family: var(--font-heading);
		color: var(--yellow);
		text-shadow: var(--ts);
	}

	.team-row .team-pair {
		background: transparent;
		border: none;
		padding: 0;
	}

	.actions {
		display: flex;
		gap: 0.4rem;
	}

	.team-pair {
		display: flex;
		gap: 1rem;
		flex-wrap: wrap;
		padding: 0.6rem 0.75rem;
		background: var(--surface-alt);
		border: 1px solid var(--border);
		border-radius: 3px;
	}

	.team-member {
		display: inline-flex;
		gap: 0.5rem;
		align-items: center;
	}

	.you {
		font-size: 0.7rem;
		text-transform: uppercase;
		background: var(--accent-soft);
		border: 1px solid var(--accent);
		color: var(--accent);
		padding: 0.05rem 0.4rem;
		border-radius: 4px;
		margin-left: 0.4rem;
	}

	.clan-tag {
		font-size: 0.75rem;
		padding: 0.05rem 0.45rem;
		border-radius: 3px;
		background: var(--surface-alt);
		border: 1px solid var(--border);
		color: var(--muted);
	}

	.stat-row {
		display: flex;
		justify-content: space-between;
		padding: 0.4rem 0;
		border-bottom: 1px solid var(--border);
	}

	.stat-row:last-of-type {
		border-bottom: none;
	}

	.clan-list {
		list-style: none;
		padding: 0;
		margin: 0;
		display: flex;
		flex-direction: column;
		gap: 0.25rem;
	}

	.clan-list li {
		display: flex;
		justify-content: space-between;
	}

	button.primary {
		border-color: var(--accent);
	}

	button.primary:hover {
		background: var(--accent-soft);
	}

	button.danger {
		border-color: var(--danger);
		color: var(--danger);
	}

	button.danger:hover {
		background: var(--danger-bg);
	}

	form {
		display: inline;
	}

	@media (max-width: 540px) {
		.hero {
			padding: 1rem 1.1rem;
		}

		.card {
			padding: 1rem;
		}

		.invite-list li,
		.pool li {
			flex-wrap: wrap;
			gap: 0.5rem 0.6rem;
		}

		.invite-list li form,
		.pool li form,
		.actions {
			margin-left: auto;
		}

		.team-pair {
			flex-direction: column;
			gap: 0.4rem;
			align-items: flex-start;
		}
	}

	/* "View teams" standings view (shown at ?view=teams once the climb is live). */
	.teams-view-head {
		display: flex;
		align-items: flex-start;
		justify-content: space-between;
		gap: 0.75rem;
		flex-wrap: wrap;
		margin-bottom: 0.75rem;
	}

	.teams-view-head h2 {
		margin: 0;
	}

	.teams-view-head .muted {
		margin: 0.25rem 0 0;
	}

	.my-stage {
		color: var(--yellow);
	}

	.board-open {
		flex-shrink: 0;
		padding: 0.5rem 1rem;
		font-family: var(--font-heading);
		background: var(--accent-soft);
		border: 1px solid var(--accent);
		border-radius: var(--radius);
		color: var(--accent);
		text-decoration: none;
		white-space: nowrap;
	}

	.board-open:hover {
		background: var(--accent);
		color: #1a1209;
	}

	.solo-cta {
		border-color: var(--accent);
		background: linear-gradient(180deg, rgba(255, 152, 31, 0.12), rgba(40, 32, 24, 0.85));
	}

	.solo-cta h2 {
		margin: 0 0 0.4rem;
	}

	.solo-cta p {
		margin: 0 0 0.75rem;
	}

	.signup-actions {
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
		flex-shrink: 0;
	}
</style>

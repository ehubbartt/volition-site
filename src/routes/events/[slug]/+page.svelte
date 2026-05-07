<script lang="ts">
	import type { PageData, ActionData } from './$types';
	import { enhance } from '$app/forms';
	import AccountIcon from '$lib/AccountIcon.svelte';

	let { data, form }: { data: PageData; form: ActionData } = $props();

	let signedUp = $derived(!!data.mySignup);
	let onTeam = $derived(!!data.mySignup?.team_id);
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
	{#if data.event.description}
		<p class="muted description">{data.event.description}</p>
	{/if}
	{#if data.event.signup_closes_at}
		<p class="muted small-meta">
			⏱ Signups close {new Date(data.event.signup_closes_at).toLocaleString()}
		</p>
	{/if}
</section>

{#if form?.error}
	<div class="error">{form.error}</div>
{/if}

<section class="grid">
	<div class="main">
		{#if !signedUp}
			<div class="card join-card">
				<h2>Join this event</h2>
				<p class="muted">
					Once you join, you'll show up in the player pool. Other players can invite you to
					duo, or you can invite them.
				</p>
				<form method="POST" action="?/joinEvent" use:enhance>
					<button type="submit" class="primary">Join event</button>
				</form>
			</div>
		{:else if onTeam}
			<div class="card team-card">
				<h2>Your team</h2>
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
				<form method="POST" action="?/leaveTeam" use:enhance>
					<button type="submit" class="danger">Leave team</button>
				</form>
			</div>
		{:else}
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
									<form method="POST" action="?/acceptInvite" use:enhance>
										<input type="hidden" name="invite_id" value={inv.id} />
										<button type="submit" class="primary">Accept</button>
									</form>
									<form method="POST" action="?/declineInvite" use:enhance>
										<input type="hidden" name="invite_id" value={inv.id} />
										<button type="submit">Decline</button>
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
								<form method="POST" action="?/cancelInvite" use:enhance>
									<input type="hidden" name="invite_id" value={inv.id} />
									<button type="submit">Cancel</button>
								</form>
							</li>
						{/each}
					</ul>
				</div>
			{/if}

			<div class="card">
				<h2>Player pool ({data.soloPool.length})</h2>
				<p class="muted">Players without a duo. Invite anyone to team up.</p>
				{#if data.soloPool.length === 0}
					<p class="muted">No one waiting right now — invite a friend to sign up!</p>
				{:else}
					<ul class="pool">
						{#each data.soloPool as p}
							<li>
								<div class="who">
									<AccountIcon type={p.account_type} />
									<strong>{p.rsn ?? p.discord_username}</strong>
									<span class="muted">— {p.discord_username}</span>
									{#if p.clan_label}
										<span class="clan-tag">{p.clan_label}</span>
									{/if}
								</div>
								<form method="POST" action="?/inviteUser" use:enhance>
									<input type="hidden" name="user_id" value={p.user_id} />
									<button type="submit" class="primary">Invite</button>
								</form>
							</li>
						{/each}
					</ul>
				{/if}
			</div>
		{/if}

		{#if data.teams.length > 0}
			<div class="card">
				<h2>Teams ({data.teams.length})</h2>
				<ul class="teams">
					{#each data.teams as t}
						<li>
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
						</li>
					{/each}
				</ul>
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
		white-space: pre-wrap;
		margin-bottom: 0.5rem;
	}

	.small-meta {
		font-size: 0.95rem;
		margin: 0;
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
</style>

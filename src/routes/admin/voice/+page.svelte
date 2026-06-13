<script lang="ts">
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();

	let search = $state('');
	let tab = $state<'leaderboard' | 'activity'>('leaderboard');

	const fmt = (n: number) => n.toLocaleString();

	function formatTime(minutes: number): string {
		if (minutes >= 1440) {
			const days = Math.floor(minutes / 1440);
			const hrs = Math.floor((minutes % 1440) / 60);
			return `${days}d ${hrs}h`;
		}
		const hrs = Math.floor(minutes / 60);
		const mins = minutes % 60;
		if (hrs > 0) return `${hrs}h ${mins}m`;
		return `${mins}m`;
	}

	function shortDate(iso: string): string {
		const d = new Date(iso);
		const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
		return `${months[d.getMonth()]} ${d.getDate()}`;
	}

	function relTime(iso: string): string {
		const diff = Date.now() - new Date(iso).getTime();
		const mins = Math.floor(diff / 60_000);
		const hours = Math.floor(diff / 3_600_000);
		const days = Math.floor(diff / 86_400_000);
		if (mins < 1) return 'just now';
		if (mins < 60) return `${mins}m ago`;
		if (hours < 24) return `${hours}h ago`;
		if (days < 30) return `${days}d ago`;
		return shortDate(iso);
	}

	let maxMinutes = $derived(Math.max(1, ...data.days.map((d) => d.total_minutes)));

	let filteredUsers = $derived.by(() => {
		const q = search.trim().toLowerCase();
		if (!q) return data.users;
		return data.users.filter((u) => u.name.toLowerCase().includes(q));
	});
</script>

<svelte:head>
	<title>Voice Activity · Volition Admin</title>
</svelte:head>

<section>
	<a href="/admin" class="back">← Admin</a>
	<h1>Voice Activity</h1>
	<p class="muted">Voice channel tracking and analytics.</p>

	<div class="summary">
		<div class="stat">
			<span class="num">{fmt(data.stats.totalMinutes)}</span>
			<span class="lbl">Total voice minutes</span>
		</div>
		<div class="stat">
			<span class="num">{fmt(data.stats.activeToday)}</span>
			<span class="lbl">Active today</span>
		</div>
		<div class="stat">
			<span class="num">{fmt(data.stats.totalUsers)}</span>
			<span class="lbl">Users tracked</span>
		</div>
		<div class="stat">
			<span class="num">{fmt(data.stats.peakConcurrentToday)}</span>
			<span class="lbl">Peak concurrent today</span>
		</div>
	</div>

	<div class="card">
		<h2>Voice minutes (30 days)</h2>
		<div class="chart">
			{#each data.days as d (d.date)}
				<div class="bar-wrap" title={`${shortDate(d.date)}: ${fmt(d.total_minutes)} min · ${d.unique_users} users`}>
					<div class="bar" style="height:{Math.max((d.total_minutes / maxMinutes) * 100, 1)}%"></div>
				</div>
			{/each}
		</div>
		<div class="chart-axis">
			<span>{shortDate(data.days[0].date)}</span>
			<span>{shortDate(data.days[data.days.length - 1].date)}</span>
		</div>
	</div>

	<div class="tabs">
		<button class:active={tab === 'leaderboard'} onclick={() => (tab = 'leaderboard')}>Leaderboard</button>
		<button class:active={tab === 'activity'} onclick={() => (tab = 'activity')}>Recent activity</button>
	</div>

	{#if tab === 'leaderboard'}
		<div class="card">
			<div class="toolbar">
				<input class="search" type="search" placeholder="Search name…" bind:value={search} />
				<span class="muted small">{filteredUsers.length} users</span>
			</div>
			<div class="table-scroll">
				<table>
					<thead>
						<tr>
							<th class="r" style="width:2.5rem">#</th>
							<th>Member</th>
							<th class="r">Voice time</th>
							<th class="r">Minutes</th>
						</tr>
					</thead>
					<tbody>
						{#each filteredUsers as u, i (u.user_id)}
							<tr>
								<td class="r muted">{i + 1}</td>
								<td>{u.name}</td>
								<td class="r">{formatTime(u.total_minutes)}</td>
								<td class="r muted">{fmt(u.total_minutes)}</td>
							</tr>
						{:else}
							<tr><td colspan="4" class="empty muted">No users found.</td></tr>
						{/each}
					</tbody>
				</table>
			</div>
		</div>
	{:else}
		<div class="card">
			{#if data.recentActivity.length === 0}
				<p class="muted empty">No recent voice activity.</p>
			{:else}
				<ul class="activity">
					{#each data.recentActivity as a (a.id)}
						<li>
							<span class="dot"></span>
							<span class="a-name">{a.name}</span>
							{#if a.type}<span class="muted small">· {a.type}</span>{/if}
							<span class="a-time muted small">{relTime(a.created_at)}</span>
						</li>
					{/each}
				</ul>
			{/if}
		</div>
	{/if}
</section>

<style>
	.back {
		display: inline-block;
		margin-bottom: 0.5rem;
		color: var(--muted);
		font-size: 0.85rem;
		text-decoration: none;
	}
	.back:hover {
		color: var(--accent);
	}
	h1 {
		margin: 0 0 0.25rem;
	}
	.muted {
		color: var(--muted);
	}
	.small {
		font-size: 0.8rem;
	}

	.summary {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(10rem, 1fr));
		gap: 1rem;
		margin: 1.5rem 0;
	}
	.stat {
		display: flex;
		flex-direction: column;
		gap: 0.2rem;
		padding: 1rem 1.25rem;
		background: var(--accent-soft);
		border: 1px solid var(--accent);
		border-radius: var(--radius);
		text-shadow: var(--ts);
	}
	.stat .num {
		font-family: 'rsbold', ui-sans-serif, Arial, sans-serif;
		font-size: 1.5rem;
		color: var(--accent);
	}
	.stat .lbl {
		font-size: 0.85rem;
		color: var(--muted);
	}

	.card {
		padding: 1.25rem;
		background: linear-gradient(180deg, rgba(58, 48, 36, 0.85), rgba(40, 32, 24, 0.85));
		border: 1px solid var(--border);
		border-radius: var(--radius);
		box-shadow: var(--shadow-card);
		margin-bottom: 1rem;
	}
	.card h2 {
		margin: 0 0 0.9rem;
		font-size: 1.1rem;
		color: var(--accent);
		text-shadow: var(--ts);
	}

	.chart {
		display: flex;
		align-items: flex-end;
		gap: 2px;
		height: 140px;
	}
	.bar-wrap {
		flex: 1;
		height: 100%;
		display: flex;
		align-items: flex-end;
	}
	.bar {
		width: 100%;
		background: var(--accent);
		border-radius: 2px 2px 0 0;
		min-height: 1px;
		transition: opacity 0.15s;
	}
	.bar-wrap:hover .bar {
		opacity: 0.7;
	}
	.chart-axis {
		display: flex;
		justify-content: space-between;
		margin-top: 0.4rem;
		font-size: 0.75rem;
		color: var(--muted);
	}

	.tabs {
		display: flex;
		gap: 0.5rem;
		margin-bottom: 1rem;
	}
	.tabs button {
		padding: 0.45rem 0.9rem;
		background: var(--surface-alt);
		border: 1px solid var(--border);
		border-radius: var(--radius);
		color: var(--muted);
		font-family: var(--font-body);
		cursor: pointer;
	}
	.tabs button:hover {
		color: var(--accent);
	}
	.tabs button.active {
		color: var(--accent);
		border-color: var(--accent);
		background: var(--accent-soft);
	}

	.toolbar {
		display: flex;
		align-items: center;
		gap: 0.75rem;
		margin-bottom: 0.75rem;
	}
	.search {
		flex: 1;
		max-width: 22rem;
		padding: 0.5rem 0.7rem;
		background: var(--surface-alt);
		border: 1px solid var(--border);
		border-radius: var(--radius);
		color: var(--text);
		font-family: var(--font-body);
	}
	.search:focus {
		outline: none;
		border-color: var(--accent);
	}

	.table-scroll {
		overflow-x: auto;
	}
	table {
		width: 100%;
		border-collapse: collapse;
		font-size: 0.9rem;
	}
	th,
	td {
		padding: 0.5rem 0.6rem;
		text-align: left;
		border-bottom: 1px solid var(--border);
		white-space: nowrap;
	}
	th {
		color: var(--muted);
		font-weight: normal;
		font-size: 0.8rem;
	}
	th.r,
	td.r {
		text-align: right;
	}
	tbody tr:hover {
		background: var(--surface-alt);
	}
	.empty {
		text-align: center;
		padding: 1.5rem;
	}

	.activity {
		list-style: none;
		margin: 0;
		padding: 0;
		display: flex;
		flex-direction: column;
	}
	.activity li {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		padding: 0.5rem 0;
		border-bottom: 1px solid var(--border);
	}
	.activity li:last-child {
		border-bottom: none;
	}
	.dot {
		width: 0.5rem;
		height: 0.5rem;
		border-radius: 50%;
		background: var(--success);
		flex: 0 0 auto;
	}
	.a-name {
		color: var(--text);
	}
	.a-time {
		margin-left: auto;
	}
</style>

<script lang="ts">
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();

	let search = $state('');
	let actorFilter = $state('all');
	let routeFilter = $state('all');
	let statusFilter = $state<'all' | 'ok' | 'fail'>('all');

	// Stable per-row actor key, matching the load's actor dropdown ids.
	const actorKey = (r: PageData['rows'][number]) => r.actor_discord_id ?? r.actor_name ?? 'anonymous';

	let filtered = $derived(
		data.rows.filter((r) => {
			if (actorFilter !== 'all' && actorKey(r) !== actorFilter) return false;
			if (routeFilter !== 'all' && r.route_id !== routeFilter) return false;
			if (statusFilter === 'ok' && !(r.status != null && r.status < 400)) return false;
			if (statusFilter === 'fail' && !(r.status != null && r.status >= 400)) return false;
			if (search.trim()) {
				const q = search.toLowerCase();
				const hay = [r.actor_name, r.actor_discord_id, r.route_id, r.path, r.action, JSON.stringify(r.payload)]
					.filter(Boolean)
					.join(' ')
					.toLowerCase();
				if (!hay.includes(q)) return false;
			}
			return true;
		})
	);

	function fmtTime(iso: string): string {
		const d = new Date(iso);
		return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
	}

	function statusClass(s: number | null): string {
		if (s == null) return 'neutral';
		if (s < 300) return 'ok';
		if (s < 400) return 'redirect';
		return 'fail';
	}

	function pretty(payload: unknown): string {
		try {
			return JSON.stringify(payload, null, 2);
		} catch {
			return String(payload);
		}
	}
</script>

<svelte:head>
	<title>Audit Log · Admin · Volition</title>
</svelte:head>

<section>
	<h1>Audit Log</h1>
	<p class="muted">
		Every privileged action (admin routes + anything an admin / card tester does) is recorded
		automatically. Showing the {data.rows.length} most recent entries.
	</p>

	<div class="toolbar">
		<input class="search" type="search" placeholder="Search actor, route, action, payload…" bind:value={search} aria-label="Search audit log" />
		<select bind:value={actorFilter} aria-label="Filter by actor">
			<option value="all">All actors</option>
			{#each data.actors as a (a.id)}
				<option value={a.id}>{a.label}</option>
			{/each}
		</select>
		<select bind:value={routeFilter} aria-label="Filter by route">
			<option value="all">All routes</option>
			{#each data.routes as r (r)}
				<option value={r}>{r}</option>
			{/each}
		</select>
		<select bind:value={statusFilter} aria-label="Filter by outcome">
			<option value="all">Any outcome</option>
			<option value="ok">Succeeded (2xx/3xx)</option>
			<option value="fail">Failed (4xx/5xx)</option>
		</select>
		<span class="result-count">{filtered.length} of {data.rows.length}</span>
	</div>

	{#if filtered.length === 0}
		<p class="muted empty">No entries match your filters.</p>
	{:else}
		<ul class="rows">
			{#each filtered as r (r.id)}
				<details class="row">
					<summary>
						<span class="time">{fmtTime(r.created_at)}</span>
						<span class="actor">
							{r.actor_name ?? r.actor_discord_id ?? 'anonymous'}
							{#if r.is_admin}<span class="badge admin">admin</span>{/if}
							{#if r.is_card_tester}<span class="badge tester">card</span>{/if}
						</span>
						<span class="what">
							<span class="route">{r.route_id ?? r.path}</span>
							{#if r.action}<span class="action">→ {r.action}</span>{/if}
						</span>
						<span class="status {statusClass(r.status)}">{r.status ?? '—'}</span>
						<span class="chev" aria-hidden="true">▾</span>
					</summary>
					<div class="detail">
						<div class="meta-grid">
							<div><span class="k">Path</span><span class="v">{r.path}</span></div>
							<div><span class="k">Method</span><span class="v">{r.method}</span></div>
							<div><span class="k">Discord ID</span><span class="v">{r.actor_discord_id ?? '—'}</span></div>
							<div><span class="k">IP</span><span class="v">{r.ip ?? '—'}</span></div>
							<div class="wide"><span class="k">User agent</span><span class="v ua">{r.user_agent ?? '—'}</span></div>
						</div>
						<pre class="payload">{pretty(r.payload)}</pre>
					</div>
				</details>
			{/each}
		</ul>

		{#if data.hasMore && data.nextBefore}
			<div class="pager">
				<a class="ghost" href="?before={encodeURIComponent(data.nextBefore)}">Load older →</a>
			</div>
		{/if}
	{/if}
</section>

<style>
	h1 {
		margin-bottom: 0.25rem;
	}

	.muted {
		color: var(--muted);
	}

	.empty {
		margin-top: 1.5rem;
	}

	.toolbar {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.5rem;
		margin: 1.25rem 0 1rem;
	}

	.search {
		flex: 1 1 16rem;
		min-width: 12rem;
	}

	.toolbar input,
	.toolbar select {
		padding: 0.45rem 0.6rem;
		background: var(--surface);
		border: 1px solid var(--border);
		border-radius: 4px;
		color: var(--text);
		font-size: 0.9rem;
	}

	.result-count {
		color: var(--muted);
		font-size: 0.85rem;
		margin-left: auto;
	}

	.rows {
		list-style: none;
		margin: 0;
		padding: 0;
		display: flex;
		flex-direction: column;
		gap: 0.3rem;
	}

	.row {
		background: var(--surface);
		border: 1px solid var(--border);
		border-radius: 6px;
		overflow: hidden;
	}

	summary {
		display: grid;
		grid-template-columns: 12rem 1fr 1.4fr 3.5rem 1rem;
		align-items: center;
		gap: 0.6rem;
		padding: 0.5rem 0.75rem;
		cursor: pointer;
		font-size: 0.88rem;
		list-style: none;
	}

	summary::-webkit-details-marker {
		display: none;
	}

	.time {
		color: var(--muted);
		font-variant-numeric: tabular-nums;
		white-space: nowrap;
	}

	.actor {
		display: flex;
		align-items: center;
		gap: 0.3rem;
		font-weight: 600;
		min-width: 0;
	}

	.what {
		display: flex;
		align-items: baseline;
		gap: 0.4rem;
		min-width: 0;
		color: var(--text);
	}

	.route {
		font-family: ui-monospace, monospace;
		font-size: 0.82rem;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.action {
		color: var(--accent);
		font-size: 0.82rem;
		white-space: nowrap;
	}

	.badge {
		font-size: 0.62rem;
		text-transform: uppercase;
		letter-spacing: 0.03em;
		padding: 0.05rem 0.3rem;
		border-radius: 3px;
		border: 1px solid var(--border);
		color: var(--muted);
	}

	.badge.admin {
		color: var(--accent);
		border-color: var(--accent);
	}

	.badge.tester {
		color: var(--yellow);
		border-color: var(--yellow);
	}

	.status {
		text-align: center;
		font-variant-numeric: tabular-nums;
		font-size: 0.82rem;
		padding: 0.1rem 0.3rem;
		border-radius: 3px;
	}

	.status.ok {
		color: #6ee7a8;
	}

	.status.redirect {
		color: var(--muted);
	}

	.status.fail {
		color: #ff981f;
		font-weight: 700;
	}

	.status.neutral {
		color: var(--muted);
	}

	.chev {
		color: var(--muted);
		transition: transform 0.15s;
	}

	.row[open] .chev {
		transform: rotate(180deg);
	}

	.detail {
		padding: 0.25rem 0.75rem 0.75rem;
		border-top: 1px solid var(--border);
	}

	.meta-grid {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(12rem, 1fr));
		gap: 0.35rem 1rem;
		margin: 0.6rem 0;
		font-size: 0.82rem;
	}

	.meta-grid .wide {
		grid-column: 1 / -1;
	}

	.meta-grid .k {
		color: var(--muted);
		margin-right: 0.4rem;
	}

	.meta-grid .ua {
		word-break: break-all;
	}

	.payload {
		margin: 0;
		padding: 0.6rem 0.75rem;
		background: rgba(0, 0, 0, 0.25);
		border: 1px solid var(--border);
		border-radius: 4px;
		font-size: 0.8rem;
		line-height: 1.4;
		overflow-x: auto;
		white-space: pre-wrap;
		word-break: break-word;
	}

	.pager {
		margin-top: 1rem;
		text-align: center;
	}

	.ghost {
		display: inline-block;
		padding: 0.45rem 1rem;
		border: 1px solid var(--border);
		border-radius: 4px;
		color: var(--text);
		text-decoration: none;
	}

	.ghost:hover {
		border-color: var(--accent);
		text-decoration: none;
	}

	@media (max-width: 720px) {
		summary {
			grid-template-columns: 1fr auto;
			grid-template-areas: 'actor status' 'what what' 'time chev';
			row-gap: 0.2rem;
		}
		.time {
			grid-area: time;
		}
		.actor {
			grid-area: actor;
		}
		.what {
			grid-area: what;
		}
		.status {
			grid-area: status;
		}
		.chev {
			grid-area: chev;
			justify-self: end;
		}
	}
</style>

<script lang="ts">
	import ModerationTabs from '$lib/admin/ModerationTabs.svelte';
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
				const hay = [r.summary, r.actor_name, r.actor_discord_id, r.route_id, r.path, r.action, JSON.stringify(r.payload)]
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

	// Replace every user id (anywhere, incl. inside stringified JSON) with the person's RSN,
	// using the server-built userId→RSN map. Non-user uuids (pack/card/team/event) pass through.
	function humanize(v: unknown): unknown {
		if (typeof v === 'string') {
			if (data.userNames[v]) return data.userNames[v];
			const t = v.trim();
			if ((t.startsWith('{') || t.startsWith('[')) && !v.endsWith('…')) {
				try {
					return humanize(JSON.parse(t));
				} catch {
					return v;
				}
			}
			return v;
		}
		if (Array.isArray(v)) return v.map(humanize);
		if (v && typeof v === 'object') {
			const o: Record<string, unknown> = {};
			for (const [k, val] of Object.entries(v)) o[k] = humanize(val);
			return o;
		}
		return v;
	}

	// Hide the bulky `_before` snapshot from the raw payload — the Changes diff renders it.
	function displayPayload(payload: unknown): unknown {
		let p = payload;
		if (p && typeof p === 'object' && !Array.isArray(p) && '_before' in p) {
			const { _before, ...rest } = p as Record<string, unknown>;
			void _before;
			p = rest;
		}
		return humanize(p);
	}

	function pretty(payload: unknown): string {
		try {
			return JSON.stringify(payload, null, 2);
		} catch {
			return String(payload);
		}
	}

	// Compact one-line rendering of a diff value (old/new), with user ids → RSN.
	function fmtVal(v: unknown): string {
		const h = humanize(v);
		if (h === null || h === undefined) return '∅';
		if (typeof h === 'string') return h;
		try {
			return JSON.stringify(h);
		} catch {
			return String(h);
		}
	}
</script>

<svelte:head>
	<title>Audit Log · Admin · Volition</title>
</svelte:head>

<ModerationTabs />

<section>
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
							{#if r.summary}
								<span class="summary">{r.summary}</span>
							{:else}
								<span class="route">{r.route_id ?? r.path}</span>
								{#if r.action}<span class="action">→ {r.action}</span>{/if}
							{/if}
						</span>
						<span class="status {statusClass(r.status)}">{r.status ?? '—'}</span>
						<span class="chev" aria-hidden="true">▾</span>
					</summary>
					<div class="detail">
						<div class="meta-grid">
							<div><span class="k">Action</span><span class="v">{r.route_id ?? r.path}{r.action ? ` → ${r.action}` : ''}</span></div>
							<div><span class="k">Method</span><span class="v">{r.method}</span></div>
							<div><span class="k">Discord ID</span><span class="v">{r.actor_discord_id ?? '—'}</span></div>
							<div><span class="k">IP</span><span class="v">{r.ip ?? '—'}</span></div>
							<div class="wide"><span class="k">User agent</span><span class="v ua">{r.user_agent ?? '—'}</span></div>
						</div>

						{#if r.resolved.length > 0}
							<div class="resolved">
								{#each r.resolved as res (res.key)}
									<span class="chip"><span class="ck">{res.key}</span> {res.label}</span>
								{/each}
							</div>
						{/if}

						{#if r.changes && r.changes.length > 0}
							<table class="changes">
								<thead><tr><th>Field</th><th>Before</th><th>After</th></tr></thead>
								<tbody>
									{#each r.changes as c (c.field)}
										<tr>
											<td class="cf">{c.field}</td>
											<td class="cb">{fmtVal(c.before)}</td>
											<td class="ca">{fmtVal(c.after)}</td>
										</tr>
									{/each}
								</tbody>
							</table>
						{:else if r.action === 'update' && r.route_id === '/admin/tables/[table]'}
							<p class="muted no-diff">No field changes detected (or the old row wasn't captured).</p>
						{/if}

						<pre class="payload">{pretty(displayPayload(r.payload))}</pre>
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

	.summary {
		color: var(--text);
		font-size: 0.88rem;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.resolved {
		display: flex;
		flex-wrap: wrap;
		gap: 0.35rem;
		margin: 0.4rem 0;
	}

	.resolved .chip {
		font-size: 0.78rem;
		padding: 0.1rem 0.45rem;
		background: var(--accent-soft);
		border: 1px solid var(--accent);
		border-radius: 3px;
		color: var(--text);
	}

	.resolved .ck {
		color: var(--muted);
		margin-right: 0.25rem;
		font-family: ui-monospace, monospace;
		font-size: 0.72rem;
	}

	.changes {
		width: 100%;
		border-collapse: collapse;
		margin: 0.5rem 0;
		font-size: 0.8rem;
	}

	.changes th,
	.changes td {
		text-align: left;
		padding: 0.3rem 0.5rem;
		border-bottom: 1px solid var(--border);
		vertical-align: top;
		word-break: break-word;
	}

	.changes thead th {
		color: var(--muted);
		font-weight: normal;
		font-size: 0.72rem;
		text-transform: uppercase;
		letter-spacing: 0.03em;
	}

	.changes .cf {
		font-family: ui-monospace, monospace;
		color: var(--accent);
		white-space: nowrap;
	}

	.changes .cb {
		color: var(--muted);
		text-decoration: line-through;
	}

	.changes .ca {
		color: #6ee7a8;
	}

	.no-diff {
		font-size: 0.8rem;
		margin: 0.4rem 0;
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

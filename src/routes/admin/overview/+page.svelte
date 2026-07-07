<script lang="ts">
	import { swrResource } from '$lib/swrResource.svelte';
	import type { PageData } from './$types';

	let { data: pageData }: { data: PageData } = $props();

	// Streamed payload (see +page.ts): revisits render the last-seen overview
	// instantly; first visits fill in as the fetch lands.
	const EMPTY_OVERVIEW = {
		configs: [],
		loadError: null,
		roster: { owners: [], envAdmins: [], dbAdmins: [], envCardTesters: [], dbCardTesters: [] },
		usernames: {}
	} as NonNullable<PageData['overview']['cached']>;
	const ovRes = swrResource(() => pageData.overview, EMPTY_OVERVIEW);
	const data = $derived(ovRes.value);

	function name(id: string): string {
		return data.usernames[id] ?? id;
	}
	function fmtDate(iso: string | null): string {
		if (!iso) return '—';
		const d = new Date(iso);
		return isNaN(d.getTime())
			? iso
			: d.toLocaleString(undefined, {
					month: 'short',
					day: 'numeric',
					year: 'numeric',
					hour: '2-digit',
					minute: '2-digit'
				});
	}
	function label(key: string): string {
		return key
			.replace(/([A-Z])/g, ' $1')
			.replace(/_/g, ' ')
			.replace(/^./, (s) => s.toUpperCase())
			.trim();
	}

	const groupLabels: Record<string, string> = {
		features: 'Features',
		economy: 'Economy',
		lootcrates: 'Loot Crates',
		events: 'Events',
		messages: 'Command Messages',
		forms: 'Forms'
	};

	// Merge env + DB sources into a single de-duplicated list per role for display.
	function merge(env: string[], dbIds: string[]): { id: string; source: 'env' | 'db' }[] {
		const out: { id: string; source: 'env' | 'db' }[] = [];
		const seen = new Set<string>();
		for (const id of env) {
			if (!seen.has(id)) { seen.add(id); out.push({ id, source: 'env' }); }
		}
		for (const id of dbIds) {
			if (!seen.has(id)) { seen.add(id); out.push({ id, source: 'db' }); }
		}
		return out;
	}

	let admins = $derived(merge(data.roster.envAdmins, data.roster.dbAdmins));
	let cardTesters = $derived(merge(data.roster.envCardTesters, data.roster.dbCardTesters));

	let groups = $derived([...new Set(data.configs.map((c) => c.config_group))]);
</script>

<svelte:head>
	<title>Bot Overview · Volition Admin</title>
</svelte:head>

<section>
	<h1>Bot Overview</h1>
	<p class="muted">
		A read-only snapshot of how the bot and site are currently configured. Use the links to
		edit. Config changes reach the bot within ~60 seconds.
	</p>

	{#if data.loadError}
		<p class="error">Failed to load bot config: {data.loadError}</p>
	{/if}

	<div class="card">
		<div class="card-head">
			<h2>Access &amp; roles</h2>
			<a class="edit-link" href="/admin/admins">Manage access →</a>
		</div>

		{@render roleRow('Owners (super admin)', data.roster.owners.map((id) => ({ id, source: 'env' as const })), 'Root, env-only')}
		{@render roleRow('Admins', admins, '')}
		{@render roleRow('Card testers', cardTesters, '')}
	</div>

	<div class="card">
		<div class="card-head">
			<h2>Bot configuration</h2>
			<a class="edit-link" href="/admin/config">Edit config →</a>
		</div>
		<p class="muted tiny">
			Static channel, role, and emoji IDs live in the bot's <code>config.json</code> and aren't shown here.
		</p>

		{#if data.configs.length === 0}
			<p class="muted">No bot_config rows found.</p>
		{:else}
			{#each groups as g (g)}
				<div class="group">
					<h3>{groupLabels[g] || label(g)}</h3>
					{#each data.configs.filter((c) => c.config_group === g) as c (c.config_name)}
						<div class="cfg">
							<div class="cfg-top">
								<strong>{label(c.config_name)}</strong>
								<span class="muted tiny">
									{#if c.entryCount !== null}{c.entryCount}
										{c.kind === 'array' ? 'item' : 'key'}{c.entryCount === 1 ? '' : 's'} ·
									{/if}
									updated {fmtDate(c.updated_at)}
								</span>
							</div>
							{#if c.description}<p class="muted tiny desc">{c.description}</p>{/if}
							{#if c.keys.length}
								<div class="keys">
									{#each c.keys as k (k)}<span class="chip">{k}</span>{/each}
									{#if c.entryCount && c.entryCount > c.keys.length}
										<span class="chip more">+{c.entryCount - c.keys.length}</span>
									{/if}
								</div>
							{/if}
						</div>
					{/each}
				</div>
			{/each}
		{/if}
	</div>
</section>

{#snippet roleRow(title: string, people: { id: string; source: 'env' | 'db' }[], hint: string)}
	<div class="role">
		<div class="role-title">
			<strong>{title}</strong>
			{#if hint}<span class="muted tiny">{hint}</span>{/if}
		</div>
		{#if people.length === 0}
			<span class="muted tiny">none</span>
		{:else}
			<div class="people">
				{#each people as p (p.id)}
					<span class="chip">
						{name(p.id)}
						<span class="src {p.source}">{p.source === 'env' ? 'env' : 'granted'}</span>
					</span>
				{/each}
			</div>
		{/if}
	</div>
{/snippet}

<style>
	h1 {
		margin-bottom: 0.25rem;
	}
	h2 {
		margin: 0;
		font-size: 1.1rem;
		color: var(--accent);
		text-shadow: var(--ts);
	}
	h3 {
		margin: 0.9rem 0 0.4rem;
		font-size: 0.95rem;
		color: var(--text);
	}
	.muted {
		color: var(--muted);
	}
	.tiny {
		font-size: 0.75rem;
	}
	code {
		background: var(--surface-alt);
		padding: 0.05rem 0.3rem;
		border-radius: 3px;
		font-size: 0.85em;
	}

	.card {
		padding: 1.25rem;
		background: linear-gradient(180deg, rgba(58, 48, 36, 0.85), rgba(40, 32, 24, 0.85));
		border: 1px solid var(--border);
		border-radius: var(--radius);
		box-shadow: var(--shadow-card);
		margin: 1rem 0;
	}
	.card-head {
		display: flex;
		align-items: baseline;
		justify-content: space-between;
		gap: 1rem;
		flex-wrap: wrap;
	}
	.edit-link {
		font-size: 0.85rem;
		color: var(--accent);
		text-decoration: none;
	}
	.edit-link:hover {
		text-decoration: underline;
	}

	.role {
		display: flex;
		gap: 0.75rem;
		align-items: baseline;
		padding: 0.55rem 0;
		border-bottom: 1px solid var(--border);
		flex-wrap: wrap;
	}
	.role:last-child {
		border-bottom: none;
	}
	.role-title {
		display: flex;
		flex-direction: column;
		min-width: 11rem;
	}
	.people {
		display: flex;
		gap: 0.4rem;
		flex-wrap: wrap;
	}

	.group {
		margin-top: 0.5rem;
	}
	.cfg {
		padding: 0.5rem 0;
		border-bottom: 1px solid var(--border);
	}
	.cfg:last-child {
		border-bottom: none;
	}
	.cfg-top {
		display: flex;
		gap: 0.6rem;
		align-items: baseline;
		justify-content: space-between;
		flex-wrap: wrap;
	}
	.desc {
		margin: 0.15rem 0 0;
	}
	.keys {
		display: flex;
		gap: 0.35rem;
		flex-wrap: wrap;
		margin-top: 0.4rem;
	}

	.chip {
		display: inline-flex;
		align-items: center;
		gap: 0.35rem;
		padding: 0.1rem 0.5rem;
		border-radius: 999px;
		font-size: 0.75rem;
		background: var(--surface-alt);
		border: 1px solid var(--border);
		color: var(--text);
	}
	.chip.more {
		color: var(--muted);
	}
	.src {
		font-size: 0.62rem;
		text-transform: uppercase;
		letter-spacing: 0.4px;
		color: var(--muted);
	}
	.src.env {
		color: var(--accent);
	}
	.error {
		color: var(--danger);
	}
</style>

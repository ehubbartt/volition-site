<script lang="ts">
	import { enhance } from '$app/forms';
	import type { SubmitFunction } from '@sveltejs/kit';
	import ModerationTabs from '$lib/admin/ModerationTabs.svelte';
	import { swrResource } from '$lib/swrResource.svelte';
	import type { PageData, ActionData } from './$types';

	let { data: pageData, form }: { data: PageData; form: ActionData } = $props();

	// Streamed payload (see +page.ts): revisits render the last-seen lists
	// instantly; first visits fill in as the fetch lands.
	const EMPTY_MODERATION: NonNullable<PageData['moderation']['cached']> = {
		bans: [],
		warnings: [],
		members: []
	};
	const modRes = swrResource(() => pageData.moderation, EMPTY_MODERATION);
	const data = $derived(modRes.value);

	let banId = $state('');
	let banReason = $state('');
	let warnId = $state('');
	let warnReason = $state('');

	// Refresh data, then clear the form's inputs on a successful submit.
	function resetOn(reset: () => void): SubmitFunction {
		return () => {
			return async ({ result, update }) => {
				await update();
				if (result.type === 'success') reset();
			};
		};
	}

	function fmt(iso: string | null): string {
		if (!iso) return '';
		try {
			return new Date(iso).toLocaleDateString(undefined, { dateStyle: 'medium' });
		} catch {
			return iso;
		}
	}
</script>

<svelte:head><title>Moderation · Volition</title></svelte:head>

<ModerationTabs />

{#if !modRes.ready}
	<p class="muted">Loading…</p>
{/if}

{#if form?.error}
	<div class="error">{form.error}</div>
{/if}

<!-- ── Bans ── -->
<div class="card">
	<div class="card-head">
		<h2>Bans <span class="count">{data.bans.length}</span></h2>
	</div>
	<p class="muted small">
		Banned users are blocked from the entire site (redirected to /banned). Keyed by Discord ID —
		the same ban list the bot uses.
	</p>

	<form
		class="add"
		method="POST"
		action="?/banUser"
		use:enhance={resetOn(() => {
			banId = '';
			banReason = '';
		})}
	>
		<select aria-label="Pick a member to ban" onchange={(e) => (banId = e.currentTarget.value)}>
			<option value="">Pick a member…</option>
			{#each data.members as m (m.discord_id)}
				<option value={m.discord_id}>{m.label}</option>
			{/each}
		</select>
		<input name="discord_id" bind:value={banId} placeholder="Discord ID" inputmode="numeric" />
		<input name="reason" bind:value={banReason} placeholder="Reason" />
		<button type="submit" class="danger" disabled={!banId || !banReason}>Ban</button>
	</form>

	{#if data.bans.length === 0}
		<p class="muted">No active bans.</p>
	{:else}
		<ul class="list">
			{#each data.bans as b (b.discord_id)}
				<li>
					<div class="who">
						<strong>{b.name}</strong>
						<span class="muted mono">{b.discord_id}</span>
					</div>
					<div class="meta">
						{#if b.reason}<span class="reason">{b.reason}</span>{/if}
						<span class="muted small">{b.by ? `by ${b.by}` : ''}{b.at ? ` · ${fmt(b.at)}` : ''}</span>
					</div>
					<form method="POST" action="?/unbanUser" use:enhance>
						<input type="hidden" name="discord_id" value={b.discord_id} />
						<button type="submit" class="ghost">Unban</button>
					</form>
				</li>
			{/each}
		</ul>
	{/if}
</div>

<!-- ── Warnings ── -->
<div class="card">
	<div class="card-head">
		<h2>Warnings <span class="count">{data.warnings.length}</span></h2>
	</div>
	<p class="muted small">Warnings expire after 6 months. Shared with the bot's /warnings.</p>

	<form
		class="add"
		method="POST"
		action="?/warnUser"
		use:enhance={resetOn(() => {
			warnId = '';
			warnReason = '';
		})}
	>
		<select aria-label="Pick a member to warn" onchange={(e) => (warnId = e.currentTarget.value)}>
			<option value="">Pick a member…</option>
			{#each data.members as m (m.discord_id)}
				<option value={m.discord_id}>{m.label}</option>
			{/each}
		</select>
		<input name="discord_id" bind:value={warnId} placeholder="Discord ID" inputmode="numeric" />
		<input name="reason" bind:value={warnReason} placeholder="Reason" />
		<button type="submit" class="primary" disabled={!warnId || !warnReason}>Warn</button>
	</form>

	{#if data.warnings.length === 0}
		<p class="muted">No warnings on record.</p>
	{:else}
		<ul class="list">
			{#each data.warnings as w (w.id)}
				<li>
					<div class="who">
						<strong>{w.name}</strong>
						<span class="pill {w.active ? 'on' : 'off'}">{w.active ? 'Active' : 'Expired'}</span>
					</div>
					<div class="meta">
						{#if w.reason}<span class="reason">{w.reason}</span>{/if}
						<span class="muted small">{w.by ? `by ${w.by}` : ''}{w.at ? ` · ${fmt(w.at)}` : ''}</span>
					</div>
					<form method="POST" action="?/removeWarning" use:enhance>
						<input type="hidden" name="id" value={w.id} />
						<button type="submit" class="ghost">Remove</button>
					</form>
				</li>
			{/each}
		</ul>
	{/if}
</div>

<style>
	.error {
		background: var(--danger-bg, rgba(255, 0, 0, 0.12));
		border: 1px solid var(--danger);
		color: var(--danger);
		padding: 0.6rem 0.8rem;
		border-radius: var(--radius);
		margin-bottom: 1rem;
	}

	.card {
		background: linear-gradient(180deg, rgba(58, 48, 36, 0.6), rgba(40, 32, 24, 0.6));
		border: 1px solid var(--border);
		border-radius: var(--radius);
		box-shadow: var(--shadow-card);
		padding: 1.1rem 1.25rem;
		margin-bottom: 1.25rem;
	}
	.card-head h2 {
		margin: 0;
		font-size: 1.25rem;
	}
	.count {
		font-size: 0.85rem;
		color: var(--muted);
	}
	.muted {
		color: var(--muted);
	}
	.small {
		font-size: 0.85rem;
	}
	.mono {
		font-family: ui-monospace, monospace;
		font-size: 0.78rem;
	}

	.add {
		display: flex;
		flex-wrap: wrap;
		gap: 0.5rem;
		margin: 0.75rem 0 1rem;
	}
	.add select,
	.add input {
		padding: 0.4rem 0.5rem;
		background: var(--surface-alt);
		color: var(--text);
		border: 1px solid var(--border-strong);
		border-radius: var(--radius);
		font-family: inherit;
		min-width: 0;
	}
	.add select {
		flex: 1 1 10rem;
	}
	.add input[name='discord_id'] {
		flex: 1 1 9rem;
	}
	.add input[name='reason'] {
		flex: 2 1 12rem;
	}

	.list {
		list-style: none;
		margin: 0;
		padding: 0;
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
	}
	.list li {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 0.75rem;
		flex-wrap: wrap;
		padding: 0.55rem 0.7rem;
		background: var(--surface-alt);
		border: 1px solid var(--border);
		border-radius: var(--radius);
	}
	.who {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		flex-wrap: wrap;
	}
	.meta {
		display: flex;
		flex-direction: column;
		gap: 0.1rem;
		flex: 1 1 12rem;
		min-width: 0;
	}
	.reason {
		font-size: 0.9rem;
	}

	.pill {
		font-size: 0.62rem;
		text-transform: uppercase;
		letter-spacing: 0.05em;
		padding: 0.05rem 0.4rem;
		border-radius: 3px;
		border: 1px solid transparent;
	}
	.pill.on {
		color: var(--accent);
		border-color: rgba(255, 152, 31, 0.5);
		background: var(--accent-soft);
	}
	.pill.off {
		color: var(--muted);
		border-color: var(--border-strong);
	}

	button {
		cursor: pointer;
		border-radius: var(--radius);
		padding: 0.4rem 0.8rem;
		font-family: inherit;
	}
	.primary {
		border: 1px solid var(--accent);
		background: var(--accent-soft);
		color: var(--accent);
	}
	.danger {
		border: 1px solid var(--danger);
		background: transparent;
		color: var(--danger);
	}
	.danger:hover:not(:disabled) {
		background: var(--danger-bg, rgba(255, 0, 0, 0.12));
	}
	.ghost {
		border: 1px solid var(--border-strong);
		background: transparent;
		color: var(--text);
		font-size: 0.82rem;
		padding: 0.3rem 0.6rem;
	}
	.ghost:hover {
		border-color: var(--accent);
		color: var(--accent);
	}
	button:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}
</style>

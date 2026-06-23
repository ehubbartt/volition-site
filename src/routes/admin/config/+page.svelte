<script lang="ts">
	import { enhance } from '$app/forms';
	import { untrack } from 'svelte';
	import ConfigValueEditor from './ConfigValueEditor.svelte';
	import DatabaseTabs from '$lib/admin/DatabaseTabs.svelte';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();

	const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v));

	// `working` holds the parsed, deeply-reactive value for EVERY config — the recursive
	// ConfigValueEditor edits it in place. `rawText` is the optional per-config "Edit as
	// JSON" escape hatch (for adding brand-new keys the controls can't); it stays synced
	// into `working` on every valid keystroke.
	let working = $state<Record<string, unknown>>({});
	let originalSig = $state<Record<string, string>>({});
	let updatedAt = $state<Record<string, string | null>>({});
	let status = $state<Record<string, { ok: boolean; msg: string } | null>>({});
	let rawMode = $state<Record<string, boolean>>({});
	let rawText = $state<Record<string, string>>({});
	let rawError = $state<Record<string, string | null>>({});

	for (const c of untrack(() => data.configs)) {
		working[c.config_name] = clone(c.config_value);
		originalSig[c.config_name] = JSON.stringify(c.config_value);
		updatedAt[c.config_name] = c.updated_at;
	}

	let groups = $derived([...new Set(data.configs.map((c) => c.config_group))].sort());
	let activeGroupOverride = $state<string | null>(null);
	let activeGroup = $derived(activeGroupOverride ?? groups[0] ?? '');
	let activeConfigs = $derived(data.configs.filter((c) => c.config_group === activeGroup));

	const groupLabels: Record<string, string> = {
		features: 'Features',
		economy: 'Economy',
		lootcrates: 'Loot Crates',
		events: 'Events'
	};

	function label(key: string): string {
		return key
			.replace(/([A-Z])/g, ' $1')
			.replace(/_/g, ' ')
			.replace(/^./, (s) => s.toUpperCase())
			.trim();
	}

	function fmtDate(iso: string | null): string {
		if (!iso) return '';
		const d = new Date(iso);
		if (isNaN(d.getTime())) return iso;
		return d.toLocaleString(undefined, {
			month: 'short',
			day: 'numeric',
			year: 'numeric',
			hour: '2-digit',
			minute: '2-digit'
		});
	}

	function isDirty(name: string): boolean {
		return JSON.stringify(working[name]) !== originalSig[name];
	}
	function valid(name: string): boolean {
		return !rawMode[name] || !rawError[name];
	}

	function toggleRaw(name: string) {
		const on = !rawMode[name];
		rawMode[name] = on;
		if (on) {
			rawText[name] = JSON.stringify(working[name], null, 2);
			rawError[name] = null;
		}
	}
	function onRawInput(name: string, text: string) {
		rawText[name] = text;
		try {
			working[name] = JSON.parse(text);
			rawError[name] = null;
		} catch {
			rawError[name] = 'Invalid JSON';
		}
	}
</script>

<svelte:head>
	<title>Bot Config · Volition Admin</title>
</svelte:head>

<section>
	<DatabaseTabs />
	<p class="muted">
		Live bot settings (<code>bot_config</code>). Changes take effect within ~60 seconds — no restart
		needed.
	</p>

	{#if data.loadError}
		<p class="error">Failed to load config: {data.loadError}</p>
	{/if}

	{#if groups.length > 1}
		<div class="tabs">
			{#each groups as g (g)}
				<button class:active={activeGroup === g} onclick={() => (activeGroupOverride = g)}>
					{groupLabels[g] || label(g)}
				</button>
			{/each}
		</div>
	{/if}

	{#each activeConfigs as c (c.config_name)}
		{@const dirty = isDirty(c.config_name)}
		<div class="card">
			<div class="cfg-head">
				<div>
					<h2>{label(c.config_name)}</h2>
					{#if c.description}<p class="muted small">{c.description}</p>{/if}
				</div>
				<div class="cfg-meta">
					{#if dirty}<span class="pill warn">Unsaved</span>{/if}
					{#if updatedAt[c.config_name]}<span class="muted tiny"
							>Updated {fmtDate(updatedAt[c.config_name])}</span
						>{/if}
					<button class="link-btn" type="button" onclick={() => toggleRaw(c.config_name)}>
						{rawMode[c.config_name] ? 'Use controls' : 'Edit as JSON'}
					</button>
				</div>
			</div>

			<div class="cfg-body">
				{#if rawMode[c.config_name]}
					<textarea
						class="json"
						spellcheck="false"
						rows={Math.min(24, rawText[c.config_name].split('\n').length + 1)}
						value={rawText[c.config_name]}
						oninput={(e) => onRawInput(c.config_name, e.currentTarget.value)}
					></textarea>
					{#if rawError[c.config_name]}<p class="error tiny">{rawError[c.config_name]}</p>{/if}
				{:else}
					<ConfigValueEditor bind:value={working[c.config_name]} />
				{/if}
			</div>

			<div class="cfg-foot">
				{#if status[c.config_name]}
					<span
						class="status"
						class:ok={status[c.config_name]?.ok}
						class:bad={!status[c.config_name]?.ok}>{status[c.config_name]?.msg}</span
					>
				{/if}
				<form
					method="POST"
					action="?/save"
					use:enhance={({ formData, cancel }) => {
						if (!valid(c.config_name)) {
							status[c.config_name] = { ok: false, msg: 'Fix JSON before saving' };
							cancel();
							return;
						}
						formData.set('config_value', JSON.stringify(working[c.config_name]));
						return async ({ result }) => {
							if (result.type === 'success') {
								originalSig[c.config_name] = JSON.stringify(working[c.config_name]);
								updatedAt[c.config_name] = new Date().toISOString();
								status[c.config_name] = { ok: true, msg: 'Saved' };
							} else if (result.type === 'failure') {
								status[c.config_name] = {
									ok: false,
									msg: (result.data as { error?: string })?.error ?? 'Save failed'
								};
							} else {
								status[c.config_name] = { ok: false, msg: 'Save failed' };
							}
						};
					}}
				>
					<input type="hidden" name="config_name" value={c.config_name} />
					<button class="primary" type="submit" disabled={!dirty || !valid(c.config_name)}>
						Save
					</button>
				</form>
			</div>
		</div>
	{/each}
</section>

<style>
	.muted {
		color: var(--muted);
	}
	.small {
		font-size: 0.85rem;
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

	.tabs {
		display: flex;
		gap: 0.5rem;
		flex-wrap: wrap;
		margin: 1.25rem 0 1rem;
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

	.card {
		padding: 1.25rem;
		background: linear-gradient(180deg, rgba(58, 48, 36, 0.85), rgba(40, 32, 24, 0.85));
		border: 1px solid var(--border);
		border-radius: var(--radius);
		box-shadow: var(--shadow-card);
		margin-bottom: 1rem;
	}
	.cfg-head {
		display: flex;
		align-items: flex-start;
		justify-content: space-between;
		gap: 1rem;
		flex-wrap: wrap;
	}
	.cfg-head h2 {
		margin: 0;
		font-size: 1.1rem;
		color: var(--accent);
		text-shadow: var(--ts);
	}
	.cfg-meta {
		display: flex;
		align-items: center;
		gap: 0.6rem;
		flex-wrap: wrap;
	}
	.cfg-body {
		margin: 0.9rem 0;
	}
	.cfg-foot {
		display: flex;
		align-items: center;
		justify-content: flex-end;
		gap: 0.75rem;
	}

	.link-btn {
		background: none;
		border: none;
		color: var(--muted);
		font-family: var(--font-body);
		font-size: 0.8rem;
		cursor: pointer;
		text-decoration: underline;
		padding: 0;
	}
	.link-btn:hover {
		color: var(--accent);
	}

	.json {
		width: 100%;
		padding: 0.6rem 0.7rem;
		background: var(--surface-alt);
		border: 1px solid var(--border);
		border-radius: var(--radius);
		color: var(--text);
		font-family: ui-monospace, 'SF Mono', Menlo, monospace;
		font-size: 0.82rem;
		resize: vertical;
	}
	.json:focus {
		outline: none;
		border-color: var(--accent);
	}

	.primary {
		padding: 0.45rem 1rem;
		background: var(--accent-soft);
		border: 1px solid var(--accent);
		border-radius: var(--radius);
		color: var(--accent);
		font-family: var(--font-body);
		cursor: pointer;
	}
	.primary:hover:not(:disabled) {
		background: var(--accent);
		color: #000;
	}
	.primary:disabled {
		opacity: 0.45;
		cursor: not-allowed;
	}

	.pill {
		display: inline-block;
		padding: 0.05rem 0.45rem;
		border-radius: 3px;
		font-size: 0.7rem;
		text-transform: uppercase;
		letter-spacing: 0.5px;
	}
	.pill.warn {
		background: var(--accent-soft);
		border: 1px solid var(--accent);
		color: var(--accent);
	}
	.status {
		font-size: 0.85rem;
	}
	.status.ok {
		color: var(--success);
	}
	.status.bad {
		color: var(--danger);
	}
	.error {
		color: var(--danger);
	}
</style>

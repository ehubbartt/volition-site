<script lang="ts">
	import { enhance } from '$app/forms';
	import { untrack } from 'svelte';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();

	type EditorType = 'boolean' | 'number' | 'string' | 'flatObject' | 'json';

	function editorType(v: unknown): EditorType {
		if (typeof v === 'boolean') return 'boolean';
		if (typeof v === 'number') return 'number';
		if (typeof v === 'string') return 'string';
		if (v && typeof v === 'object' && !Array.isArray(v)) {
			const vals = Object.values(v as Record<string, unknown>);
			if (
				vals.length > 0 &&
				vals.every((x) => typeof x === 'boolean' || typeof x === 'number' || typeof x === 'string')
			)
				return 'flatObject';
		}
		return 'json';
	}

	const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v));

	// Working copies. `working` holds parsed values for primitive/flat-object editors;
	// `jsonText` holds the raw JSON string for the fallback textarea editor.
	let working = $state<Record<string, unknown>>({});
	let jsonText = $state<Record<string, string>>({});
	let originalSig = $state<Record<string, string>>({});
	let updatedAt = $state<Record<string, string | null>>({});
	let status = $state<Record<string, { ok: boolean; msg: string } | null>>({});

	for (const c of untrack(() => data.configs)) {
		const t = editorType(c.config_value);
		if (t === 'json') jsonText[c.config_name] = JSON.stringify(c.config_value, null, 2);
		else working[c.config_name] = clone(c.config_value);
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

	// The JSON string we'll POST for a config (server JSON.parses it).
	function submitValue(name: string, t: EditorType): string {
		return t === 'json' ? jsonText[name] : JSON.stringify(working[name]);
	}

	function currentSig(name: string, t: EditorType): string | null {
		if (t === 'json') {
			try {
				return JSON.stringify(JSON.parse(jsonText[name]));
			} catch {
				return null; // invalid JSON → treat as dirty + block save
			}
		}
		return JSON.stringify(working[name]);
	}

	function isDirty(name: string, t: EditorType): boolean {
		return currentSig(name, t) !== originalSig[name];
	}

	function jsonValid(name: string, t: EditorType): boolean {
		return t !== 'json' || currentSig(name, t) !== null;
	}
</script>

<svelte:head>
	<title>Bot Config · Volition Admin</title>
</svelte:head>

<section>
	<a href="/admin" class="back">← Admin</a>
	<h1>Bot Config</h1>
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
		{@const t = editorType(c.config_value)}
		{@const dirty = isDirty(c.config_name, t)}
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
				</div>
			</div>

			<div class="cfg-body">
				{#if t === 'boolean'}
					<label class="toggle">
						<input type="checkbox" bind:checked={working[c.config_name] as boolean} />
						<span>{working[c.config_name] ? 'Enabled' : 'Disabled'}</span>
					</label>
				{:else if t === 'number'}
					<input class="field" type="number" bind:value={working[c.config_name] as number} />
				{:else if t === 'string'}
					<input class="field" type="text" bind:value={working[c.config_name] as string} />
				{:else if t === 'flatObject'}
					<div class="kv">
						{#each Object.keys(working[c.config_name] as Record<string, unknown>) as k (k)}
							{@const obj = working[c.config_name] as Record<string, unknown>}
							<label class="kv-row">
								<span class="kv-key">{label(k)}</span>
								{#if typeof obj[k] === 'boolean'}
									<input type="checkbox" bind:checked={obj[k] as boolean} />
								{:else if typeof obj[k] === 'number'}
									<input class="field" type="number" bind:value={obj[k] as number} />
								{:else}
									<input class="field" type="text" bind:value={obj[k] as string} />
								{/if}
							</label>
						{/each}
					</div>
				{:else}
					<textarea
						class="json"
						spellcheck="false"
						rows={Math.min(20, jsonText[c.config_name].split('\n').length + 1)}
						bind:value={jsonText[c.config_name]}
					></textarea>
					{#if !jsonValid(c.config_name, t)}<p class="error tiny">Invalid JSON</p>{/if}
				{/if}
			</div>

			<div class="cfg-foot">
				{#if status[c.config_name]}
					<span class="status" class:ok={status[c.config_name]?.ok} class:bad={!status[c.config_name]?.ok}
						>{status[c.config_name]?.msg}</span
					>
				{/if}
				<form
					method="POST"
					action="?/save"
					use:enhance={() => {
						return async ({ result }) => {
							if (result.type === 'success') {
								originalSig[c.config_name] = currentSig(c.config_name, t) ?? originalSig[c.config_name];
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
					<input type="hidden" name="config_value" value={submitValue(c.config_name, t)} />
					<button class="primary" type="submit" disabled={!dirty || !jsonValid(c.config_name, t)}>
						Save
					</button>
				</form>
			</div>
		</div>
	{/each}
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

	.toggle {
		display: inline-flex;
		align-items: center;
		gap: 0.5rem;
		cursor: pointer;
	}
	.field {
		width: 100%;
		max-width: 28rem;
		padding: 0.45rem 0.6rem;
		background: var(--surface-alt);
		border: 1px solid var(--border);
		border-radius: var(--radius);
		color: var(--text);
		font-family: var(--font-body);
	}
	.field:focus {
		outline: none;
		border-color: var(--accent);
	}
	.kv {
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
	}
	.kv-row {
		display: grid;
		grid-template-columns: 14rem 1fr;
		align-items: center;
		gap: 0.75rem;
	}
	.kv-key {
		color: var(--muted);
		font-size: 0.9rem;
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
		border-radius: 999px;
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

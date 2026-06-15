<script lang="ts">
	import { enhance } from '$app/forms';
	import { goto, invalidateAll } from '$app/navigation';
	import { page } from '$app/state';
	import { untrack } from 'svelte';
	import DatabaseTabs from '$lib/admin/DatabaseTabs.svelte';
	import type { PageData } from './$types';

	type ColumnMeta = {
		name: string;
		dataType: string;
		isNullable: boolean;
		hasDefault: boolean;
		isIdentity: boolean;
	};

	let { data }: { data: PageData } = $props();

	let searchInput = $state(untrack(() => data.search));
	let busy = $state(false);

	type Mode = 'new' | 'edit';
	let modal = $state<{ mode: Mode; row: Record<string, unknown> } | null>(null);
	let edit = $state<Record<string, unknown>>({});
	let editError = $state<string | null>(null);

	const metaByName = $derived(
		new Map(data.columnMeta.map((m) => [m.name, m as ColumnMeta]))
	);

	const isBool = (t: string) => /bool/i.test(t);
	const isNum = (t: string) => /(int|numeric|decimal|double|real|float|serial)/i.test(t);
	const isJson = (t: string) => /json/i.test(t);

	function meta(col: string): ColumnMeta {
		return (
			metaByName.get(col) ?? {
				name: col,
				dataType: 'text',
				isNullable: true,
				hasDefault: false,
				isIdentity: false
			}
		);
	}

	// ---- URL-driven search / sort / paginate ----
	let currentPage = $derived(Math.floor(data.offset / data.limit) + 1);
	let totalPages = $derived(Math.max(1, Math.ceil(data.total / data.limit)));

	async function applyParams(changes: Record<string, string | null>) {
		busy = true;
		const sp = new URLSearchParams(page.url.searchParams);
		for (const [k, v] of Object.entries(changes)) {
			if (v === null || v === '') sp.delete(k);
			else sp.set(k, v);
		}
		await goto(`?${sp.toString()}`, { invalidateAll: true, keepFocus: true });
		busy = false;
	}

	let searchTimer: ReturnType<typeof setTimeout> | null = null;
	function onSearch(v: string) {
		searchInput = v;
		if (searchTimer) clearTimeout(searchTimer);
		searchTimer = setTimeout(() => applyParams({ search: v.trim() || null, offset: '0' }), 400);
	}

	function toggleSort(col: string) {
		const dir = data.sortBy === col && data.sortDir === 'asc' ? 'desc' : 'asc';
		applyParams({ sortBy: col, sortDir: dir, offset: '0' });
	}
	const arrow = (col: string) => (data.sortBy !== col ? '' : data.sortDir === 'asc' ? ' ▲' : ' ▼');

	function gotoPage(p: number) {
		if (p < 1 || p > totalPages) return;
		applyParams({ offset: String((p - 1) * data.limit) });
	}

	// ---- Cell display ----
	function cell(v: unknown): string {
		if (v === null || v === undefined) return '';
		if (typeof v === 'boolean') return v ? '✓' : '✗';
		if (typeof v === 'object') return JSON.stringify(v);
		return String(v);
	}

	// ---- Modal ----
	function openNew() {
		const e: Record<string, unknown> = {};
		for (const m of data.columnMeta) {
			e[m.name] = isBool(m.dataType) ? false : '';
		}
		edit = e;
		editError = null;
		modal = { mode: 'new', row: {} };
	}

	function openEdit(row: Record<string, unknown>) {
		const e: Record<string, unknown> = {};
		for (const m of data.columnMeta) {
			const v = row[m.name];
			if (isBool(m.dataType)) e[m.name] = !!v;
			else if (v === null || v === undefined) e[m.name] = '';
			else if (typeof v === 'object') e[m.name] = JSON.stringify(v, null, 2);
			else e[m.name] = String(v);
		}
		edit = e;
		editError = null;
		modal = { mode: 'edit', row };
	}

	function closeModal() {
		modal = null;
	}

	// Build the typed JSON payload to POST. Returns null on a JSON parse error (sets editError).
	function buildPayload(): string | null {
		const out: Record<string, unknown> = {};
		const creating = modal?.mode === 'new';
		for (const m of data.columnMeta) {
			const v = edit[m.name];
			const empty = v === '' || v === null || v === undefined;

			if (isBool(m.dataType)) {
				out[m.name] = !!v;
				continue;
			}
			// On insert, omit empty defaulted/identity columns so the DB fills them.
			if (creating && empty && (m.hasDefault || m.isIdentity)) continue;

			if (isNum(m.dataType)) {
				out[m.name] = empty ? (m.isNullable ? null : 0) : Number(v);
			} else if (isJson(m.dataType)) {
				if (empty) {
					out[m.name] = m.isNullable ? null : null;
				} else {
					try {
						out[m.name] = JSON.parse(String(v));
					} catch {
						editError = `Invalid JSON in "${m.name}"`;
						return null;
					}
				}
			} else {
				out[m.name] = empty ? (m.isNullable ? null : '') : v;
			}
		}
		return JSON.stringify(out);
	}

	function rowId(row: Record<string, unknown>): string {
		return String(row.id ?? '');
	}
</script>

<svelte:head>
	<title>{data.table} · Table Editor</title>
</svelte:head>

<section>
	<DatabaseTabs />
	<a href="/admin/tables" class="back">← Tables</a>
	<div class="head">
		<h1>{data.table}</h1>
		<span class="muted">{data.total.toLocaleString()} rows</span>
	</div>

	<div class="toolbar">
		<input
			class="search"
			type="search"
			placeholder="Search all columns…"
			value={searchInput}
			oninput={(e) => onSearch(e.currentTarget.value)}
		/>
		<select
			class="sel"
			value={String(data.limit)}
			onchange={(e) => applyParams({ limit: e.currentTarget.value, offset: '0' })}
		>
			{#each [50, 100, 250, 500] as n (n)}<option value={String(n)}>{n} / page</option>{/each}
		</select>
		<button class="primary" onclick={openNew}>+ New row</button>
		{#if busy}<span class="muted small">…</span>{/if}
	</div>

	{#if !data.hasId}
		<p class="warn-text small">⚠ This table has no <code>id</code> column — editing and deleting are disabled (view only).</p>
	{/if}

	<div class="card">
		<div class="table-scroll">
			<table>
				<thead>
					<tr>
						<th class="actions-col"></th>
						{#each data.columns as col (col)}
							<th class="click" onclick={() => toggleSort(col)}
								>{col}<span class="muted tiny"> {meta(col).dataType}</span>{arrow(col)}</th
							>
						{/each}
					</tr>
				</thead>
				<tbody>
					{#each data.rows as row, i (rowId(row) || i)}
						<tr>
							<td class="actions-col">
								<button class="mini" title="Edit" onclick={() => openEdit(row)}>✎</button>
								{#if data.hasId}
									<form
										method="POST"
										action="?/delete"
										style="display:contents"
										use:enhance={() => {
											return async ({ result, update }) => {
												if (result.type === 'success') await invalidateAll();
												else await update();
											};
										}}
									>
										<input type="hidden" name="id" value={rowId(row)} />
										<button
											class="mini danger"
											title="Delete"
											onclick={(e) => {
												if (!confirm('Delete this row? This cannot be undone.'))
													e.preventDefault();
											}}>🗑</button
										>
									</form>
								{/if}
							</td>
							{#each data.columns as col (col)}
								{@const v = row[col]}
								<td class:null={v === null || v === undefined} title={cell(v)}>
									<span class="val">{cell(v) || '—'}</span>
								</td>
							{/each}
						</tr>
					{:else}
						<tr><td colspan={data.columns.length + 1} class="empty muted">No rows.</td></tr>
					{/each}
				</tbody>
			</table>
		</div>
	</div>

	<div class="pager">
		<span class="muted small">
			{#if data.total > 0}
				{data.offset + 1}–{Math.min(data.offset + data.rows.length, data.total)} of {data.total.toLocaleString()}
			{:else}No results{/if}
		</span>
		<div class="pager-btns">
			<button class="mini" disabled={currentPage <= 1 || busy} onclick={() => gotoPage(1)}>«</button>
			<button class="mini" disabled={currentPage <= 1 || busy} onclick={() => gotoPage(currentPage - 1)}
				>‹</button
			>
			<span class="muted small">Page {currentPage} / {totalPages}</span>
			<button
				class="mini"
				disabled={currentPage >= totalPages || busy}
				onclick={() => gotoPage(currentPage + 1)}>›</button
			>
			<button class="mini" disabled={currentPage >= totalPages || busy} onclick={() => gotoPage(totalPages)}
				>»</button
			>
		</div>
	</div>
</section>

{#if modal}
	<div
		class="overlay"
		role="button"
		tabindex="-1"
		onclick={(e) => {
			if (e.target === e.currentTarget) closeModal();
		}}
		onkeydown={(e) => {
			if (e.key === 'Escape') closeModal();
		}}
	>
		<div class="drawer" role="dialog" aria-modal="true">
			<div class="drawer-head">
				<h2>{modal.mode === 'new' ? 'New row' : 'Edit row'} · {data.table}</h2>
				<button class="mini" onclick={closeModal}>✕</button>
			</div>

			{#if editError}<p class="error">{editError}</p>{/if}

			<form
				method="POST"
				action={modal.mode === 'new' ? '?/insert' : '?/update'}
				use:enhance={({ formData, cancel }) => {
					editError = null;
					const payload = buildPayload();
					if (payload === null) {
						cancel();
						return;
					}
					formData.set('payload', payload);
					return async ({ result, update }) => {
						if (result.type === 'success') {
							closeModal();
							await invalidateAll();
						} else if (result.type === 'failure') {
							editError = (result.data as { error?: string })?.error ?? 'Save failed';
							await update({ reset: false });
						} else {
							await update();
						}
					};
				}}
			>
				{#if modal.mode === 'edit'}<input type="hidden" name="id" value={rowId(modal.row)} />{/if}

				<div class="fields">
					{#each data.columnMeta as m (m.name)}
						{@const skip = modal.mode === 'new' && m.isIdentity}
						{#if !skip}
							<label class="field-row">
								<span class="f-name">
									{m.name}
									<span class="muted tiny">{m.dataType}{m.isNullable ? '' : ' · required'}</span>
								</span>
								{#if isBool(m.dataType)}
									<input type="checkbox" bind:checked={edit[m.name] as boolean} />
								{:else if isNum(m.dataType)}
									<input class="f-input" type="number" step="any" bind:value={edit[m.name] as number} />
								{:else if isJson(m.dataType)}
									<textarea class="f-input mono" rows="3" spellcheck="false" bind:value={edit[m.name] as string}
									></textarea>
								{:else}
									<input class="f-input" type="text" bind:value={edit[m.name] as string} />
								{/if}
							</label>
						{/if}
					{/each}
				</div>

				<div class="drawer-foot">
					<button type="button" class="ghost" onclick={closeModal}>Cancel</button>
					<button type="submit" class="primary">{modal.mode === 'new' ? 'Create' : 'Save'}</button>
				</div>
			</form>
		</div>
	</div>
{/if}

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
	.head {
		display: flex;
		align-items: baseline;
		gap: 0.75rem;
	}
	h1 {
		margin: 0;
		font-family: ui-monospace, 'SF Mono', Menlo, monospace;
		font-size: 1.4rem;
		color: var(--accent);
	}
	.muted {
		color: var(--muted);
	}
	.small {
		font-size: 0.85rem;
	}
	.tiny {
		font-size: 0.7rem;
	}
	.warn-text {
		color: var(--accent);
	}
	code {
		background: var(--surface-alt);
		padding: 0.05rem 0.3rem;
		border-radius: 3px;
	}

	.toolbar {
		display: flex;
		align-items: center;
		gap: 0.6rem;
		flex-wrap: wrap;
		margin: 1rem 0;
	}
	.search {
		flex: 1;
		min-width: 12rem;
		max-width: 24rem;
		padding: 0.5rem 0.7rem;
		background: var(--surface-alt);
		border: 1px solid var(--border);
		border-radius: var(--radius);
		color: var(--text);
		font-family: var(--font-body);
	}
	.search:focus,
	.sel:focus {
		outline: none;
		border-color: var(--accent);
	}
	.sel {
		padding: 0.5rem 0.6rem;
		background: var(--surface-alt);
		border: 1px solid var(--border);
		border-radius: var(--radius);
		color: var(--text);
		font-family: var(--font-body);
	}

	.card {
		padding: 0.4rem;
		background: linear-gradient(180deg, rgba(58, 48, 36, 0.85), rgba(40, 32, 24, 0.85));
		border: 1px solid var(--border);
		border-radius: var(--radius);
		box-shadow: var(--shadow-card);
	}
	.table-scroll {
		overflow-x: auto;
	}
	table {
		width: 100%;
		border-collapse: collapse;
		font-size: 0.82rem;
	}
	th,
	td {
		padding: 0.4rem 0.55rem;
		text-align: left;
		border-bottom: 1px solid var(--border);
		white-space: nowrap;
		max-width: 22rem;
	}
	th {
		color: var(--muted);
		font-weight: normal;
		font-size: 0.78rem;
		font-family: ui-monospace, 'SF Mono', Menlo, monospace;
		position: sticky;
		top: 0;
		background: var(--surface-alt);
	}
	th.click {
		cursor: pointer;
		user-select: none;
	}
	th.click:hover {
		color: var(--accent);
	}
	td .val {
		display: inline-block;
		max-width: 22rem;
		overflow: hidden;
		text-overflow: ellipsis;
		vertical-align: bottom;
	}
	td.null {
		color: var(--muted-soft);
	}
	tbody tr:hover {
		background: var(--surface-alt);
	}
	.actions-col {
		width: 1px;
		white-space: nowrap;
	}
	.empty {
		text-align: center;
		padding: 1.5rem;
	}

	.mini {
		padding: 0.2rem 0.45rem;
		background: var(--surface);
		border: 1px solid var(--border);
		border-radius: var(--radius);
		color: var(--text);
		font-size: 0.85rem;
		cursor: pointer;
	}
	.mini:hover:not(:disabled) {
		border-color: var(--accent);
		color: var(--accent);
	}
	.mini:disabled {
		opacity: 0.4;
		cursor: not-allowed;
	}
	.mini.danger:hover {
		border-color: var(--danger);
		color: var(--danger);
	}

	.pager {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 1rem;
		margin-top: 0.75rem;
		flex-wrap: wrap;
	}
	.pager-btns {
		display: flex;
		align-items: center;
		gap: 0.35rem;
	}

	.primary {
		padding: 0.5rem 0.9rem;
		background: var(--accent-soft);
		border: 1px solid var(--accent);
		border-radius: var(--radius);
		color: var(--accent);
		font-family: var(--font-body);
		cursor: pointer;
	}
	.primary:hover {
		background: var(--accent);
		color: #000;
	}
	.ghost {
		padding: 0.5rem 0.9rem;
		background: var(--surface);
		border: 1px solid var(--border);
		border-radius: var(--radius);
		color: var(--muted);
		font-family: var(--font-body);
		cursor: pointer;
	}
	.ghost:hover {
		color: var(--text);
	}

	.overlay {
		position: fixed;
		inset: 0;
		background: rgba(0, 0, 0, 0.6);
		display: flex;
		justify-content: flex-end;
		z-index: 100;
	}
	.drawer {
		width: min(34rem, 100%);
		height: 100%;
		overflow-y: auto;
		background: var(--surface);
		border-left: 1px solid var(--border-strong);
		padding: 1.25rem;
		box-shadow: -8px 0 24px rgba(0, 0, 0, 0.4);
	}
	.drawer-head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 1rem;
		margin-bottom: 1rem;
	}
	.drawer-head h2 {
		margin: 0;
		font-size: 1.05rem;
		color: var(--accent);
		text-shadow: var(--ts);
	}
	.fields {
		display: flex;
		flex-direction: column;
		gap: 0.7rem;
	}
	.field-row {
		display: flex;
		flex-direction: column;
		gap: 0.25rem;
	}
	.f-name {
		font-size: 0.85rem;
		font-family: ui-monospace, 'SF Mono', Menlo, monospace;
		display: flex;
		gap: 0.5rem;
		align-items: baseline;
	}
	.f-input {
		width: 100%;
		padding: 0.4rem 0.55rem;
		background: var(--surface-alt);
		border: 1px solid var(--border);
		border-radius: var(--radius);
		color: var(--text);
		font-family: var(--font-body);
	}
	.f-input:focus {
		outline: none;
		border-color: var(--accent);
	}
	.mono {
		font-family: ui-monospace, 'SF Mono', Menlo, monospace;
		font-size: 0.8rem;
		resize: vertical;
	}
	.drawer-foot {
		display: flex;
		justify-content: flex-end;
		gap: 0.6rem;
		margin-top: 1.25rem;
	}
	.error {
		margin: 0.5rem 0;
		padding: 0.5rem 0.7rem;
		background: var(--danger-bg);
		border: 1px solid var(--danger);
		border-radius: var(--radius);
		color: var(--danger);
		font-size: 0.85rem;
	}
</style>

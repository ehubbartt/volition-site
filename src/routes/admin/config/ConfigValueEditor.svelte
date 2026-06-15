<script lang="ts">
	// Recursive, type-aware editor for an arbitrary JSON config value. Walks the value
	// and renders the right control for each node — booleans → toggle, numbers → number
	// input, hex strings → colour picker, strings → text, arrays → add/remove list,
	// objects → labelled field groups (recursing for each). New fields added to the
	// underlying JSON are picked up automatically because we render whatever keys exist.
	import Self from './ConfigValueEditor.svelte';

	let { value = $bindable(), depth = 0 }: { value: unknown; depth?: number } = $props();

	type Kind = 'boolean' | 'number' | 'string' | 'array' | 'object' | 'null';
	function kind(v: unknown): Kind {
		if (v === null || v === undefined) return 'null';
		if (typeof v === 'boolean') return 'boolean';
		if (typeof v === 'number') return 'number';
		if (typeof v === 'string') return 'string';
		if (Array.isArray(v)) return 'array';
		if (typeof v === 'object') return 'object';
		return 'null';
	}
	let t = $derived(kind(value));

	const isHexColor = (s: unknown): s is string =>
		typeof s === 'string' && /^#?[0-9a-fA-F]{6}$/.test(s);
	// DB may store colours with or without a leading '#'; preserve the original format.
	const withHash = (v: string) => (v.startsWith('#') ? v : `#${v}`);
	function setColor(hex: string) {
		const hadHash = typeof value === 'string' && value.startsWith('#');
		value = hadHash ? hex : hex.replace(/^#/, '');
	}

	function label(k: string): string {
		return k
			.replace(/([A-Z])/g, ' $1')
			.replace(/_/g, ' ')
			.replace(/^./, (s) => s.toUpperCase())
			.trim();
	}

	// Build a blank value shaped like a sample (so "Add item" matches the array's shape).
	function blankLike(sample: unknown): unknown {
		switch (kind(sample)) {
			case 'boolean':
				return false;
			case 'number':
				return 0;
			case 'string':
				return '';
			case 'array':
				return [];
			case 'object': {
				const o: Record<string, unknown> = {};
				for (const k of Object.keys(sample as object)) o[k] = blankLike((sample as Record<string, unknown>)[k]);
				return o;
			}
			default:
				return '';
		}
	}
	function addItem() {
		const arr = value as unknown[];
		arr.push(arr.length > 0 ? blankLike(arr[arr.length - 1]) : '');
	}
	function removeItem(i: number) {
		(value as unknown[]).splice(i, 1);
	}
</script>

{#if t === 'boolean'}
	<label class="leaf toggle">
		<input type="checkbox" bind:checked={value as boolean} />
		<span class="muted">{value ? 'true' : 'false'}</span>
	</label>
{:else if t === 'number'}
	<input class="leaf inp" type="number" step="any" bind:value={value as number} />
{:else if t === 'string'}
	{#if isHexColor(value)}
		<div class="leaf color-row">
			<input type="color" value={withHash(value)} oninput={(e) => setColor(e.currentTarget.value)} />
			<input class="inp" type="text" bind:value={value as string} />
		</div>
	{:else}
		<input class="leaf inp" type="text" bind:value={value as string} />
	{/if}
{:else if t === 'array'}
	<div class="nest">
		{#each value as unknown[] as _item, i (i)}
			<div class="item">
				<span class="idx">{i}</span>
				<div class="item-body"><Self bind:value={(value as unknown[])[i]} depth={depth + 1} /></div>
				<button class="x" type="button" title="Remove" onclick={() => removeItem(i)}>✕</button>
			</div>
		{/each}
		{#if (value as unknown[]).length === 0}<span class="muted empty">(empty)</span>{/if}
		<button class="add" type="button" onclick={addItem}>+ Add item</button>
	</div>
{:else if t === 'object'}
	<div class="nest">
		{#each Object.keys(value as Record<string, unknown>) as k (k)}
			<div class="field">
				<span class="key">{label(k)}</span>
				<div class="field-body">
					<Self bind:value={(value as Record<string, unknown>)[k]} depth={depth + 1} />
				</div>
			</div>
		{/each}
		{#if Object.keys(value as Record<string, unknown>).length === 0}<span class="muted empty">(empty)</span>{/if}
	</div>
{:else}
	<input
		class="leaf inp"
		type="text"
		placeholder="null"
		value=""
		oninput={(e) => (value = e.currentTarget.value)}
	/>
{/if}

<style>
	.muted {
		color: var(--muted);
	}
	.empty {
		font-size: 0.8rem;
	}
	.leaf {
		display: inline-flex;
		align-items: center;
		gap: 0.5rem;
	}
	.inp {
		width: 100%;
		max-width: 24rem;
		padding: 0.4rem 0.55rem;
		background: var(--surface-alt);
		border: 1px solid var(--border);
		border-radius: var(--radius);
		color: var(--text);
		font-family: var(--font-body);
	}
	.inp:focus {
		outline: none;
		border-color: var(--accent);
	}
	.toggle {
		cursor: pointer;
	}
	.color-row {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		width: 100%;
	}
	.color-row input[type='color'] {
		width: 2.2rem;
		height: 2.2rem;
		padding: 0;
		border: 1px solid var(--border);
		border-radius: var(--radius);
		background: var(--surface-alt);
		cursor: pointer;
		flex: 0 0 auto;
	}
	.color-row .inp {
		max-width: 9rem;
	}

	/* Nested containers get a left rule so structure is readable. */
	.nest {
		display: flex;
		flex-direction: column;
		gap: 0.55rem;
		border-left: 2px solid var(--border);
		padding-left: 0.8rem;
		margin-top: 0.2rem;
	}
	.field {
		display: grid;
		grid-template-columns: 13rem 1fr;
		gap: 0.6rem;
		align-items: start;
	}
	.key {
		color: var(--muted);
		font-size: 0.88rem;
		padding-top: 0.4rem;
	}
	.field-body {
		min-width: 0;
	}
	.item {
		display: grid;
		grid-template-columns: 1.5rem 1fr auto;
		gap: 0.5rem;
		align-items: start;
		background: rgba(0, 0, 0, 0.15);
		border: 1px solid var(--border);
		border-radius: var(--radius);
		padding: 0.5rem 0.6rem;
	}
	.idx {
		color: var(--muted-soft);
		font-size: 0.78rem;
		padding-top: 0.4rem;
	}
	.item-body {
		min-width: 0;
	}
	.x {
		align-self: start;
		padding: 0.15rem 0.4rem;
		background: var(--surface);
		border: 1px solid var(--border);
		border-radius: var(--radius);
		color: var(--muted);
		cursor: pointer;
		font-size: 0.8rem;
	}
	.x:hover {
		border-color: var(--danger);
		color: var(--danger);
	}
	.add {
		align-self: flex-start;
		padding: 0.3rem 0.7rem;
		background: var(--surface);
		border: 1px dashed var(--border-strong);
		border-radius: var(--radius);
		color: var(--muted);
		font-family: var(--font-body);
		cursor: pointer;
		font-size: 0.85rem;
	}
	.add:hover {
		border-color: var(--accent);
		color: var(--accent);
	}

	/* On narrow screens, stack object key above its control. */
	@media (max-width: 640px) {
		.field {
			grid-template-columns: 1fr;
			gap: 0.25rem;
		}
		.key {
			padding-top: 0;
		}
	}
</style>

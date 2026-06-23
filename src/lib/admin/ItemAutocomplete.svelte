<script lang="ts">
	// Name → OSRS item-id autocomplete for the tracked-items editor. Renders the
	// `item_name` text field plus a hidden `item_id` field; picking a suggestion
	// fills both. Typing a free-text name without picking leaves the id blank
	// (name-only matching still works on the proxy side).
	interface Item {
		id: number;
		name: string;
	}

	let query = $state('');
	let itemId = $state<number | ''>('');
	let results = $state<Item[]>([]);
	let open = $state(false);
	let timer: ReturnType<typeof setTimeout> | undefined;

	async function search(q: string) {
		if (q.trim().length < 2) {
			results = [];
			open = false;
			return;
		}
		try {
			const res = await fetch(`/api/items/search?q=${encodeURIComponent(q)}`);
			if (res.ok) {
				results = await res.json();
				open = results.length > 0;
			}
		} catch {
			/* offline / blocked — leave the field as a manual entry */
		}
	}

	function onInput(e: Event) {
		query = (e.currentTarget as HTMLInputElement).value;
		itemId = ''; // typing invalidates a previously-picked id
		clearTimeout(timer);
		timer = setTimeout(() => search(query), 200);
	}

	function pick(it: Item) {
		query = it.name;
		itemId = it.id;
		open = false;
		results = [];
	}
</script>

<div class="ac">
	<input
		name="item_name"
		type="text"
		placeholder="Item name"
		autocomplete="off"
		required
		value={query}
		oninput={onInput}
		onfocus={() => (open = results.length > 0)}
		onblur={() => setTimeout(() => (open = false), 150)}
	/>
	<input type="hidden" name="item_id" value={itemId} />
	{#if open}
		<ul class="ac-list">
			{#each results as it (it.id)}
				<li>
					<button type="button" onmousedown={() => pick(it)}>
						<span class="nm">{it.name}</span><span class="id">#{it.id}</span>
					</button>
				</li>
			{/each}
		</ul>
	{/if}
</div>

<style>
	.ac {
		position: relative;
		flex: 1;
		min-width: 140px;
	}
	.ac > input[type='text'] {
		width: 100%;
	}
	.ac-list {
		position: absolute;
		z-index: 20;
		left: 0;
		right: 0;
		top: 100%;
		margin: 2px 0 0;
		padding: 0;
		list-style: none;
		max-height: 220px;
		overflow-y: auto;
		background: #0f0d0a;
		border: 1px solid #342c20;
		border-radius: 6px;
		box-shadow: 0 6px 18px rgba(0, 0, 0, 0.5);
	}
	.ac-list button {
		display: flex;
		justify-content: space-between;
		gap: 0.5rem;
		width: 100%;
		text-align: left;
		background: none;
		border: none;
		color: #eee;
		padding: 0.35rem 0.55rem;
		cursor: pointer;
		font: inherit;
	}
	.ac-list button:hover {
		background: #2a241c;
	}
	.ac-list .id {
		color: #8a7a5c;
		font-size: 0.78rem;
	}
</style>

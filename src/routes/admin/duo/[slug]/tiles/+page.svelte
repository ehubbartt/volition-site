<script lang="ts">
	import type { PageData } from './$types';
	import { enhance } from '$app/forms';

	let { data }: { data: PageData } = $props();

	type Tile = PageData['tiles'][number];
	type EditState = {
		name: string;
		img: string;
		required: number;
		faq: string;
		prePic: boolean;
		postRequired: boolean;
		autoClear: string;
	};

	let search = $state('');
	let openId = $state<string | null>(null);
	let edit = $state<Record<string, EditState>>({});
	let savedFlash = $state<Record<string, boolean>>({});
	let errorMsg = $state<string | null>(null);

	const floors = $derived([...new Set(data.tiles.map((t) => t.floor))].sort((a, b) => a - b));
	const editedCount = $derived(data.tiles.filter((t) => t.overridden).length);

	const filtered = $derived.by(() => {
		const q = search.trim().toLowerCase();
		if (!q) return data.tiles;
		return data.tiles.filter(
			(t) =>
				t.name.toLowerCase().includes(q) ||
				t.label.toLowerCase().includes(q) ||
				t.id.toLowerCase().includes(q) ||
				t.group.toLowerCase().includes(q)
		);
	});

	// Group a floor's (filtered) tiles into contiguous subgroups for subheaders.
	function groupsForFloor(f: number): { group: string; tiles: Tile[] }[] {
		const out: { group: string; tiles: Tile[] }[] = [];
		for (const t of filtered.filter((x) => x.floor === f)) {
			const last = out[out.length - 1];
			if (last && last.group === t.group) last.tiles.push(t);
			else out.push({ group: t.group, tiles: [t] });
		}
		return out;
	}

	function startEdit(t: Tile) {
		if (openId === t.id) {
			openId = null;
			return;
		}
		edit[t.id] = {
			name: t.name,
			img: t.img,
			required: t.required,
			faq: t.faq,
			prePic: t.prePic,
			postRequired: t.postRequired,
			autoClear: t.autoClear
		};
		openId = t.id;
		errorMsg = null;
	}
</script>

<svelte:head>
	<title>Edit board tiles · {data.event.name} · Admin</title>
</svelte:head>

<section>
	<nav class="crumbs">
		<a href="/admin/events">← Events</a>
		<a href="/admin/duo/{data.event.slug}/review">Review submissions →</a>
		<a href="/events/{data.event.slug}/board" target="_blank" rel="noopener">Open board ↗</a>
	</nav>

	<h1>Edit board tiles</h1>
	<p class="muted">
		{data.event.name} · {data.tiles.length} tiles · <strong>{editedCount}</strong> customised
	</p>

	<div class="note">
		Edits save to the database and apply on the live board within ~10 seconds — no deploy needed.
		Tiles you don't touch keep their built-in defaults. The <strong>FAQ</strong> supports markdown;
		to highlight a pre-pic requirement use
		<code>&lt;strong class='prepic'&gt;…&lt;/strong&gt;</code>. Changing a tile's
		<strong>Required</strong> count mid-event re-evaluates every team's progress for that tile, so
		take care once the climb is live. <strong>Images</strong> are loaded without a referrer, so
		most hosts (OSRS wiki, Fandom/wikia, imgur) embed fine — if one still shows blank, that host
		blocks hotlinking; re-host the image elsewhere.
	</div>

	{#if errorMsg}<div class="error">{errorMsg}</div>{/if}

	<input class="search" type="search" placeholder="Search tiles by name, label or id…" bind:value={search} />

	{#each floors as f (f)}
		{@const floorGroups = groupsForFloor(f)}
		{#if floorGroups.length > 0}
			<details class="floor" open={f === floors[0]}>
				<summary><strong>Floor {f}</strong></summary>

				{#each floorGroups as grp (grp.group)}
					<h3 class="group">{grp.group}</h3>
					<ul class="tiles">
						{#each grp.tiles as t (t.id)}
							<li class="tile" class:open={openId === t.id}>
								<button type="button" class="tile-head" onclick={() => startEdit(t)}>
									{#if t.img}
										<img class="thumb" src={t.img} alt="" loading="lazy" referrerpolicy="no-referrer" />
									{:else}
										<span class="thumb empty">?</span>
									{/if}
									<span class="tile-info">
										<span class="tile-label">{t.label}</span>
										<span class="tile-name">{t.name || '(no name)'}</span>
									</span>
									<span class="tile-tags">
										{#if t.required > 1}<span class="tag req">×{t.required}</span>{/if}
										{#if t.prePic}<span class="tag pre">pre-pic</span>{/if}
										{#if t.overridden}<span class="tag edited">edited</span>{/if}
										{#if savedFlash[t.id]}<span class="tag saved">saved ✓</span>{/if}
									</span>
									<span class="chev" aria-hidden="true">{openId === t.id ? '▾' : '▸'}</span>
								</button>

								{#if openId === t.id && edit[t.id]}
									<div class="editor">
										<form
											method="POST"
											action="?/saveTile"
											use:enhance={() => {
												return async ({ result, update }) => {
													await update({ reset: false });
													if (result.type === 'success') {
														savedFlash[t.id] = true;
														setTimeout(() => (savedFlash[t.id] = false), 2500);
													} else if (result.type === 'failure') {
														errorMsg = (result.data as { error?: string } | undefined)?.error ?? 'Save failed';
													} else if (result.type === 'error') {
														errorMsg = result.error?.message ?? 'Something went wrong';
													}
												};
											}}
										>
											<input type="hidden" name="node_id" value={t.id} />
											<label>
												<span>Name</span>
												<input name="name" type="text" bind:value={edit[t.id].name} required />
											</label>
											<label>
												<span>Image URL</span>
												<input name="img" type="url" bind:value={edit[t.id].img} placeholder="https://oldschool.runescape.wiki/…" />
											</label>
											{#if edit[t.id].img}
												<img class="preview" src={edit[t.id].img} alt="Tile preview" referrerpolicy="no-referrer" />
											{/if}
											<label class="narrow">
												<span>{t.kind === 'boss' ? 'Boss HP (required hits)' : 'Required count'}</span>
												<input name="required" type="number" min="1" bind:value={edit[t.id].required} />
											</label>
											<label>
												<span>FAQ / how to complete (markdown)</span>
												<textarea name="faq" rows="5" bind:value={edit[t.id].faq}></textarea>
											</label>
											<label class="check">
												<input type="checkbox" name="pre_pic" bind:checked={edit[t.id].prePic} />
												<span>Needs a pre-pic — shows the two-box (Pre-pic / Post-pic) submit</span>
											</label>
											{#if edit[t.id].prePic}
												<label class="check sub">
													<input type="checkbox" name="post_required" bind:checked={edit[t.id].postRequired} />
													<span>Post-pic required too (else the post box is optional)</span>
												</label>
											{/if}
											{#if t.kind === 'boss'}
												<label>
													<span>Auto-clear label (boss only — blank for none)</span>
													<input name="auto_clear" type="text" bind:value={edit[t.id].autoClear} placeholder="e.g. Mutagen or Pet" />
												</label>
											{/if}
											<div class="form-actions">
												<button type="submit" class="primary">Save tile</button>
												{#if savedFlash[t.id]}<span class="saved-text">Saved ✓</span>{/if}
											</div>
										</form>

										{#if t.overridden}
											<form
												method="POST"
												action="?/resetTile"
												class="reset-form"
												use:enhance={() => {
													return async ({ result, update }) => {
														await update({ reset: false });
														if (result.type === 'success') {
															openId = null;
														} else if (result.type === 'failure') {
															errorMsg = (result.data as { error?: string } | undefined)?.error ?? 'Reset failed';
														}
													};
												}}
											>
												<input type="hidden" name="node_id" value={t.id} />
												<button type="submit" class="reset">↩ Reset to default</button>
											</form>
										{/if}
									</div>
								{/if}
							</li>
						{/each}
					</ul>
				{/each}
			</details>
		{/if}
	{/each}
</section>

<style>
	section {
		max-width: 880px;
		margin: 0 auto;
	}

	.crumbs {
		display: flex;
		flex-wrap: wrap;
		gap: 0.4rem 1.25rem;
		margin-bottom: 0.75rem;
	}

	.crumbs a {
		color: var(--muted);
		font-size: 0.9rem;
		text-decoration: none;
	}

	.crumbs a:hover {
		color: var(--accent);
	}

	h1 {
		margin: 0 0 0.25rem;
		color: var(--accent);
		text-shadow: var(--ts);
	}

	.muted {
		color: var(--muted);
	}

	.note {
		margin: 1rem 0;
		padding: 0.75rem 0.9rem;
		font-size: 0.85rem;
		line-height: 1.5;
		background: var(--accent-soft);
		border: 1px solid var(--border-strong);
		border-radius: var(--radius);
		color: var(--text);
	}

	.note code {
		background: var(--surface);
		border: 1px solid var(--border);
		padding: 0.05rem 0.35rem;
		border-radius: 3px;
		font-size: 0.85em;
	}

	.error {
		margin: 1rem 0;
		padding: 0.6rem 0.8rem;
		background: var(--danger-bg);
		border: 1px solid var(--danger);
		color: var(--danger);
		border-radius: var(--radius);
	}

	.search {
		width: 100%;
		margin: 0.5rem 0 1rem;
	}

	.floor {
		margin-bottom: 0.85rem;
		background: linear-gradient(180deg, rgba(58, 48, 36, 0.55), rgba(40, 32, 24, 0.55));
		border: 1px solid var(--border);
		border-radius: var(--radius);
		padding: 0.5rem 0.85rem 0.85rem;
	}

	.floor > summary {
		cursor: pointer;
		padding: 0.4rem 0;
		font-size: 1.05rem;
		color: var(--accent);
	}

	.group {
		margin: 0.85rem 0 0.4rem;
		font-size: 0.78rem;
		text-transform: uppercase;
		letter-spacing: 0.08em;
		color: var(--muted);
		border-bottom: 1px solid var(--border);
		padding-bottom: 0.25rem;
	}

	.tiles {
		list-style: none;
		margin: 0;
		padding: 0;
		display: flex;
		flex-direction: column;
		gap: 0.4rem;
	}

	.tile {
		background: var(--surface-alt);
		border: 1px solid var(--border);
		border-radius: var(--radius);
		overflow: hidden;
	}

	.tile.open {
		border-color: var(--accent);
	}

	.tile-head {
		display: flex;
		align-items: center;
		gap: 0.7rem;
		width: 100%;
		padding: 0.5rem 0.7rem;
		background: transparent;
		border: 0;
		min-height: 0;
		text-align: left;
		cursor: pointer;
		color: var(--text);
	}

	.tile-head:hover {
		background: rgba(255, 152, 31, 0.06);
	}

	.thumb {
		width: 2.4rem;
		height: 2.4rem;
		object-fit: contain;
		flex-shrink: 0;
		background: #000;
		border: 1px solid var(--border);
		border-radius: 4px;
	}

	.thumb.empty {
		display: flex;
		align-items: center;
		justify-content: center;
		color: var(--muted);
		font-family: var(--font-heading);
	}

	.tile-info {
		display: flex;
		flex-direction: column;
		gap: 0.1rem;
		min-width: 0;
		flex: 1 1 auto;
	}

	.tile-label {
		font-size: 0.72rem;
		color: var(--muted);
	}

	.tile-name {
		font-size: 0.95rem;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.tile-tags {
		display: flex;
		align-items: center;
		gap: 0.3rem;
		flex-shrink: 0;
	}

	.tag {
		font-size: 0.62rem;
		text-transform: uppercase;
		letter-spacing: 0.04em;
		padding: 0.05rem 0.4rem;
		border-radius: 999px;
		border: 1px solid var(--border-strong);
		color: var(--muted);
	}

	.tag.req {
		color: var(--yellow);
		border-color: var(--yellow);
	}

	.tag.pre {
		color: var(--accent);
		border-color: var(--accent);
	}

	.tag.edited {
		color: #1a1208;
		background: var(--accent);
		border-color: var(--accent);
	}

	.tag.saved {
		color: var(--success);
		border-color: var(--success);
	}

	.chev {
		color: var(--muted);
		flex-shrink: 0;
	}

	.editor {
		padding: 0.85rem;
		border-top: 1px solid var(--border);
	}

	.editor form {
		display: flex;
		flex-direction: column;
		gap: 0.7rem;
	}

	.editor label {
		display: flex;
		flex-direction: column;
		gap: 0.25rem;
	}

	.editor label.narrow {
		max-width: 12rem;
	}

	.editor label > span {
		font-size: 0.78rem;
		color: var(--muted);
	}

	.editor label.check {
		flex-direction: row;
		align-items: flex-start;
		gap: 0.5rem;
	}

	.editor label.check span {
		font-size: 0.85rem;
		color: var(--text);
	}

	.editor label.check.sub {
		margin-left: 1.5rem;
	}

	.editor label.check input {
		margin-top: 0.15rem;
		width: 1.05rem;
		height: 1.05rem;
		min-height: 0;
		flex-shrink: 0;
		accent-color: var(--accent);
	}

	.preview {
		max-width: 7rem;
		max-height: 7rem;
		object-fit: contain;
		background: #000;
		border: 1px solid var(--border);
		border-radius: 4px;
		align-self: flex-start;
	}

	.form-actions {
		display: flex;
		align-items: center;
		gap: 0.75rem;
	}

	button.primary {
		border-color: var(--accent);
		align-self: flex-start;
	}

	button.primary:hover {
		background: var(--accent-soft);
	}

	.saved-text {
		color: var(--success);
		font-size: 0.85rem;
	}

	.reset-form {
		margin-top: 0.6rem;
	}

	button.reset {
		font-size: 0.8rem;
		min-height: 0;
		padding: 0.3rem 0.6rem;
		color: var(--danger);
		border-color: var(--danger);
		background: transparent;
	}

	button.reset:hover {
		background: var(--danger-bg);
	}
</style>

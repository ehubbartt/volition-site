<script lang="ts">
	// The fleet key: every ship CLASS on the board, drawn at its real length, with how
	// many of each are still afloat.
	//
	// The roster this replaces listed all 31 ships by name — "Cruiser VII (3)" thirty-one
	// times over. Accurate, and useless for aiming: what a player needs before spending a
	// bomb is the SHAPE they are hunting and, above all, the SHORTEST hull still out
	// there. That one number sets your search spacing — if nothing under 3 long is left,
	// a shot every third square cannot miss all of them, and two thirds of the board stops
	// being worth touching. `hint` below is the whole point of this component.
	//
	// Presentational only. `fleetSummary` is already on every redacted snapshot for BOTH
	// sides (ship sizes and sunk flags are what a real game reveals when you sink
	// something), so nothing here widens what a player can see.

	interface ShipRow {
		id: string;
		name: string;
		len: number;
		sunk: boolean;
	}

	let {
		fleetSummary,
		/** Side colour, for the heading. */
		color = 'var(--accent)',
		label,
		/** Start open. Collapsed by default — this sits under the boards. */
		open = false,
		/** The fleet you're SHOOTING at. The aiming hint only makes sense for that one. */
		enemy = true
	}: {
		fleetSummary: ShipRow[];
		color?: string;
		label: string;
		open?: boolean;
		enemy?: boolean;
	} = $props();

	interface ClassRow {
		len: number;
		name: string;
		total: number;
		afloat: number;
		ships: ShipRow[];
	}

	// Group by hull length, longest first. The class name comes off the ships themselves
	// rather than a second copy of CLASS_BY_LEN, so a rename in rules.ts can't leave this
	// component saying something different from the roster it summarises.
	const classes = $derived.by<ClassRow[]>(() => {
		const by = new Map<number, ClassRow>();
		for (const s of fleetSummary) {
			let row = by.get(s.len);
			if (!row) {
				// "Cruiser VII" → "Cruiser". Ordinals are roman numerals; the first of each
				// class carries none, so the split is on the space before them.
				row = { len: s.len, name: s.name.replace(/ [IVXL]+$/, ''), total: 0, afloat: 0, ships: [] };
				by.set(s.len, row);
			}
			row.total++;
			if (!s.sunk) row.afloat++;
			row.ships.push(s);
		}
		return [...by.values()].sort((a, b) => b.len - a.len);
	});

	const afloat = $derived(fleetSummary.filter((f) => !f.sunk).length);
	const sunk = $derived(fleetSummary.length - afloat);

	/** The shortest hull still afloat — the number that sets your search spacing. */
	const shortest = $derived.by(() => {
		const live = classes.filter((c) => c.afloat > 0);
		return live.length ? live[live.length - 1] : null;
	});
</script>

<details class="fleetkey osrs-inset" {open}>
	<summary>
		<span class="who" style="color: {color}">{label}</span>
		<span class="tally">
			{#if afloat === 0}
				<strong class="dead">fleet destroyed</strong>
			{:else}
				<strong>{afloat}</strong> afloat<span class="muted"> · {sunk} sunk</span>
			{/if}
		</span>
	</summary>

	<div class="body">
		{#if shortest && enemy}
			<p class="hint">
				Shortest hull still afloat: <strong>{shortest.name}</strong>, {shortest.len} squares
				long. A shot every <strong>{shortest.len}</strong>{shortest.len === 2
					? 'nd'
					: shortest.len === 3
						? 'rd'
						: 'th'} square can't miss all of them — anything finer is wasted on water.
			</p>
		{/if}

		<ul class="classes">
			{#each classes as c (c.len)}
				<li class:gone={c.afloat === 0}>
					<span class="hull" aria-hidden="true">
						{#each { length: c.len } as _, i (i)}<span class="seg"></span>{/each}
					</span>
					<span class="label"><span class="name">{c.name}</span><span class="len muted">{c.len} long</span></span>
					<!-- Count and pips travel together: on a narrow row they wrap as one unit
					     rather than the tally stranding itself on a line of its own. -->
					<span class="right">
						<span class="count">
							{#if c.afloat === 0}
								<span class="dead">all {c.total} sunk</span>
							{:else}
								<strong>{c.afloat}</strong><span class="muted">/{c.total} afloat</span>
							{/if}
						</span>
						<span class="pips" title={c.ships.map((s) => `${s.name}${s.sunk ? ' — sunk' : ''}`).join('\n')}>
							{#each c.ships as s (s.id)}
								<span class="pip" class:sunk={s.sunk}>{s.sunk ? '✗' : '▪'}</span>
							{/each}
						</span>
					</span>
				</li>
			{/each}
		</ul>
	</div>
</details>

<style>
	.fleetkey {
		padding: 0;
	}

	summary {
		display: flex;
		align-items: baseline;
		justify-content: space-between;
		gap: 0.75rem;
		padding: 0.5rem 0.65rem;
		cursor: pointer;
		list-style: none;
		user-select: none;
	}
	summary::-webkit-details-marker {
		display: none;
	}
	/* The disclosure caret, so the row reads as expandable without a marker glyph. */
	summary::before {
		content: '▸';
		color: var(--muted);
		font-size: 0.8em;
		transition: transform 0.12s ease;
	}
	.fleetkey[open] summary::before {
		transform: rotate(90deg);
	}
	summary:hover .who {
		text-shadow: var(--ts-strong);
	}
	.who {
		font-family: var(--font-heading);
		text-shadow: var(--ts);
		margin-right: auto;
	}
	.tally {
		font-size: 0.85rem;
	}

	.body {
		border-top: 1px solid var(--border);
		padding: 0.55rem 0.65rem 0.65rem;
	}

	.hint {
		margin: 0 0 0.55rem;
		font-size: 0.8rem;
		color: var(--muted);
		line-height: 1.45;
	}
	.hint strong {
		color: var(--accent);
	}

	.classes {
		list-style: none;
		margin: 0;
		padding: 0;
		display: grid;
		gap: 0.3rem;
	}
	/* Grid, not flex: the hull column is fixed at the longest ship's width so every shape
	   starts on the same line and you can read the length difference down the column.
	   It also stops a long class name wrapping the tally onto a line of its own. */
	.classes li {
		display: grid;
		grid-template-columns: 64px minmax(0, 1fr) auto;
		align-items: center;
		gap: 0.5rem;
		font-size: 0.85rem;
	}
	.classes li.gone {
		opacity: 0.45;
	}

	/* The shape itself — one segment per square, at the hull's real length. */
	.hull {
		display: inline-flex;
		gap: 1px;
		flex: none;
	}
	.seg {
		width: 11px;
		height: 11px;
		background: var(--border-strong);
		border: 1px solid var(--bg);
		border-radius: 1px;
	}
	.gone .seg {
		background: transparent;
		border-style: dashed;
		border-color: var(--muted-soft);
	}

	.name {
		font-family: var(--font-heading);
		text-shadow: var(--ts);
	}
	.len {
		font-size: 0.78rem;
		margin-left: 0.35rem;
	}
	.right {
		display: inline-flex;
		align-items: center;
		justify-content: flex-end;
		gap: 0.5rem;
	}
	.count {
		white-space: nowrap;
	}
	.dead {
		color: var(--danger);
	}

	/* One pip per hull: which individual ships of this class are gone. */
	.pips {
		display: inline-flex;
		gap: 2px;
		flex-wrap: wrap;
		flex: none;
		max-width: 100%;
	}
	.pip {
		color: var(--success);
		font-size: 0.72rem;
		line-height: 1;
	}
	.pip.sunk {
		color: var(--danger);
	}

	/* Narrow: the tally drops under the hull rather than squeezing the pips to nothing. */
	@media (max-width: 560px) {
		.classes li {
			grid-template-columns: 64px minmax(0, 1fr);
		}
		.right {
			grid-column: 1 / -1;
			justify-content: space-between;
		}
	}
</style>

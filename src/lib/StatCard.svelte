<script lang="ts">
	// A single "big number + small label" stat tile. The root `.stat` class picks up
	// the global OSRS sprite-frame (app.css `.page :is(.stat)`), so this matches every
	// other framed panel. Lay several out with the `.stat-grid` utility in app.css.
	let {
		value,
		label,
		accent,
		title
	}: {
		value: string | number;
		label: string;
		/** Override the value colour (defaults to the yellow numeric highlight). */
		accent?: string;
		title?: string;
	} = $props();
</script>

<div class="stat" {title}>
	<span class="value" style={accent ? `color:${accent}` : undefined}>{value}</span>
	<span class="label">{label}</span>
</div>

<style>
	.stat {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 0.15rem;
		padding: 0.9rem 0.5rem;
		text-align: center;
	}
	.value {
		font-family: var(--font-heading);
		font-size: 1.7rem;
		color: var(--yellow);
		text-shadow: var(--ts);
		line-height: 1.1;
	}
	.label {
		font-size: 0.8rem;
		color: var(--muted);
	}
</style>

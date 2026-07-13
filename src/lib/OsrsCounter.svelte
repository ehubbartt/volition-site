<script lang="ts">
	import { formatGP, osrsTier } from '$lib/gp';

	// Engraved stone value readout (the `.osrs-counter` block in app.css) for the
	// headline VP / wallet / GP numbers. Always applies the OSRS quantity colour
	// scale (yellow <100k, white <10M, green 10M+) so every value display matches.
	let {
		value,
		label,
		title,
		format = 'number'
	}: {
		value: number;
		label: string;
		title?: string;
		/** 'number' → toLocaleString(); 'gp' → compact formatGP() (1.4B etc.). */
		format?: 'number' | 'gp';
	} = $props();

	let text = $derived(format === 'gp' ? formatGP(value) : value.toLocaleString());
</script>

<div class="osrs-counter" {title}>
	<span class="amount {osrsTier(value)}">{text}</span>
	<span class="label">{label}</span>
</div>

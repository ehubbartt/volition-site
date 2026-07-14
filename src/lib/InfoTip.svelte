<script lang="ts">
	// ⓘ with an instant CSS tooltip (native title needs a long motionless hover and is
	// dead on touch). A <button> so keyboard focus and mobile tap both open it; inside a
	// <label> it doesn't toggle the control (labels skip interactive click targets).
	let { tip, label = 'More info' }: { tip: string; label?: string } = $props();
</script>

<button type="button" class="info-tip" aria-label={label} data-tip={tip}>ⓘ</button>

<style>
	.info-tip {
		position: relative;
		margin-left: 0.25rem;
		color: var(--muted);
		cursor: help;
		font-size: 0.85em;
		/* resets for the global bronze button styling */
		background: none;
		border: none;
		border-image: none;
		min-height: 0;
		padding: 0 0.15rem;
		line-height: 1;
	}
	.info-tip:hover,
	.info-tip:focus {
		color: var(--accent);
	}
	.info-tip::after {
		content: attr(data-tip);
		position: absolute;
		left: 0;
		bottom: calc(100% + 0.5rem);
		width: min(320px, 78vw);
		padding: 0.55rem 0.7rem;
		background: #2a2418;
		border: 1px solid var(--border);
		border-radius: 6px;
		box-shadow: 0 4px 14px rgba(0, 0, 0, 0.55);
		color: var(--text);
		font-size: 0.78rem;
		line-height: 1.45;
		text-align: left;
		white-space: normal;
		opacity: 0;
		pointer-events: none;
		transition: opacity 0.12s ease;
		z-index: 30;
	}
	.info-tip:hover::after,
	.info-tip:focus::after {
		opacity: 1;
	}
</style>

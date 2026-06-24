<script lang="ts">
	// Squared submission-status chip (pending / approved / rejected) shared by the
	// event/task/submission cards, which previously each re-declared identical CSS
	// and re-derived the label. Pass a custom `label` to override the default text.
	let {
		status,
		label
	}: {
		status: 'pending' | 'approved' | 'rejected';
		label?: string;
	} = $props();

	const DEFAULT_LABEL = {
		pending: 'Pending',
		approved: 'Approved',
		rejected: 'Rejected'
	} as const;
</script>

<span class="status-pill status-{status}">{label ?? DEFAULT_LABEL[status]}</span>

<style>
	.status-pill {
		display: inline-block;
		padding: 0.05rem 0.45rem;
		font-family: var(--font-heading);
		font-size: 0.68rem;
		letter-spacing: 1px;
		text-transform: uppercase;
		border-radius: 3px;
		border: 1px solid transparent;
		text-shadow: none;
	}
	.status-pending {
		background: rgba(255, 152, 31, 0.18);
		border-color: var(--accent);
		color: var(--accent);
	}
	.status-approved {
		background: rgba(127, 209, 138, 0.12);
		border-color: #7fd18a;
		color: #7fd18a;
	}
	.status-rejected {
		background: rgba(255, 0, 0, 0.12);
		border-color: var(--danger);
		color: var(--danger);
	}
</style>

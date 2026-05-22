<script lang="ts">
	import type { BingoTile } from './tiles';
	import { TIER_BY_KEY } from './tiles';
	import type { TileStatus } from './state';

	type MyStatus = 'approved' | 'pending' | 'rejected' | null;

	interface Props {
		tile: BingoTile;
		status: TileStatus;
		myStatus: MyStatus;
		onclick?: () => void;
	}

	let { tile, status, myStatus, onclick }: Props = $props();

	const tier = $derived(TIER_BY_KEY[tile.tier]);
</script>

<button
	type="button"
	class="cell {tile.tier} {status}"
	class:my-approved={myStatus === 'approved'}
	class:my-pending={myStatus === 'pending'}
	class:my-rejected={myStatus === 'rejected'}
	disabled={status === 'blurred'}
	aria-label={status === 'blurred' ? 'Locked future tile' : `${tile.name} (${tile.points} pts)`}
	onclick={() => {
		if (status !== 'blurred') onclick?.();
	}}
>
	<div class="dot" style="background: {tier.color}"></div>
	<span class="name">{tile.name}</span>
	<div class="meta">
		<span class="points">{tile.points} pt{tile.points === 1 ? '' : 's'}</span>
	</div>
	{#if myStatus === 'approved'}
		<span class="status-icon approved" aria-label="You completed this">✓</span>
	{:else if myStatus === 'pending'}
		<span class="status-icon pending" aria-label="Pending review">⋯</span>
	{:else if myStatus === 'rejected'}
		<span class="status-icon rejected" aria-label="Submission rejected — resubmit">✗</span>
	{/if}
	{#if status === 'past-locked' && !myStatus}
		<span class="lock" aria-label="Locked">🔒</span>
	{/if}
</button>

<style>
	.cell {
		position: relative;
		display: flex;
		flex-direction: column;
		justify-content: space-between;
		gap: 0.35rem;
		min-height: 4.5rem;
		padding: 0.55rem 0.6rem;
		text-align: left;
		background: linear-gradient(180deg, rgba(58, 48, 36, 0.85), rgba(40, 32, 24, 0.85));
		border: 1px solid var(--border);
		border-radius: var(--radius);
		font-family: var(--font-body);
		color: var(--text);
		text-shadow: var(--ts);
		cursor: pointer;
		transition:
			transform 0.12s,
			border-color 0.12s,
			box-shadow 0.12s,
			opacity 0.12s;
	}

	.cell:disabled {
		cursor: default;
	}

	.cell.open:hover {
		transform: translateY(-2px);
		border-color: var(--accent);
		box-shadow: 0 4px 12px rgba(0, 0, 0, 0.4), 0 0 0 1px rgba(255, 152, 31, 0.2);
	}

	.cell.past-locked {
		opacity: 0.55;
		filter: saturate(0.5);
	}

	.cell.blurred {
		filter: blur(6px) saturate(0.5);
		pointer-events: none;
	}

	.cell.my-approved {
		border-color: var(--success);
		box-shadow: inset 0 0 0 1px rgba(13, 193, 13, 0.4);
	}

	.cell.my-pending {
		border-color: var(--accent);
		box-shadow: inset 0 0 0 1px rgba(255, 152, 31, 0.4);
	}

	.cell.my-rejected {
		border-color: var(--danger);
		box-shadow: inset 0 0 0 1px rgba(255, 0, 0, 0.45);
	}

	.cell.my-rejected:not(:disabled) {
		animation: rejectedPulse 2.4s ease-in-out infinite;
	}

	@keyframes rejectedPulse {
		0%,
		100% {
			box-shadow: inset 0 0 0 1px rgba(255, 0, 0, 0.35);
		}
		50% {
			box-shadow: inset 0 0 0 1px rgba(255, 0, 0, 0.7);
		}
	}

	@media (prefers-reduced-motion: reduce) {
		.cell.my-rejected:not(:disabled) {
			animation: none;
		}
	}

	.dot {
		width: 14px;
		height: 14px;
		border-radius: 3px;
		flex-shrink: 0;
		box-shadow: 0 0 0 1px rgba(0, 0, 0, 0.5);
	}

	.name {
		font-size: 0.85rem;
		line-height: 1.2;
		overflow: hidden;
		display: -webkit-box;
		-webkit-line-clamp: 3;
		line-clamp: 3;
		-webkit-box-orient: vertical;
		word-break: break-word;
	}

	.meta {
		display: flex;
		justify-content: space-between;
		align-items: center;
		font-size: 0.72rem;
		color: var(--muted);
	}

	.points {
		font-family: var(--font-heading);
		color: var(--accent);
	}

	.status-icon {
		position: absolute;
		top: 4px;
		right: 6px;
		font-family: var(--font-heading);
		font-size: 1.1rem;
		text-shadow: 1px 1px #000;
		line-height: 1;
	}

	.status-icon.approved {
		color: var(--success);
	}

	.status-icon.pending {
		color: var(--accent);
		font-size: 1.3rem;
		top: 0px;
	}

	.status-icon.rejected {
		color: var(--danger);
	}

	.lock {
		position: absolute;
		top: 4px;
		right: 6px;
		font-size: 0.9rem;
		opacity: 0.7;
	}

	@media (max-width: 720px) {
		.cell {
			gap: 0.2rem;
			min-height: 3.2rem;
			padding: 0.32rem 0.38rem;
		}
		.dot {
			width: 10px;
			height: 10px;
		}
		.name {
			font-size: 0.72rem;
			-webkit-line-clamp: 2;
			line-clamp: 2;
		}
		.meta {
			font-size: 0.62rem;
		}
		.status-icon {
			font-size: 0.85rem;
			top: 2px;
			right: 4px;
		}
		.status-icon.pending {
			font-size: 1rem;
			top: 0;
		}
		.lock {
			font-size: 0.7rem;
			top: 2px;
			right: 4px;
		}
	}

	@media (max-width: 480px) {
		.cell {
			min-height: 2.6rem;
			padding: 0.25rem 0.3rem;
			border-radius: 3px;
		}
		.name {
			font-size: 0.62rem;
			line-height: 1.15;
		}
		.meta {
			font-size: 0.56rem;
		}
		.points {
			font-size: 0.6rem;
		}
		.dot {
			width: 8px;
			height: 8px;
		}
	}
</style>

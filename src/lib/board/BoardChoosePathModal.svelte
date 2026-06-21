<script lang="ts">
	import { enhance } from '$app/forms';

	interface LaneTile {
		id: string;
		name: string;
		img: string | null;
		required: number;
	}
	interface Lane {
		lane: number;
		tiles: LaneTile[];
	}

	interface Props {
		floor: number;
		section: string;
		lanes: Lane[];
		onclose: () => void;
	}

	let { floor, section, lanes, onclose }: Props = $props();

	let choosing = $state(false);
	let error = $state<string | null>(null);

	function onKey(e: KeyboardEvent) {
		if (e.key === 'Escape') onclose();
	}
	function backdropClick(e: MouseEvent) {
		if (e.target === e.currentTarget) onclose();
	}
</script>

<svelte:window onkeydown={onKey} />

<!-- svelte-ignore a11y_click_events_have_key_events -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="backdrop" onclick={backdropClick}>
	<div class="modal" role="dialog" aria-labelledby="choose-title" aria-modal="true">
		<button type="button" class="close" aria-label="Close" onclick={onclose}>×</button>

		<header class="head">
			<h2 id="choose-title">Choose your path</h2>
			<p class="sub">Floor {floor} · Section {section} — pick one of these {lanes.length} paths. This locks your route for this section.</p>
		</header>

		{#if error}<p class="error">{error}</p>{/if}

		<div class="lanes" style="--cols: {lanes.length}">
			{#each lanes as ln (ln.lane)}
				<div class="lane">
					<ul class="tiles">
						{#each ln.tiles as t (t.id)}
							<li>
								{#if t.img}
									<img src={t.img} alt={t.name} loading="lazy" referrerpolicy="no-referrer" />
								{/if}
								<span class="t-name">{t.name}</span>
								{#if t.required > 1}
									<span class="req">{t.required}×</span>
								{/if}
							</li>
						{/each}
					</ul>
					<form
						method="POST"
						action="?/choosePath"
						use:enhance={() => {
							choosing = true;
							return async ({ result, update }) => {
								choosing = false;
								if (result.type === 'success') {
									await update();
									onclose();
								} else if (result.type === 'failure') {
									const d = result.data as { error?: string } | undefined;
									error = d?.error ?? 'Could not choose path';
								} else if (result.type === 'error') {
									error = result.error?.message ?? 'Something went wrong';
								}
							};
						}}
					>
						<input type="hidden" name="floor" value={floor} />
						<input type="hidden" name="section" value={section} />
						<input type="hidden" name="lane" value={ln.lane} />
						<button type="submit" class="primary" disabled={choosing}>
							{choosing ? 'Choosing…' : 'Choose this path'}
						</button>
					</form>
				</div>
			{/each}
		</div>
	</div>
</div>

<style>
	.backdrop {
		position: fixed;
		inset: 0;
		background: rgba(0, 0, 0, 0.72);
		z-index: 100;
		display: flex;
		align-items: center;
		justify-content: center;
		padding: 2rem 1rem;
		overflow-y: auto;
	}

	/* Keep the modal vertically centered, but if it's taller than the viewport let it
	   scroll from the top instead of clipping (margin auto + flex centering). */
	.modal {
		margin: auto;
	}

	.modal {
		position: relative;
		width: 100%;
		max-width: 46rem;
		padding: 1.5rem;
		background: linear-gradient(180deg, rgba(58, 48, 36, 0.97), rgba(40, 32, 24, 0.97));
		border: 1px solid var(--border);
		border-radius: var(--radius);
		box-shadow: var(--shadow-card);
		color: var(--text);
		font-family: var(--font-body);
	}

	.close {
		position: absolute;
		top: 6px;
		right: 8px;
		width: 32px;
		height: 32px;
		min-height: 0;
		padding: 0;
		font-family: var(--font-heading);
		font-size: 1.4rem;
		background: transparent;
		border-color: transparent;
		color: var(--muted);
	}
	.close:hover {
		color: var(--accent);
		background: transparent;
	}

	.head {
		margin-bottom: 1rem;
		padding-right: 2rem;
	}
	.head h2 {
		margin: 0 0 0.25rem;
		font-size: 1.3rem;
	}
	.sub {
		margin: 0;
		color: var(--muted);
		font-size: 0.9rem;
	}

	.lanes {
		display: grid;
		grid-template-columns: repeat(var(--cols), 1fr);
		gap: 0.75rem;
	}

	@media (max-width: 640px) {
		.lanes {
			grid-template-columns: 1fr;
		}
	}

	.lane {
		display: flex;
		flex-direction: column;
		gap: 0.6rem;
		padding: 0.75rem;
		background: var(--surface-alt);
		border: 1px solid var(--border);
		border-radius: var(--radius);
	}

	.tiles {
		list-style: none;
		margin: 0;
		padding: 0;
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
		flex: 1;
	}

	.tiles li {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		font-size: 0.85rem;
	}

	.tiles img {
		width: 2rem;
		height: 2rem;
		object-fit: contain;
		flex-shrink: 0;
		filter: drop-shadow(0 1px 1px rgba(0, 0, 0, 0.7));
	}

	.t-name {
		flex: 1;
		line-height: 1.2;
	}

	.req {
		font-family: var(--font-heading);
		color: var(--yellow);
		font-size: 0.8rem;
		flex-shrink: 0;
	}

	form {
		margin: 0;
	}

	button.primary {
		width: 100%;
		border-color: var(--accent);
	}
	button.primary:hover:not(:disabled) {
		background: var(--accent-soft);
	}

	.error {
		margin: 0 0 0.75rem;
		padding: 0.5rem 0.7rem;
		background: var(--danger-bg);
		border: 1px solid var(--danger);
		color: var(--danger);
		border-radius: 3px;
		font-size: 0.85rem;
	}
</style>

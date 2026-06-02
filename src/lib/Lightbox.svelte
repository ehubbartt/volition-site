<script lang="ts">
	interface Props {
		src: string;
		alt?: string;
		onclose: () => void;
	}

	let { src, alt = 'Image', onclose }: Props = $props();

	const MIN_ZOOM = 0.5;
	const MAX_ZOOM = 6;
	const STEP = 0.25;

	let zoom = $state(1);
	let panX = $state(0);
	let panY = $state(0);
	let isPanning = $state(false);
	let dragStartX = 0;
	let dragStartY = 0;

	function clampZoom(z: number) {
		return Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, +z.toFixed(2)));
	}

	function recenterIfMinimal() {
		if (zoom <= 1) {
			panX = 0;
			panY = 0;
		}
	}

	function zoomIn() {
		zoom = clampZoom(zoom + STEP);
	}

	function zoomOut() {
		zoom = clampZoom(zoom - STEP);
		recenterIfMinimal();
	}

	function reset() {
		zoom = 1;
		panX = 0;
		panY = 0;
	}

	function onWheel(e: WheelEvent) {
		e.preventDefault();
		zoom = clampZoom(zoom + (e.deltaY > 0 ? -STEP : STEP));
		recenterIfMinimal();
	}

	function onMouseDown(e: MouseEvent) {
		if (e.button !== 0 || zoom <= 1) return;
		isPanning = true;
		dragStartX = e.clientX - panX;
		dragStartY = e.clientY - panY;
	}

	function onMouseMove(e: MouseEvent) {
		if (!isPanning) return;
		e.preventDefault();
		panX = e.clientX - dragStartX;
		panY = e.clientY - dragStartY;
	}

	function onMouseUp() {
		isPanning = false;
	}

	function onTouchStart(e: TouchEvent) {
		if (zoom <= 1 || e.touches.length !== 1) return;
		isPanning = true;
		dragStartX = e.touches[0].clientX - panX;
		dragStartY = e.touches[0].clientY - panY;
	}

	function onTouchMove(e: TouchEvent) {
		if (!isPanning || e.touches.length !== 1) return;
		e.preventDefault();
		panX = e.touches[0].clientX - dragStartX;
		panY = e.touches[0].clientY - dragStartY;
	}

	function onTouchEnd() {
		isPanning = false;
	}

	function onImageDoubleClick(e: MouseEvent) {
		e.preventDefault();
		zoom = zoom > 1 ? 1 : 2;
		recenterIfMinimal();
	}

	function backdropClick(e: MouseEvent) {
		if (e.target === e.currentTarget) onclose();
	}

	// Capture-phase Esc so this beats any bubble-phase keydown listeners on
	// parent modals (e.g. SubmitModal also listens for Escape).
	$effect(() => {
		const handler = (e: KeyboardEvent) => {
			if (e.key === 'Escape') {
				e.stopImmediatePropagation();
				onclose();
			}
		};
		document.addEventListener('keydown', handler, { capture: true });
		return () => document.removeEventListener('keydown', handler, { capture: true });
	});
</script>

<!-- svelte-ignore a11y_click_events_have_key_events -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
	class="lightbox"
	class:panning={isPanning}
	role="dialog"
	aria-modal="true"
	aria-label={alt}
	onclick={backdropClick}
	onwheel={onWheel}
	onmousedown={onMouseDown}
	onmousemove={onMouseMove}
	onmouseup={onMouseUp}
	onmouseleave={onMouseUp}
	ontouchstart={onTouchStart}
	ontouchmove={onTouchMove}
	ontouchend={onTouchEnd}
>
	<div class="controls">
		<button type="button" onclick={zoomIn} title="Zoom in" aria-label="Zoom in">+</button>
		<button type="button" onclick={zoomOut} title="Zoom out" aria-label="Zoom out">−</button>
		<button type="button" onclick={reset} title="Reset view" aria-label="Reset view">⟲</button>
		<a
			class="open-tab"
			href={src}
			target="_blank"
			rel="noopener"
			title="Open in new tab"
			aria-label="Open in new tab"
			onclick={(e) => e.stopPropagation()}>↗</a
		>
		<button type="button" class="close" onclick={onclose} title="Close" aria-label="Close">
			×
		</button>
	</div>

	<img
		class:panning={isPanning}
		src={src}
		alt={alt}
		draggable="false"
		ondblclick={onImageDoubleClick}
		style="transform: scale({zoom}) translate({panX / zoom}px, {panY / zoom}px); cursor: {zoom > 1
			? isPanning
				? 'grabbing'
				: 'grab'
			: 'default'};"
	/>
</div>

<style>
	.lightbox {
		position: fixed;
		inset: 0;
		background: rgba(0, 0, 0, 0.92);
		z-index: 200;
		display: flex;
		align-items: center;
		justify-content: center;
		overflow: hidden;
		user-select: none;
		touch-action: none;
	}

	img {
		max-width: 95vw;
		max-height: 95vh;
		object-fit: contain;
		display: block;
		transform-origin: 50% 50%;
		transition: transform 0.08s ease-out;
		-webkit-user-drag: none;
	}

	img.panning {
		transition: none;
	}

	.controls {
		position: absolute;
		top: 12px;
		right: 12px;
		z-index: 1;
		display: flex;
		gap: 6px;
		align-items: center;
	}

	.controls button,
	.controls .open-tab {
		display: inline-flex;
		width: 36px;
		height: 36px;
		min-height: 0;
		padding: 0;
		align-items: center;
		justify-content: center;
		background: rgba(0, 0, 0, 0.65);
		border: 1px solid var(--accent);
		color: var(--accent);
		border-radius: var(--radius);
		font-family: var(--font-heading);
		font-size: 1.15rem;
		text-decoration: none;
		text-shadow: var(--ts);
		cursor: pointer;
	}

	.controls button:hover,
	.controls .open-tab:hover {
		background: var(--accent-soft);
		text-decoration: none;
	}

	.controls button.close {
		font-size: 1.4rem;
	}
</style>

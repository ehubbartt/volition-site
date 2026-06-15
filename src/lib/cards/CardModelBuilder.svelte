<script lang="ts">
	// Interactive 3D builder for a card's .glb model(s): orbit the camera, pick a model
	// from the list, drag the gizmo (move/rotate) or use the sliders (position, rotation,
	// scale), toggle embed-clip / billboard / wander / animation + pick its front axis,
	// then Save. Persists the whole models array to vs_cards.models via the page's
	// `updateModels` action.
	import { onMount } from 'svelte';
	import { enhance } from '$app/forms';
	import { invalidateAll } from '$app/navigation';
	import * as THREE from 'three';
	import type { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
	import type { TransformControls } from 'three/examples/jsm/controls/TransformControls.js';
	import { loadCardModel, type CardModelHandle } from '$lib/cards/cardModel';
	import { DEFAULT_CARD_BACK, toCardModels, type CardModelEntry, type ModelFrontAxis } from '$lib/cards/rarity';

	interface BuilderCard {
		id: string;
		name: string;
		front_url: string | null;
		back_url: string | null;
		model_url?: string | null;
		model_settings?: CardModelEntry['settings'];
		models?: CardModelEntry[];
	}

	let { card, onClose }: { card: BuilderCard; onClose: () => void } = $props();

	type S = {
		scale: number;
		offsetX: number;
		offsetY: number;
		offsetZ: number;
		rotX: number;
		rotY: number;
		rotZ: number;
		spin: number;
		animate: boolean;
		clip: boolean;
		faceCamera: boolean;
		wander: boolean;
		wanderSpeed: number;
		frontAxis: ModelFrontAxis;
	};
	type Entry = { id: string; url: string; path: string | null; settings: S };

	const BASE_Z = 0.08 + 0.15; // hover default with 0 layers
	const FRONT_AXES: ModelFrontAxis[] = ['+x', '-x', '+y', '-y', '+z', '-z'];

	let idc = 0;
	function fillSettings(raw: CardModelEntry['settings']): S {
		const ms = raw ?? {};
		const clip = ms.clip ?? false;
		return {
			scale: ms.scale ?? 1,
			offsetX: ms.offsetX ?? 0,
			offsetY: ms.offsetY ?? 0,
			offsetZ: ms.offsetZ ?? (clip ? 0 : BASE_Z),
			rotX: ms.rotX ?? 0,
			rotY: ms.rotY ?? 0,
			rotZ: ms.rotZ ?? 0,
			spin: ms.spin ?? 0,
			animate: ms.animate ?? true,
			clip,
			faceCamera: ms.faceCamera ?? false,
			wander: ms.wander ?? false,
			wanderSpeed: ms.wanderSpeed ?? 0.5,
			frontAxis: ms.frontAxis ?? '+z'
		};
	}
	function initialEntries(): Entry[] {
		return toCardModels(card).map((m) => ({
			id: `m${idc++}`,
			url: m.url,
			path: m.path ?? null,
			settings: fillSettings(m.settings)
		}));
	}

	let entries = $state<Entry[]>(initialEntries());
	let selected = $state(0);

	let canvas: HTMLCanvasElement;
	let mode = $state<'translate' | 'rotate'>('translate');
	let ready = $state(false);
	let saving = $state(false);
	let error = $state<string | null>(null);

	// Three handles + gizmo bridge kept OUT of $state (never proxy three objects).
	const handles: Record<string, CardModelHandle> = {};
	let attachGizmo: (obj: THREE.Object3D | null) => void = () => {};
	let attachVersion = $state(0); // bumped as handles load / models change, to re-attach

	const round = (n: number) => Math.round(n * 1000) / 1000;
	const rad2deg = (r: number) => (r * 180) / Math.PI;

	const sel = $derived(entries[selected]?.settings ?? null);
	const modelsJson = $derived(
		JSON.stringify(entries.map((e) => ({ path: e.path, url: e.url, settings: e.settings })))
	);

	// Apply the selected model's settings to its handle whenever they change. Snapshot
	// FIRST (unconditionally) so the effect always tracks every settings field — if we
	// read them inside `handles[e.id]?.setSettings(...)`, the optional-chain short-circuits
	// while the handle is still loading and no dependencies get registered (no live update).
	$effect(() => {
		void attachVersion; // also re-apply once handles finish loading
		const e = entries[selected];
		if (!e) return;
		const snap = { ...e.settings };
		handles[e.id]?.setSettings(snap);
	});

	// (Re)attach the gizmo to the selected model (also after async loads / list changes).
	$effect(() => {
		void attachVersion;
		const e = entries[selected];
		attachGizmo(e ? handles[e.id]?.object ?? null : null);
	});

	// Billboard / wander force translate (rotation is automatic); keep the gizmo mode in
	// sync. Read the reactive values first so deps register even before the gizmo loads.
	$effect(() => {
		const m = sel?.faceCamera || sel?.wander ? 'translate' : mode;
		setControlMode?.(m);
	});
	let setControlMode: ((m: 'translate' | 'rotate') => void) | null = null;

	function deleteSelected() {
		const e = entries[selected];
		if (!e) return;
		handles[e.id]?.dispose();
		delete handles[e.id];
		entries.splice(selected, 1);
		if (selected >= entries.length) selected = Math.max(0, entries.length - 1);
		attachVersion++;
	}

	function resetSelected() {
		const e = entries[selected];
		if (!e) return;
		e.settings.scale = 1;
		e.settings.offsetX = 0;
		e.settings.offsetY = 0;
		e.settings.offsetZ = e.settings.clip ? 0 : BASE_Z;
		e.settings.rotX = 0;
		e.settings.rotY = 0;
		e.settings.rotZ = 0;
		e.settings.spin = 0;
	}

	onMount(() => {
		let disposed = false;
		let teardown = () => {};

		(async () => {
			const frontUrl = card.front_url || DEFAULT_CARD_BACK;
			const dims = await new Promise<{ w: number; h: number }>((res) => {
				const img = new Image();
				img.onload = () => res({ w: img.naturalWidth || 5, h: img.naturalHeight || 7 });
				img.onerror = () => res({ w: 5, h: 7 });
				img.src = frontUrl;
			});
			if (disposed) return;

			const CARD_H = 4;
			const CARD_W = CARD_H * (dims.w / dims.h);
			const CARD_D = 0.04;

			const scene = new THREE.Scene();
			scene.background = new THREE.Color(0x14110c);
			const camera = new THREE.PerspectiveCamera(40, 1, 0.1, 100);
			camera.position.set(0, 0, 9);

			const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
			renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
			renderer.localClippingEnabled = true;

			scene.add(new THREE.AmbientLight(0xffffff, 0.9));
			const key = new THREE.DirectionalLight(0xffffff, 1.1);
			key.position.set(3, 5, 6);
			scene.add(key);
			const fill = new THREE.DirectionalLight(0xffffff, 0.5);
			fill.position.set(-4, 2, 4);
			scene.add(fill);

			const group = new THREE.Group();
			scene.add(group);
			const loader = new THREE.TextureLoader();

			const frontMat = new THREE.MeshBasicMaterial({ color: 0x222222 });
			loader.load(frontUrl, (t) => {
				t.colorSpace = THREE.SRGBColorSpace;
				frontMat.map = t;
				frontMat.needsUpdate = true;
			});
			group.add(new THREE.Mesh(new THREE.PlaneGeometry(CARD_W, CARD_H), frontMat));
			const edgeBox = new THREE.Mesh(
				new THREE.BoxGeometry(CARD_W, CARD_H, CARD_D),
				new THREE.MeshBasicMaterial({ color: 0x0c0c0e })
			);
			edgeBox.position.z = -CARD_D / 2 - 0.001;
			group.add(edgeBox);
			const backMat = new THREE.MeshBasicMaterial({ color: 0x111111 });
			loader.load(card.back_url || DEFAULT_CARD_BACK, (t) => {
				t.colorSpace = THREE.SRGBColorSpace;
				backMat.map = t;
				backMat.needsUpdate = true;
			});
			const back = new THREE.Mesh(new THREE.PlaneGeometry(CARD_W, CARD_H), backMat);
			back.rotation.y = Math.PI;
			back.position.z = -(CARD_D + 0.006);
			group.add(back);

			// OrbitControls (lazy).
			let orbit: OrbitControls | null = null;
			try {
				const OC = (await import('three/examples/jsm/controls/OrbitControls.js')).OrbitControls;
				orbit = new OC(camera, renderer.domElement);
				orbit.enableDamping = true;
				orbit.target.set(0, 0, 0);
				orbit.update();
			} catch (e) {
				console.warn('[builder] OrbitControls failed:', e);
			}
			if (disposed) return;

			// Load every model.
			for (const e of entries) {
				loadCardModel(group, e.url, { ...e.settings }, {
					cardW: CARD_W,
					cardH: CARD_H,
					baseZ: BASE_Z,
					camera
				}).then((h) => {
					if (disposed) {
						h.dispose();
						return;
					}
					handles[e.id] = h;
					attachVersion++; // triggers gizmo attach for the selected one
				});
			}
			ready = true;

			// TransformControls (lazy).
			try {
				const TC = (await import('three/examples/jsm/controls/TransformControls.js')).TransformControls;
				const control: TransformControls = new TC(camera, renderer.domElement);
				control.setMode('translate');
				control.setSpace('local');
				control.addEventListener('dragging-changed', (ev) => {
					if (orbit) orbit.enabled = !(ev as unknown as { value: boolean }).value;
				});
				control.addEventListener('objectChange', () => {
					const e = entries[selected];
					const o = e ? handles[e.id]?.object : null;
					if (!e || !o) return;
					if (control.getMode() === 'rotate') {
						e.settings.rotX = round(rad2deg(o.rotation.x));
						e.settings.rotY = round(rad2deg(o.rotation.y));
						e.settings.rotZ = round(rad2deg(o.rotation.z));
					} else {
						e.settings.offsetX = round(o.position.x);
						e.settings.offsetY = round(o.position.y);
						e.settings.offsetZ = round(o.position.z);
					}
				});
				const ctl = control as unknown as { getHelper?: () => THREE.Object3D };
				scene.add(ctl.getHelper ? ctl.getHelper() : (control as unknown as THREE.Object3D));
				setControlMode = (m) => control.setMode(m);
				attachGizmo = (obj) => {
					if (obj) control.attach(obj);
					else control.detach();
				};
				attachVersion++; // attach to the initial selection
				teardown = chain(teardown, () => {
					control.detach();
					control.dispose();
				});
			} catch (e) {
				console.warn('[builder] TransformControls failed:', e);
			}

			function fit() {
				const w = canvas.clientWidth || 1;
				const h = canvas.clientHeight || 1;
				renderer.setSize(w, h, false);
				camera.aspect = w / h;
				camera.updateProjectionMatrix();
			}
			fit();
			const ro = new ResizeObserver(fit);
			ro.observe(canvas);

			let raf = 0;
			let last = performance.now();
			function frame() {
				raf = requestAnimationFrame(frame);
				const now = performance.now();
				const dt = Math.min(0.05, (now - last) / 1000);
				last = now;
				orbit?.update();
				for (const id in handles) handles[id].update(dt, 0);
				renderer.render(scene, camera);
			}
			frame();

			teardown = chain(teardown, () => {
				cancelAnimationFrame(raf);
				ro.disconnect();
				orbit?.dispose();
				for (const id in handles) handles[id].dispose();
				scene.traverse((o) => {
					const m = o as THREE.Mesh;
					m.geometry?.dispose?.();
					const mat = m.material as THREE.Material | THREE.Material[] | undefined;
					if (Array.isArray(mat)) mat.forEach((x) => x.dispose());
					else mat?.dispose?.();
				});
				renderer.dispose();
				try {
					renderer.forceContextLoss();
				} catch {
					/* ignore */
				}
			});
		})();

		return () => {
			disposed = true;
			teardown();
		};
	});

	function chain(a: () => void, b: () => void): () => void {
		return () => {
			b();
			a();
		};
	}
</script>

<div class="builder-backdrop" role="dialog" aria-modal="true" aria-label="3D model builder">
	<div class="builder">
		<header class="b-head">
			<h2>3D models · {card.name}</h2>
			<button type="button" class="close" aria-label="Close" onclick={onClose}>✕</button>
		</header>

		<div class="b-body">
			<div class="b-stage">
				<canvas bind:this={canvas}></canvas>
				{#if !ready}<div class="b-loading">Loading…</div>{/if}
				<div class="b-hint">Drag the gizmo to {mode === 'rotate' ? 'rotate' : 'move'} the selected model · drag empty space to orbit · scroll to zoom</div>
			</div>

			<div class="b-panel">
				{#if entries.length === 0}
					<p class="muted small">No models on this card. Upload a .glb in the card editor, then re-open the builder.</p>
				{:else}
					<div class="model-tabs">
						{#each entries as e, i (e.id)}
							<button type="button" class:active={i === selected} onclick={() => (selected = i)}>
								Model {i + 1}
							</button>
						{/each}
					</div>

					{#if sel}
						<div class="gizmo-modes">
							<button type="button" class:active={mode === 'translate'} onclick={() => (mode = 'translate')}>Move</button>
							<button type="button" class:active={mode === 'rotate'} disabled={sel.faceCamera || sel.wander} onclick={() => (mode = 'rotate')}>Rotate</button>
						</div>

						<fieldset>
							<legend>Size</legend>
							<label class="knob">
								<span>Scale <input type="number" class="num" min="0.05" step="0.05" bind:value={entries[selected].settings.scale} /></span>
								<input type="range" min="0.1" max="5" step="0.05" bind:value={entries[selected].settings.scale} />
							</label>
						</fieldset>

						<fieldset disabled={sel.wander}>
							<legend>Position{#if sel.wander} <span class="muted small">(auto — wandering)</span>{/if}</legend>
							<label class="knob"><span>X <input type="number" class="num" step="0.01" bind:value={entries[selected].settings.offsetX} /></span><input type="range" min="-3" max="3" step="0.01" bind:value={entries[selected].settings.offsetX} /></label>
							<label class="knob"><span>Y <input type="number" class="num" step="0.01" bind:value={entries[selected].settings.offsetY} /></span><input type="range" min="-3" max="3" step="0.01" bind:value={entries[selected].settings.offsetY} /></label>
							<label class="knob"><span>Z (depth) <input type="number" class="num" step="0.01" bind:value={entries[selected].settings.offsetZ} /></span><input type="range" min="-2" max="2" step="0.01" bind:value={entries[selected].settings.offsetZ} /></label>
						</fieldset>

						<fieldset disabled={sel.faceCamera || sel.wander}>
							<legend>Rotation{#if sel.faceCamera} <span class="muted small">(auto — facing camera)</span>{:else if sel.wander} <span class="muted small">(auto — facing travel)</span>{/if}</legend>
							<label class="knob"><span>X° <input type="number" class="num" step="1" bind:value={entries[selected].settings.rotX} /></span><input type="range" min="-180" max="180" step="1" bind:value={entries[selected].settings.rotX} /></label>
							<label class="knob"><span>Y° <input type="number" class="num" step="1" bind:value={entries[selected].settings.rotY} /></span><input type="range" min="-180" max="180" step="1" bind:value={entries[selected].settings.rotY} /></label>
							<label class="knob"><span>Z° <input type="number" class="num" step="1" bind:value={entries[selected].settings.rotZ} /></span><input type="range" min="-180" max="180" step="1" bind:value={entries[selected].settings.rotZ} /></label>
							<label class="knob"><span>Auto-spin <input type="number" class="num" step="0.1" bind:value={entries[selected].settings.spin} /></span><input type="range" min="0" max="6.28" step="0.1" bind:value={entries[selected].settings.spin} /></label>
						</fieldset>

						<fieldset>
							<legend>Behaviour</legend>
							<label class="check"><input type="checkbox" bind:checked={entries[selected].settings.clip} /><span>Embed in card (clip the back)</span></label>
							<label class="check"><input type="checkbox" bind:checked={entries[selected].settings.faceCamera} /><span>Always face camera (eye)</span></label>
							<label class="check"><input type="checkbox" bind:checked={entries[selected].settings.wander} /><span>Wander around the card</span></label>
							{#if sel.wander}
								<label class="knob"><span>Wander speed <input type="number" class="num" step="0.1" bind:value={entries[selected].settings.wanderSpeed} /></span><input type="range" min="0.1" max="3" step="0.1" bind:value={entries[selected].settings.wanderSpeed} /></label>
							{/if}
							<label class="check"><input type="checkbox" bind:checked={entries[selected].settings.animate} /><span>Play embedded animation</span></label>
							<label class="knob">
								<span>Front axis (the model's "nose")</span>
								<select bind:value={entries[selected].settings.frontAxis}>
									{#each FRONT_AXES as ax}<option value={ax}>{ax}</option>{/each}
								</select>
							</label>
							<p class="muted small">Front axis is used by "face camera" + "wander" to know which way the model faces. Try each if it points the wrong way.</p>
						</fieldset>

						<button type="button" class="del" onclick={deleteSelected}>Delete this model</button>
					{/if}
				{/if}

				{#if error}<p class="b-error">{error}</p>{/if}

				<div class="b-actions">
					<button type="button" class="ghost" onclick={resetSelected} disabled={!sel}>Reset</button>
					<form
						method="POST"
						action="?/updateModels"
						use:enhance={() => {
							saving = true;
							error = null;
							return async ({ result }) => {
								saving = false;
								if (result.type === 'success') {
									await invalidateAll();
									onClose();
								} else if (result.type === 'failure') {
									error = (result.data as { error?: string } | undefined)?.error ?? 'Save failed';
								} else if (result.type === 'error') {
									error = 'Something went wrong';
								}
							};
						}}
					>
						<input type="hidden" name="card_id" value={card.id} />
						<input type="hidden" name="models" value={modelsJson} />
						<button type="submit" class="primary" disabled={saving}>{saving ? 'Saving…' : 'Save'}</button>
					</form>
				</div>
			</div>
		</div>
	</div>
</div>

<style>
	.builder-backdrop {
		position: fixed;
		inset: 0;
		z-index: 200;
		background: rgba(0, 0, 0, 0.78);
		display: grid;
		place-items: center;
		padding: 1rem;
	}
	.builder {
		width: min(64rem, 100%);
		max-height: 92vh;
		display: flex;
		flex-direction: column;
		background: linear-gradient(180deg, rgba(48, 40, 30, 0.98), rgba(28, 23, 17, 0.98));
		border: 1px solid var(--border-strong);
		border-radius: var(--radius-lg);
		box-shadow: var(--shadow-card);
		overflow: hidden;
	}
	.b-head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 1rem;
		padding: 0.8rem 1rem;
		border-bottom: 1px solid var(--border);
	}
	.b-head h2 {
		margin: 0;
		font-size: 1.1rem;
		color: var(--accent);
		text-shadow: var(--ts);
	}
	.close {
		min-height: 0;
		padding: 0.2rem 0.55rem;
	}
	.b-body {
		display: grid;
		grid-template-columns: 1fr 18rem;
		min-height: 0;
		flex: 1;
	}
	.b-stage {
		position: relative;
		background: #14110c;
		min-height: 24rem;
	}
	.b-stage canvas {
		display: block;
		width: 100%;
		height: 100%;
		touch-action: none;
	}
	.b-loading {
		position: absolute;
		inset: 0;
		display: grid;
		place-items: center;
		color: var(--muted);
	}
	.b-hint {
		position: absolute;
		left: 0;
		right: 0;
		bottom: 0;
		padding: 0.3rem 0.6rem;
		font-size: 0.72rem;
		color: rgba(255, 255, 255, 0.6);
		background: linear-gradient(180deg, transparent, rgba(0, 0, 0, 0.55));
		text-align: center;
	}
	.b-panel {
		padding: 0.8rem;
		overflow-y: auto;
		border-left: 1px solid var(--border);
		display: flex;
		flex-direction: column;
		gap: 0.7rem;
	}
	.model-tabs {
		display: flex;
		flex-wrap: wrap;
		gap: 0.3rem;
	}
	.model-tabs button {
		min-height: 0;
		padding: 0.25rem 0.55rem;
		font-size: 0.8rem;
		background: var(--surface-alt);
		border: 1px solid var(--border);
		border-radius: 3px;
		color: var(--muted);
	}
	.model-tabs button.active {
		background: var(--accent-soft);
		border-color: var(--accent);
		color: var(--accent);
	}
	.gizmo-modes {
		display: flex;
		gap: 0.4rem;
	}
	.gizmo-modes button {
		flex: 1;
		min-height: 0;
		padding: 0.35rem;
		font-size: 0.85rem;
		background: var(--surface-alt);
		border: 1px solid var(--border);
		border-radius: 3px;
		color: var(--muted);
	}
	.gizmo-modes button.active {
		background: var(--accent-soft);
		border-color: var(--accent);
		color: var(--accent);
	}
	fieldset {
		border: 1px solid var(--border);
		border-radius: var(--radius);
		padding: 0.5rem 0.6rem 0.6rem;
		margin: 0;
	}
	legend {
		font-family: var(--font-heading);
		font-size: 0.72rem;
		letter-spacing: 1px;
		text-transform: uppercase;
		color: var(--muted);
		padding: 0 0.3rem;
	}
	.knob {
		display: block;
		margin-top: 0.35rem;
	}
	.knob span {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 0.4rem;
		font-size: 0.8rem;
		margin-bottom: 0.1rem;
	}
	.knob .num {
		width: 4.5rem;
		min-height: 0;
		padding: 0.1rem 0.3rem;
		font-size: 0.78rem;
		text-align: right;
		color: var(--yellow);
		background: var(--surface);
		border: 1px solid var(--border);
		border-radius: 3px;
	}
	.knob input[type='range'],
	.knob select {
		width: 100%;
	}
	.check {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		font-size: 0.85rem;
		margin-top: 0.3rem;
	}
	.del {
		min-height: 0;
		padding: 0.35rem;
		font-size: 0.82rem;
		background: var(--danger-bg);
		border: 1px solid var(--danger);
		color: var(--danger);
		border-radius: 3px;
	}
	.b-error {
		margin: 0;
		padding: 0.4rem 0.6rem;
		background: var(--danger-bg);
		border: 1px solid var(--danger);
		color: var(--danger);
		border-radius: 3px;
		font-size: 0.82rem;
	}
	.b-actions {
		display: flex;
		gap: 0.5rem;
		margin-top: auto;
	}
	.b-actions form {
		flex: 1;
	}
	.b-actions .primary {
		width: 100%;
		border-color: var(--accent);
	}
	.b-actions .ghost {
		background: var(--surface-alt);
		border: 1px solid var(--border);
		color: var(--muted);
	}
	.muted {
		color: var(--muted);
	}
	.small {
		font-size: 0.78rem;
	}
	@media (max-width: 640px) {
		.b-body {
			grid-template-columns: 1fr;
		}
		.b-panel {
			border-left: 0;
			border-top: 1px solid var(--border);
		}
	}
</style>

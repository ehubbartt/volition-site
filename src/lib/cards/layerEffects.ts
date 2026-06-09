// Client-safe catalog of reusable per-layer animation effects for 3D depth cards.
// A card's depth layers (vs_cards.layers) can each carry an `effect` key; the 3D
// renderers (PackOpener + CardInspector3D) wire each effected layer through
// createLayerEffect() and call the returned handle every frame. Effects are
// defined HERE, once — adding a new one makes it available to every card without
// per-card hard-coding.
//
// All effects are driven by `spin` — how fast the card is currently being turned
// (0 = at rest). So a layer only animates WHILE you spin the card and is static
// otherwise. Idle = no motion.
//
// Intentionally has ZERO three.js imports so it's safe to pull into the admin page
// (which only needs the catalog for its dropdown). The renderers pass their real
// three.js objects (which structurally satisfy the Fx* interfaces) plus a small set
// of primitives the effects need (e.g. makeGlow, which builds a three.js mesh).

export type LayerEffect = 'spin' | 'grow' | 'glow';

export interface LayerEffectMeta {
	key: LayerEffect;
	label: string;
	description: string;
}

// The available effects, in the order they appear in the admin dropdown.
export const LAYER_EFFECTS: LayerEffectMeta[] = [
	{ key: 'spin', label: 'Spin', description: 'Layer rotates while you spin the card.' },
	{ key: 'grow', label: 'Grow / shrink', description: 'Layer swells while you spin the card.' },
	{ key: 'glow', label: 'Glow', description: 'Layer lights up (along its shape) while you spin the card.' }
];

export const LAYER_EFFECT_KEYS: LayerEffect[] = LAYER_EFFECTS.map((e) => e.key);

export function isLayerEffect(value: unknown): value is LayerEffect {
	return typeof value === 'string' && (LAYER_EFFECT_KEYS as string[]).includes(value);
}

export function layerEffectLabel(value: unknown): string {
	return LAYER_EFFECTS.find((e) => e.key === value)?.label ?? 'None';
}

// Minimal structural shapes for the three.js objects an effect mutates. Defined
// locally so this file needs no three.js import; THREE.Mesh / MeshBasicMaterial
// satisfy them structurally when passed in by the renderers.
export interface FxVec3 {
	x: number;
	y: number;
	z: number;
	set(x: number, y: number, z: number): void;
	setScalar(s: number): void;
}
export interface FxEuler {
	x: number;
	y: number;
	z: number;
}
export interface FxMesh {
	rotation: FxEuler;
	scale: FxVec3;
	position: FxVec3;
}

// A component-built additive glow copy of a layer. The renderer supplies it (it
// needs three.js to make the mesh/shader); the glow effect just drives intensity.
export interface GlowHandle {
	setIntensity(i: number): void;
	dispose(): void;
}

// What the renderer gives each effect at setup time for one layer.
export interface LayerEffectSetup {
	mesh: FxMesh; // the layer plane
	baseZ: number; // its resting z height
	index: number; // layer index (bottom→top)
	// Build an additive, soft glow copy of this layer and return a handle to drive
	// its intensity (only the 'glow' effect calls this). May return null if the
	// renderer can't make one.
	makeGlow: () => GlowHandle | null;
}

// Per-frame inputs.
export interface LayerEffectFrame {
	dt: number; // seconds since the last frame (for accumulation)
	spin: number; // 0..1 — how fast the card is being turned right now
	// 0..1 — how visible the host card is right now. The additive glow respects it
	// so a dimmed/hidden card (e.g. one behind the front card in the opener) never
	// glows through. Defaults to 1 (fully visible) when omitted.
	hostOpacity?: number;
}

// A live, per-layer effect: update() runs every frame, dispose() on teardown.
export interface LayerEffectHandle {
	update(frame: LayerEffectFrame): void;
	dispose(): void;
}

// How strongly each effect responds to spin.
const SPIN_SPEED = 7; // rad/sec of layer rotation at full spin
const GROW_AMOUNT = 0.22; // +22% scale at full spin
const GLOW_GAIN = 1.0; // glow intensity per unit spin

// Build the live effect for one layer. Each effect reads only `spin` (and `dt` for
// the accumulating spin), so layers sit still until the card is turned.
export function createLayerEffect(effect: LayerEffect, setup: LayerEffectSetup): LayerEffectHandle {
	switch (effect) {
		case 'spin': {
			return {
				update: ({ dt, spin }) => {
					setup.mesh.rotation.z += spin * dt * SPIN_SPEED;
				},
				dispose: () => {}
			};
		}
		case 'grow': {
			return {
				update: ({ spin }) => {
					const s = 1 + spin * GROW_AMOUNT;
					setup.mesh.scale.set(s, s, 1);
				},
				dispose: () => {}
			};
		}
		case 'glow': {
			const glow = setup.makeGlow();
			return {
				update: ({ spin, hostOpacity }) => glow?.setIntensity(spin * GLOW_GAIN * (hostOpacity ?? 1)),
				dispose: () => glow?.dispose()
			};
		}
	}
}

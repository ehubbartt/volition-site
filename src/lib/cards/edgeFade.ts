import * as THREE from 'three';

// A soft rectangular edge-fade mask used as a depth layer's `alphaMap`, so layer
// art that reaches the card border feathers out instead of hard-cutting into a
// straight line (and the square plane corners don't poke past the card's rounded
// silhouette). White center → opaque, fading to black at the edges → transparent;
// MeshBasicMaterial.alphaMap reads the green channel. Linear (no colour space) as
// it's a mask, not colour. Returns null if a 2D canvas context isn't available.
export function makeEdgeFade(): THREE.CanvasTexture | null {
	const s = 128;
	const cv = document.createElement('canvas');
	cv.width = cv.height = s;
	const cx = cv.getContext('2d');
	if (!cx) return null;
	cx.fillStyle = '#000';
	cx.fillRect(0, 0, s, s);
	// blur a slightly-inset white rect → a feathered border on all four edges. Keep
	// the inset small so it only softens the very edge, not the bulk of the art.
	cx.filter = `blur(${s * 0.05}px)`;
	const m = s * 0.06; // inset; with the blur this is the feather margin
	cx.fillStyle = '#fff';
	cx.fillRect(m, m, s - 2 * m, s - 2 * m);
	const tex = new THREE.CanvasTexture(cv);
	tex.colorSpace = THREE.NoColorSpace;
	return tex;
}

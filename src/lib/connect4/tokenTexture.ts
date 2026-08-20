// CLIENT-ONLY — the face of a floating objective token, as a WebGL texture.
//
// The 3D board's tokens carry the real item art, which is hotlinked from the OSRS Wiki. Two
// things make that workable:
//
//  1. THE WIKI SENDS `access-control-allow-origin: *` on the image AND on every redirect
//     hop, so an <img> loaded with crossOrigin='anonymous' can be drawn into a canvas
//     without tainting it — which is what lets the canvas become a texture at all. Without
//     that header this would have to fall back to text.
//  2. FILE NAMES ARE CASE-SENSITIVE past the first letter, so this walks the same candidate
//     spellings as the DOM path (`wikiImageSources`) rather than trusting one url.
//
// The texture is returned IMMEDIATELY with the parchment disc painted, and the icon is
// composited in when it arrives. Nothing awaits an image: a token that is briefly a blank
// coin is much better than a board that waits for 25 network round trips before it draws.
//
// Textures are cached by item name — a replacement tile that reuses an item, or a remount of
// the board, costs nothing — and `disposeTokenTextures()` frees the lot with the scene.

import * as THREE from 'three';
import { wikiImageSources } from '$lib/wikiImage';

const SIZE = 128;
const cache = new Map<string, THREE.CanvasTexture>();

/** The parchment disc the flat rail uses, so both views read as the same object. */
function paintDisc(ctx: CanvasRenderingContext2D) {
	ctx.clearRect(0, 0, SIZE, SIZE);
	const g = ctx.createRadialGradient(SIZE * 0.4, SIZE * 0.35, SIZE * 0.05, SIZE * 0.5, SIZE * 0.5, SIZE * 0.55);
	g.addColorStop(0, '#efe4c8');
	g.addColorStop(0.75, '#cbbb95');
	g.addColorStop(1, '#a89774');
	ctx.save();
	ctx.beginPath();
	ctx.arc(SIZE / 2, SIZE / 2, SIZE / 2, 0, Math.PI * 2);
	ctx.clip();
	ctx.fillStyle = g;
	ctx.fillRect(0, 0, SIZE, SIZE);
	// A soft inner shadow around the rim, matching the flat disc's inset box-shadow.
	const rim = ctx.createRadialGradient(SIZE / 2, SIZE / 2, SIZE * 0.36, SIZE / 2, SIZE / 2, SIZE / 2);
	rim.addColorStop(0, 'rgba(0,0,0,0)');
	rim.addColorStop(1, 'rgba(0,0,0,0.35)');
	ctx.fillStyle = rim;
	ctx.fillRect(0, 0, SIZE, SIZE);
	ctx.restore();
}

/** Try each spelling in turn; resolve with the first that loads, or null if none do. */
function loadFirst(urls: string[]): Promise<HTMLImageElement | null> {
	return new Promise((resolve) => {
		let i = 0;
		const next = () => {
			if (i >= urls.length) return resolve(null);
			const img = new Image();
			// Required for the canvas to stay untainted, and therefore usable as a texture.
			img.crossOrigin = 'anonymous';
			img.referrerPolicy = 'no-referrer';
			img.onload = () => resolve(img);
			img.onerror = () => {
				i += 1;
				next();
			};
			img.src = urls[i];
		};
		next();
	});
}

/**
 * The token face for an item. Cached; safe to call every frame.
 * The returned texture is usable straight away — the icon appears on it when it loads.
 */
export function tokenTexture(itemName: string): THREE.CanvasTexture {
	const key = itemName.trim().toLowerCase();
	const hit = cache.get(key);
	if (hit) return hit;

	const canvas = document.createElement('canvas');
	canvas.width = SIZE;
	canvas.height = SIZE;
	const ctx = canvas.getContext('2d')!;
	paintDisc(ctx);

	const tex = new THREE.CanvasTexture(canvas);
	tex.colorSpace = THREE.SRGBColorSpace;
	tex.anisotropy = 4;
	cache.set(key, tex);

	loadFirst(wikiImageSources(itemName)).then((img) => {
		if (!img) return; // every spelling 404'd — the bare disc stands in
		const box = SIZE * 0.72;
		const scale = Math.min(box / img.naturalWidth, box / img.naturalHeight);
		const w = img.naturalWidth * scale;
		const h = img.naturalHeight * scale;
		ctx.drawImage(img, (SIZE - w) / 2, (SIZE - h) / 2, w, h);
		tex.needsUpdate = true;
	});

	return tex;
}

/** Free every cached texture. Call when the 3D board unmounts. */
export function disposeTokenTextures(): void {
	for (const tex of cache.values()) tex.dispose();
	cache.clear();
}

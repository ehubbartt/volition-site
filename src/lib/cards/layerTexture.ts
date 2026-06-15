// CLIENT three: load a card depth-layer texture that may be a still image
// (PNG/WEBP/GIF/JPEG) OR a short video (WEBM/MP4). Videos become a looping, muted
// VideoTexture so the layer animates in the 3D views (PackOpener + CardInspector3D).
// Shared so both renderers handle video identically.

import * as THREE from 'three';
import { isVideoLayerUrl } from './config';

export interface LayerTextureHandle {
	// Tear down the texture; for video also pauses/unloads the <video> element so it
	// stops decoding in the background.
	dispose: () => void;
}

// Loads `url` and invokes `apply(texture)` once it's usable. Images go through the
// shared TextureLoader (async, fires `apply` in its callback). Videos build a
// VideoTexture from an autoplaying muted <video> and fire `apply` once it has data.
export function loadLayerTexture(
	loader: THREE.TextureLoader,
	url: string,
	apply: (t: THREE.Texture) => void
): LayerTextureHandle {
	if (isVideoLayerUrl(url)) {
		const video = document.createElement('video');
		video.src = url;
		video.loop = true;
		video.muted = true;
		video.defaultMuted = true;
		video.playsInline = true;
		video.crossOrigin = 'anonymous';
		video.preload = 'auto';
		video.autoplay = true;

		const tex = new THREE.VideoTexture(video);
		tex.colorSpace = THREE.SRGBColorSpace;
		tex.minFilter = THREE.LinearFilter;
		tex.magFilter = THREE.LinearFilter;
		tex.generateMipmaps = false;

		const ready = () => {
			apply(tex);
			video.play().catch(() => {
				/* autoplay can be blocked until a gesture; it resumes on the next play() */
			});
		};
		if (video.readyState >= 2) ready();
		else video.addEventListener('loadeddata', ready, { once: true });

		return {
			dispose: () => {
				try {
					video.pause();
					video.removeAttribute('src');
					video.load();
				} catch {
					/* ignore */
				}
				tex.dispose();
			}
		};
	}

	let tex: THREE.Texture | null = null;
	loader.load(url, (t) => {
		tex = t;
		apply(t);
	});
	return { dispose: () => tex?.dispose() };
}

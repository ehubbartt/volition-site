// Side-effect module: turn on three.js's built-in in-memory file cache ONCE for the
// whole app. With it on, an image fetched by one TextureLoader (e.g. a pack front in
// the /gamba store) is reused — no re-fetch / re-decode — when the opener loads the
// same URL or the pack is reopened. Import this for its side effect at the top of
// every component that creates a TextureLoader.
import * as THREE from 'three';

THREE.Cache.enabled = true;

export {};

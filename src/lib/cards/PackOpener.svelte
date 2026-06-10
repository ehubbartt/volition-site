<script lang="ts">
  import { onMount } from "svelte";
  import * as THREE from "three";
  import {
    DEFAULT_CARD_BACK,
    RARITY_BY_KEY,
    DEFAULT_RARITY,
    type Card,
  } from "$lib/cards/rarity";
  import {
    FINISH_BY_KEY,
    HOLO_TEXTURE_URL,
    HOLO_MASK_URL,
    type CardFinish,
    type FinishMeta,
  } from "$lib/cards/finishes";
  import { HOLO_VERT, HOLO_FRAG, LAYER_SHADOW_FRAG, LAYER_GLOW_FRAG } from "$lib/cards/holo";
  import { createLayerEffect, type LayerEffectHandle } from "$lib/cards/layerEffects";
  import { makeEdgeFade } from "$lib/cards/edgeFade";
  import { loadLayerTexture, type LayerTextureHandle } from "$lib/cards/layerTexture";
  import { isVideoUrl } from "$lib/cards/config";
  import {
    SFX_OPENING,
    SFX_PULL_DRAGON,
    SFX_PULL_SR,
    SFX_PACK_SHINE,
    SFX_NEXT_CARD,
  } from "$lib/cards/sfx";
  import { DEFAULT_PACK_FRONT, DEFAULT_PACK_BACK } from "$lib/cards/packs";

  interface OpenerPack {
    name: string;
    front_url: string | null;
    back_url: string | null;
  }

  // Cards may carry a rolled `finish` (the gamba open flow); without one (the
  // tester) the opener cycles the holo looks for comparison. `isNew` is set by the
  // real open flow when the card was not already in the player's collection.
  type OpenerCard = Card & { finish?: CardFinish; isNew?: boolean };
  let {
    pack,
    cards,
    onClose,
  }: { pack: OpenerPack; cards: OpenerCard[]; onClose: () => void } = $props();

  let canvas: HTMLCanvasElement;
  let stage = $state<"pack" | "cards" | "grid" | "inspect">("pack");
  let locked = $state(true); // rotation lock (default on) so tearing is easy
  let ripping = $state(false); // true once a tear has begun (hides the tip)
  let currentIndex = $state(0);
  let inspectIndex = $state(0); // focused card while in the grid/fullscreen view
  let total = $derived(cards.length);
  let holoLabels = $state<string[]>([]);

  // which card the HUD describes: the inspected one in fullscreen, else the deck's
  let focusIndex = $derived(stage === "inspect" ? inspectIndex : currentIndex);
  let currentCard = $derived(cards[Math.min(focusIndex, total - 1)] ?? null);
  let currentRarity = $derived(
    currentCard
      ? (RARITY_BY_KEY[currentCard.rarity] ?? RARITY_BY_KEY[DEFAULT_RARITY])
      : null,
  );
  let currentHolo = $derived(holoLabels[focusIndex] ?? "");
  let currentIsNew = $derived(!!currentCard?.isNew);

  // ---- Per-card open sound + volume ----
  let volume = $state(1); // 0..1
  let lastVolume = 1; // level to restore when un-muting via the speaker icon
  const soundCache = new Map<string, HTMLAudioElement>();
  let currentCardAudio: HTMLAudioElement | null = null; // the focused card's sound
  let audioPrimed = false;
  // Create + start loading an <audio> for a url (cached). Preloading up front means
  // the reveal sound is ready instantly instead of downloading on first play.
  function ensureAudio(url: string | null | undefined): HTMLAudioElement | null {
    if (!url) return null;
    let a = soundCache.get(url);
    if (!a) {
      a = new Audio(url);
      a.preload = "auto";
      soundCache.set(url, a);
      try {
        a.load();
      } catch {
        /* ignore */
      }
    }
    return a;
  }
  function playSfx(url: string | null | undefined): HTMLAudioElement | null {
    if (volume <= 0 || !url) return null;
    try {
      const a = ensureAudio(url);
      if (!a) return null;
      a.muted = false; // undo any earlier priming-mute so it's always audible
      a.volume = volume;
      a.currentTime = 0;
      void a.play().catch(() => {});
      return a;
    } catch {
      /* autoplay/format issues are non-fatal */
      return null;
    }
  }
  // Unlock audio inside the first user gesture (mobile Safari / autoplay policies
  // block programmatic play() until an element has been played from a gesture).
  // play()+pause() SYNCHRONOUSLY (not in a .then) so it can't race a real play()
  // that happens in the same gesture — the old async unmute could leave the tear
  // clip muted or pause it mid-play. Runs once.
  function primeAudio() {
    if (audioPrimed) return;
    audioPrimed = true;
    soundCache.forEach((a) => {
      try {
        a.muted = true;
        void a.play().catch(() => {});
        a.pause();
        a.currentTime = 0;
        a.muted = false;
      } catch {
        a.muted = false;
      }
    });
  }
  function stopCardSound() {
    if (currentCardAudio) {
      try {
        currentCardAudio.pause();
        currentCardAudio.currentTime = 0;
      } catch {
        /* ignore */
      }
      currentCardAudio = null;
    }
  }
  // Which sound a revealed card plays: its own first, else a rarity default
  // (Dragon / SR), else nothing.
  function cardSoundUrl(c: OpenerCard | null | undefined): string | null {
    if (!c) return null;
    if (c.sound_url) return c.sound_url;
    if (c.rarity === "sr") return SFX_PULL_SR;
    if (c.rarity === "dragon") return SFX_PULL_DRAGON;
    return null;
  }
  function playCardSound(c: OpenerCard | null | undefined) {
    // Swiping to another card cuts off the previous card's sound.
    stopCardSound();
    currentCardAudio = playSfx(cardSoundUrl(c));
  }
  function toggleMute() {
    if (volume > 0) {
      lastVolume = volume;
      volume = 0;
    } else {
      volume = lastVolume > 0 ? lastVolume : 1;
    }
  }
  onMount(() => {
    try {
      const v = parseFloat(localStorage.getItem("vs_po_volume") ?? "1");
      if (Number.isFinite(v)) volume = Math.min(1, Math.max(0, v));
      if (volume > 0) lastVolume = volume;
    } catch {
      /* ignore */
    }
    // Preload every sound this open can play (pack shine, tear sound, swipe whoosh,
    // rarity defaults, and each card's own sound) so reveals — including swiping
    // back to a card — are instant, not waiting on a first-play download.
    ensureAudio(SFX_PACK_SHINE);
    ensureAudio(SFX_OPENING);
    ensureAudio(SFX_NEXT_CARD);
    ensureAudio(SFX_PULL_DRAGON);
    ensureAudio(SFX_PULL_SR);
    for (const c of cards) ensureAudio(cardSoundUrl(c));

    // Pack shine: plays as the unopened pack first appears (before it's ripped).
    playSfx(SFX_PACK_SHINE);
  });
  // Persist the volume and apply it live to any loaded/playing clips.
  $effect(() => {
    try {
      localStorage.setItem("vs_po_volume", String(volume));
    } catch {
      /* ignore */
    }
    soundCache.forEach((a) => {
      a.volume = volume;
      if (volume <= 0) a.pause();
    });
  });
  // Play the focused card's sound as it's revealed in the deck (and the first card
  // when the deck appears). Re-firing on a volume change is a no-op (same index).
  let lastSoundIndex = -1;
  $effect(() => {
    if (stage !== "cards") {
      // leaving the deck (grid / closed) stops the focused card's sound too
      if (lastSoundIndex !== -1) stopCardSound();
      lastSoundIndex = -1;
      return;
    }
    if (currentIndex === lastSoundIndex) return;
    lastSoundIndex = currentIndex;
    playCardSound(cards[currentIndex]);
    sparkleFor(cards[currentIndex]);
  });

  // Imperative bridges so the DOM HUD can drive the 3D scene.
  let goTo: (i: number) => void = () => {};
  let triggerRip: () => void = () => {};
  let goBackToGrid: () => void = () => {};
  // Burst sparkles from the focused card on a Dragon/SR pull (set in onMount).
  let sparkleFor: (c: OpenerCard | null | undefined) => void = () => {};

  onMount(() => {
    let disposed = false;
    let teardown = () => {};

    // Load an image's natural PIXEL size so the 3D pack + cards can be sized at
    // ONE shared scale (1:1 with the pixels). The designer lines the card art up
    // inside the pack art and it matches in 3D.
    const loadDims = (url: string | null, fallback: string) =>
      new Promise<{ w: number; h: number }>((resolve) => {
        const probe = (src: string, onFail: () => void) => {
          if (isVideoUrl(src)) {
            const v = document.createElement("video");
            v.preload = "metadata";
            v.muted = true;
            v.crossOrigin = "anonymous";
            v.onloadedmetadata = () =>
              resolve({ w: v.videoWidth || 5, h: v.videoHeight || 7 });
            v.onerror = onFail;
            v.src = src;
            return;
          }
          const img = new Image();
          img.crossOrigin = "anonymous";
          img.onload = () =>
            resolve({ w: img.naturalWidth || 5, h: img.naturalHeight || 7 });
          img.onerror = onFail;
          img.src = src;
        };
        probe(url || fallback, () =>
          url && url !== fallback
            ? probe(fallback, () => resolve({ w: 5, h: 7 }))
            : resolve({ w: 5, h: 7 }),
        );
      });

    (async () => {
      // One shared world-units-per-pixel scale: the pack is anchored to ~3.5 wide
      // and the cards are sized from THEIR pixels at the same scale, so card art
      // placed (centred) inside the pack art lines up 1:1 in 3D.
      // Load both dimensions in PARALLEL (not one after the other) so the opener
      // becomes interactive sooner — the sequential awaits added up to ~1s on a
      // cold load before anything rendered or the rip button worked.
      const [packImg, cardImg] = await Promise.all([
        loadDims(pack.front_url, DEFAULT_PACK_FRONT),
        cards[0] ? loadDims(cards[0].front_url, DEFAULT_CARD_BACK) : Promise.resolve({ w: 5, h: 7 }),
      ]);
      if (disposed) return;
      const SCALE = 3.5 / packImg.w;
      const PACK_W = packImg.w * SCALE;
      const PACK_H = packImg.h * SCALE;
      const rawCardW = cardImg.w * SCALE;
      const rawCardH = cardImg.h * SCALE;
      // A card must fit INSIDE its pack. If the shared-scale card would be bigger
      // than the pack (e.g. the pack has no front image so the small default is
      // used), scale it down to fit — keeps the bulge matched to the card instead
      // of the card ballooning past a collapsed bulge. With correct art (card
      // smaller than the pack in px) fit == 1, so it stays true 1:1.
      const fit = Math.min(
        1,
        (PACK_W * 0.97) / rawCardW,
        (PACK_H * 0.92) / rawCardH,
      );
      const CARD_W = rawCardW * fit;
      const CARD_H = rawCardH * fit;

      const cardCenterY = 0; // card centred in the pack (centre the art to match)
      // bulge plateau = the cards' real extent (so it isn't wider than the cards)
      const bBot = 0.5 + (cardCenterY - CARD_H / 2) / PACK_H;
      const bTop = 0.5 + (cardCenterY + CARD_H / 2) / PACK_H;
      const bMargin = (PACK_W - CARD_W) / 2 / PACK_W; // side margin = card width
      const BULGE_TAPER = 0.04;
      const TEAR_BASE = Math.min(0.96, bTop + 0.03); // crimp/tear above the cards
      // px of horizontal swipe to fully rip. Scaled to the viewport so a narrow
      // (mobile) screen doesn't need an impossible ~2-screen-width swipe — there
      // the tear tracks the finger ~1:1 like it does on desktop.
      const RIP_DISTANCE = Math.min(750, window.innerWidth * 0.9);
      const tearWorldY = (TEAR_BASE - 0.5) * PACK_H;

      const scene = new THREE.Scene();
      const camera = new THREE.PerspectiveCamera(42, 1, 0.1, 100);
      camera.position.set(0, 0, 8);

      const renderer = new THREE.WebGLRenderer({
        canvas,
        antialias: true,
        alpha: true,
        powerPreference: "high-performance",
      });
      // Cap at 1.5 — a full-screen canvas at DPR 2 with MSAA is ~4× the pixels of
      // DPR 1 and was the dominant per-frame cost. 1.5 keeps cards crisp for far less.
      renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));

      // Step 3: a faint, NEARLY-UNIFORM environment for subtle metallic reflection.
      // Kept very low-contrast on purpose so the curved bulge doesn't sweep through
      // bright/dark spots (which is what made the lighting look patchy before).
      function makeEnvGradient() {
        const c = document.createElement("canvas");
        c.width = 8;
        c.height = 256;
        const ctx = c.getContext("2d");
        const t = new THREE.CanvasTexture(c);
        t.mapping = THREE.EquirectangularReflectionMapping;
        t.colorSpace = THREE.SRGBColorSpace;
        if (!ctx) return t;
        const g = ctx.createLinearGradient(0, 0, 0, 256);
        g.addColorStop(0, "#e6e8ec"); // top — bright but low contrast
        g.addColorStop(1, "#d4d7dc"); // bottom
        ctx.fillStyle = g;
        ctx.fillRect(0, 0, 8, 256);
        t.needsUpdate = true;
        return t;
      }
      const pmrem = new THREE.PMREMGenerator(renderer);
      const envSrc = makeEnvGradient();
      const envTex = pmrem.fromEquirectangular(envSrc).texture;
      envSrc.dispose();
      scene.environment = envTex;

      scene.add(new THREE.AmbientLight(0xffffff, 0.95));
      const key = new THREE.DirectionalLight(0xffffff, 1.0);
      key.position.set(3, 5, 6);
      scene.add(key);
      const rim = new THREE.DirectionalLight(0xff9a3c, 0.45);
      rim.position.set(-5, -2, 2);
      scene.add(rim);
      // a sharp glint light from the upper-left front — gives a bright specular
      // highlight that travels across the foil as it rotates (metallic cue)
      const glint = new THREE.DirectionalLight(0xffffff, 1.3);
      glint.position.set(-4, 4, 5);
      scene.add(glint);

      const loader = new THREE.TextureLoader();
      loader.crossOrigin = "anonymous";

      // Holo foil (colour) + region-mask (alpha) textures, loaded once and shared
      // across cards (cached by URL). dummyTex keeps the foil/mask samplers bound
      // for Normal cards, where uHas = 0 means the shader never reads them.
      const texCache = new Map<string, THREE.Texture>();
      const dummyTex = new THREE.DataTexture(
        new Uint8Array([255, 255, 255, 255]),
        1,
        1,
      );
      dummyTex.needsUpdate = true;
      function holoTexFor(url: string, srgb: boolean, repeat: boolean) {
        const hit = texCache.get(url);
        if (hit) return hit;
        const t = loader.load(url, (tx) => {
          if (!disposed) {
            try {
              renderer.initTexture(tx);
            } catch {
              /* perf hint only */
            }
          }
        });
        if (srgb) t.colorSpace = THREE.SRGBColorSpace;
        // foil tiles with MIRRORED repeat (no hard seam when the UV offset pushes
        // past the edge); the mask must clamp so its region doesn't repeat.
        t.wrapS = t.wrapT = repeat
          ? THREE.MirroredRepeatWrapping
          : THREE.ClampToEdgeWrapping;
        texCache.set(url, t);
        return t;
      }

      // Fine foil crinkle as a NORMAL map — thousands of tiny facets that catch the
      // glint light as sparkle. Fine scale → metallic shimmer, not large patchiness.
      const FOIL_SIZE = 512;
      function makeFoilNormal() {
        const src = document.createElement("canvas");
        src.width = src.height = FOIL_SIZE;
        const sctx = src.getContext("2d");
        const out = document.createElement("canvas");
        out.width = out.height = FOIL_SIZE;
        const octx = out.getContext("2d");
        const tex = new THREE.CanvasTexture(out);
        tex.wrapS = tex.wrapT = THREE.MirroredRepeatWrapping; // seamless
        tex.repeat.set(3, 4);
        tex.colorSpace = THREE.NoColorSpace;
        if (!sctx || !octx) return tex;
        // layered fine value-noise height field
        sctx.fillStyle = "#808080";
        sctx.fillRect(0, 0, FOIL_SIZE, FOIL_SIZE);
        sctx.imageSmoothingEnabled = true;
        let alpha = 0.55;
        for (const cells of [32, 64, 128, 256]) {
          const o = document.createElement("canvas");
          o.width = o.height = cells;
          const octx2 = o.getContext("2d");
          if (!octx2) continue;
          const id = octx2.createImageData(cells, cells);
          for (let i = 0; i < cells * cells; i++) {
            const v = Math.random() * 255;
            id.data[i * 4] = id.data[i * 4 + 1] = id.data[i * 4 + 2] = v;
            id.data[i * 4 + 3] = 255;
          }
          octx2.putImageData(id, 0, 0);
          sctx.globalAlpha = alpha;
          sctx.drawImage(o, 0, 0, FOIL_SIZE, FOIL_SIZE);
          alpha *= 0.6;
        }
        sctx.globalAlpha = 1;
        // height → normal (Sobel)
        const h = sctx.getImageData(0, 0, FOIL_SIZE, FOIL_SIZE).data;
        const nd = octx.createImageData(FOIL_SIZE, FOIL_SIZE);
        const at = (x: number, y: number) =>
          h[
            (((y + FOIL_SIZE) % FOIL_SIZE) * FOIL_SIZE +
              ((x + FOIL_SIZE) % FOIL_SIZE)) *
              4
          ];
        const strength = 2.5;
        for (let y = 0; y < FOIL_SIZE; y++) {
          for (let x = 0; x < FOIL_SIZE; x++) {
            const dx = ((at(x - 1, y) - at(x + 1, y)) / 255) * strength;
            const dy = ((at(x, y - 1) - at(x, y + 1)) / 255) * strength;
            const len = Math.hypot(dx, dy, 1);
            const i = (y * FOIL_SIZE + x) * 4;
            nd.data[i] = ((dx / len) * 0.5 + 0.5) * 255;
            nd.data[i + 1] = ((dy / len) * 0.5 + 0.5) * 255;
            nd.data[i + 2] = ((1 / len) * 0.5 + 0.5) * 255;
            nd.data[i + 3] = 255;
          }
        }
        octx.putImageData(nd, 0, 0);
        tex.needsUpdate = true;
        return tex;
      }
      const foilNormal = makeFoilNormal();

      // ---- Foil pack: sharp corners, thin sealed edges, bulging middle ----
      const W = PACK_W,
        H = PACK_H;
      // plateau half-thickness — scales with how many cards are in the pack
      const BULGE = Math.min(0.34, 0.06 + cards.length * 0.015);
      const CRUMPLE = 0.002; // foil wrinkle depth (near-flat — smooth pack)

      const ss = (a: number, b: number, x: number) => {
        const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
        return t * t * (3 - 2 * t);
      };
      // ~flat across the middle, falling to 0 within margin m of each edge
      const falloff = (t: number, m: number) => ss(0, m, t) * ss(1, 1 - m, t);
      // layered sine "noise" for the crumpled-foil surface
      const wrinkle = (u: number, v: number) =>
        Math.sin(u * 38 + v * 11) * 0.5 +
        Math.sin(u * 17 - v * 29) * 0.35 +
        Math.sin(u * 53 + v * 41) * 0.22 +
        Math.sin(v * 61 + u * 7) * 0.18;

      // Shared ripple state for every pack face (shell + body + lid) so the whole
      // foil undulates as one sheet. Amplitude is driven from movement in the loop.
      const rippleUniforms = {
        uTime: { value: 0 },
        uRipple: { value: 0 },
        uPoke: { value: new THREE.Vector2(0, 0) }, // cursor pos in pack-local space
        uPokeAmt: { value: 0 }, // strength of the cursor deformation
      };

      function artMat(url: string | null, fallback: string, isFront: boolean) {
        // Printed foil wrapper: the art is dark INK (kept bright via low metalness +
        // diffuse) under a glossy clearcoat lacquer that supplies the shiny foil
        // sheen. The clearcoat reflects the uniform env as an EVEN coat, so it's
        // shiny without going dark (high metalness tints reflections by the dark art)
        // and without the patchy sweep.
        const m = new THREE.MeshPhysicalMaterial({
          roughness: 0.3, // the printed base
          metalness: 0.1,
          envMapIntensity: 1.45,
          clearcoat: 1.0, // glossy lacquer = the foil sheen
          clearcoatRoughness: 0.07, // very sharp, wet-looking gloss
          normalMap: foilNormal, // barely-there crinkle facets...
          normalScale: new THREE.Vector2(0.05, 0.05),
          clearcoatNormalMap: foilNormal, // ...the faintest sparkle in the lacquer
          clearcoatNormalScale: new THREE.Vector2(0.05, 0.05),
        });
        const apply = (t: THREE.Texture) => {
          t.colorSpace = THREE.SRGBColorSpace;
          m.map = t;
          m.needsUpdate = true;
        };
        loader.load(url || fallback, apply, undefined, () =>
          loader.load(fallback, apply),
        );
        // Inject a thin-foil ripple: a small traveling wave along the foil's
        // thickness axis (same sign front/back so it moves as one sheet), plus a
        // matching normal tilt so the lighting/sheen shimmers with it. The cursor
        // poke uses uFace: +1 on the front (dents inward) and a smaller -0.6 on the
        // back so the back caves inward too (the pack squishes) rather than bulging
        // out the far side.
        m.onBeforeCompile = (shader) => {
          shader.uniforms.uTime = rippleUniforms.uTime;
          shader.uniforms.uRipple = rippleUniforms.uRipple;
          shader.uniforms.uPoke = rippleUniforms.uPoke;
          shader.uniforms.uPokeAmt = rippleUniforms.uPokeAmt;
          shader.uniforms.uFace = { value: isFront ? 1.0 : -0.6 };
          shader.vertexShader = shader.vertexShader
            .replace(
              "#include <common>",
              `#include <common>
            uniform float uTime;
            uniform float uRipple;
            uniform vec2 uPoke;
            uniform float uPokeAmt;
            uniform float uFace;
            float ripW(vec2 p) {
              // broad, slow flex (not water ripples) — the foil shifting as it moves
              return uRipple * (
                sin(p.x * 1.1 + p.y * 0.7 + uTime * 1.2) * 0.6 +
                sin(p.x * 0.8 - p.y * 1.3 + uTime * 0.8) * 0.4
              );
            }
            // how rigid the foil is here: 1 = backed by the (rigid) card stack,
            // 0 = slack foil at the sealed top/bottom and side margins
            float firmnessAt(vec2 p) {
              float u = p.x / ${W.toFixed(3)} + 0.5;
              float v = p.y / ${H.toFixed(3)} + 0.5;
              float vBand = smoothstep(${(bBot - BULGE_TAPER).toFixed(4)}, ${bBot.toFixed(4)}, v) * (1.0 - smoothstep(${bTop.toFixed(4)}, ${(bTop + BULGE_TAPER).toFixed(4)}, v));
              float fU = smoothstep(0.0, ${bMargin.toFixed(4)}, u) * (1.0 - smoothstep(${(1 - bMargin).toFixed(4)}, 1.0, u));
              return clamp(fU * vBand, 0.0, 1.0);
            }
            // localized push under the cursor: a soft dent on the SLACK foil only —
            // over the rigid card stack the foil barely gives, so cards don't bend
            float pokeW(vec2 p) {
              float d = length(p - uPoke);
              float poke = -uPokeAmt * exp(-d * d * 4.0);
              // guard: pressing the firm center is allowed; pressing slack foil
              // leaves the card-backed area alone so the cards don't morph.
              float guard = max(firmnessAt(uPoke), 1.0 - firmnessAt(p));
              poke *= guard;
              // the foil can't dent past the cards behind it: limit the inward
              // depth to how far it sits above the card stack here, so the bulge can
              // flatten onto the cards but never push into them.
              float plateau = ${BULGE.toFixed(3)} * firmnessAt(p);
              return max(poke, -(plateau + 0.03));
            }
            float surfW(vec2 p) { return ripW(p) + uFace * pokeW(p); }`,
            )
            .replace(
              "#include <beginnormal_vertex>",
              `#include <beginnormal_vertex>
            {
              float e = 0.04;
              float w0 = surfW(position.xy);
              float wx = surfW(position.xy + vec2(e, 0.0));
              float wy = surfW(position.xy + vec2(0.0, e));
              objectNormal.xy += vec2(-(wx - w0), -(wy - w0)) / e * 0.8;
              objectNormal = normalize(objectNormal);
            }`,
            )
            .replace(
              "#include <begin_vertex>",
              `#include <begin_vertex>
            transformed.z += surfW(position.xy);`,
            );
        };
        m.customProgramCacheKey = () => "foil-ripple";
        return m;
      }

      // straight tear (Pokémon-TCG style) — no jag across the width
      const jagAt = (_u: number) => 0;

      // One face (front/back) of a vertical slice [v0,v1]. The bulge is a flat
      // RECTANGULAR plateau over the card area that fades out BEFORE the top/bottom
      // so the tear sits in a flat sealed section. The shared tear edge is jagged
      // (matching UVs front/back) so it's invisible until torn, ragged once open.
      function buildFace(
        v0: number,
        v1: number,
        front: boolean,
        tearEdge: "top" | "bottom" | null,
      ) {
        const segV = Math.max(4, Math.round(56 * (v1 - v0)));
        const geo = new THREE.PlaneGeometry(W, (v1 - v0) * H, 52, segV);
        const centerY = ((v0 + v1) / 2 - 0.5) * H;
        const h = (v1 - v0) * H;
        const pos = geo.attributes.position;
        const uv = geo.attributes.uv;
        for (let i = 0; i < pos.count; i++) {
          const x = pos.getX(i);
          const yl = pos.getY(i);
          const u = (x + W / 2) / W;
          let gy = yl + centerY;
          if (tearEdge === "top" && Math.abs(yl - h / 2) < 1e-3) gy += jagAt(u);
          else if (tearEdge === "bottom" && Math.abs(yl + h / 2) < 1e-3)
            gy += jagAt(u);
          pos.setY(i, gy - centerY);
          const v = (gy + H / 2) / H;
          // cards fill nearly the full width and most of the height, sitting just
          // slightly low: very thin side seals, a small seal at the bottom and a
          // slightly larger crimp at the top
          // plateau matches the cards' real vertical extent (derived from the card
          // image height), with thin tapers just outside
          const vBand =
            ss(bBot - BULGE_TAPER, bBot, v) * ss(bTop + BULGE_TAPER, bTop, v);
          const plateau = BULGE * falloff(u, bMargin) * vBand;
          const cr =
            CRUMPLE *
            wrinkle(front ? u : u + 1.7, front ? v : v + 2.3) *
            falloff(u, 0.05) *
            falloff(v, 0.05);
          pos.setZ(i, (front ? plateau : -plateau) + cr);
          uv.setXY(i, front ? u : 1 - u, v);
        }
        pos.needsUpdate = true;
        uv.needsUpdate = true;
        geo.computeVertexNormals();
        const mat = artMat(
          front ? pack.front_url : pack.back_url,
          front ? DEFAULT_PACK_FRONT : DEFAULT_PACK_BACK,
          front,
        );
        if (!front) mat.side = THREE.BackSide;
        const m = new THREE.Mesh(geo, mat);
        m.position.y = centerY;
        return m;
      }

      function fade(obj: THREE.Object3D, o: number) {
        obj.traverse((n) => {
          const raw = (n as THREE.Mesh).material;
          if (!raw) return;
          const arr = Array.isArray(raw) ? raw : [raw];
          for (const m of arr) {
            m.transparent = true;
            (m as { opacity: number }).opacity = o;
          }
        });
      }

      const packGroup = new THREE.Group();
      packGroup.rotation.set(-0.05, 0, 0);
      scene.add(packGroup);

      const tearV = TEAR_BASE;

      // Sealed shell = one continuous front + back mesh for the whole pack. A
      // single mesh has no internal seam, so the unopened pack shows NO tear line.
      // It's swapped for the body+lid pair the instant a rip begins — at that
      // point they're still flush (jagged edges coincident, lid barely moved), so
      // the swap is invisible.
      const shellGroup = new THREE.Group();
      shellGroup.add(buildFace(0, 1, true, null));
      shellGroup.add(buildFace(0, 1, false, null));
      packGroup.add(shellGroup);

      // Torn pieces, hidden until a tear starts.
      const tornGroup = new THREE.Group();
      tornGroup.visible = false;
      packGroup.add(tornGroup);

      // Body = bottom of the pack (sealed bottom + sides, jagged open top).
      const body = new THREE.Group();
      body.add(buildFace(0, tearV, true, "top"));
      body.add(buildFace(0, tearV, false, "top"));
      tornGroup.add(body);

      // Lid = the flat top. Instead of hinging rigidly it PEELS: it tears from the
      // left, the torn part folding forward toward the viewer, and the tear front
      // sweeping right as `rip` grows (see peelLid below).
      const lidFaceFront = buildFace(tearV, 1, true, "bottom");
      const lidFaceBack = buildFace(tearV, 1, false, "bottom");
      const lidInner = new THREE.Group();
      lidInner.add(lidFaceFront);
      lidInner.add(lidFaceBack);
      lidInner.position.y = -tearWorldY;
      const lidGroup = new THREE.Group();
      lidGroup.position.y = tearWorldY;
      lidGroup.add(lidInner);
      tornGroup.add(lidGroup);

      // Peel state: keep each lid face's flat base vertices so we can re-fold the
      // flap from scratch every frame as the tear progresses.
      const lidPeel = [lidFaceFront, lidFaceBack].map((m) => ({
        geo: m.geometry,
        base: Float32Array.from(
          m.geometry.attributes.position.array as ArrayLike<number>,
        ),
      }));
      // Peel the lid in the direction of the rip (dir = +1 left→right, -1 right→left):
      // the tear front is a vertical line sweeping toward the dir edge, and the
      // already-torn material behind it curls up toward the viewer and folds over in
      // the dir direction. progress 0..1.
      function peelLid(progress: number, dir: number) {
        const aMax = 2.3; // curl angle — toward the viewer and over
        const span = 0.55; // width of the curling tear front
        // front starts at the −dir edge and sweeps past the +dir edge
        const xFront =
          dir > 0 ? -W / 2 + progress * (W + span) : W / 2 - progress * (W + span);
        for (const { geo, base } of lidPeel) {
          const pos = geo.attributes.position;
          for (let i = 0; i < pos.count; i++) {
            const bx = base[i * 3],
              by = base[i * 3 + 1],
              bz = base[i * 3 + 2];
            const dx = bx - xFront;
            if (dx * dir >= 0) {
              pos.setXYZ(i, bx, by, bz); // still attached, ahead of the tear front
              continue;
            }
            // how far through the curl this column is (1 = fully folded over)
            const a = aMax * Math.min(1, Math.abs(dx) / span);
            const ca = Math.cos(a),
              sa = Math.sin(a);
            // rotate about the vertical tear front (y-axis at xFront); dir flips the
            // fold so it curls over toward whichever way you're tearing
            pos.setXYZ(i, xFront + dx * ca + dir * bz * sa, by, -dir * dx * sa + bz * ca);
          }
          pos.needsUpdate = true;
          geo.computeVertexNormals();
        }
      }

      // ---- Tear guide: a dotted line tracing the ACTUAL jagged tear path with a
      // scissors at its start. Lives in packGroup so it follows the pack's spin;
      // shown only while sealed + rotation-locked, with the dots filling in
      // left→right on a loop.
      const guideGroup = new THREE.Group();
      packGroup.add(guideGroup);

      const GUIDE_Z = 0.18; // float just in front of the foil at the tear line

      // rounded white dash texture (soft alpha ends keep the dashes rounded)
      const dashCanvas = document.createElement("canvas");
      dashCanvas.width = 64;
      dashCanvas.height = 24;
      const dashCtx = dashCanvas.getContext("2d");
      if (dashCtx) {
        dashCtx.fillStyle = "#ffffff";
        dashCtx.beginPath();
        dashCtx.roundRect(2, 2, 60, 20, 10);
        dashCtx.fill();
      }
      const dashTex = new THREE.CanvasTexture(dashCanvas);
      dashTex.colorSpace = THREE.SRGBColorSpace;

      const DASH_COUNT = 22;
      const DASH_MARGIN = 0.08; // start the dashes right at the pack edge
      const dashGeo = new THREE.PlaneGeometry(0.085, 0.026); // small rounded dash
      const guideDashMats: THREE.MeshBasicMaterial[] = [];
      for (let i = 0; i < DASH_COUNT; i++) {
        const u = i / (DASH_COUNT - 1);
        const mat = new THREE.MeshBasicMaterial({
          map: dashTex,
          color: 0xffffff,
          transparent: true,
          opacity: 0,
          depthTest: false,
        });
        const d = new THREE.Mesh(dashGeo, mat);
        // sit on the jagged tear path and rotate to follow its local slope
        const du = 0.012;
        const slope = (jagAt(u + du) - jagAt(u - du)) / (2 * du * W);
        const x = -W / 2 + DASH_MARGIN + u * (W - 2 * DASH_MARGIN);
        d.position.set(x, tearWorldY + jagAt(u), GUIDE_Z);
        d.rotation.z = Math.atan(slope);
        d.renderOrder = 5;
        guideGroup.add(d);
        guideDashMats.push(mat);
      }

      // ---- Rip FX: a glowing star that swipes across the straight tear line
      // (Pokémon-TCG style), trailing a bright glow over the part already cut. These
      // live in packGroup (not guideGroup) so they show DURING the rip.
      function makeStarTexture() {
        const s = 128;
        const cv = document.createElement("canvas");
        cv.width = cv.height = s;
        const x = cv.getContext("2d");
        const t = new THREE.CanvasTexture(cv);
        t.colorSpace = THREE.SRGBColorSpace;
        if (!x) return t;
        const cx = s / 2;
        const g = x.createRadialGradient(cx, cx, 0, cx, cx, cx);
        g.addColorStop(0, "rgba(255,255,255,1)");
        g.addColorStop(0.22, "rgba(255,246,205,0.9)");
        g.addColorStop(0.55, "rgba(255,212,120,0.25)");
        g.addColorStop(1, "rgba(255,200,100,0)");
        x.fillStyle = g;
        x.fillRect(0, 0, s, s);
        x.translate(cx, cx);
        x.fillStyle = "rgba(255,255,255,0.95)";
        const spike = (len: number, w: number) => {
          x.beginPath();
          x.moveTo(0, -len);
          x.lineTo(w, 0);
          x.lineTo(0, len);
          x.lineTo(-w, 0);
          x.closePath();
          x.fill();
        };
        spike(cx * 0.95, 7); // vertical
        x.rotate(Math.PI / 2);
        spike(cx * 0.95, 7); // horizontal
        x.rotate(-Math.PI / 4);
        spike(cx * 0.55, 4); // diagonals
        x.rotate(Math.PI / 2);
        spike(cx * 0.55, 4);
        t.needsUpdate = true;
        return t;
      }
      const starTex = makeStarTexture();
      const starMat = new THREE.SpriteMaterial({
        map: starTex,
        transparent: true,
        depthTest: false,
        blending: THREE.AdditiveBlending,
        opacity: 0,
      });
      const star = new THREE.Sprite(starMat);
      star.scale.set(0.95, 0.95, 0.95);
      // sit right on the foil at the tear line (not floating out front) so the
      // swipe tracks the actual edge
      star.position.set(-W / 2, tearWorldY, 0.07);
      star.renderOrder = 8;
      packGroup.add(star);

      // bright glow along the already-cut part of the tear line
      const trailMat = new THREE.MeshBasicMaterial({
        color: 0xffe6a6,
        transparent: true,
        depthTest: false,
        blending: THREE.AdditiveBlending,
        opacity: 0,
      });
      const trail = new THREE.Mesh(new THREE.PlaneGeometry(1, 0.025), trailMat);
      trail.position.set(-W / 2, tearWorldY, 0.05);
      trail.renderOrder = 7;
      packGroup.add(trail);

      // Cards live in a group inside the pack so they rotate/tilt with it; on
      // open it's detached to the scene (upright) to become the deck.
      const cardsGroup = new THREE.Group();
      packGroup.add(cardsGroup);

      // ---- Cards (planes with the holo shader) ----
      function makeCardMat(
        url: string | null,
        fallback: string,
        level: FinishMeta,
        c: OpenerCard,
      ) {
        // Full-art card with its own holo image → foil over the WHOLE card (mask =
        // dummyTex, alpha 1 everywhere). Otherwise the finish's masked foil.
        const fullArtHolo = !!c.full_art && !!c.holo_url;
        // The foil: a full-art card uses its own holo; otherwise the pack's per-finish
        // holo override (holo_regular_url / holo_reverse_url) if set, else the default.
        const holoTexVal = fullArtHolo
          ? holoTexFor(c.holo_url as string, true, true)
          : level.placement === "regular"
            ? holoTexFor(c.holo_regular_url ?? HOLO_TEXTURE_URL.star, true, true)
            : level.placement === "reverse"
              ? holoTexFor(c.holo_reverse_url ?? HOLO_TEXTURE_URL.ripple, true, true)
              : dummyTex;
        const maskVal = fullArtHolo
          ? dummyTex
          : level.placement
            ? holoTexFor(HOLO_MASK_URL[level.placement], false, false)
            : dummyTex;
        const mat = new THREE.ShaderMaterial({
          uniforms: {
            map: { value: null },
            uHoloTex: { value: holoTexVal },
            uMask: { value: maskVal },
            uHas: { value: fullArtHolo || level.placement ? 1 : 0 },
            uStrength: { value: fullArtHolo ? 1 : level.strength },
            uReveal: { value: 1 },
            uOpacity: { value: 0 },
            uMapSrgb: { value: 0 },
          },
          vertexShader: HOLO_VERT,
          fragmentShader: HOLO_FRAG,
          transparent: true,
        });
        const apply = (t: THREE.Texture) => {
          t.colorSpace = THREE.SRGBColorSpace;
          mat.uniforms.map.value = t;
          mat.needsUpdate = true;
          // Upload to the GPU NOW (while the pack idles) instead of in the frame
          // the rip first reveals the card — uploading several large card images
          // at once was the freeze right after clicking "Rip open".
          if (!disposed) {
            try {
              renderer.initTexture(t);
            } catch {
              /* perf hint only */
            }
          }
        };
        // A video front animates as a looping VideoTexture (handle disposed with the
        // other layer/video handles on teardown); a still image uses the texture loader.
        if (isVideoUrl(url)) {
          const applyVideo = (t: THREE.Texture) => {
            // three doesn't sRGB-decode a VideoTexture on sample, so mark it linear
            // (no decode) and let the shader decode instead (uMapSrgb) — without this
            // the video front renders washed-out / too bright.
            t.colorSpace = THREE.LinearSRGBColorSpace;
            mat.uniforms.uMapSrgb.value = 1;
            mat.uniforms.map.value = t;
            mat.needsUpdate = true;
            if (!disposed) {
              try {
                renderer.initTexture(t);
              } catch {
                /* perf hint only */
              }
            }
          };
          layerTexHandles.push(loadLayerTexture(loader, url as string, applyVideo));
        } else {
          loader.load(url || fallback, apply, undefined, () =>
            loader.load(fallback, apply),
          );
        }
        return mat;
      }

      const CARD_D = 0.04; // very thin card slab (CARD_W/CARD_H come from the image)
      const cardGeo = new THREE.PlaneGeometry(CARD_W, CARD_H);
      const edgeGeo = new THREE.BoxGeometry(CARD_W, CARD_H, CARD_D);
      const labels: string[] = [];
      const overlayMats: (THREE.ShaderMaterial | null)[] = [];
      const edgeMats: THREE.MeshStandardMaterial[] = [];
      const backMats: THREE.MeshBasicMaterial[] = [];
      // Per-card stacked depth layers (parallel to cardMeshes; empty for most),
      // the matching drop-shadow materials, and the layer+shadow meshes (so we can
      // toggle their visibility per card / per stage).
      const layerMats: THREE.MeshBasicMaterial[][] = [];
      const shadowMats: THREE.ShaderMaterial[][] = [];
      const depthObjs: THREE.Object3D[][] = [];
      // Per-card live layer effects (parallel to cardMeshes), updated each frame.
      const layerFx: LayerEffectHandle[][] = [];
      // Image/video texture handles across all cards, disposed on teardown (video also
      // gets paused so it stops decoding once the opener closes).
      const layerTexHandles: LayerTextureHandle[] = [];
      const LAYER_DEPTH = 0.08; // how far each layer sits above the card (small = subtle)
      const SHADOW_STRENGTH = 0.5;
      const SHADOW_DIR = new THREE.Vector2(0.6, -0.8); // light upper-left → shadow lower-right
      // Soft edge-fade mask so layer art that reaches the card border feathers out
      // instead of hard-cutting. Shared across every card's layers.
      const edgeFade = cards.some((c) => (c.layers ?? []).length) ? makeEdgeFade() : null;
      const flipped: boolean[] = cards.map(() => false); // per-card flip state
      // the summary grid always shows fronts, so clear any flips when entering it
      const resetFlips = () => flipped.fill(false);
      // No rolled finish (the pack tester) → preview the guaranteed-slot rule: the
      // last card is a Holo, the second-to-last a Reverse Holo, the rest Normal.
      const finishFor = (c: OpenerCard, i: number): FinishMeta => {
        if (c.full_art) return FINISH_BY_KEY.normal; // full-art cards never holo
        if (c.finish) return FINISH_BY_KEY[c.finish] ?? FINISH_BY_KEY.normal;
        if (i === cards.length - 1) return FINISH_BY_KEY.holo;
        if (i === cards.length - 2) return FINISH_BY_KEY.reverse;
        return FINISH_BY_KEY.normal;
      };
      const cardMeshes: THREE.Mesh[] = cards.map((c, i) => {
        const level: FinishMeta = finishFor(c, i);
        // A full-art card with its own holo image reads as "Holo" in the HUD.
        labels.push(c.full_art && c.holo_url ? 'Holo' : level.label);
        const m = new THREE.Mesh(
          cardGeo,
          makeCardMat(c.front_url, DEFAULT_CARD_BACK, level, c),
        );
        m.position.set(0, -1.5, 0);

        // a thin dark slab behind the face gives the card a little thickness
        const edgeMat = new THREE.MeshStandardMaterial({
          color: 0x0c0c0e,
          roughness: 0.7,
          transparent: true,
        });
        const edge = new THREE.Mesh(edgeGeo, edgeMat);
        edge.position.z = -CARD_D / 2 - 0.001;
        m.add(edge);
        edgeMats.push(edgeMat);

        // back face — shown once the card is flipped (rotated ~180° about Y). Sits
        // at the far -z so after the flip it becomes the frontmost face.
        const backMat = new THREE.MeshBasicMaterial({
          transparent: true,
          opacity: 0,
        });
        const applyBack = (t: THREE.Texture) => {
          t.colorSpace = THREE.SRGBColorSpace;
          backMat.map = t;
          backMat.needsUpdate = true;
          if (!disposed) {
            try {
              renderer.initTexture(t);
            } catch {
              /* perf hint only */
            }
          }
        };
        loader.load(c.back_url || DEFAULT_CARD_BACK, applyBack, undefined, () =>
          loader.load(DEFAULT_CARD_BACK, applyBack),
        );
        const back = new THREE.Mesh(cardGeo, backMat);
        back.rotation.y = Math.PI;
        back.position.z = -(CARD_D + 0.006);
        m.add(back);
        backMats.push(backMat);

        // Stacked 3D depth layers above the front (special cards only). Each sits at
        // a higher z so tilting parallaxes them apart, AND casts a soft drop shadow
        // on the card base (offset by its height) so it reads as popping OUT of the
        // card. Layer + shadow opacity track the front's uOpacity in the frame loop.
        const myLayerMats: THREE.MeshBasicMaterial[] = [];
        const myShadowMats: THREE.ShaderMaterial[] = [];
        const myDepthObjs: THREE.Object3D[] = [];
        const myLayerFx: LayerEffectHandle[] = [];
        (c.layers ?? []).forEach((ly, li) => {
          const h = (li + 1) * LAYER_DEPTH;
          const lm = new THREE.MeshBasicMaterial({ transparent: true, opacity: 0 });
          if (edgeFade) lm.alphaMap = edgeFade;
          const sm = new THREE.ShaderMaterial({
            uniforms: {
              map: { value: null },
              uOpacity: { value: 0 },
              uBlur: { value: new THREE.Vector2(0.012 * (li + 1), 0.012 * (li + 1)) },
            },
            vertexShader: HOLO_VERT,
            fragmentShader: LAYER_SHADOW_FRAG,
            transparent: true,
            depthWrite: false,
          });
          // Glow-effect materials for this layer share the texture once it loads.
          const glowMaps: { value: THREE.Texture | null }[] = [];
          const applyLayer = (t: THREE.Texture) => {
            t.colorSpace = THREE.SRGBColorSpace;
            lm.map = t;
            lm.needsUpdate = true;
            sm.uniforms.map.value = t; // shadow reuses the layer texture (alpha)
            for (const g of glowMaps) g.value = t;
            if (!disposed) {
              try {
                renderer.initTexture(t);
              } catch {
                /* perf hint only */
              }
            }
          };
          layerTexHandles.push(loadLayerTexture(loader, ly.url, applyLayer));
          // Force draw order front(0) → shadow(1) → layer(2) so the transparency
          // sort never flips the shadow behind the front (which made it vanish).
          const shadow = new THREE.Mesh(cardGeo, sm);
          shadow.position.set(SHADOW_DIR.x * h * 1.1, SHADOW_DIR.y * h * 1.1, 0.002 + li * 0.0015);
          shadow.renderOrder = 1;
          m.add(shadow);
          myShadowMats.push(sm);
          const lp = new THREE.Mesh(cardGeo, lm);
          lp.position.z = h;
          lp.renderOrder = 2;
          m.add(lp);
          myLayerMats.push(lm);
          myDepthObjs.push(shadow, lp);
          if (ly.effect) {
            myLayerFx.push(
              createLayerEffect(ly.effect, {
                mesh: lp,
                baseZ: h,
                index: li,
                makeGlow: ({ blur }) => {
                  const gmat = new THREE.ShaderMaterial({
                    uniforms: {
                      map: { value: lm.map },
                      uIntensity: { value: 0 },
                      uBlur: { value: new THREE.Vector2(blur, blur) },
                      uFeather: { value: new THREE.Vector2(0.12, 0.12) },
                      uTint: { value: new THREE.Color(1, 1, 1) },
                    },
                    vertexShader: HOLO_VERT,
                    fragmentShader: LAYER_GLOW_FRAG,
                    transparent: true,
                    blending: THREE.AdditiveBlending,
                    depthWrite: false,
                  });
                  glowMaps.push(gmat.uniforms.map);
                  const gmesh = new THREE.Mesh(cardGeo, gmat);
                  gmesh.position.z = h + 0.002;
                  gmesh.renderOrder = 3;
                  m.add(gmesh);
                  myDepthObjs.push(gmesh);
                  return {
                    setIntensity: (v) => (gmat.uniforms.uIntensity.value = v),
                    dispose: () => {
                      m.remove(gmesh);
                      gmat.dispose();
                    },
                  };
                },
              }),
            );
          }
        });
        layerMats.push(myLayerMats);
        shadowMats.push(myShadowMats);
        depthObjs.push(myDepthObjs);
        layerFx.push(myLayerFx);

        // The holo is the masked foil on the front itself — no separate overlay
        // sheet. overlayMats stays parallel to cardMeshes (always null) so the
        // frame loop's `if (ov)` guards just skip.
        overlayMats.push(null);

        cardsGroup.add(m);
        return m;
      });
      holoLabels = labels;
      // Skip the per-frame effect loop entirely unless some layer has an effect.
      const anyLayerFx = layerFx.some((a) => a.length > 0);

      // ---- Sparkle burst (Dragon / SR pulls) ----
      // Additive point particles that fly out of the focused card on reveal. More
      // for SR than Dragon. A ring buffer of SPARK_MAX particles, updated per frame.
      const SPARK_MAX = 260;
      const sparkPos = new Float32Array(SPARK_MAX * 3);
      const sparkCol = new Float32Array(SPARK_MAX * 3);
      const sparkA = new Float32Array(SPARK_MAX); // alpha (0 = dead)
      const sparkSz = new Float32Array(SPARK_MAX); // current point size (px)
      const sparkVel = new Float32Array(SPARK_MAX * 3);
      const sparkLife = new Float32Array(SPARK_MAX);
      const sparkTtl = new Float32Array(SPARK_MAX);
      const sparkBase = new Float32Array(SPARK_MAX); // base size
      let sparkCursor = 0;
      let sparkAlive = false;
      let sparkPrevT = performance.now();

      function makeSparkleTexture() {
        const s = 64;
        const cv = document.createElement("canvas");
        cv.width = cv.height = s;
        const ctx = cv.getContext("2d");
        if (ctx) {
          const cx = s / 2;
          const g = ctx.createRadialGradient(cx, cx, 0, cx, cx, cx);
          g.addColorStop(0, "rgba(255,255,255,1)");
          g.addColorStop(0.3, "rgba(255,255,255,0.55)");
          g.addColorStop(1, "rgba(255,255,255,0)");
          ctx.fillStyle = g;
          ctx.fillRect(0, 0, s, s);
          // soft 4-point star flare
          ctx.globalCompositeOperation = "lighter";
          ctx.strokeStyle = "rgba(255,255,255,0.6)";
          ctx.lineWidth = 1.5;
          ctx.beginPath();
          ctx.moveTo(cx, 4);
          ctx.lineTo(cx, s - 4);
          ctx.moveTo(4, cx);
          ctx.lineTo(s - 4, cx);
          ctx.stroke();
        }
        const t = new THREE.CanvasTexture(cv);
        t.colorSpace = THREE.SRGBColorSpace;
        return t;
      }
      const sparkTex = makeSparkleTexture();

      const sparkGeo = new THREE.BufferGeometry();
      sparkGeo.setAttribute("position", new THREE.BufferAttribute(sparkPos, 3));
      sparkGeo.setAttribute("aColor", new THREE.BufferAttribute(sparkCol, 3));
      sparkGeo.setAttribute("aAlpha", new THREE.BufferAttribute(sparkA, 1));
      sparkGeo.setAttribute("aSize", new THREE.BufferAttribute(sparkSz, 1));
      const sparkMat = new THREE.ShaderMaterial({
        uniforms: { uTex: { value: sparkTex } },
        vertexShader: `
          attribute vec3 aColor;
          attribute float aAlpha;
          attribute float aSize;
          varying vec3 vColor;
          varying float vAlpha;
          void main() {
            vColor = aColor;
            vAlpha = aAlpha;
            vec4 mv = modelViewMatrix * vec4(position, 1.0);
            gl_PointSize = aSize * (8.0 / max(0.001, -mv.z));
            gl_Position = projectionMatrix * mv;
          }
        `,
        fragmentShader: `
          uniform sampler2D uTex;
          varying vec3 vColor;
          varying float vAlpha;
          void main() {
            vec4 t = texture2D(uTex, gl_PointCoord);
            gl_FragColor = vec4(vColor, t.a * vAlpha);
          }
        `,
        transparent: true,
        depthTest: false,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      });
      const sparkPoints = new THREE.Points(sparkGeo, sparkMat);
      sparkPoints.frustumCulled = false;
      sparkPoints.renderOrder = 20;
      scene.add(sparkPoints);

      const _sparkWP = new THREE.Vector3();
      function burstSparkles(count: number, hex: string) {
        const m = cardMeshes[currentIndex];
        if (!m || count <= 0) return;
        m.getWorldPosition(_sparkWP);
        const col = new THREE.Color(hex);
        for (let n = 0; n < count; n++) {
          const i = sparkCursor;
          sparkCursor = (sparkCursor + 1) % SPARK_MAX;
          // spawn across the card face, just in front of it
          sparkPos[i * 3] = _sparkWP.x + (Math.random() - 0.5) * CARD_W * 0.9;
          sparkPos[i * 3 + 1] = _sparkWP.y + (Math.random() - 0.5) * CARD_H * 0.9;
          sparkPos[i * 3 + 2] = _sparkWP.z + 0.2 + Math.random() * 0.4;
          // velocity: spread outward, biased up and toward the viewer
          const ang = Math.random() * Math.PI * 2;
          const spd = 1.4 + Math.random() * 2.6;
          sparkVel[i * 3] = Math.cos(ang) * spd * 0.6;
          sparkVel[i * 3 + 1] = Math.sin(ang) * spd * 0.6 + 1.1;
          sparkVel[i * 3 + 2] = 1.4 + Math.random() * 2.2;
          const ttl = 0.7 + Math.random() * 0.9;
          sparkLife[i] = ttl;
          sparkTtl[i] = ttl;
          sparkBase[i] = 16 + Math.random() * 26;
          sparkA[i] = 1;
          sparkSz[i] = sparkBase[i];
          // colour: rarity hue mixed toward white for a bright spark
          const w = 0.45 + Math.random() * 0.45;
          sparkCol[i * 3] = col.r * (1 - w) + w;
          sparkCol[i * 3 + 1] = col.g * (1 - w) + w;
          sparkCol[i * 3 + 2] = col.b * (1 - w) + w;
        }
        sparkAlive = true;
      }
      sparkleFor = (c) => {
        if (!c) return;
        if (c.rarity === "sr") burstSparkles(120, RARITY_BY_KEY.sr.color);
        else if (c.rarity === "dragon") burstSparkles(55, RARITY_BY_KEY.dragon.color);
      };

      function updateSparkles(now: number) {
        const dt = Math.min(0.05, (now - sparkPrevT) / 1000);
        sparkPrevT = now;
        if (!sparkAlive) return;
        let alive = 0;
        const drag = Math.pow(0.1, dt);
        for (let i = 0; i < SPARK_MAX; i++) {
          if (sparkLife[i] <= 0) {
            sparkA[i] = 0;
            continue;
          }
          sparkLife[i] -= dt;
          if (sparkLife[i] <= 0) {
            sparkA[i] = 0;
            sparkSz[i] = 0;
            continue;
          }
          alive++;
          sparkVel[i * 3 + 1] -= 2.4 * dt; // gravity
          sparkVel[i * 3] *= drag;
          sparkVel[i * 3 + 1] *= drag;
          sparkVel[i * 3 + 2] *= drag;
          sparkPos[i * 3] += sparkVel[i * 3] * dt;
          sparkPos[i * 3 + 1] += sparkVel[i * 3 + 1] * dt;
          sparkPos[i * 3 + 2] += sparkVel[i * 3 + 2] * dt;
          const t = sparkLife[i] / sparkTtl[i];
          sparkA[i] = Math.min(1, t * 1.6); // hold bright, fade at the end
          sparkSz[i] = sparkBase[i] * (0.35 + 0.65 * t);
        }
        sparkAlive = alive > 0;
        sparkGeo.attributes.position.needsUpdate = true;
        sparkGeo.attributes.aColor.needsUpdate = true;
        sparkGeo.attributes.aAlpha.needsUpdate = true;
        sparkGeo.attributes.aSize.needsUpdate = true;
      }

      // ---- Interaction state ----
      let targetRotY = 0,
        targetRotX = -0.05;
      let dragging = false;
      let lastX = 0,
        lastY = 0;
      let ripPull = 0; // accumulated horizontal swipe (px)
      let ripDir = 1; // +1 = tear left→right, -1 = right→left (set by the drag)
      let rip = 0,
        ripTarget = 0; // 0..1 current / target tear progress
      let committing = false;
      let openSfxFired = false; // the "opening a pack" sound plays once, on commit
      let ripActive = false; // true only when the swipe started at the pack's top
      let flinging = false;
      let flingStart = 0;
      let sliding = false; // cards sliding up out of the opened pack
      let slideStart = 0;
      let dragDX = 0;
      let tiltX = 0,
        tiltY = 0; // drag-to-rotate (the stack while swiping, the card in inspect)
      let pointerX = 0,
        pointerY = 0;
      let downX = 0,
        downY = 0; // pointer-down position, to tell a tap from a drag
      const TOP_GATE = -0.12; // must grab above this (normalized Y) to rip
      // Deck swipe feel: a horizontal drag first just turns the stack (inspect);
      // only past SEP_START does the top card peel off the stack (the visual cue),
      // and releasing only swipes it once you're past SWIPE_COMMIT (else it snaps
      // back). This stops a casual inspect-drag from swiping the card by accident.
      const SEP_START = 95;
      const SWIPE_COMMIT = 175;

      function goToIndex(i: number) {
        if (i >= total) {
          // Swiping the LAST card away to the summary still gets a whoosh.
          playSfx(SFX_NEXT_CARD);
          resetFlips();
          stage = "grid"; // past the last card → summary grid
          return;
        }
        const next = Math.max(0, Math.min(total - 1, i));
        // Swipe whoosh on every card-to-card move (forward or back).
        if (next !== currentIndex) playSfx(SFX_NEXT_CARD);
        currentIndex = next;
      }
      goTo = goToIndex;
      triggerRip = () => {
        if (stage === "pack") {
          committing = true;
          ripTarget = 1;
          rip = Math.max(rip, 0.08); // tear is visible the instant you click
          // Play the tear sound HERE, inside the click gesture — mobile/strict
          // autoplay blocks the deferred play in the render loop below.
          if (!openSfxFired) {
            openSfxFired = true;
            playSfx(SFX_OPENING);
          }
        }
      };
      goBackToGrid = () => {
        if (stage === "inspect") {
          resetFlips();
          stage = "grid";
        }
      };

      function onDown(e: PointerEvent) {
        primeAudio(); // unlock audio within this gesture (mobile autoplay)
        dragging = true;
        lastX = e.clientX;
        lastY = e.clientY;
        downX = e.clientX;
        downY = e.clientY;
        const rect = canvas.getBoundingClientRect();
        const py = ((e.clientY - rect.top) / rect.height) * 2 - 1;
        ripActive = stage === "pack" && locked && py < TOP_GATE;
        canvas.setPointerCapture(e.pointerId);
      }
      function onMove(e: PointerEvent) {
        const dx = e.clientX - lastX;
        const dy = e.clientY - lastY;
        lastX = e.clientX;
        lastY = e.clientY;
        const rect = canvas.getBoundingClientRect();
        pointerX = ((e.clientX - rect.left) / rect.width) * 2 - 1;
        pointerY = ((e.clientY - rect.top) / rect.height) * 2 - 1;
        if (!dragging) return;
        if (stage === "pack") {
          if (locked && ripActive && !flinging) {
            // the first horizontal move sets which way the pack tears
            if (ripPull === 0 && dx !== 0) ripDir = dx > 0 ? 1 : -1;
            ripPull += Math.abs(dx);
            ripTarget = Math.min(ripPull / RIP_DISTANCE, 1);
            if (ripTarget >= 1) committing = true;
          } else if (!locked) {
            targetRotY += dx * 0.01;
            targetRotX = THREE.MathUtils.clamp(
              targetRotX + dy * 0.006,
              -0.8,
              0.8,
            );
          }
        } else if (stage === "cards") {
          dragDX += dx;
          // drag turns the stack (to see its side) — wider yaw, no sideways travel
          tiltY = THREE.MathUtils.clamp(tiltY + dx * 0.006, -0.6, 0.6);
          tiltX = THREE.MathUtils.clamp(tiltX + dy * 0.005, -0.4, 0.4);
        } else if (stage === "inspect") {
          // free-rotate the inspected card
          tiltY += dx * 0.01;
          tiltX = THREE.MathUtils.clamp(tiltX + dy * 0.01, -1.3, 1.3);
        }
      }
      // which card (if any) is under the pointer — used to pick from the grid
      function pickCard(e: PointerEvent): number {
        const rect = canvas.getBoundingClientRect();
        pokeNdc.set(
          ((e.clientX - rect.left) / rect.width) * 2 - 1,
          -(((e.clientY - rect.top) / rect.height) * 2 - 1),
        );
        raycaster.setFromCamera(pokeNdc, camera);
        const hits = raycaster.intersectObjects(cardMeshes, true);
        if (!hits.length) return -1;
        let obj: THREE.Object3D | null = hits[0].object;
        while (obj && !cardMeshes.includes(obj as THREE.Mesh)) obj = obj.parent;
        return obj ? cardMeshes.indexOf(obj as THREE.Mesh) : -1;
      }

      function onUp(e: PointerEvent) {
        const tap = Math.hypot(e.clientX - downX, e.clientY - downY) < 8;
        if (stage === "pack" && locked && ripActive && !committing) {
          if (rip >= 0.5) {
            committing = true;
            ripTarget = 1;
            // Play the tear sound inside this pointer-up gesture (autoplay-safe).
            if (!openSfxFired) {
              openSfxFired = true;
              playSfx(SFX_OPENING);
            }
          } else {
            ripTarget = 0;
            ripPull = 0;
          }
        }
        ripActive = false;
        if (stage === "cards") {
          if (tap && currentIndex < total) {
            flipped[currentIndex] = !flipped[currentIndex]; // tap flips the card
          } else if (dragDX < -SWIPE_COMMIT) {
            // goToIndex handles the last-card → summary grid case (with whoosh) itself.
            goToIndex(currentIndex + 1);
          } else if (dragDX > SWIPE_COMMIT && currentIndex > 0) {
            goToIndex(currentIndex - 1);
          }
        } else if (stage === "grid" && tap) {
          const idx = pickCard(e);
          if (idx >= 0) {
            inspectIndex = idx;
            tiltX = 0;
            tiltY = 0;
            stage = "inspect";
          }
        } else if (stage === "inspect" && tap) {
          flipped[inspectIndex] = !flipped[inspectIndex]; // tap flips
        }
        dragDX = 0;
        dragging = false;
        try {
          canvas.releasePointerCapture(e.pointerId);
        } catch {
          /* ignore */
        }
      }
      canvas.addEventListener("pointerdown", onDown);
      canvas.addEventListener("pointermove", onMove);
      canvas.addEventListener("pointerup", onUp);
      canvas.addEventListener("pointercancel", onUp);

      function resize() {
        const w = canvas.clientWidth,
          h = canvas.clientHeight;
        if (!w || !h) return;
        renderer.setSize(w, h, false);
        const aspect = w / h;
        camera.aspect = aspect;
        // Fit the pack within BOTH dimensions (with margin) so on narrow/portrait
        // phones the camera pulls back instead of the pack filling the width.
        const vfov = (camera.fov * Math.PI) / 180;
        const fitH = PACK_H + 1.1, // frame the pack (whatever height the art gives)
          fitW = PACK_W + 1.1;
        const distV = fitH / 2 / Math.tan(vfov / 2);
        const distH = fitW / 2 / (Math.tan(vfov / 2) * aspect);
        camera.position.z = Math.max(distV, distH);
        camera.updateProjectionMatrix();
      }
      const ro = new ResizeObserver(resize);
      ro.observe(canvas);
      resize();

      // world width/height visible at the card plane (z≈0), for grid/inspect layout
      function fitDims() {
        const vfov = (camera.fov * Math.PI) / 180;
        const h = 2 * Math.tan(vfov / 2) * camera.position.z;
        return { w: h * camera.aspect, h };
      }

      const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

      // foil-ripple drive: amplitude follows how fast the pack spins / tears
      let prevRotY = packGroup.rotation.y,
        prevRotX = packGroup.rotation.x,
        prevRip = 0;
      const MAX_AMP = 0.02,
        SPIN_GAIN = 1.2,
        RIP_GAIN = 0.5,
        HOVER_GAIN = 2.5;

      // for projecting the cursor onto the pack to drive the localized poke
      const raycaster = new THREE.Raycaster();
      const pokeNdc = new THREE.Vector2();
      const pokePoint = new THREE.Vector3();
      let prevPx = 0,
        prevPy = 0;
      // Spin speed (drag-rotate velocity), smoothed — drives the layer effects so
      // they only animate while you actually turn a card.
      let prevTiltX = 0,
        prevTiltY = 0;
      let fxSpin = 0;
      let lastFxNow = performance.now();

      let raf = 0;
      function frame() {
        raf = requestAnimationFrame(frame);
        const now = performance.now();

        // Depth layers/shadows only show for the FRONT-most card, and never while
        // the pack is still closed — otherwise behind-card layers clip through the
        // top card and the raised layer pokes out of the unopened pack.
        for (let i = 0; i < depthObjs.length; i++) {
          let show: boolean;
          if (stage === "pack") show = false;
          else if (stage === "cards") show = i === currentIndex;
          else if (stage === "inspect") show = i === inspectIndex;
          else show = true; // grid: cards are spread out, all can show
          for (const o of depthObjs[i]) o.visible = show;
        }

        if (stage === "pack") {
          packGroup.rotation.y = lerp(packGroup.rotation.y, targetRotY, 0.12);
          packGroup.rotation.x = lerp(packGroup.rotation.x, targetRotX, 0.12);
          rip = lerp(rip, ripTarget, 0.2);

          // Fire the "opening a pack" sound once the tear commits — works whether the
          // pack was ripped slowly (drag) or fast ("Rip open" / quick swipe).
          if (committing && !openSfxFired) {
            openSfxFired = true;
            playSfx(SFX_OPENING);
          }

          // how fast the cursor itself is moving (drives the "as it passes" ripple)
          const hoverVel =
            Math.abs(pointerX - prevPx) + Math.abs(pointerY - prevPy);
          prevPx = pointerX;
          prevPy = pointerY;

          // project the cursor onto the pack: is it over the foil, and where?
          let over = false;
          if (shellGroup.visible) {
            pokeNdc.set(pointerX, -pointerY);
            raycaster.setFromCamera(pokeNdc, camera);
            const hits = raycaster.intersectObjects(shellGroup.children, false);
            if (hits.length) {
              over = true;
              packGroup.worldToLocal(pokePoint.copy(hits[0].point));
              rippleUniforms.uPoke.value.set(pokePoint.x, pokePoint.y);
            }
          }

          // global flex tracks spin + tear velocity, plus the cursor sweeping over it
          // (the hover term works even with rotation locked, since spin is then ~0)
          const spinVel =
            Math.abs(packGroup.rotation.y - prevRotY) +
            Math.abs(packGroup.rotation.x - prevRotX);
          const ripVel = Math.abs(rip - prevRip);
          prevRotY = packGroup.rotation.y;
          prevRotX = packGroup.rotation.x;
          prevRip = rip;
          const targetAmp = Math.min(
            MAX_AMP,
            spinVel * SPIN_GAIN +
              ripVel * RIP_GAIN +
              (over ? hoverVel * HOVER_GAIN : 0),
          );
          rippleUniforms.uRipple.value = lerp(
            rippleUniforms.uRipple.value,
            targetAmp,
            0.12,
          );
          rippleUniforms.uTime.value = now * 0.004;

          // localized dent under the cursor — stronger as it passes / when dragging
          const pokeTarget = over
            ? Math.min(0.15, (dragging ? 0.12 : 0.06) + hoverVel * 2.0)
            : 0;
          rippleUniforms.uPokeAmt.value = lerp(
            rippleUniforms.uPokeAmt.value,
            pokeTarget,
            pokeTarget > rippleUniforms.uPokeAmt.value ? 0.35 : 0.12,
          );

          // swap the seamless sealed shell for the torn body+lid as soon as a
          // tear begins — until then the pack is one seam-free mesh
          const opened = rip > 0.02;
          shellGroup.visible = !opened;
          tornGroup.visible = opened;

          // dotted tear guide: fill dashes left→right, looping. Pre-rip hint only.
          const guideOn = locked && !opened;
          guideGroup.visible = guideOn;
          if (guideOn) {
            const prog = Math.min(1, (now % 3400) / 3400 / 0.82);
            for (let i = 0; i < guideDashMats.length; i++) {
              const target = i / (guideDashMats.length - 1) <= prog ? 0.7 : 0;
              guideDashMats[i].opacity = lerp(
                guideDashMats[i].opacity,
                target,
                0.12,
              );
            }
          }

          // glowing star swipes across the straight tear line ONLY while ripping;
          // a bright glow trails the part already cut. Inset from the edges so it
          // stays within the pack width.
          const fxOn = locked && !flinging && rip > 0.02 && rip < 0.995;
          const EDGE = 0.03;
          const ripX = Math.max(0, Math.min(1, rip));
          // track peelLid's tear front (it sweeps across W + PEEL_SPAN) so the star
          // sits exactly where the foil is actually separating, not behind it
          const PEEL_SPAN = 0.55;
          const left = -W / 2 + EDGE;
          const right = W / 2 - EDGE;
          // tear front sweeps from the −ripDir edge toward the +ripDir edge
          const startX = ripDir > 0 ? -W / 2 : W / 2;
          const xFront = Math.max(
            left,
            Math.min(right, startX + ripDir * ripX * (W + PEEL_SPAN)),
          );
          star.position.x = xFront;
          star.scale.setScalar(0.16 + 0.03 * Math.sin(now / 110));
          starMat.opacity = lerp(starMat.opacity, fxOn ? 1 : 0, 0.3);
          // glow trails from the starting edge up to the tear front
          const startEdge = ripDir > 0 ? left : right;
          const cut = Math.max(0.001, Math.abs(xFront - startEdge));
          trail.scale.x = cut;
          trail.position.x = (startEdge + xFront) / 2;
          trailMat.opacity = lerp(trailMat.opacity, fxOn ? 0.85 : 0, 0.2);

          if (!flinging) {
            // the top peels open in the rip direction, folding forward toward you
            peelLid(rip, ripDir);

            const torn = rip > 0.05;
            if (torn !== ripping) ripping = torn;

            if (committing && rip > 0.98) {
              flinging = true;
              flingStart = now;
            }
          } else {
            // fully torn: the folded flap drops away toward the viewer and fades,
            // then the cards slide up out of the pack
            peelLid(1, ripDir);
            const tt = Math.min((now - flingStart) / 450, 1);
            const e = 1 - Math.pow(1 - tt, 3);
            lidGroup.position.x = e * 2.6 * ripDir; // slide off where it peeled
            lidGroup.position.z = e * 0.6;
            fade(lidGroup, 1 - e);
            if (tt >= 1 && !sliding) {
              sliding = true;
              slideStart = now;
              // hand the cards to the scene so they hold their place while the
              // pack slides away beneath them
              scene.attach(cardsGroup);
            }
          }

          // Cards stay hidden until the tear begins, then sit still inside the pack,
          // visible through the opening.
          cardsGroup.visible = rip > 0.02;
          if (cardsGroup.visible && !sliding) {
            const cardScale = 1; // full size — same as when they come out
            for (let i = 0; i < cardMeshes.length; i++) {
              const m = cardMeshes[i];
              m.position.set(0, cardCenterY + i * 0.012, -i * 0.012);
              m.rotation.set(0, 0, 0);
              m.scale.setScalar(cardScale);
              (m.material as THREE.ShaderMaterial).uniforms.uOpacity.value = 1;
              edgeMats[i].opacity = 1;
              layerMats[i].forEach((lm) => (lm.opacity = 1));
              shadowMats[i].forEach((sm) => (sm.uniforms.uOpacity.value = SHADOW_STRENGTH));
            }
          }

          // The pack slides DOWN out of view, revealing the cards (which were
          // detached to the scene and stay in place), then the deck takes over.
          if (sliding) {
            const st = Math.min((now - slideStart) / 650, 1);
            const se = 1 - Math.pow(1 - st, 3);
            packGroup.position.y = -se * 7.5; // drop away beneath the cards
            // the foil reacts as the cards leave: a quick flex that settles, plus a
            // tiny recoil bob early in the drop
            rippleUniforms.uRipple.value = 0.07 * Math.sin(st * Math.PI);
            packGroup.position.y += 0.18 * Math.sin(st * Math.PI) * (1 - st);
            if (st >= 1) {
              stage = "cards";
              packGroup.visible = false;
            }
          }
        }

        if (stage === "cards") {
          // the WHOLE stack rotates together when you inspect (so cards don't clip
          // into each other), and the group settles to a centred resting spot
          const DECK_Y = 0.4;
          // Leftward drag ADVANCES: the top card peels off to the left (0 = seated,
          // 1 = committed). Rightward drag GOES BACK: the top card stays put and the
          // previous card slides back on top instead (only if there is one).
          const nextSep = THREE.MathUtils.clamp(
            (-dragDX - SEP_START) / (SWIPE_COMMIT - SEP_START),
            0,
            1.1,
          );
          const prevSep =
            currentIndex > 0
              ? THREE.MathUtils.clamp((dragDX - SEP_START) / (SWIPE_COMMIT - SEP_START), 0, 1.1)
              : 0;
          // advancing eases the tilt back so the swipe reads cleanly; going back keeps
          // the deck tilted while the previous card flies in.
          const turn = 1 - Math.min(1, nextSep);
          const inspectRX = (pointerY * 0.14 + tiltX) * turn;
          const inspectRY = (pointerX * 0.14 + tiltY) * turn;
          // inspecting TURNS the whole stack (revealing its side/edge) rather than
          // sliding it horizontally — the group stays centred and just rotates
          cardsGroup.position.x = lerp(cardsGroup.position.x, 0, 0.15);
          cardsGroup.position.y = lerp(cardsGroup.position.y, DECK_Y, 0.1);
          cardsGroup.position.z = lerp(cardsGroup.position.z, 0, 0.1);
          cardsGroup.rotation.x = lerp(cardsGroup.rotation.x, inspectRX, 0.15);
          cardsGroup.rotation.y = lerp(cardsGroup.rotation.y, inspectRY, 0.15);
          cardsGroup.rotation.z = lerp(cardsGroup.rotation.z, 0, 0.15);
          for (let i = 0; i < cardMeshes.length; i++) {
            const m = cardMeshes[i];
            const rel = i - currentIndex;
            const mat = m.material as THREE.ShaderMaterial;
            let tx = 0,
              ty = 0,
              tz = 0,
              rx = 0,
              rz = 0,
              ry = 0,
              op = 0,
              sc = 1;
            if (rel === -1 && prevSep > 0) {
              // going back: the previous card flies in from the left to land on top,
              // so you can see it's coming back (instead of moving the top card right).
              const k = Math.min(1, prevSep);
              tx = -12 * (1 - k);
              tz = 0.06 + k * 0.7;
              rz = 0.18 * (1 - k);
              op = k;
              ry = flipped[i] ? Math.PI : 0;
            } else if (rel < 0) {
              // swiped away — flies off to the left and fades
              tx = -12;
              tz = 2;
              rz = 0.5;
              op = 0;
            } else if (rel > 6) {
              tz = -0.6;
              op = 0;
              sc = 0.96;
            } else {
              // a tight STACK: cards sit on top of each other with tiny offsets so
              // the edges of the ones underneath just peek out
              tx = rel * 0.015;
              ty = -rel * 0.02;
              tz = -rel * 0.04;
              sc = 1 - rel * 0.012;
              op = 1; // solid stack — under cards are blurred, not see-through
              ry = flipped[i] ? Math.PI : 0; // tapped cards show their back
              if (rel === 0 && nextSep > 0) {
                // peel the top card off to the LEFT to advance; release before
                // SWIPE_COMMIT and it lerps back into place. Rightward drag leaves it
                // seated (the previous card moves instead).
                tx = -nextSep * 2.2;
                tz = 0.06 + nextSep * 0.7;
                rz = nextSep * 0.14;
              }
            }
            m.position.x = lerp(m.position.x, tx, 0.14);
            m.position.y = lerp(m.position.y, ty, 0.14);
            m.position.z = lerp(m.position.z, tz, 0.14);
            m.rotation.x = lerp(m.rotation.x, rx, 0.14);
            m.rotation.z = lerp(m.rotation.z, rz, 0.14);
            m.rotation.y = lerp(m.rotation.y, ry, 0.14);
            // while the front card is mid-flip it swings a wide arc in z; lift it
            // forward by how edge-on it is so it clears the cards behind it
            if (rel === 0)
              m.position.z =
                tz + (CARD_W / 2) * Math.abs(Math.sin(m.rotation.y));
            const s = lerp(m.scale.x, sc, 0.14);
            m.scale.set(s, s, s);
            mat.uniforms.uOpacity.value = lerp(
              mat.uniforms.uOpacity.value,
              op,
              0.14,
            );
            // only the front card is revealed; the rest stay blurred — but the
            // previous card sharpens as it flies back on top.
            const revealTarget =
              rel === 0 ? 1 : rel === -1 && prevSep > 0 ? Math.min(1, prevSep) : 0;
            mat.uniforms.uReveal.value = lerp(mat.uniforms.uReveal.value, revealTarget, 0.18);
            edgeMats[i].opacity = mat.uniforms.uOpacity.value;
            backMats[i].opacity = mat.uniforms.uOpacity.value;
            layerMats[i].forEach((lm) => (lm.opacity = mat.uniforms.uOpacity.value));
            shadowMats[i].forEach(
              (sm) => (sm.uniforms.uOpacity.value = mat.uniforms.uOpacity.value * SHADOW_STRENGTH),
            );

            const ov = overlayMats[i];
            if (ov) {
              ov.uniforms.uOpacity.value =
                rel === 0 ? mat.uniforms.uOpacity.value : 0;
            }
          }

          // ease the drag-rotate back to centre when not dragging
          if (!dragging) {
            tiltX = lerp(tiltX, 0, 0.1);
            tiltY = lerp(tiltY, 0, 0.1);
          }
        }

        if (stage === "grid" || stage === "inspect") {
          // grid: all pulled cards laid out face-up; inspect: one card fullscreen.
          // Reserve space at the bottom (and a little at top) for the HUD so the
          // cards never overlap the "Your pull" text / Done / Back buttons.
          const view = fitDims();
          const TOP_RESERVE = 0.08,
            BOT_RESERVE = 0.22;
          const usableH = view.h * (1 - TOP_RESERVE - BOT_RESERVE);
          const usableW = view.w * 0.92;
          const layoutYOffset = (view.h * (BOT_RESERVE - TOP_RESERVE)) / 2; // shift up
          const n = cardMeshes.length;
          const cols = Math.ceil(Math.sqrt(n));
          const rows = Math.ceil(n / cols);
          const gap = 1.15; // cell = card * gap
          const cellScale = Math.min(
            usableW / (cols * CARD_W * gap),
            usableH / (rows * CARD_H * gap),
            1,
          );
          const cw = CARD_W * cellScale * gap;
          const ch = CARD_H * cellScale * gap;

          // inspected card fills the usable area (clear of the HUD)
          const bigScale = Math.min(usableW / CARD_W, usableH / CARD_H);

          cardsGroup.position.x = lerp(cardsGroup.position.x, 0, 0.15);
          cardsGroup.position.y = lerp(cardsGroup.position.y, 0, 0.15);
          cardsGroup.position.z = lerp(cardsGroup.position.z, 0, 0.15);
          cardsGroup.rotation.x = lerp(cardsGroup.rotation.x, 0, 0.15);
          cardsGroup.rotation.y = lerp(cardsGroup.rotation.y, 0, 0.15);
          cardsGroup.rotation.z = lerp(cardsGroup.rotation.z, 0, 0.15);

          for (let i = 0; i < cardMeshes.length; i++) {
            const m = cardMeshes[i];
            const mat = m.material as THREE.ShaderMaterial;
            let tx, ty, tz, rx, ry, sc, op;
            if (stage === "inspect") {
              const focused = i === inspectIndex;
              tx = 0;
              ty = layoutYOffset;
              tz = focused ? 0.5 : -3;
              sc = focused ? bigScale : cellScale * 0.6;
              op = focused ? 1 : 0;
              rx = focused ? tiltX : 0;
              ry = (flipped[i] ? Math.PI : 0) + (focused ? tiltY : 0);
            } else {
              const col = i % cols;
              const row = Math.floor(i / cols);
              tx = (col - (cols - 1) / 2) * cw;
              ty = ((rows - 1) / 2 - row) * ch + layoutYOffset;
              tz = 0;
              sc = cellScale;
              op = 1;
              rx = 0;
              ry = flipped[i] ? Math.PI : 0;
            }
            m.position.x = lerp(m.position.x, tx, 0.15);
            m.position.y = lerp(m.position.y, ty, 0.15);
            m.position.z = lerp(m.position.z, tz, 0.15);
            m.rotation.x = lerp(m.rotation.x, rx, 0.15);
            m.rotation.y = lerp(m.rotation.y, ry, 0.15);
            m.rotation.z = lerp(m.rotation.z, 0, 0.15);
            const s = lerp(m.scale.x, sc, 0.15);
            m.scale.set(s, s, s);
            mat.uniforms.uOpacity.value = lerp(
              mat.uniforms.uOpacity.value,
              op,
              0.15,
            );
            mat.uniforms.uReveal.value = lerp(
              mat.uniforms.uReveal.value,
              1,
              0.15,
            );
            edgeMats[i].opacity = mat.uniforms.uOpacity.value;
            backMats[i].opacity = mat.uniforms.uOpacity.value;
            layerMats[i].forEach((lm) => (lm.opacity = mat.uniforms.uOpacity.value));
            shadowMats[i].forEach(
              (sm) => (sm.uniforms.uOpacity.value = mat.uniforms.uOpacity.value * SHADOW_STRENGTH),
            );
            const ov = overlayMats[i];
            if (ov) ov.uniforms.uOpacity.value = mat.uniforms.uOpacity.value;
          }

          if (!dragging && stage === "grid") {
            tiltX = lerp(tiltX, 0, 0.1);
            tiltY = lerp(tiltY, 0, 0.1);
          }
        }

        // Play any per-layer animation effects. Driven by how fast a card is being
        // turned (drag-rotate velocity) — they're static until you spin it. Each
        // card's glow is gated by its own visibility so behind cards never glow.
        if (anyLayerFx) {
          const dt = Math.min(0.05, (now - lastFxNow) / 1000);
          const d = Math.abs(tiltX - prevTiltX) + Math.abs(tiltY - prevTiltY);
          prevTiltX = tiltX;
          prevTiltY = tiltY;
          // Fast attack / slow release so the effects hold steady between the spiky
          // per-frame drag samples and glide down when you stop (no flicker).
          const target = Math.min(1, d * 12);
          fxSpin = lerp(fxSpin, target, target > fxSpin ? 0.25 : 0.05);
          for (let i = 0; i < layerFx.length; i++) {
            if (!layerFx[i].length) continue;
            const hostOpacity = (cardMeshes[i].material as THREE.ShaderMaterial)
              .uniforms.uOpacity.value;
            for (const fx of layerFx[i]) fx.update({ dt, spin: fxSpin, hostOpacity });
          }
        }
        lastFxNow = now;

        updateSparkles(now);
        renderer.render(scene, camera);
      }

      // Pre-warm GPU shader programs for the torn pack + cards. They're hidden until
      // you tear, so their first draw (mid-tear) is when they'd otherwise compile —
      // that's the one-time hitch on the first rip. compileAsync compiles them now,
      // in parallel (non-blocking), while the pack just idles/spins. Visibility is
      // flipped only so the compile pass sees these materials, then restored before
      // the first render — so nothing actually draws in this state.
      {
        const wasTorn = tornGroup.visible;
        const wasCards = cardsGroup.visible;
        tornGroup.visible = true;
        cardsGroup.visible = true;
        try {
          renderer.compileAsync?.(scene, camera);
        } catch {
          /* unsupported → first tear just pays the compile, as before */
        }
        tornGroup.visible = wasTorn;
        cardsGroup.visible = wasCards;
      }

      frame();

      teardown = () => {
        cancelAnimationFrame(raf);
        ro.disconnect();
        layerFx.forEach((hs) => hs.forEach((h) => h.dispose()));
        layerTexHandles.forEach((h) => h.dispose());
        edgeFade?.dispose();
        canvas.removeEventListener("pointerdown", onDown);
        canvas.removeEventListener("pointermove", onMove);
        canvas.removeEventListener("pointerup", onUp);
        canvas.removeEventListener("pointercancel", onUp);
        scene.traverse((o) => {
          if (o instanceof THREE.Mesh) {
            o.geometry?.dispose();
            const mats = Array.isArray(o.material) ? o.material : [o.material];
            mats.forEach((m) => {
              (m as THREE.MeshStandardMaterial).map?.dispose();
              (m as THREE.ShaderMaterial).uniforms?.map?.value?.dispose?.();
              m.dispose();
            });
          }
        });
        starTex.dispose();
        starMat.dispose();
        trailMat.dispose();
        foilNormal.dispose();
        envTex.dispose();
        pmrem.dispose();
        texCache.forEach((t) => t.dispose());
        dummyTex.dispose();
        sparkGeo.dispose();
        sparkMat.dispose();
        sparkTex.dispose();
        renderer.dispose();
        // Actively release the WebGL context. dispose() alone leaves the context
        // alive until GC, so repeated opens pile up contexts (browsers cap ~16) and
        // the whole tab gets progressively laggier. forceContextLoss frees it now.
        try {
          renderer.forceContextLoss();
        } catch {
          /* ignore */
        }
        // Stop and release any preloaded card sounds.
        soundCache.forEach((a) => {
          try {
            a.pause();
            a.src = "";
          } catch {
            /* ignore */
          }
        });
        soundCache.clear();
      };
    })();

    return () => {
      disposed = true;
      teardown();
    };
  });

  function handleKey(e: KeyboardEvent) {
    if (e.key === "Escape") {
      if (stage === "inspect") goBackToGrid();
      else onClose();
    } else if (stage === "cards" && e.key === "ArrowRight")
      goTo(currentIndex + 1);
    else if (stage === "cards" && e.key === "ArrowLeft") goTo(currentIndex - 1);
  }
</script>

<svelte:window on:keydown={handleKey} />

<div
  class="overlay"
  role="dialog"
  aria-modal="true"
  aria-label="Opening {pack.name}"
>
  <button class="close" onclick={onClose} aria-label="Close">✕</button>
  <div class="volume">
    <button
      class="vol-icon"
      onclick={toggleMute}
      aria-label={volume === 0 ? 'Unmute' : 'Mute'}
      title={volume === 0 ? 'Unmute' : 'Mute'}
    >
      {volume === 0 ? '🔇' : volume < 0.5 ? '🔉' : '🔊'}
    </button>
    <input
      class="vol-slider"
      type="range"
      min="0"
      max="1"
      step="0.01"
      bind:value={volume}
      aria-label="Volume"
    />
  </div>

  <canvas bind:this={canvas}></canvas>

  <div class="hud">
    {#if stage === "pack"}
      <p class="title">{pack.name}</p>
      <p class="hint">
        {locked
          ? "Swipe across the top to rip it open"
          : "Drag to spin the pack"}
      </p>
      <div class="pack-actions">
        <button
          class="lock"
          class:on={locked}
          onclick={() => (locked = !locked)}
          aria-pressed={locked}
        >
          {locked ? "🔒 Rotation locked" : "🔓 Rotation free"}
        </button>
        <button class="rip" onclick={() => { primeAudio(); triggerRip(); }}>Rip open</button>
      </div>
    {:else if stage === "cards"}
      {#if currentCard}
        <p class="card-name" style="--rarity: {currentRarity?.color}">
          {#if currentIsNew}<span class="new-badge">NEW</span>{/if}
          {currentCard.name}
          <span class="card-sub">
            {currentRarity?.label}{#if currentCard.level}
              · lvl {currentCard.level}{/if}
          </span>
          {#if currentHolo}
            <span class="holo-tag">✦ {currentHolo}</span>
          {/if}
        </p>
      {/if}
      <div class="nav">
        <button
          onclick={() => goTo(currentIndex - 1)}
          disabled={currentIndex === 0}
          aria-label="Previous">‹</button
        >
        <span class="counter">{currentIndex + 1} / {total}</span>
        <button onclick={() => goTo(currentIndex + 1)} aria-label="Next"
          >›</button
        >
      </div>
      <p class="hint">Swipe to flip through · tap a card to flip it</p>
    {:else if stage === "grid"}
      <p class="title">Your pull</p>
      <p class="hint">Tap a card to view it</p>
      <button class="rip" onclick={onClose}>Done</button>
    {:else if stage === "inspect"}
      {#if currentCard}
        <p class="card-name" style="--rarity: {currentRarity?.color}">
          {#if currentIsNew}<span class="new-badge">NEW</span>{/if}
          {currentCard.name}
          <span class="card-sub">
            {currentRarity?.label}{#if currentCard.level}
              · lvl {currentCard.level}{/if}
          </span>
          {#if currentHolo}
            <span class="holo-tag">✦ {currentHolo}</span>
          {/if}
        </p>
      {/if}
      <p class="hint">Tap to flip · drag to rotate</p>
      <button class="rip" onclick={() => goBackToGrid()}>← Back</button>
    {/if}
  </div>
</div>

<style>
  .overlay {
    position: fixed;
    inset: 0;
    z-index: 100;
    background: radial-gradient(circle at 50% 35%, #2a2218, #000000);
    touch-action: none;
    display: flex;
    flex-direction: column;
  }

  canvas {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    touch-action: none;
    cursor: grab;
  }

  canvas:active {
    cursor: grabbing;
  }

  .close {
    position: absolute;
    top: 1rem;
    right: 1rem;
    z-index: 2;
    width: 2.5rem;
    height: 2.5rem;
    min-height: 0;
    border-radius: 999px;
    background: rgba(0, 0, 0, 0.5);
    border: 1px solid var(--border-strong);
    color: var(--text);
    font-size: 1rem;
    cursor: pointer;
  }

  .close:hover {
    border-color: var(--accent);
    color: var(--accent);
  }

  .volume {
    position: absolute;
    top: 1rem;
    right: 3.75rem;
    z-index: 2;
    display: flex;
    align-items: center;
    gap: 0.35rem;
    height: 2.5rem;
    padding: 0 0.6rem 0 0.25rem;
    border-radius: 999px;
    background: rgba(0, 0, 0, 0.5);
    border: 1px solid var(--border-strong);
  }

  .vol-icon {
    min-height: 0;
    width: 1.9rem;
    height: 1.9rem;
    padding: 0;
    background: none;
    border: none;
    color: var(--text);
    font-size: 1rem;
    cursor: pointer;
  }

  .vol-slider {
    width: 6rem;
    accent-color: var(--accent);
    cursor: pointer;
  }

  @media (max-width: 560px) {
    .vol-slider {
      width: 4.5rem;
    }
  }

  .hud {
    position: absolute;
    left: 0;
    right: 0;
    bottom: 0;
    z-index: 2;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 0.6rem;
    padding: 1.5rem;
    pointer-events: none;
    text-align: center;
  }

  .hud button {
    pointer-events: auto;
  }

  .title {
    margin: 0;
    font-family: "rsbold", ui-sans-serif, Arial, sans-serif;
    font-size: 1.5rem;
    color: var(--accent);
    text-shadow: var(--ts-strong);
  }

  .card-name {
    margin: 0;
    font-family: "rsbold", ui-sans-serif, Arial, sans-serif;
    font-size: 1.4rem;
    color: var(--rarity, var(--text));
    text-shadow: var(--ts-strong);
    display: flex;
    flex-direction: column;
    gap: 0.1rem;
  }

  .card-sub {
    font-family: "rssmall", ui-sans-serif, Arial, sans-serif;
    font-size: 0.85rem;
    color: rgba(255, 255, 255, 0.7);
  }

  .new-badge {
    align-self: center;
    font-family: "rsbold", ui-sans-serif, Arial, sans-serif;
    font-size: 0.8rem;
    letter-spacing: 1.5px;
    color: #ff4d4d;
    border: 2px solid #ff4d4d;
    border-radius: 4px;
    padding: 0.05rem 0.45rem;
    margin-bottom: 0.15rem;
    text-shadow: none;
    box-shadow: 0 0 6px rgba(255, 0, 0, 0.55);
    animation: new-pulse 1.1s ease-in-out infinite;
  }

  @keyframes new-pulse {
    0%,
    100% {
      box-shadow: 0 0 5px rgba(255, 0, 0, 0.45);
    }
    50% {
      box-shadow: 0 0 11px rgba(255, 0, 0, 0.85);
    }
  }

  .holo-tag {
    font-family: "rssmall", ui-sans-serif, Arial, sans-serif;
    font-size: 0.8rem;
    color: #fff;
    background: linear-gradient(
      90deg,
      #ff5e5e,
      #ffe14d,
      #5effa0,
      #5ec8ff,
      #b06bff
    );
    -webkit-background-clip: text;
    background-clip: text;
    -webkit-text-fill-color: transparent;
    text-shadow: none;
  }

  .hint {
    margin: 0;
    font-size: 0.9rem;
    color: rgba(255, 255, 255, 0.55);
    text-shadow: var(--ts);
  }

  .pack-actions {
    display: flex;
    gap: 0.6rem;
    align-items: center;
    flex-wrap: wrap;
    justify-content: center;
  }

  .lock {
    border-color: var(--border-strong);
    color: rgba(255, 255, 255, 0.8);
    background: rgba(0, 0, 0, 0.45);
    padding: 0 1rem;
  }

  .lock.on {
    border-color: var(--accent);
    color: var(--accent);
    background: rgba(255, 152, 31, 0.12);
  }

  .rip {
    border-color: var(--accent);
    color: var(--accent);
    font-family: "rsbold", ui-sans-serif, Arial, sans-serif;
    background: rgba(255, 152, 31, 0.12);
    padding: 0 1.5rem;
  }

  .rip:hover {
    background: var(--accent-soft);
  }

  .nav {
    display: flex;
    align-items: center;
    gap: 1rem;
  }

  .nav button {
    width: 3rem;
    height: 3rem;
    min-height: 0;
    border-radius: 999px;
    font-size: 1.5rem;
    background: rgba(0, 0, 0, 0.5);
    border: 1px solid var(--border-strong);
    color: var(--text);
    cursor: pointer;
  }

  .nav button:hover:not(:disabled) {
    border-color: var(--accent);
    color: var(--accent);
  }

  .nav button:disabled {
    opacity: 0.35;
    cursor: not-allowed;
  }

  .counter {
    min-width: 4rem;
    color: rgba(255, 255, 255, 0.8);
    text-shadow: var(--ts);
  }
</style>

// Holo card shaders — the 3D foil look used for revealed cards. Shared by the
// pack-open reveal (PackOpener.svelte) and the collection inspector
// (CardInspector3D.svelte) so both render identically.
//
// The foil is a colour texture (uHoloTex — star / ripple) overlaid onto the card
// front, confined to a region by a mask (uMask, its ALPHA channel: opaque = apply
// foil here). `uHas` = 1 for a holo card (0 = Normal, foil skipped). The foil
// slides with the card's tilt so the colours travel as you angle it, and blooms
// toward grazing angles (fresnel). `uReveal` = 1 for a focused/front card (cards
// behind it are dimmed). `uStrength` scales the foil; `uOpacity` fades the card.

export const HOLO_VERT = `
	varying vec2 vUv;
	varying vec3 vNormal;
	varying vec3 vViewPos;
	void main() {
		vUv = uv;
		vec4 mv = modelViewMatrix * vec4(position, 1.0);
		vViewPos = -mv.xyz;
		vNormal = normalMatrix * normal;
		gl_Position = projectionMatrix * mv;
	}
`;

// Soft drop shadow for a raised depth layer: renders the layer's silhouette (its
// alpha) as a blurred dark shape. Placed on the card's base surface and offset by
// the layer's height, it grounds the layer so it reads as popping OUT of the card
// instead of floating above it. uBlur = penumbra radius (uv); uOpacity = darkness.
export const LAYER_SHADOW_FRAG = `
	uniform sampler2D map;
	uniform float uOpacity;
	uniform vec2 uBlur;
	varying vec2 vUv;
	void main() {
		// 9-tap box blur of the alpha for a soft penumbra
		float a = texture2D(map, vUv).a * 0.36;
		a += texture2D(map, vUv + vec2(uBlur.x, 0.0)).a * 0.1;
		a += texture2D(map, vUv - vec2(uBlur.x, 0.0)).a * 0.1;
		a += texture2D(map, vUv + vec2(0.0, uBlur.y)).a * 0.1;
		a += texture2D(map, vUv - vec2(0.0, uBlur.y)).a * 0.1;
		a += texture2D(map, vUv + uBlur).a * 0.06;
		a += texture2D(map, vUv - uBlur).a * 0.06;
		a += texture2D(map, vUv + vec2(uBlur.x, -uBlur.y)).a * 0.06;
		a += texture2D(map, vUv + vec2(-uBlur.x, uBlur.y)).a * 0.06;
		gl_FragColor = vec4(0.0, 0.0, 0.0, a * uOpacity);
	}
`;

// Soft additive glow for a depth layer (the 'glow' layer effect). Blurs the layer
// texture and emits it additively, tinted, so the glow follows the layer's SHAPE
// (a lightning PNG glows along the bolt — transparent pixels add nothing, no SVG
// needed). uIntensity (0 = off) is driven by how fast the card is being spun, so
// the layer only lights up while you turn it. uBlur = halo spread (uv). uFeather =
// margin over which the glow fades to nothing at the card edge, so art that reaches
// the border doesn't hard-cut into a straight line.
export const LAYER_GLOW_FRAG = `
	uniform sampler2D map;
	uniform float uIntensity;
	uniform vec2 uBlur;
	uniform vec2 uFeather;
	uniform vec3 uTint;
	varying vec2 vUv;
	vec3 lin2srgb(vec3 c) {
		c = clamp(c, 0.0, 1.0);
		return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c));
	}
	void main() {
		// blurred, alpha-premultiplied sample → a soft halo confined to the layer's
		// opaque pixels. Weights are a 1D gaussian applied on each axis (9 taps).
		float w0 = 0.227, w1 = 0.194, w2 = 0.121, w3 = 0.054;
		vec4 c = texture2D(map, vUv);
		vec4 acc = vec4(c.rgb * c.a, c.a) * w0;
		for (int i = 1; i < 4; i++) {
			float fi = float(i);
			float wi = i == 1 ? w1 : (i == 2 ? w2 : w3);
			vec2 ox = vec2(uBlur.x * fi, 0.0);
			vec2 oy = vec2(0.0, uBlur.y * fi);
			vec4 s1 = texture2D(map, vUv + ox);
			vec4 s2 = texture2D(map, vUv - ox);
			vec4 s3 = texture2D(map, vUv + oy);
			vec4 s4 = texture2D(map, vUv - oy);
			acc += (vec4(s1.rgb * s1.a, s1.a) + vec4(s2.rgb * s2.a, s2.a)
				+ vec4(s3.rgb * s3.a, s3.a) + vec4(s4.rgb * s4.a, s4.a)) * wi;
		}
		// normalise by the total tap weight (~1.703) so the halo brightness is ~1 at
		// full opacity rather than inflated by the kernel sum
		float a = acc.a / 1.703;
		vec3 col = (acc.rgb / max(acc.a, 0.001)) * uTint; // average colour of the halo, tinted
		// fade the glow smoothly toward the card edge so it never hard-cuts
		vec2 e = smoothstep(vec2(0.0), uFeather, vUv) * smoothstep(vec2(0.0), uFeather, 1.0 - vUv);
		float edge = e.x * e.y;
		// additive: rgb carries the brightness (scaled by intensity), alpha the shape
		gl_FragColor = vec4(lin2srgb(col) * uIntensity, a * edge);
	}
`;

export const HOLO_FRAG = `
	uniform sampler2D map;
	uniform sampler2D uHoloTex;
	uniform sampler2D uMask;
	uniform float uHas;
	uniform float uStrength;
	uniform float uOpacity;
	uniform float uReveal;
	varying vec2 vUv;
	varying vec3 vNormal;
	varying vec3 vViewPos;
	// sRGB textures are GPU-decoded to linear on sample; re-encode the final colour
	// to sRGB for display (built-in materials do this for us, ShaderMaterial does
	// not) — otherwise the cards render dark/dull.
	vec3 lin2srgb(vec3 c) {
		c = clamp(c, 0.0, 1.0);
		return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c));
	}
	void main() {
		vec4 base = texture2D(map, vUv);
		vec3 col = base.rgb;

		if (uHas > 0.5) {
			vec3 N = normalize(vNormal);
			vec3 V = normalize(vViewPos);
			float fres = pow(1.0 - clamp(dot(N, V), 0.0, 1.0), 2.0);
			vec2 tilt = N.xy;

			// region = the mask's alpha (opaque = apply the foil here)
			float region = texture2D(uMask, vUv).a;

			// slide the foil with the tilt so its colours travel as the card angles.
			// the foil texture uses MIRRORED-repeat wrapping, so this offset reflects
			// at the texture edge instead of showing a hard seam running onto the card.
			vec2 huv = vUv + tilt * 0.22;
			vec3 foil = texture2D(uHoloTex, huv).rgb;

			// foil strength: subtle head-on, blooms at grazing angles.
			float amt = uStrength * region * uReveal * (0.18 + 0.6 * fres);
			// Keep the foil off the extreme card edge — full-art / reverse-holo masks
			// reach the border, so without this the foil spills over the card's rounded
			// edge. Fades over a small margin from each side (regular holo's mask is
			// interior, so it's unaffected). The card art itself is untouched.
			vec2 ef = smoothstep(vec2(0.0), vec2(0.03), vUv) * smoothstep(vec2(0.0), vec2(0.03), 1.0 - vUv);
			float edgeMask = ef.x * ef.y;
			amt *= edgeMask;
			// Screen-blend reads as reflective foil, but screen can only LIGHTEN, so it
			// only truly fails where ALL channels are already high (white / light grey)
			// — a saturated or dark colour still has a low channel for screen to lift.
			// So measure WHITENESS as the min channel and only fade toward linear-light
			// (which also darkens, making foil visible) for near-white art. Dark, mid,
			// and saturated colours keep the original, subtler reflective look.
			vec3 screenCol = 1.0 - (1.0 - col) * (1.0 - foil * amt);
			vec3 linearCol = col + (foil - 0.5) * amt * 2.0;
			float whiteness = min(min(col.r, col.g), col.b);
			col = mix(screenCol, linearCol, smoothstep(0.6, 0.95, whiteness));
			// a touch of extra additive sparkle right at the edge (shows on darker art)
			col += foil * region * uStrength * fres * 0.22 * uReveal * edgeMask;
		}

		// cards behind the focused one are dimmed a touch so they recede
		col *= mix(0.55, 1.0, uReveal);
		gl_FragColor = vec4(lin2srgb(col), base.a * uOpacity);
	}
`;

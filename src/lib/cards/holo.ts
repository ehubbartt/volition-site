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

			// screen-blend the foil over the base (reads as reflective foil, not paint),
			// scaled by region, how much the card is revealed, and the viewing angle so
			// it's subtle head-on and blooms at grazing angles.
			float amt = uStrength * region * uReveal * (0.18 + 0.6 * fres);
			col = 1.0 - (1.0 - col) * (1.0 - foil * amt);
			// a touch of extra additive sparkle right at the edge
			col += foil * region * uStrength * fres * 0.22 * uReveal;
		}

		// cards behind the focused one are dimmed a touch so they recede
		col *= mix(0.55, 1.0, uReveal);
		gl_FragColor = vec4(lin2srgb(col), base.a * uOpacity);
	}
`;

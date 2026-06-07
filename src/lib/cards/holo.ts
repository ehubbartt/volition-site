// Holo card shaders — the 3D foil look used for revealed cards. Used by the
// collection inspector (CardInspector3D.svelte). These MIRROR the holo shaders
// inlined in PackOpener.svelte (the pack-open reveal); if you retune the holo
// look in one, update the other so the inspector matches the opener.
//
// The look is self-contained in the fragment shader (it derives its own
// fresnel/flow from the surface normal — no scene lights needed). `uHolo` =
// rainbow strength, `uSheen` = moving glare, `uPattern` = which holo pattern
// (0 stripe, 1 sparkle, 2 wave, 3 prism), `uReveal` = 1 for a focused card.

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

export const HOLO_FRAG = `
	uniform sampler2D map;
	uniform float uHolo;
	uniform float uSheen;
	uniform float uOpacity;
	uniform float uReveal;
	uniform int uPattern;
	varying vec2 vUv;
	varying vec3 vNormal;
	varying vec3 vViewPos;
	// the sRGB texture is GPU-decoded to linear on sample; re-encode the final
	// colour to sRGB for display (built-in materials do this for us, ShaderMaterial
	// does not) — otherwise the cards render dark/dull.
	vec3 lin2srgb(vec3 c) {
		c = clamp(c, 0.0, 1.0);
		return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c));
	}
	void main() {
		vec4 base = texture2D(map, vUv);
		vec3 N = normalize(vNormal);
		vec3 V = normalize(vViewPos);
		float fres = pow(1.0 - clamp(dot(N, V), 0.0, 1.0), 3.0);

		// motion driven by how the card is tilted toward the viewer (no time)
		vec2 tilt = N.xy;
		float flow = (tilt.x + tilt.y) * 9.0;

		vec2 p = vUv;
		float phase;
		float glare;

		if (uPattern == 0) {
			phase = (p.x + p.y) * 5.0 + flow;
			glare = smoothstep(0.6, 1.0, sin((p.x + p.y) * 7.0 + flow * 1.4 + fres * 3.0));
		} else if (uPattern == 1) {
			vec2 cell = fract(p * 9.0) - 0.5;
			float d = length(cell);
			float tw = 0.5 + 0.5 * sin(flow * 1.5 + (floor(p.x * 9.0) + floor(p.y * 9.0)) * 1.7);
			phase = p.x * 5.0 - p.y * 5.0 + flow;
			glare = smoothstep(0.32, 0.0, d) * tw;
		} else if (uPattern == 2) {
			float r = length(p - 0.5);
			phase = r * 9.0 + flow;
			glare = smoothstep(0.6, 1.0, sin(r * 34.0 + flow * 2.0 + fres * 4.0));
		} else {
			vec2 c = p - 0.5;
			float a = atan(c.y, c.x);
			float r = length(c);
			phase = a * 1.5 + r * 4.0 + flow;
			glare = smoothstep(0.6, 1.0, sin(a * 8.0 + flow + r * 10.0));
		}

		vec3 rainbow = 0.5 + 0.5 * cos(6.28318 * (vec3(0.0, 0.33, 0.67) + phase + fres * 3.0));
		vec3 col = base.rgb;
		col += rainbow * uHolo * (0.3 + fres) * base.a * uReveal;
		col += mix(rainbow, vec3(1.0), 0.25) * glare * uSheen * base.a * uReveal;
		col *= mix(0.55, 1.0, uReveal);
		gl_FragColor = vec4(lin2srgb(col), base.a * uOpacity);
	}
`;

// Extra floating holo sheet for the top tier (additive, layered-depth shimmer).
export const HOLO_OVERLAY_FRAG = `
	uniform float uOpacity;
	varying vec2 vUv;
	varying vec3 vNormal;
	varying vec3 vViewPos;
	void main() {
		vec3 N = normalize(vNormal);
		vec3 V = normalize(vViewPos);
		float fres = pow(1.0 - clamp(dot(N, V), 0.0, 1.0), 2.0);
		vec2 tilt = N.xy;
		float flow = (tilt.x + tilt.y) * 9.0;
		vec2 p = vUv + tilt * 0.18;
		vec2 c = p - 0.5;
		float a = atan(c.y, c.x);
		float r = length(c);
		float band = sin(a * 10.0 + flow + r * 14.0);
		float mask = smoothstep(0.45, 1.0, band) * (0.25 + fres);
		vec3 rainbow = 0.5 + 0.5 * cos(6.28318 * (vec3(0.0, 0.33, 0.67) + a + flow * 0.3));
		gl_FragColor = vec4(rainbow * mask, mask * uOpacity * 0.07);
	}
`;

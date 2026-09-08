<script lang="ts">
	// The Connect Four board in three.js — the same game state as Connect4Board.svelte,
	// rendered as an actual slotted frame with discs behind it.
	//
	// It takes the SAME props as the 2D board (`pieces`, `revealed`, `falling`, `runCells`)
	// so the playback clock drives either one without knowing which is mounted, and the two
	// can never disagree about what the board looks like.
	//
	// Shape of the scene:
	//   - a back panel, so an empty hole reads as a dark socket rather than a window onto
	//     the page background;
	//   - the FRAME IN FRONT of the discs, extruded from one Shape with 250 circular holes
	//     punched in it — that is what makes it look like the board game rather than a grid
	//     of circles;
	//   - discs as two InstancedMeshes (one per side), because 250 individual meshes is a
	//     lot of draw calls for something a phone might be rendering in software;
	//   - the ONE piece currently falling as a real mesh, so its animation doesn't mean
	//     rewriting an instance matrix every frame. It joins the instances when it lands.
	//
	// Hover raycasts a single invisible plane rather than 250 instances: the plane hit maps
	// straight back to a column and row, which is cheaper and exact.
	import { untrack } from 'svelte';
	import * as THREE from 'three';
	import '$lib/cards/threeSetup';
	import { detectWebgl, prefersReducedMotion } from '$lib/cards/glCapabilities';
	import { COLS, ROWS, cellId, type LiveTile, type Piece } from './rules';
	import { FALL_MS } from './playback.svelte';
	import { disposeTokenTextures, tokenTexture } from './tokenTexture';

	let {
		pieces = [],
		live = [],
		cols = COLS,
		rows = ROWS,
		claiming,
		sideColors = ['#ef4444', '#eab308'],
		runCells = new Set<string>(),
		revealed = null,
		falling = null,
		selected = null,
		onselect,
		onhover
	}: {
		pieces: Piece[];
		/** The objective on offer above each column — rendered as the floating tokens. */
		live: (LiveTile | null)[];
		/** Board dimensions. Captured at init — remount (the pages {#key} by game) to change. */
		cols?: number;
		rows?: number;
		/** Columns whose objective is claimed but not yet replaced — their slot stays empty. */
		claiming?: Set<number>;
		sideColors?: string[];
		runCells?: Set<string>;
		revealed?: number | null;
		falling?: string | null;
		selected?: number | null;
		onselect?: (col: number) => void;
		/** Reports what the pointer is over so the page can show one card for either. */
		onhover?: (info: HoverInfo | null) => void;
	} = $props();

	export type HoverInfo =
		| { kind: 'piece'; piece: Piece; x: number; y: number }
		| { kind: 'tile'; tile: LiveTile; x: number; y: number };

	const shown = $derived(revealed === null ? pieces : pieces.slice(0, Math.max(0, revealed)));

	// ── layout constants (world units; one cell is 1 unit) ────────────────────
	// The whole scene is built once in onMount for a FIXED board — a game's size never
	// changes, and the pages remount this component per game — so the dimensions are
	// captured deliberately at init rather than made reactive.
	// svelte-ignore state_referenced_locally
	const NCOLS = cols;
	// svelte-ignore state_referenced_locally
	const NROWS = rows;
	const CELL = 1;
	const HOLE_R = 0.42;
	const DISC_R = 0.4;
	const DISC_D = 0.26;
	const PAD = 0.55;
	const W = NCOLS * CELL + PAD * 2;
	const H = NROWS * CELL + PAD * 2;
	const FRAME_D = 0.42;

	// The objective tokens hover in a band above the frame. TOKEN_GAP is measured from the
	// top of the frame, so the coins clear it without floating off on their own.
	const TOKEN_R = 0.52;
	const TOKEN_D = 0.16;
	const TOKEN_GAP = 1.15;
	const TOKEN_Y = H / 2 + TOKEN_GAP;
	// What the camera has to frame: the board AND the band above it. The scene is no longer
	// centred on the frame, so everything aims at SCENE_CY rather than the origin.
	const SCENE_TOP = TOKEN_Y + TOKEN_R + 0.35;
	const SCENE_H = SCENE_TOP + H / 2;
	const SCENE_CY = (SCENE_TOP - H / 2) / 2;

	// Cell (col,row) → world x/y. Row 0 is the BOTTOM, which is also +y here, so the two
	// coordinate systems agree without a flip anywhere else.
	const wx = (col: number) => (col - (NCOLS - 1) / 2) * CELL;
	const wy = (row: number) => (row - (NROWS - 1) / 2) * CELL;

	let host: HTMLDivElement | null = $state(null);
	let webgl = $state<'ok' | 'software' | 'none'>('ok');
	let ready = $state(false);

	let renderer: THREE.WebGLRenderer | null = null;
	let scene: THREE.Scene | null = null;
	let camera: THREE.PerspectiveCamera | null = null;
	let discMeshes: THREE.InstancedMesh[] = [];
	let glowMesh: THREE.InstancedMesh | null = null;
	let glowMat: THREE.MeshStandardMaterial | null = null;
	let fallingMesh: THREE.Mesh | null = null;
	let pickPlane: THREE.Mesh | null = null;
	/** One coin per column, indexed by column. Hidden where the column has retired. */
	let tokens: THREE.Mesh[] = [];
	let raf = 0;
	let disposed = false;

	// The current fall, as a start time + the cell it is heading for.
	let fall: { startedAt: number; col: number; row: number; side: number } | null = null;
	let lastFallingId: string | null = null;

	const reduced = () => prefersReducedMotion();

	// STRAIGHT ON by default — this is a board you read, and reading 250 cells at an angle
	// is worse than reading them square.
	//
	// Dragging gives a small parallax tilt and nothing more. The limits used to be ±0.5rad,
	// which swung the board (26 units wide) far enough that it overflowed a frame fitted
	// for the straight-on view — and the tokens, sitting ABOVE the board, were the first
	// thing pushed off screen. Keeping the range small means the fit margin below can cover
	// every reachable angle.
	const YAW_HOME = 0;
	const PITCH_HOME = 0;
	let yaw = $state(YAW_HOME);
	let pitch = $state(PITCH_HOME);
	const YAW_LIMIT = 0.22;
	const PITCH_LIMIT = 0.14;

	/** Straight-on box fit — the starting guess for `requiredDistance`. */
	function fitDistance(): number {
		if (!camera) return 20;
		const vFov = (camera.fov * Math.PI) / 180;
		const distH = SCENE_H / 2 / Math.tan(vFov / 2);
		const distW = W / 2 / Math.tan(vFov / 2) / camera.aspect;
		return Math.max(distH, distW) * 1.04;
	}

	// The eight corners of everything that has to stay on screen: the board's own box,
	// extended up to the top of the token band.
	const CORNERS: THREE.Vector3[] = [];
	for (const x of [-W / 2, W / 2])
		for (const y of [-H / 2, SCENE_TOP])
			for (const z of [-DISC_D, FRAME_D / 2 + 0.6]) CORNERS.push(new THREE.Vector3(x, y, z));
	const probe = new THREE.PerspectiveCamera();
	const scratch = new THREE.Vector3();

	function camAt(cam: THREE.PerspectiveCamera, d: number) {
		cam.position.set(
			Math.sin(yaw) * Math.cos(pitch) * d,
			SCENE_CY + Math.sin(pitch) * d,
			Math.cos(yaw) * Math.cos(pitch) * d
		);
		cam.lookAt(0, SCENE_CY, 0);
	}

	/**
	 * How far back the camera has to sit for the WHOLE scene to be on screen at the CURRENT
	 * angle.
	 *
	 * A fixed straight-on fit is wrong the moment you tilt: the tokens sit at the very top
	 * of the scene, so they were the first thing pushed out of frame, and the board just
	 * looked like it had eaten them. Projecting the corners and pushing the distance out
	 * until nothing overflows is correct at any angle, and converges in two or three passes.
	 */
	function requiredDistance(): number {
		if (!camera) return 20;
		probe.fov = camera.fov;
		probe.aspect = camera.aspect;
		probe.near = camera.near;
		probe.far = camera.far;
		let d = fitDistance();
		for (let i = 0; i < 4; i++) {
			camAt(probe, d);
			probe.updateMatrixWorld(true);
			probe.updateProjectionMatrix();
			let worst = 1;
			for (const c of CORNERS) {
				scratch.copy(c).project(probe);
				worst = Math.max(worst, Math.abs(scratch.x), Math.abs(scratch.y));
			}
			if (worst <= 1.002) break;
			d *= worst * 1.01;
		}
		return d;
	}

	function placeCamera() {
		if (!camera) return;
		camAt(camera, requiredDistance());
		camera.updateProjectionMatrix();
	}

	function fitCamera() {
		if (!camera || !renderer || !host) return;
		const w = host.clientWidth || 1;
		const h = host.clientHeight || 1;
		camera.aspect = w / h;
		placeCamera();
		renderer.setSize(w, h, false);
	}

	// ── drag to rotate ────────────────────────────────────────────────────────
	// $state because the template binds a class to it — the grab cursor depends on it.
	let dragging = $state(false);
	let last = { x: 0, y: 0 };
	// A rotate that happens to end over a coin must not also select it.
	let movedWhileDown = false;
	function onDown(e: PointerEvent) {
		dragging = true;
		movedWhileDown = false;
		last = { x: e.clientX, y: e.clientY };
		(e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
	}
	function onUp(e: PointerEvent) {
		dragging = false;
		(e.currentTarget as HTMLElement).releasePointerCapture?.(e.pointerId);
	}
	function onDrag(e: PointerEvent) {
		if (!dragging) return;
		const dx = e.clientX - last.x;
		const dy = e.clientY - last.y;
		if (Math.abs(dx) + Math.abs(dy) > 2) movedWhileDown = true;
		last = { x: e.clientX, y: e.clientY };
		yaw = Math.max(-YAW_LIMIT, Math.min(YAW_LIMIT, yaw + dx * 0.0022));
		pitch = Math.max(-PITCH_LIMIT, Math.min(PITCH_LIMIT, pitch + dy * 0.0022));
		placeCamera();
	}
	function resetView() {
		yaw = YAW_HOME;
		pitch = PITCH_HOME;
		placeCamera();
	}

	/** The frame: one rectangle with a circular hole punched per cell, extruded. */
	function buildFrame(): THREE.Mesh {
		const shape = new THREE.Shape();
		const hw = W / 2;
		const hh = H / 2;
		const r = 0.35; // rounded outer corners
		shape.moveTo(-hw + r, -hh);
		shape.lineTo(hw - r, -hh);
		shape.quadraticCurveTo(hw, -hh, hw, -hh + r);
		shape.lineTo(hw, hh - r);
		shape.quadraticCurveTo(hw, hh, hw - r, hh);
		shape.lineTo(-hw + r, hh);
		shape.quadraticCurveTo(-hw, hh, -hw, hh - r);
		shape.lineTo(-hw, -hh + r);
		shape.quadraticCurveTo(-hw, -hh, -hw + r, -hh);

		for (let c = 0; c < NCOLS; c++) {
			for (let rw = 0; rw < NROWS; rw++) {
				const path = new THREE.Path();
				path.absarc(wx(c), wy(rw), HOLE_R, 0, Math.PI * 2, true);
				shape.holes.push(path);
			}
		}

		const geo = new THREE.ExtrudeGeometry(shape, {
			depth: FRAME_D,
			bevelEnabled: true,
			bevelThickness: 0.05,
			bevelSize: 0.045,
			bevelSegments: 1,
			// 250 holes: keep the segment count modest or the triangulation gets silly.
			curveSegments: 10
		});
		geo.translate(0, 0, -FRAME_D / 2);
		const mat = new THREE.MeshStandardMaterial({ color: 0x2f6ea8, roughness: 0.55, metalness: 0.05 });
		return new THREE.Mesh(geo, mat);
	}

	/**
	 * One coin per column, floating above the frame. The face carries the item art (see
	 * tokenTexture); the rim is the same warm bronze as the site's OSRS chrome.
	 *
	 * A cylinder's groups are [side, top, bottom], and rotating it a quarter turn about X
	 * turns the TOP cap towards the camera — so the face material is index 1.
	 */
	function buildTokens(): THREE.Mesh[] {
		// The BODY is a cylinder turned to face the camera. Its cap UVs are generated in the
		// cylinder's own XZ plane, so turning the geometry turns the artwork with it — which
		// is why the item icons came out rotated a quarter turn. The face is therefore a
		// separate CircleGeometry, whose UVs are laid out in XY facing +Z: no rotation to
		// compensate for, and nothing to get wrong again if the body ever changes.
		const body = new THREE.CylinderGeometry(TOKEN_R, TOKEN_R, TOKEN_D, 28);
		body.rotateX(Math.PI / 2);
		const faceGeo = new THREE.CircleGeometry(TOKEN_R * 0.97, 28);
		const rim = new THREE.MeshStandardMaterial({ color: 0x8a6f3c, roughness: 0.5, metalness: 0.45 });
		return Array.from({ length: NCOLS }, (_, col) => {
			const mesh = new THREE.Mesh(body, rim);
			mesh.position.set(wx(col), TOKEN_Y, 0.35);
			mesh.userData.col = col;
			mesh.frustumCulled = false;
			mesh.visible = false;

			const face = new THREE.Mesh(
				faceGeo,
				new THREE.MeshStandardMaterial({ roughness: 0.55, metalness: 0.05 })
			);
			// Just proud of the rim so it never z-fights with the cap behind it.
			face.position.z = TOKEN_D / 2 + 0.004;
			face.frustumCulled = false;
			mesh.add(face);
			mesh.userData.face = face;

			scene!.add(mesh);
			return mesh;
		});
	}

	/** Point each coin at the item its column is currently offering. */
	function syncTokens() {
		for (let col = 0; col < NCOLS; col++) {
			const mesh = tokens[col];
			if (!mesh) continue;
			// A claimed column has no coin until the server names the replacement: showing
			// the old one again would say the objective is still up for grabs.
			const slot = claiming?.has(col) ? null : (live[col] ?? null);
			// A column mid-drop keeps its coin — the fall animation owns it until it lands.
			if (!slot) {
				if (!fall || fall.col !== col) mesh.visible = false;
				continue;
			}
			mesh.visible = true;
			const faceMesh = mesh.userData.face as THREE.Mesh | undefined;
			const mat = faceMesh?.material as THREE.MeshStandardMaterial | undefined;
			if (!mat) continue;
			// A group tile's display name isn't an item — draw its first member's icon.
			const tex = tokenTexture(slot.tile.any_of?.[0]?.item_name ?? slot.tile.item_name);
			if (mat.map !== tex) {
				mat.map = tex;
				mat.needsUpdate = true;
			}
			const isSel = selected === col;
			mat.emissive.set(isSel ? 0x664400 : 0x000000);
			mat.emissiveIntensity = isSel ? 0.9 : 0;
		}
	}

	function init() {
		if (!host) return;
		// `bind:this` sets `host` after the first effect run, so this effect runs twice and
		// the cleanup fires in between. Without clearing the flag the render loop bails on
		// its first frame and the canvas stays empty forever.
		disposed = false;
		const probe = detectWebgl();
		webgl = probe.tier;
		if (probe.tier === 'none') return;

		scene = new THREE.Scene();
		camera = new THREE.PerspectiveCamera(38, 1, 0.1, 200);

		renderer = new THREE.WebGLRenderer({ antialias: probe.tier === 'ok', alpha: true });
		renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, probe.tier === 'ok' ? 2 : 1));
		host.appendChild(renderer.domElement);
		renderer.domElement.style.width = '100%';
		renderer.domElement.style.height = '100%';
		renderer.domElement.style.display = 'block';

		// Lights: one key from the front-left, a soft fill, and ambient so the dark
		// sockets don't go pure black.
		scene.add(new THREE.AmbientLight(0xffffff, 1.5));
		const key = new THREE.DirectionalLight(0xffffff, 2.1);
		key.position.set(-6, 8, 12);
		scene.add(key);
		const fill = new THREE.DirectionalLight(0x99bbff, 0.7);
		fill.position.set(8, -6, 6);
		scene.add(fill);

		// Back panel — what you see through an empty hole.
		const back = new THREE.Mesh(
			new THREE.PlaneGeometry(W, H),
			new THREE.MeshStandardMaterial({ color: 0x0a141c, roughness: 0.95 })
		);
		back.position.z = -DISC_D;
		scene.add(back);

		scene.add(buildFrame());

		// Discs — one instanced mesh per side.
		const discGeo = new THREE.CylinderGeometry(DISC_R, DISC_R, DISC_D, 22);
		discGeo.rotateX(Math.PI / 2); // face the camera
		discMeshes = sideColors.map((hex) => {
			const m = new THREE.InstancedMesh(
				discGeo,
				new THREE.MeshStandardMaterial({ color: new THREE.Color(hex), roughness: 0.35, metalness: 0.1 }),
				NCOLS * NROWS
			);
			m.count = 0;
			m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
			m.frustumCulled = false;
			scene!.add(m);
			return m;
		});

		// Scoring runs get a glowing ring sitting just proud of the disc.
		glowMat = new THREE.MeshStandardMaterial({
			color: 0xffffff,
			emissive: new THREE.Color(0xffffff),
			emissiveIntensity: 1.2,
			transparent: true,
			opacity: 0.9
		});
		glowMesh = new THREE.InstancedMesh(new THREE.TorusGeometry(DISC_R * 0.96, 0.045, 8, 24), glowMat, NCOLS * NROWS);
		glowMesh.count = 0;
		glowMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
		glowMesh.frustumCulled = false;
		scene.add(glowMesh);

		// The single falling piece.
		fallingMesh = new THREE.Mesh(discGeo, new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.35 }));
		fallingMesh.visible = false;
		scene.add(fallingMesh);

		tokens = buildTokens();

		// Invisible pick plane at disc depth — one raycast target instead of 250.
		pickPlane = new THREE.Mesh(new THREE.PlaneGeometry(W, H), new THREE.MeshBasicMaterial({ visible: false }));
		scene.add(pickPlane);

		fitCamera();
		ready = true;
		syncDiscs();
		syncTokens();
		loop();
	}

	const dummy = new THREE.Object3D();

	/** Push the current board into the instanced meshes. */
	function syncDiscs() {
		if (!discMeshes.length) return;
		const counts = [0, 0];
		for (const p of shown) {
			if (falling && p.id === falling) continue; // drawn by the falling mesh instead
			const idx = p.side - 1;
			const mesh = discMeshes[idx];
			if (!mesh) continue;
			dummy.position.set(wx(p.col), wy(p.row), 0);
			dummy.rotation.set(0, 0, 0);
			dummy.scale.setScalar(1);
			dummy.updateMatrix();
			mesh.setMatrixAt(counts[idx], dummy.matrix);
			counts[idx]++;
		}
		discMeshes.forEach((m, i) => {
			m.count = counts[i];
			m.instanceMatrix.needsUpdate = true;
		});

		if (glowMesh) {
			let g = 0;
			for (const p of shown) {
				if (!runCells.has(cellId(p.col, p.row))) continue;
				dummy.position.set(wx(p.col), wy(p.row), DISC_D / 2 + 0.02);
				dummy.rotation.set(0, 0, 0);
				dummy.scale.setScalar(1);
				dummy.updateMatrix();
				glowMesh.setMatrixAt(g, dummy.matrix);
				g++;
			}
			glowMesh.count = g;
			glowMesh.instanceMatrix.needsUpdate = true;
		}
	}

	function loop() {
		if (disposed) return;
		raf = requestAnimationFrame(loop);
		if (!renderer || !scene || !camera) return;

		// THE CLAIM. The objective's coin drops out of the band and INTO the column, becoming
		// the piece — one continuous motion in two halves, so the whole thing still fits the
		// FALL_MS the playback clock hands out and replay needs no special case.
		//
		//   0 .. HANDOFF   the coin falls from the band to the top row, shrinking
		//   HANDOFF .. 1   the coloured disc carries on from that same spot, with the bounce
		//
		// The handoff is at one x and an adjacent y, so it reads as the coin turning into the
		// piece rather than two objects swapping.
		const HANDOFF = 0.35;
		if (fall && fallingMesh) {
			const t = Math.min(1, (performance.now() - fall.startedAt) / FALL_MS);
			const entry = wy(NROWS - 1);
			const coin = tokens[fall.col];

			if (t < HANDOFF) {
				const k = t / HANDOFF;
				if (coin) {
					coin.visible = true;
					coin.position.set(wx(fall.col), TOKEN_Y + (entry - TOKEN_Y) * (k * k), 0.35 * (1 - k));
					const shrink = 1 - 0.35 * k;
					coin.scale.setScalar(shrink);
					coin.rotation.z = k * 0.9;
				}
				fallingMesh.visible = false;
			} else {
				if (coin) {
					// The coin is spent; the replacement takes its place up in the band.
					coin.scale.setScalar(1);
					coin.rotation.z = 0;
					coin.position.set(wx(fall.col), TOKEN_Y, 0.35);
					coin.visible = !!live[fall.col] && !claiming?.has(fall.col);
				}
				const k = (t - HANDOFF) / (1 - HANDOFF);
				const target = wy(fall.row);
				let y: number;
				if (k < 0.72) {
					const e = k / 0.72;
					y = entry + (target - entry) * (e * e);
				} else {
					const e = (k - 0.72) / 0.28;
					y = target + Math.sin(e * Math.PI) * 0.32;
				}
				fallingMesh.visible = true;
				fallingMesh.position.set(wx(fall.col), y, 0);
			}

			if (t >= 1) {
				fall = null;
				fallingMesh.visible = false;
				syncDiscs();
				syncTokens();
			}
		}

		// The coins bob, each on its own phase so 25 of them don't move in lockstep. Kept
		// well under the 1-unit column spacing so neighbours never intersect.
		if (!reduced()) {
			const now = performance.now() / 1000;
			for (let col = 0; col < NCOLS; col++) {
				const coin = tokens[col];
				if (!coin?.visible || (fall && fall.col === col)) continue;
				const phase = col * 0.7;
				const lift = selected === col ? 0.3 : 0;
				coin.position.y = TOKEN_Y + lift + Math.sin(now * 1.3 + phase) * 0.09;
				coin.rotation.y = Math.sin(now * 0.8 + phase) * 0.28;
			}
		}

		if (glowMat) {
			glowMat.emissiveIntensity = reduced() ? 1.1 : 0.75 + Math.sin(performance.now() / 260) * 0.55;
		}
		renderer.render(scene, camera);
	}

	// ── hover ─────────────────────────────────────────────────────────────────
	const ray = new THREE.Raycaster();
	const ndc = new THREE.Vector2();
	/** The coin under the pointer, if any. Only 25 meshes, so raycasting them is cheap. */
	function coinAt(e: PointerEvent): { col: number; top: number } | null {
		if (!camera || !renderer) return null;
		const rect = renderer.domElement.getBoundingClientRect();
		ndc.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
		ndc.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
		ray.setFromCamera(ndc, camera);
		const hit = ray.intersectObjects(tokens.filter((t) => t.visible), false)[0];
		if (!hit) return null;
		const col = (hit.object as THREE.Mesh).userData.col as number;
		// Screen y of the coin's top edge, so the page can anchor a card above it.
		const p = new THREE.Vector3(wx(col), TOKEN_Y + TOKEN_R, 0.35).project(camera);
		return { col, top: rect.top + ((1 - p.y) / 2) * rect.height };
	}

	function onMove(e: PointerEvent) {
		if (!camera || !pickPlane || !renderer || !onhover) return;
		const rect = renderer.domElement.getBoundingClientRect();

		// Coins sit in front of the board and are what the pointer is most likely aiming at.
		const coin = coinAt(e);
		if (coin) {
			const slot = live[coin.col];
			hoverCol = coin.col;
			return onhover(slot ? { kind: 'tile', tile: slot, x: e.clientX, y: coin.top } : null);
		}
		hoverCol = null;

		ndc.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
		ndc.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
		ray.setFromCamera(ndc, camera);
		const hit = ray.intersectObject(pickPlane, false)[0];
		if (!hit) return onhover(null);
		const col = Math.round(hit.point.x / CELL + (NCOLS - 1) / 2);
		const row = Math.round(hit.point.y / CELL + (NROWS - 1) / 2);
		const piece = shown.find((p) => p.col === col && p.row === row);
		onhover(
			piece
				? { kind: 'piece', piece, x: e.clientX, y: rect.top + ((1 - (hit.point.y + H / 2) / H) * rect.height) }
				: null
		);
	}

	/** Which column's coin the pointer is over — drives the grab/pointer cursor. */
	let hoverCol = $state<number | null>(null);

	function onClick(e: PointerEvent) {
		// A drag that ends over a coin shouldn't also select it.
		if (movedWhileDown) return;
		const coin = coinAt(e);
		if (coin && live[coin.col]) onselect?.(coin.col);
	}

	$effect(() => {
		// `host` is the ONLY thing that should rebuild the scene. `init()` reaches
		// `placeCamera()`, which reads yaw/pitch — so without untrack this effect tracked
		// them, and every drag tore the whole scene down and rebuilt it. The rebuilt tokens
		// start hidden and the sync effect had no reason to re-run, so they vanished for
		// good the first time you rotated the board.
		const el = host;
		if (!el) return;
		untrack(() => init());
		const ro = new ResizeObserver(() => fitCamera());
		ro.observe(el);
		return () => {
			disposed = true;
			cancelAnimationFrame(raf);
			ro.disconnect();
			// Free the GL context and every buffer we made — a board toggled back and forth
			// would otherwise leak a context per mount and hit the browser's cap.
			scene?.traverse((o) => {
				const mesh = o as THREE.Mesh;
				mesh.geometry?.dispose?.();
				const m = mesh.material;
				if (Array.isArray(m)) m.forEach((x) => x.dispose());
				else m?.dispose?.();
			});
			disposeTokenTextures();
			renderer?.dispose();
			renderer?.domElement.remove();
			renderer = null;
			scene = null;
		};
	});

	// Board changed → repopulate the instances.
	$effect(() => {
		void shown;
		void runCells;
		void live;
		void selected;
		if (ready) {
			syncDiscs();
			syncTokens();
		}
	});

	// A new piece started falling → hand it to the falling mesh.
	$effect(() => {
		const id = falling;
		if (!ready || id === lastFallingId) return;
		lastFallingId = id ?? null;
		if (!id) {
			if (fallingMesh) fallingMesh.visible = false;
			fall = null;
			syncDiscs();
			return;
		}
		const piece = pieces.find((p) => p.id === id);
		if (!piece || !fallingMesh) return;
		(fallingMesh.material as THREE.MeshStandardMaterial).color.set(sideColors[piece.side - 1] ?? '#888');
		fallingMesh.visible = true;
		if (reduced()) {
			// No drop for reduced motion — the piece is simply there.
			fallingMesh.visible = false;
			fall = null;
		} else {
			fall = { startedAt: performance.now(), col: piece.col, row: piece.row, side: piece.side };
		}
		syncDiscs();
	});
</script>

<div class="stage">
	<div
		class="host"
		class:dragging
		class:overcoin={hoverCol !== null}
		bind:this={host}
		onpointermove={(e) => {
			onDrag(e);
			if (!dragging) onMove(e);
		}}
		onpointerdown={onDown}
		onpointerup={(e) => {
			onClick(e);
			onUp(e);
		}}
		onpointercancel={onUp}
		onpointerleave={() => onhover?.(null)}
		role="img"
		aria-label="Connect Four board, {NCOLS} columns by {NROWS} rows, 3D view"
	></div>
	{#if ready}
		<button type="button" class="reset" onclick={resetView}>Reset view</button>
	{/if}
</div>

{#if webgl === 'none'}
	<p class="note">This browser can't run WebGL — switch back to the flat board.</p>
{:else if webgl === 'software'}
	<p class="note">
		WebGL is running on the CPU here, so the 3D board may be slow. Turning on hardware
		acceleration in your browser settings fixes it.
	</p>
{/if}

<style>
	.stage {
		position: relative;
	}
	.host {
		width: 100%;
		/* The board is 25 x 10, so give the canvas roughly that shape and let the camera
		   fit to whatever it actually gets. */
		aspect-ratio: 25 / 13;
		min-height: 200px;
		border-radius: 4px;
		overflow: hidden;
		background:
			radial-gradient(120% 140% at 50% 0%, #16324a 0%, #0b1a26 60%, #060d13 100%);
		touch-action: pan-y;
		cursor: grab;
	}
	.host.dragging {
		cursor: grabbing;
	}
	.host.overcoin:not(.dragging) {
		cursor: pointer;
	}
	.reset {
		position: absolute;
		right: 0.4rem;
		bottom: 0.4rem;
		min-height: 0;
		padding: 0.1rem 0.5rem;
		font-size: 0.72rem;
		opacity: 0.55;
	}
	.reset:hover {
		opacity: 1;
	}
	.note {
		margin: 0.4rem 0 0;
		font-size: 0.78rem;
		color: var(--muted);
	}
</style>

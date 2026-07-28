#!/usr/bin/env node
// Local visual-testing harness: boot `vite dev`, sign in via /auth/dev-login, screenshot
// one or more pages, shut everything down. See docs/DEV-PREVIEW.md § Local visual testing.
//
//   node scripts/preview.mjs / /me
//   node scripts/preview.mjs --no-login --out shots --width 1440 /events
//
// Deliberately DEPENDENCY-FREE: it talks to the pre-installed Chromium over the DevTools
// protocol using Node's built-in WebSocket (Node 22+). Adding Playwright just to take a
// PNG would drag a browser-download postinstall into every `npm ci` on the deploy image.
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { existsSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const ROOT = resolve(fileURLToPath(new URL('../', import.meta.url)));

// ---------------------------------------------------------------- args

function parseArgs(argv) {
	const opts = {
		pages: [],
		out: 'preview-shots',
		port: 5173,
		width: 1440,
		height: 900,
		login: true,
		fullPage: false,
		maxHeight: 8000,
		timeout: 45_000
	};
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a === '--no-login') opts.login = false;
		else if (a === '--full-page') opts.fullPage = true;
		else if (a === '--max-height') opts.maxHeight = Number(argv[++i]);
		else if (a === '--out') opts.out = argv[++i];
		else if (a === '--port') opts.port = Number(argv[++i]);
		else if (a === '--width') opts.width = Number(argv[++i]);
		else if (a === '--height') opts.height = Number(argv[++i]);
		else if (a === '--timeout') opts.timeout = Number(argv[++i]);
		else if (a.startsWith('--')) throw new Error(`Unknown flag: ${a}`);
		else opts.pages.push(a.startsWith('/') ? a : `/${a}`);
	}
	if (!opts.pages.length) opts.pages = ['/'];
	return opts;
}

// ------------------------------------------------------------- chromium

// Playwright's browser store, pinned by PLAYWRIGHT_BROWSERS_PATH on this image. Prefer the
// headless shell (smaller, no GPU stack); fall back to the full chrome build.
function findChromium() {
	const base = process.env.PLAYWRIGHT_BROWSERS_PATH || '/opt/pw-browsers';
	const candidates = [];
	if (existsSync(base)) {
		let entries = [];
		try {
			entries = readdirSync(base);
		} catch {
			entries = [];
		}
		for (const dir of entries.filter((d) => d.startsWith('chromium_headless_shell'))) {
			candidates.push(join(base, dir, 'chrome-linux', 'headless_shell'));
		}
		for (const dir of entries.filter((d) => d.startsWith('chromium'))) {
			candidates.push(join(base, dir, 'chrome-linux', 'chrome'));
		}
		candidates.push(join(base, 'chromium'));
	}
	candidates.push(process.env.CHROMIUM_PATH, '/usr/bin/chromium', '/usr/bin/google-chrome');
	const found = candidates.find((p) => p && existsSync(p));
	if (!found) {
		throw new Error(
			`No Chromium found under ${base}. Set CHROMIUM_PATH, or PLAYWRIGHT_BROWSERS_PATH to a Playwright browser store.`
		);
	}
	return found;
}

// --------------------------------------------------------------- utils

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForHttp(url, timeoutMs) {
	const deadline = Date.now() + timeoutMs;
	let lastErr;
	while (Date.now() < deadline) {
		try {
			const res = await fetch(url);
			if (res.ok) return await res.json().catch(() => ({}));
		} catch (e) {
			lastErr = e;
		}
		await sleep(250);
	}
	throw new Error(`Timed out waiting for ${url}${lastErr ? ` (${lastErr.message})` : ''}`);
}

// ----------------------------------------------------------- CDP client

// Minimal DevTools-protocol client. One WebSocket, flat sessions (`sessionId` on every
// message) so browser- and page-scoped commands share the same socket.
class Cdp {
	constructor(ws) {
		this.ws = ws;
		this.nextId = 1;
		this.pending = new Map();
		this.listeners = new Set();
		ws.addEventListener('message', (ev) => {
			const msg = JSON.parse(ev.data);
			if (msg.id && this.pending.has(msg.id)) {
				const { resolve: ok, reject } = this.pending.get(msg.id);
				this.pending.delete(msg.id);
				msg.error ? reject(new Error(`${msg.error.message} (${msg.method ?? ''})`)) : ok(msg.result);
			} else if (msg.method) {
				for (const fn of this.listeners) fn(msg);
			}
		});
	}

	static async connect(wsUrl) {
		const ws = new WebSocket(wsUrl);
		await new Promise((ok, bad) => {
			ws.addEventListener('open', ok, { once: true });
			ws.addEventListener('error', () => bad(new Error(`Failed to connect to ${wsUrl}`)), {
				once: true
			});
		});
		return new Cdp(ws);
	}

	send(method, params = {}, sessionId) {
		const id = this.nextId++;
		const payload = { id, method, params };
		if (sessionId) payload.sessionId = sessionId;
		return new Promise((ok, bad) => {
			this.pending.set(id, { resolve: ok, reject: bad });
			this.ws.send(JSON.stringify(payload));
		});
	}

	on(fn) {
		this.listeners.add(fn);
		return () => this.listeners.delete(fn);
	}

	close() {
		try {
			this.ws.close();
		} catch {
			/* already gone */
		}
	}
}

// Resolve once no request has been in flight for `quietMs`, or when `timeoutMs` elapses.
// Cheaper and more reliable here than a fixed sleep: these pages hydrate and then fetch
// their real data from /api/*, so "load" fires well before there's anything to look at.
function networkIdle(cdp, sessionId, { quietMs = 600, timeoutMs = 15_000 } = {}) {
	return new Promise((done) => {
		const inflight = new Set();
		let quietTimer = null;
		const finish = () => {
			clearTimeout(quietTimer);
			clearTimeout(hardStop);
			off();
			done();
		};
		const arm = () => {
			clearTimeout(quietTimer);
			if (inflight.size === 0) quietTimer = setTimeout(finish, quietMs);
		};
		const off = cdp.on((msg) => {
			if (msg.sessionId !== sessionId) return;
			if (msg.method === 'Network.requestWillBeSent') inflight.add(msg.params.requestId);
			else if (
				msg.method === 'Network.loadingFinished' ||
				msg.method === 'Network.loadingFailed'
			) {
				inflight.delete(msg.params.requestId);
				arm();
			}
		});
		const hardStop = setTimeout(finish, timeoutMs);
		arm();
	});
}

// ----------------------------------------------------------------- run

async function main() {
	const opts = parseArgs(process.argv.slice(2));
	const outDir = resolve(ROOT, opts.out);
	await mkdir(outDir, { recursive: true });

	const origin = `http://127.0.0.1:${opts.port}`;
	const children = [];
	const cleanup = () => {
		for (const c of children) {
			try {
				c.kill('SIGTERM');
			} catch {
				/* already dead */
			}
		}
	};
	process.on('exit', cleanup);
	process.on('SIGINT', () => {
		cleanup();
		process.exit(130);
	});

	// 1. vite dev. PUBLIC_SITE_URL is forced to the local origin because hooks.server.ts
	//    308-redirects every off-canonical host — an https value would bounce us away.
	//
	//    Behind an egress proxy (sandboxed dev containers), Node's built-in fetch — which
	//    is what supabase-js uses — ignores HTTPS_PROXY unless NODE_USE_ENV_PROXY is set,
	//    so every DB call goes direct and gets refused while curl to the same host works.
	//    Opt in when a proxy is configured; NO_PROXY already exempts loopback, so the
	//    dev server's own traffic is unaffected. No-op when no proxy is set.
	const proxyEnv = {};
	if ((process.env.HTTPS_PROXY || process.env.https_proxy) && !process.env.NODE_USE_ENV_PROXY) {
		proxyEnv.NODE_USE_ENV_PROXY = '1';
		console.log('[preview] egress proxy detected — enabling NODE_USE_ENV_PROXY for the dev server.');
	}

	console.log(`[preview] starting vite dev on ${origin} …`);
	const vite = spawn('npx', ['vite', 'dev', '--port', String(opts.port), '--strictPort'], {
		cwd: ROOT,
		env: {
			...process.env,
			...proxyEnv,
			PUBLIC_SITE_URL: origin,
			DEV_LOGIN: opts.login ? '1' : (process.env.DEV_LOGIN ?? ''),
			NODE_ENV: 'development'
		},
		stdio: ['ignore', 'pipe', 'pipe']
	});
	children.push(vite);
	const viteLog = [];
	const tap = (buf) => {
		const s = buf.toString();
		viteLog.push(s);
		if (process.env.PREVIEW_VERBOSE) process.stdout.write(`[vite] ${s}`);
	};
	vite.stdout.on('data', tap);
	vite.stderr.on('data', tap);
	vite.on('exit', (code) => {
		if (code !== 0 && code !== null) {
			console.error(`[preview] vite exited early (${code}):\n${viteLog.join('')}`);
		}
	});

	await waitForHttp(`${origin}/health`, opts.timeout).catch((e) => {
		throw new Error(`${e.message}\n--- vite output ---\n${viteLog.join('')}`);
	});
	console.log('[preview] dev server up.');

	// 2. Chromium, remote-debugging on a loopback port. --no-sandbox is required in this
	//    container (no user namespaces); the profile is a throwaway temp dir.
	const chromePort = opts.port + 1000;
	const bin = findChromium();
	const profile = join(tmpdir(), `preview-profile-${process.pid}`);
	console.log(`[preview] launching ${bin}`);
	const chrome = spawn(
		bin,
		[
			`--remote-debugging-port=${chromePort}`,
			'--remote-debugging-address=127.0.0.1',
			`--user-data-dir=${profile}`,
			'--headless=new',
			'--no-sandbox',
			'--disable-dev-shm-usage',
			'--disable-gpu',
			'--hide-scrollbars',
			'--force-color-profile=srgb',
			'--force-device-scale-factor=1',
			'about:blank'
		],
		{ stdio: ['ignore', 'ignore', 'pipe'] }
	);
	children.push(chrome);
	const chromeErr = [];
	chrome.stderr.on('data', (b) => chromeErr.push(b.toString()));

	const version = await waitForHttp(`http://127.0.0.1:${chromePort}/json/version`, 20_000).catch(
		(e) => {
			throw new Error(`${e.message}\n--- chromium stderr ---\n${chromeErr.join('')}`);
		}
	);
	const cdp = await Cdp.connect(version.webSocketDebuggerUrl);

	// 3. One tab, reused across pages so the session cookie from dev-login sticks.
	const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
	const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
	await cdp.send('Page.enable', {}, sessionId);
	await cdp.send('Network.enable', {}, sessionId);
	await cdp.send(
		'Emulation.setDeviceMetricsOverride',
		{ width: opts.width, height: opts.height, deviceScaleFactor: 1, mobile: false },
		sessionId
	);

	const consoleErrors = [];
	cdp.on((msg) => {
		if (msg.sessionId !== sessionId) return;
		if (msg.method === 'Runtime.exceptionThrown') {
			consoleErrors.push(msg.params.exceptionDetails?.exception?.description ?? 'exception');
		}
	});
	await cdp.send('Runtime.enable', {}, sessionId);

	const evaluate = async (expression) => {
		const { result } = await cdp.send(
			'Runtime.evaluate',
			{ expression, returnByValue: true, awaitPromise: true },
			sessionId
		);
		return result.value;
	};

	// Network idle alone is not "ready" here. Pages render a skeleton, hydrate, THEN fetch
	// from /api/* (the instantLoad pattern, see docs/PAGES.md) — so there's a quiet gap
	// before the real request starts, and a screenshot taken in it catches empty
	// placeholders. Every loading placeholder in this app carries `skeleton` in its class
	// name, so wait for the last one to clear before shooting.
	const waitForContent = async (timeoutMs = 15_000) => {
		const deadline = Date.now() + timeoutMs;
		while (Date.now() < deadline) {
			const left = await evaluate(
				`document.querySelectorAll('[class*="skeleton" i]').length`
			);
			if (!left) return true;
			await sleep(150);
		}
		console.warn('[preview]   still showing skeletons after wait — data may be missing');
		return false;
	};

	// Resolve when the NEW document has loaded. Without this gate the waits below can be
	// satisfied by the page we're navigating away from — networkIdle arms its quiet timer
	// immediately, so if the navigation is slow to issue its first request the whole wait
	// completes while the old page is still on screen, and we screenshot it under the new
	// page's filename. That produced one silently wrong /me capture before this existed.
	const waitForLoad = (timeoutMs = 30_000) =>
		new Promise((done) => {
			const finish = () => {
				clearTimeout(timer);
				off();
				done();
			};
			const off = cdp.on((msg) => {
				if (msg.sessionId === sessionId && msg.method === 'Page.loadEventFired') finish();
			});
			const timer = setTimeout(finish, timeoutMs);
		});

	// waitContent is off for the sign-in hop: it only matters for a page we're about to
	// photograph, and running it there just warns about the landing page's skeletons.
	const goto = async (path, { waitContent = true } = {}) => {
		const loaded = waitForLoad();
		await cdp.send('Page.navigate', { url: `${origin}${path}` }, sessionId);
		await loaded;
		await networkIdle(cdp, sessionId);
		if (waitContent) await waitForContent();
		// Content that only mounted once the data arrived (images, wiki sprites) starts
		// its own requests — settle once more now that they've been kicked off.
		await networkIdle(cdp, sessionId, { quietMs: 500, timeoutMs: 10_000 });
		return await evaluate('location.pathname + location.search');
	};

	// 4. Sign in first, so the screenshots show the signed-in pages.
	if (opts.login) {
		const landed = await goto('/auth/dev-login?next=/', { waitContent: false });
		if (landed?.startsWith('/auth/dev-login')) {
			throw new Error(
				'dev-login did not sign in (still on /auth/dev-login). Is DEV_LOGIN set, and does a vs_users row exist for the configured Discord id?'
			);
		}
		console.log(`[preview] signed in via dev-login → ${landed}`);
	}

	// 5. Shoot.
	const results = [];
	for (const path of opts.pages) {
		const before = consoleErrors.length;
		// Retry a navigation that lands somewhere else. Some redirects are legitimate
		// (signed-out /me → /), but a transient Supabase read makes readSession fail
		// closed and bounce an authenticated request the same way — that's recoverable,
		// and without a retry the shot silently saves the wrong page under this name.
		let landed = await goto(path);
		for (let attempt = 1; landed !== path && attempt <= 2; attempt++) {
			console.warn(`[preview]   landed on ${landed}, expected ${path} — retry ${attempt}/2`);
			landed = await goto(path);
		}
		// A little extra settle for fonts/images that resolve after the last response.
		await sleep(400);

		// Full page: grow the VIEWPORT to the content height and shoot normally, rather
		// than using captureBeyondViewport — the latter leaves the page background painted
		// at the original viewport height, so anything taller comes out with a black band
		// below the fold. Clamped, because a long list (the home member table) can run to
		// 20k px and produce an unreadable strip.
		let resized = false;
		if (opts.fullPage) {
			const full = await evaluate('document.documentElement.scrollHeight');
			const height = Math.min(full, opts.maxHeight);
			if (full > opts.maxHeight) {
				console.warn(
					`[preview]   page is ${full}px tall — truncated to ${opts.maxHeight} (raise with --max-height)`
				);
			}
			await cdp.send(
				'Emulation.setDeviceMetricsOverride',
				{ width: opts.width, height, deviceScaleFactor: 1, mobile: false },
				sessionId
			);
			resized = true;
			await sleep(250);
		}

		const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' }, sessionId);

		if (resized) {
			await cdp.send(
				'Emulation.setDeviceMetricsOverride',
				{ width: opts.width, height: opts.height, deviceScaleFactor: 1, mobile: false },
				sessionId
			);
		}
		const name = `${path === '/' ? 'home' : path.replace(/^\/|\/$/g, '').replace(/[^\w.-]+/g, '-')}.png`;
		const file = join(outDir, name);
		await writeFile(file, Buffer.from(data, 'base64'));
		const errs = consoleErrors.slice(before);
		results.push({ path, landed, file, errors: errs });
		if (landed !== path) {
			console.warn(`[preview] ⚠ ${path} → ${file} — THIS IS ${landed}, not ${path}`);
		} else {
			console.log(`[preview] ${path} → ${file}`);
		}
		for (const e of errs) console.warn(`[preview]   page error: ${e.split('\n')[0]}`);
	}

	cdp.close();
	cleanup();
	console.log(`\n[preview] ${results.length} screenshot(s) in ${outDir}`);
	// Give the children a moment to die before the process exits.
	await sleep(200);
	process.exit(0);
}

main().catch((e) => {
	console.error(`[preview] FAILED: ${e.message}`);
	process.exit(1);
});

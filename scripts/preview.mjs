#!/usr/bin/env node
// Screenshot pages of the local site for a quick visual check. See docs/DEV-PREVIEW.md.
//
//   npm run preview:shots -- / /me
//   npm run preview:shots -- --no-login --full-page /events
//
// For anything beyond looking at a picture — clicking, filling a form, asserting — write
// a Playwright test in e2e/ instead (npm run test:e2e). This is only the camera.
import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { existsSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const ROOT = resolve(fileURLToPath(new URL('../', import.meta.url)));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Mirrors playwright.config.ts: use the browser already on disk rather than the build
// Playwright pins, which isn't downloaded here. undefined = let Playwright find its own.
function chromiumPath() {
	if (process.env.CHROMIUM_PATH) return process.env.CHROMIUM_PATH;
	const base = process.env.PLAYWRIGHT_BROWSERS_PATH;
	if (!base || !existsSync(base)) return undefined;
	for (const dir of readdirSync(base).filter((d) => /^chromium-\d+$/.test(d))) {
		const exe = join(base, dir, 'chrome-linux', 'chrome');
		if (existsSync(exe)) return exe;
	}
	return undefined;
}

function parseArgs(argv) {
	const o = {
		pages: [],
		out: 'preview-shots',
		port: 5173,
		width: 1440,
		height: 900,
		login: true,
		fullPage: false
	};
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a === '--no-login') o.login = false;
		else if (a === '--full-page') o.fullPage = true;
		else if (a === '--out') o.out = argv[++i];
		else if (a === '--port') o.port = Number(argv[++i]);
		else if (a === '--width') o.width = Number(argv[++i]);
		else if (a === '--height') o.height = Number(argv[++i]);
		else if (a.startsWith('--')) throw new Error(`Unknown flag: ${a}`);
		else o.pages.push(a.startsWith('/') ? a : `/${a}`);
	}
	if (!o.pages.length) o.pages = ['/'];
	return o;
}

async function waitForServer(url, timeoutMs = 60_000) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		try {
			if ((await fetch(url)).ok) return;
		} catch {
			/* not up yet */
		}
		await sleep(250);
	}
	throw new Error(`Timed out waiting for ${url}`);
}

const opts = parseArgs(process.argv.slice(2));
const origin = `http://127.0.0.1:${opts.port}`;
const outDir = resolve(ROOT, opts.out);
await mkdir(outDir, { recursive: true });

// Node's fetch ignores HTTPS_PROXY unless told, so behind an egress proxy supabase-js
// goes direct and is refused while curl to the same host works (see DEV-PREVIEW.md).
const proxyEnv =
	(process.env.HTTPS_PROXY || process.env.https_proxy) && !process.env.NODE_USE_ENV_PROXY
		? { NODE_USE_ENV_PROXY: '1' }
		: {};

console.log(`[preview] starting vite dev on ${origin} …`);
const vite = spawn('npx', ['vite', 'dev', '--port', String(opts.port), '--strictPort'], {
	cwd: ROOT,
	env: {
		...process.env,
		...proxyEnv,
		// Must be the local origin: hooks.server.ts 308-redirects off-canonical hosts.
		PUBLIC_SITE_URL: origin,
		DEV_LOGIN: opts.login ? '1' : (process.env.DEV_LOGIN ?? ''),
		NODE_ENV: 'development'
	},
	stdio: ['ignore', 'pipe', 'pipe']
});
const log = [];
vite.stdout.on('data', (b) => log.push(b.toString()));
vite.stderr.on('data', (b) => log.push(b.toString()));
const stop = () => {
	try {
		vite.kill('SIGTERM');
	} catch {
		/* already gone */
	}
};
process.on('exit', stop);
process.on('SIGINT', () => {
	stop();
	process.exit(130);
});

try {
	await waitForServer(`${origin}/health`);
} catch (e) {
	stop();
	console.error(`[preview] FAILED: ${e.message}\n--- vite output ---\n${log.join('')}`);
	process.exit(1);
}
console.log('[preview] dev server up.');

const browser = await chromium.launch({
	executablePath: chromiumPath(),
	args: ['--no-sandbox', '--disable-dev-shm-usage']
});
const page = await browser.newPage({ viewport: { width: opts.width, height: opts.height } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));

if (opts.login) {
	await page.goto(`${origin}/auth/dev-login?next=/`, { waitUntil: 'networkidle' });
	if (new URL(page.url()).pathname.startsWith('/auth/dev-login')) {
		stop();
		await browser.close();
		console.error(
			'[preview] FAILED: dev-login did not sign in. Is DEV_LOGIN set, and does a vs_users row exist for the configured Discord id?'
		);
		process.exit(1);
	}
	console.log('[preview] signed in via dev-login.');
}

for (const path of opts.pages) {
	const before = errors.length;
	await page.goto(`${origin}${path}`, { waitUntil: 'networkidle' });
	// Pages render a skeleton, hydrate, then fetch from /api/* — network-idle alone can
	// land in the gap before that fetch starts. Every placeholder here carries `skeleton`
	// in its class, so wait for the last one to clear.
	await page
		.locator('[class*="skeleton" i]')
		.first()
		.waitFor({ state: 'detached', timeout: 15_000 })
		.catch(() => console.warn('[preview]   still showing skeletons — data may be missing'));

	const name = `${path === '/' ? 'home' : path.replace(/^\/|\/$/g, '').replace(/[^\w.-]+/g, '-')}.png`;
	const file = join(outDir, name);
	await page.screenshot({ path: file, fullPage: opts.fullPage });

	const landed = new URL(page.url()).pathname;
	if (landed !== path) {
		console.warn(`[preview] ⚠ ${path} → ${file} — THIS IS ${landed}, not ${path}`);
	} else {
		console.log(`[preview] ${path} → ${file}`);
	}
	for (const e of errors.slice(before)) console.warn(`[preview]   page error: ${e.split('\n')[0]}`);
}

await browser.close();
stop();
console.log(`\n[preview] ${opts.pages.length} screenshot(s) in ${outDir}`);
process.exit(0);

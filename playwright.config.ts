import { defineConfig, devices } from '@playwright/test';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

// End-to-end tests run the REAL app against whatever Supabase the shell points at
// (normally staging — see docs/DEV-PREVIEW.md). They sign in through /auth/dev-login,
// which only answers on a local dev server with DEV_LOGIN set.

const PORT = Number(process.env.E2E_PORT ?? 5173);
export const BASE_URL = `http://127.0.0.1:${PORT}`;

// Use the browser already on disk rather than downloading Playwright's pinned build.
// The revisions don't have to match exactly — this image ships chromium 1194 and drives
// fine under the 1234 Playwright expects. Returning undefined lets Playwright fall back
// to its own managed browser on a machine that has one.
function chromiumPath(): string | undefined {
	if (process.env.CHROMIUM_PATH) return process.env.CHROMIUM_PATH;
	const base = process.env.PLAYWRIGHT_BROWSERS_PATH;
	if (!base || !existsSync(base)) return undefined;
	for (const dir of readdirSync(base).filter((d) => /^chromium-\d+$/.test(d))) {
		const exe = join(base, dir, 'chrome-linux', 'chrome');
		if (existsSync(exe)) return exe;
	}
	return undefined;
}

// Node's fetch ignores HTTPS_PROXY unless told, so behind an egress proxy supabase-js
// goes direct and is refused while curl to the same host works. See DEV-PREVIEW.md.
const proxyEnv =
	(process.env.HTTPS_PROXY || process.env.https_proxy) && !process.env.NODE_USE_ENV_PROXY
		? { NODE_USE_ENV_PROXY: '1' }
		: {};

export default defineConfig({
	testDir: 'e2e',
	// These hit a shared database, so parallel writes across workers would race.
	workers: 1,
	fullyParallel: false,
	// Retry once locally too: readSession fails closed, so a transient Supabase read
	// signs a request out and redirects it like a genuine auth failure.
	retries: process.env.CI ? 2 : 1,
	reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : [['list']],
	timeout: 60_000,
	expect: { timeout: 15_000 },

	use: {
		baseURL: BASE_URL,
		trace: 'retain-on-failure',
		screenshot: 'only-on-failure',
		launchOptions: {
			executablePath: chromiumPath(),
			args: ['--no-sandbox', '--disable-dev-shm-usage']
		}
	},

	projects: [
		// Signs in once via dev-login and saves the session cookie; every other project
		// starts from that state instead of re-authenticating per test.
		{ name: 'setup', testMatch: /auth\.setup\.ts/ },
		{
			name: 'chromium',
			dependencies: ['setup'],
			use: { ...devices['Desktop Chrome'], storageState: 'e2e/.auth/user.json' }
		}
	],

	webServer: {
		command: `npx vite dev --port ${PORT} --strictPort`,
		url: `${BASE_URL}/health`,
		reuseExistingServer: !process.env.CI,
		timeout: 120_000,
		env: {
			// Must be the local origin: hooks.server.ts 308-redirects off-canonical hosts.
			PUBLIC_SITE_URL: BASE_URL,
			DEV_LOGIN: '1',
			NODE_ENV: 'development',
			...proxyEnv
		}
	}
});

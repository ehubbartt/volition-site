import { execFileSync } from 'node:child_process';
import type { Page } from '@playwright/test';

// Shared rigging for the Connect Four QA specs.
//
// Each spec builds its OWN board (scripts/c4-qa-lab.mjs) so the assertions are
// deterministic and two specs can never tread on one another. The board is 6x4 with one
// tile of every interesting shape in a known column — see the script's header for the
// layout.

export interface LabCast {
	slug: string;
	eventId: string;
	red: { id: string; rsn: string }[];
	yellow: { id: string; rsn: string }[];
	bench: { id: string; rsn: string };
	outsider: { id: string; rsn: string };
}

/** A 1x1 PNG — the proof screenshot. Small on purpose; nothing reads the pixels. */
export const PROOF_B64 =
	'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

function run(slug: string, cmd: string): string {
	return execFileSync('node', ['scripts/c4-qa-lab.mjs', cmd], {
		cwd: process.cwd(),
		encoding: 'utf8',
		env: { ...process.env, C4_QA_SLUG: slug, NODE_USE_ENV_PROXY: '1' },
		timeout: 180_000
	});
}

/** Build (or rebuild) the lab board and return who is on it. */
export function buildLab(slug: string): LabCast {
	const out = run(slug, 'create');
	const line = out.split('\n').find((l) => l.startsWith('QA_LAB_JSON='));
	if (!line) throw new Error(`c4-qa-lab create said nothing useful:\n${out}`);
	return JSON.parse(line.slice('QA_LAB_JSON='.length)) as LabCast;
}

/** Board state as the seed script reads it — for corroborating what the UI showed. */
export function labInfo(slug: string): string {
	return run(slug, 'info');
}

export function deleteLab(slug: string): void {
	try {
		run(slug, 'delete');
	} catch {
		/* a spec that died before creating one has nothing to clean up */
	}
}

/** Sign a browser in as a particular member. Dev-login only answers locally. */
export async function signInAs(page: Page, discordId: string, next = '/'): Promise<void> {
	await page.goto(`/auth/dev-login?as=${encodeURIComponent(discordId)}&next=${encodeURIComponent(next)}`);
}

/** Clear the first-visit evidence modal if it is up. */
export async function passAckGate(page: Page): Promise<void> {
	const gate = page.getByRole('dialog', { name: /Before you start/i });
	if (!(await gate.isVisible().catch(() => false))) return;
	for (const box of await gate.locator('input[type="checkbox"]').all()) await box.check();
	await gate.getByRole('button', { name: /Confirm/ }).click();
	await gate.waitFor({ state: 'hidden' });
}

/**
 * Paste a screenshot into the claim form the way a player does — a real paste event on
 * the window, which is where the listener lives.
 */
export async function pasteProof(page: Page): Promise<void> {
	await page.evaluate(async (b64) => {
		const bin = atob(b64);
		const bytes = new Uint8Array(bin.length);
		for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
		const file = new File([bytes], 'drop.png', { type: 'image/png' });
		const dt = new DataTransfer();
		dt.items.add(file);
		window.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true }));
	}, PROOF_B64);
}

/** Column index → the label the UI shows (A, B, C…). */
export const colLabel = (col: number) => String.fromCharCode(65 + col);

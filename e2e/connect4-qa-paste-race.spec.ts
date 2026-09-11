import { test, expect, type Browser, type Page } from '@playwright/test';
import { buildLab, deleteLab, passAckGate, PROOF_B64, signInAs, type LabCast } from './c4-qa-lab';

// PASTING STRAIGHT AFTER OPENING A TILE.
//
// Opening a column kicks off an effect that restores whatever was staged for it from
// IndexedDB and ASSIGNS THE RESULT OVER `staged`. A screenshot pasted before that async
// read lands is overwritten by it — the thumbnail appears, then disappears, and Submit
// greys out again with nothing said. Click-then-Ctrl+V with no pause in between is
// exactly what a player mid-raid does.
//
//   npx playwright test e2e/connect4-qa-paste-race.spec.ts

const SLUG = 'c4qa-paste';
test.describe.configure({ mode: 'serial', retries: 0 });

let cast: LabCast;
let player: Page;

test.beforeAll(async ({ browser }: { browser: Browser }) => {
	cast = buildLab(SLUG);
	player = await (await browser.newContext({ viewport: { width: 1280, height: 1000 } })).newPage();
	await signInAs(player, cast.red[0].id);
});

test.afterAll(async () => {
	await player?.context().close();
	deleteLab(SLUG);
});

/** Click the column and paste in the same turn, with nothing awaited in between. */
async function clickAndPaste(page: Page, col: string, name: string) {
	await page.evaluate(
		async ({ b64, label }) => {
			const tile = [...document.querySelectorAll('.rail .tile')].find(
				(t) => t.getAttribute('aria-label') === label
			) as HTMLButtonElement | undefined;
			if (!tile) throw new Error(`no rail tile ${label}`);
			tile.click();
			const bin = atob(b64);
			const bytes = new Uint8Array(bin.length);
			for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
			const file = new File([bytes], 'drop.png', { type: 'image/png' });
			const dt = new DataTransfer();
			dt.items.add(file);
			window.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true }));
		},
		{ b64: PROOF_B64, label: `Column ${col}: ${name}` }
	);
}

test('a screenshot pasted the instant a tile opens is still there a second later', async () => {
	test.setTimeout(120_000);
	await player.goto(`/events/${SLUG}/connect4`, { waitUntil: 'domcontentloaded' });
	await expect(player.locator('.rail .tile').first()).toBeVisible({ timeout: 30_000 });
	await passAckGate(player);

	await clickAndPaste(player, 'A', 'Bandos chestplate');

	// It arrives…
	await expect(player.getByText('Pasted from your clipboard.')).toBeVisible({ timeout: 10_000 });
	await expect(player.locator('form.claim-form .thumb img')).toHaveCount(1, { timeout: 10_000 });

	// …and it has to still be there once the draft restore has run.
	await player.waitForTimeout(2500);
	await expect(
		player.locator('form.claim-form .thumb img'),
		'the pasted screenshot was wiped by the draft restore'
	).toHaveCount(1);
	await expect(
		player.locator('form.claim-form').getByRole('button', { name: /Submit this drop/ }),
		'Submit greyed out again after the paste'
	).toBeEnabled();
});

import { test, expect } from '@playwright/test';
import { mkdirSync } from 'node:fs';

// THE SCORING FORM KEEPS ITS NUMBERS. Svelte sets `value={…}` as a DOM property, so these
// boxes carry no value ATTRIBUTE and their reset value is blank — and the default
// `use:enhance` resets a form on success. Pressing "Save scoring" therefore emptied every
// box on screen, which looks exactly like the save having wiped the event's scoring. It
// had not, but a second Save from that blank form would have: an empty number field used
// to be read as a real zero.
const SLUG = `scf-${Date.now().toString(36)}`;
test.describe.configure({ mode: 'serial', retries: 0 });

const FIELDS = ['tile_points', 'line_4', 'line_5', 'line_6', 'line_7', 'extra_per_cell', 'pet_points'];

test('saving the scoring keeps every number on screen, and a blank box never zeroes a board', async ({
	page
}) => {
	test.setTimeout(180_000);
	mkdirSync('e2e-shots/scoring', { recursive: true });

	await page.goto('/admin/connect4');
	await page.locator('input[name="name"]').fill(`Scoring ${SLUG}`);
	await page.locator('input[name="slug"]').fill(SLUG);
	await page.locator('input[name="cols"]').fill('5');
	await page.locator('input[name="rows"]').fill('4');
	await page.getByRole('button', { name: 'Create' }).click();
	await expect(page).toHaveURL(new RegExp(`/admin/connect4/${SLUG}$`));

	const box = (n: string) => page.locator(`input[name="${n}"]`);
	const mode = page.locator('select[name="line_mode"]');
	const values = async () => {
		const out: Record<string, string> = {};
		for (const n of FIELDS) out[n] = await box(n).inputValue();
		return out;
	};

	const before = await values();
	expect(before, 'a new game should arrive on the event defaults').toEqual({
		tile_points: '10',
		line_4: '40',
		line_5: '50',
		line_6: '60',
		line_7: '70',
		extra_per_cell: '10',
		pet_points: '10'
	});
	expect(await mode.inputValue(), 'a new game should start on Complete fours').toBe('blocks');

	// ── the reported flow: change the mode, save, and look at the boxes ────────
	await mode.selectOption('tiers');
	await page.getByRole('button', { name: 'Save scoring' }).click();
	// Saving says so — without a confirmation the boxes blanking WAS the only feedback.
	await expect(page.getByText('Saved — the board is re-scored.')).toBeVisible({ timeout: 30_000 });
	expect(await values(), 'saving blanked the scoring boxes').toEqual(before);
	expect(await mode.inputValue()).toBe('tiers');
	await page.locator('select[name="line_mode"]').scrollIntoViewIfNeeded();
	await page.screenshot({ path: 'e2e-shots/scoring/01-after-save.png' });

	// Switching back is just as safe, and a reload proves the numbers were really kept.
	await mode.selectOption('blocks');
	await page.getByRole('button', { name: 'Save scoring' }).click();
	await page.waitForTimeout(1500);
	expect(await values(), 'switching back blanked the boxes').toEqual(before);
	await page.goto(`/admin/connect4/${SLUG}`, { waitUntil: 'domcontentloaded' });
	expect(await values(), 'the stored scoring changed when only the mode was meant to').toEqual(before);
	expect(await mode.inputValue()).toBe('blocks');

	// ── a blank box means "leave it alone", never zero ─────────────────────────
	// Belt and braces: even if a form does arrive empty, it must not silently score the
	// whole event at nothing.
	for (const n of FIELDS) await box(n).fill('');
	await page.getByRole('button', { name: 'Save scoring' }).click();
	await page.waitForTimeout(1500);
	await page.goto(`/admin/connect4/${SLUG}`, { waitUntil: 'domcontentloaded' });
	expect(await values(), 'an empty submit zeroed the scoring').toEqual(before);

	// A real edit still lands.
	await box('tile_points').fill('7');
	await page.getByRole('button', { name: 'Save scoring' }).click();
	await page.waitForTimeout(1500);
	await page.goto(`/admin/connect4/${SLUG}`, { waitUntil: 'domcontentloaded' });
	expect(await box('tile_points').inputValue()).toBe('7');
	expect(await box('line_4').inputValue()).toBe('40');

	await page.goto('/admin/connect4');
	const row = page.locator('tr', { hasText: `Scoring ${SLUG}` });
	await row.getByRole('button', { name: 'Delete' }).click();
	await expect(row).toHaveCount(0, { timeout: 30_000 });
});

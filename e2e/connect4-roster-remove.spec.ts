import { test, expect } from '@playwright/test';
import { mkdirSync } from 'node:fs';

const SLUG = `rmv-${Date.now().toString(36)}`;
test.describe.configure({ mode: 'serial', retries: 0 });

test('Remove takes members off the event, seated or not', async ({ page }) => {
	test.setTimeout(180_000);
	mkdirSync('e2e-shots/remove', { recursive: true });

	await page.goto('/admin/connect4');
	await page.locator('input[name="name"]').fill(`Remove ${SLUG}`);
	await page.locator('input[name="slug"]').fill(SLUG);
	await page.getByRole('button', { name: 'Create' }).click();
	await expect(page).toHaveURL(new RegExp(`/admin/connect4/${SLUG}$`));

	const members = page.locator('.roster .member');
	const inEvent = () => page.locator('.roster .member .pill');

	// Seat four, then unseat two of them — the state that used to be invisible.
	for (const i of [0, 1, 2, 3]) await members.nth(i).locator('input').check();
	await page.getByRole('button', { name: '→ Red' }).click();
	await expect(page.locator('.roster .member .pill', { hasText: 'Red' })).toHaveCount(4);

	for (const i of [0, 1]) await members.nth(i).locator('input').check();
	await page.getByRole('button', { name: 'Remove from event' }).click();
	await expect(page.getByText('Removed 2 from the event')).toBeVisible({ timeout: 30_000 });
	await expect(page.locator('.roster .member .pill', { hasText: 'Red' })).toHaveCount(2);
	await expect(inEvent()).toHaveCount(2); // and no "in event · no side" left behind
	await page.locator('.roster').scrollIntoViewIfNeeded();
	await page.screenshot({ path: 'e2e-shots/remove/01-removed-seated.png' });

	// THE REPORTED CASE: someone on the event with no side. Seat then unseat via a side
	// change is not enough — enrol them and clear the side directly.
	for (const i of [4, 5] as const) await members.nth(i).locator('input').check();
	await page.getByRole('button', { name: '→ Yellow' }).click();
	await expect(page.locator('.roster .member .pill', { hasText: 'Yellow' })).toHaveCount(2);
	await expect(page.getByText(/4 on this event/)).toBeVisible();
	await page.screenshot({ path: 'e2e-shots/remove/02-counts.png' });

	for (const i of [4, 5] as const) await members.nth(i).locator('input').check();
	await page.getByRole('button', { name: 'Remove from event' }).click();
	await expect(page.getByText('Removed 2 from the event')).toBeVisible({ timeout: 30_000 });
	await expect(page.getByText(/2 on this event/)).toBeVisible();
	await page.screenshot({ path: 'e2e-shots/remove/03-after.png' });

	// Removing someone who was never on it says so rather than pretending it worked.
	await members.nth(10).locator('input').check();
	await page.getByRole('button', { name: 'Remove from event' }).click();
	await expect(page.getByText(/Nothing to remove/)).toBeVisible({ timeout: 30_000 });

	await page.goto('/admin/connect4');
	const row = page.locator('tr', { hasText: `Remove ${SLUG}` });
	await row.getByRole('button', { name: 'Delete' }).click();
	await expect(row).toHaveCount(0, { timeout: 30_000 });
});

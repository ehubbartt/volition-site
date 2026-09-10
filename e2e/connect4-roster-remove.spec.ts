import { test, expect } from '@playwright/test';
import { mkdirSync } from 'node:fs';

const SLUG = `rmv-${Date.now().toString(36)}`;
const SLUG2 = `seat-${Date.now().toString(36)}`;
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

// THE REPORTED FLOW, on the screen rather than through the server. Two things looked
// broken from an admin's chair: "Preview the split" threw away the roster you had just
// picked, and Remove appeared to do nothing at all — you could not always find the person
// to tick, and whatever the button did was reported six hundred lines up the page.
test('the seating panel keeps its source, finds people by name, and reports where you can see it', async ({
	page
}) => {
	test.setTimeout(180_000);
	mkdirSync('e2e-shots/seating', { recursive: true });

	await page.goto('/admin/connect4');
	await page.locator('input[name="name"]').fill(`Seating ${SLUG2}`);
	await page.locator('input[name="slug"]').fill(SLUG2);
	await page.getByRole('button', { name: 'Create' }).click();
	await expect(page).toHaveURL(new RegExp(`/admin/connect4/${SLUG2}$`));

	const teams = page.locator('#teams');
	const source = teams.locator('select[name="sourceEventId"]');
	const members = page.locator('.roster .member');

	// ── 1. the source select survives a preview ────────────────────────────────
	// It used to snap back to "this game's own signups", so seating the roster you had
	// just previewed meant picking it again — and picking wrong seated the wrong list.
	const options = await source.locator('option').all();
	test.skip(options.length < 2, 'staging has no signup event to seat from');
	const wanted = (await options[1].getAttribute('value')) ?? '';
	const wantedLabel = (await options[1].innerText()).trim();
	await source.selectOption(wanted);

	await teams.getByRole('button', { name: 'Preview the split' }).click();
	await expect(teams.getByText(/nothing has been changed yet/)).toBeVisible({ timeout: 30_000 });
	expect(await source.inputValue(), 'the preview threw the chosen roster away').toBe(wanted);
	await expect(teams.getByText(`Preview of ${wantedLabel}`)).toBeVisible();
	await teams.screenshot({ path: 'e2e-shots/seating/01-preview-kept-source.png' });

	// ── 2. find someone by the OTHER spelling of their name ────────────────────
	// An RSN is written with spaces in game and underscores nearly everywhere else, and an
	// admin types whichever one they are looking at. Searching the other spelling used to
	// return an empty roster, so there was no row to tick and Remove stayed disabled — the
	// button looked dead when the person simply was not on screen.
	const names = (
		await page.locator('.roster .member > span:nth-of-type(1)').allInnerTexts()
	).map((n) => n.trim());
	const spaced = names.find((n) => /[ _-]/.test(n));
	test.skip(!spaced, 'no RSN on staging is written with a space or underscore');
	const other = names.find((n) => n && n !== spaced) ?? '';

	const filter = page.getByPlaceholder('Filter by RSN…');
	const swapped = /_/.test(spaced!) ? spaced!.replace(/_/g, ' ') : spaced!.replace(/ /g, '_');
	await filter.fill(swapped.toUpperCase());
	// Not an exact count: one RSN can be a prefix of another. What matters is that the
	// person searched for is on screen and tickable.
	await expect(page.locator('.roster').getByText(spaced!, { exact: true })).toBeVisible();
	await page.screenshot({ path: 'e2e-shots/seating/02-found-by-either-spelling.png' });

	// Ticking survives narrowing the list, so an admin can search, tick, search, tick.
	await members.filter({ hasText: spaced! }).first().locator('input').check();
	await filter.fill(other);
	await members.filter({ hasText: other }).first().locator('input').check();
	await expect(teams.getByText('2 selected')).toBeVisible();

	await filter.fill('');
	await teams.getByRole('button', { name: '→ Yellow' }).click();
	await expect(page.locator('.roster .member .pill', { hasText: 'Yellow' })).toHaveCount(2);

	// ── 3. "on this event only" finds them with no typing at all ───────────────
	await page.getByText('On this event only').click();
	await expect(members).toHaveCount(2);
	for (const name of [spaced!, other]) await expect(page.locator('.roster')).toContainText(name);

	// ── 4. remove, and say so beside the button that was pressed ───────────────
	await members.first().locator('input').check();
	await teams.getByRole('button', { name: 'Remove from event' }).click();
	const said = teams.getByText(/Removed 1 from the event/);
	await expect(said).toBeVisible({ timeout: 30_000 });
	// The point of the fix: the admin can READ it without scrolling back up the page.
	await expect(said).toBeInViewport();
	await expect(members).toHaveCount(1);
	await page.screenshot({ path: 'e2e-shots/seating/03-removed-in-panel.png' });

	// ── 5. and the last one goes the same way ──────────────────────────────────
	// With nothing ticked the buttons are disabled, which is why a silent failure was so
	// hard to tell apart from a working one.
	await expect(teams.getByRole('button', { name: 'Remove from event' })).toBeDisabled();
	await members.first().locator('input').check();
	await teams.getByRole('button', { name: 'Remove from event' }).click();
	await expect(teams.getByText(/Removed 1 from the event/)).toBeVisible({ timeout: 30_000 });
	await expect(members).toHaveCount(0);

	await page.goto('/admin/connect4');
	const row = page.locator('tr', { hasText: `Seating ${SLUG2}` });
	await row.getByRole('button', { name: 'Delete' }).click();
	await expect(row).toHaveCount(0, { timeout: 30_000 });
});

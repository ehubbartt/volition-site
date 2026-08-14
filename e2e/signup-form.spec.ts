import { test, expect, type Page } from '@playwright/test';

// Drives a signup event through its whole life in the UI: an admin creates it, writes
// questions, a member answers them, the admin reads the answers back, and then the people
// are pushed into a real event.
//
// That last step is the one worth a browser test. Everything before it is a form; the
// handoff is the reason the form exists, and it is the step that silently does nothing if
// the checkboxes and the hidden inputs ever drift apart.

const STAMP = Date.now().toString(36);
const SLUG = `e2e-signup-${STAMP}`;
const TARGET_SLUG = `e2e-target-${STAMP}`;

/**
 * Click a button whose handler only exists after hydration, and keep clicking until the
 * thing it toggles shows up. Same reason as the battleship spec: these pages are
 * server-rendered and hydrate a moment later, so a plain click can land on inert markup.
 */
async function clickUntil(page: Page, button: string | RegExp, expected: string) {
	const target = page.locator(expected);
	for (let attempt = 0; attempt < 12; attempt++) {
		await page.getByRole('button', { name: button }).first().click();
		try {
			await target.first().waitFor({ state: 'visible', timeout: 2_000 });
			return;
		} catch {
			// not hydrated yet — go round again
		}
	}
	throw new Error(`"${button}" never revealed ${expected}`);
}

/**
 * Pick an option and wait for the branch it reveals. The event-type dropdown is bound to
 * Svelte state, so until the page hydrates, selecting "Signup form" changes the select and
 * nothing else — the fields it should reveal never appear and the next `fill` hangs.
 */
async function selectUntil(page: Page, value: string, expected: string) {
	const target = page.locator(expected);
	for (let attempt = 0; attempt < 12; attempt++) {
		await page.selectOption('select[name="kind"]', value);
		try {
			await target.first().waitFor({ state: 'visible', timeout: 2_000 });
			return;
		} catch {
			// not hydrated yet — go round again
		}
	}
	throw new Error(`selecting "${value}" never revealed ${expected}`);
}

test.describe.serial('Signup forms', () => {
	test('an admin can create a signup form and write questions', async ({ page }) => {
		test.slow();

		await page.goto('/admin/events');

		// Two events: the signup form, and something to hand its people over to at the end.
		for (const [kind, slug, name, button] of [
			['signup', SLUG, 'E2E Signup', /^create signup form$/i],
			['custom', TARGET_SLUG, 'E2E Target', /^create event$/i]
		] as const) {
			await selectUntil(page, kind, 'input[name="slug"]');
			await page.fill('input[name="slug"]', slug);
			await page.fill('input[name="name"]', name);
			await page.getByRole('button', { name: button }).click();
			await expect(page.locator('.err')).toHaveCount(0);
			// The list is fetched separately, so wait for the row rather than assuming the
			// insert landed before the next iteration rewrites the form.
			await expect(page.locator('.event-list li.card', { hasText: `/${slug}` })).toHaveCount(1);
		}

		// A signup event must NOT land on the generic detail page — that is the DuoWolf
		// pairing flow, which would offer to duo people up for an event that doesn't exist.
		await page.goto(`/events/${SLUG}`);
		await expect(page).toHaveURL(`/events/${SLUG}/signup`);

		// ── write the questions ──────────────────────────────────────────────
		await page.goto(`/admin/events/${SLUG}/signup`);
		await clickUntil(page, /add question/i, '.qrow');

		const rows = page.locator('.qrow');
		await rows.nth(0).locator('.qlabel').fill('How many hours a week can you play?');
		await rows.nth(0).locator('.qtype').selectOption('number');
		await rows.nth(0).getByRole('checkbox').check();

		await page.getByRole('button', { name: /add question/i }).click();
		await expect(rows).toHaveCount(2);
		await rows.nth(1).locator('.qlabel').fill('When are you usually on?');
		await rows.nth(1).locator('.qtype').selectOption('choice');
		// Picking "choice" seeds two blank options so the field is never born unanswerable.
		const choices = rows.nth(1).locator('.choice input');
		await expect(choices).toHaveCount(2);
		await choices.nth(0).fill('Weekends');
		await choices.nth(1).fill('Weekdays');

		await page.getByRole('button', { name: /save questions/i }).click();
		await expect(page.locator('.ok')).toContainText(/saved 2 questions/i);

		// The saved form is what comes back — not what was typed. A reload proves it landed
		// in the database rather than only in local state.
		await page.reload();
		await expect(page.locator('.qrow')).toHaveCount(2);
		await expect(page.locator('.qrow').nth(0).locator('.qlabel')).toHaveValue(
			'How many hours a week can you play?'
		);
	});

	test('a member answers the questions, and the answers reach the roster', async ({ page }) => {
		await page.goto(`/events/${SLUG}/signup`);

		// Required fields are required server-side, not just in the browser: strip the
		// attribute and post anyway, and the server must still refuse.
		await page.evaluate(() =>
			document.querySelectorAll('[required]').forEach((el) => el.removeAttribute('required'))
		);
		await page.getByRole('button', { name: /sign me up/i }).click();
		await expect(page.locator('.fielderr').first()).toContainText(/required/i);

		// Now answer properly.
		await page.reload();
		const hours = page.locator('input[type="number"]');
		await hours.fill('14');
		await page.locator('select').first().selectOption('Weekends');
		await page.getByRole('button', { name: /sign me up/i }).click();
		await expect(page.locator('.ok')).toContainText(/on the list/i);

		// Editing is a second submit of the same form, not a different flow.
		await expect(page.getByRole('button', { name: /save my answers/i })).toBeVisible();
		await page.locator('input[type="number"]').fill('20');
		await page.getByRole('button', { name: /save my answers/i }).click();
		await expect(page.locator('.ok')).toContainText(/updated/i);

		// The admin sees the answer, not just the name — the whole point of asking.
		await page.goto(`/admin/events/${SLUG}/signup`);
		const row = page.locator('tbody tr').first();
		await expect(row).toContainText('20');
		await expect(row).toContainText('Weekends');
	});

	test('the roster converts into a real event', async ({ page }) => {
		await page.goto(`/admin/events/${SLUG}/signup`);
		await expect(page.locator('tbody tr')).toHaveCount(1);

		// Everyone is selected by default, so the common case is one click.
		await page.selectOption('select[name="target_slug"]', TARGET_SLUG);
		await clickUntil(page, /add 1 person/i, '.ok');
		await expect(page.locator('.ok').first()).toContainText(/added 1 to e2e target/i);

		// Idempotent: doing it again adds nobody and says so, rather than erroring on the
		// unique index. This is the realistic second use — convert, spot a straggler,
		// convert again.
		await page.reload();
		await page.selectOption('select[name="target_slug"]', TARGET_SLUG);
		await page.getByRole('button', { name: /add 1 person/i }).click();
		await expect(page.locator('.ok').first()).toContainText(/added 0.*already in it/i);

		// And the source list is untouched — converting is a copy, not a move, so a mistake
		// is re-runnable rather than fatal.
		await page.reload();
		await expect(page.locator('tbody tr')).toHaveCount(1);
	});

	test('the form builder refuses an event that is not a signup', async ({ page }) => {
		// Saving questions against, say, a bingo would write a signupForm key into its
		// structure, where nothing reads it and the bingo normalizer strips it on the next
		// builder save — an admin's work quietly lost. It has to refuse up front.
		const res = await page.goto(`/admin/events/${TARGET_SLUG}/signup`);
		expect(res?.status()).toBe(400);
		await expect(page.locator('body')).toContainText(/not a signup form/i);
	});

	test.afterAll(async ({ browser }) => {
		// Delete every event this spec made, however many runs have piled up. Deleting only
		// the first match is what left orphans behind in the battleship spec and then failed
		// every later run on the same assertion.
		const page = await browser.newPage({ storageState: 'e2e/.auth/user.json' });
		for (const slug of [SLUG, TARGET_SLUG]) {
			for (let attempt = 0; attempt < 6; attempt++) {
				await page.goto('/admin/events');
				const card = page.locator('.event-list li.card', { hasText: `/${slug}` });
				if ((await card.count()) === 0) break;

				// The card's controls live behind a <details>; open it, then satisfy the
				// type-the-slug guard and the confirm() before Delete will do anything.
				const summary = card.first().locator('summary').first();
				if (await summary.count()) await summary.click();
				await card.first().locator('input[name="confirm_slug"]').fill(slug);
				page.once('dialog', (d) => d.accept());
				await card.first().getByRole('button', { name: /^delete$/i }).click();
				await expect(page.locator('.event-list li.card', { hasText: `/${slug}` })).toHaveCount(0);
			}
		}
		await page.close();
	});
});

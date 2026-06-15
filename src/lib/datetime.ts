// CLIENT-SAFE datetime helpers for admin forms.
//
// A <input type="datetime-local"> value (e.g. "2026-06-10T14:30") carries NO
// timezone — it's the user's local wall-clock. If that bare string is sent to the
// server and parsed there with `new Date(str)`, it's interpreted in the SERVER's
// timezone (UTC on Fly), so a local 2:30pm gets stored as 2:30pm UTC and reads
// back shifted by the user's offset. To avoid that, convert the local value to a
// real UTC instant HERE (in the browser, where the local tz is known) before POST.

import type { SubmitFunction } from '@sveltejs/kit';

// Fields that hold a datetime-local value across the event/calendar admin forms.
const DATE_FIELDS = ['starts_at', 'ends_at', 'signup_opens_at', 'signup_closes_at'];

// "2026-06-10T14:30" (browser-local) → "2026-06-10T18:30:00.000Z" (UTC ISO).
export function datetimeLocalToIso(value: string): string | null {
	if (!value.trim()) return null;
	const d = new Date(value); // parsed in the browser's local timezone
	return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

// use:enhance helper for any form with datetime-local date fields: rewrites them to
// UTC ISO right before submit (timezone-correct regardless of server tz), and keeps
// the form's typed values after a successful save (like the admin keepValues).
export const dateFormEnhance: SubmitFunction = ({ formData }) => {
	for (const f of DATE_FIELDS) {
		const v = formData.get(f);
		if (typeof v === 'string' && v.trim()) {
			const iso = datetimeLocalToIso(v);
			if (iso) formData.set(f, iso);
		}
	}
	return async ({ update }) => update({ reset: false });
};

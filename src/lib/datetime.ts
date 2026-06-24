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

// --- Display formatters -------------------------------------------------------
// Shared "show this instant to the user" helpers so pages stop re-inventing
// `new Date(iso).toLocaleString()` (and the two copies of `ago()`). All return an
// em dash for null/invalid input so callers don't have to guard.

const EM_DASH = '—';

// Date only, e.g. "Jun 10, 2026" (override via opts). '—' on null/invalid.
export function formatDate(
	iso: string | null | undefined,
	opts: Intl.DateTimeFormatOptions = { month: 'short', day: 'numeric', year: 'numeric' }
): string {
	if (!iso) return EM_DASH;
	const d = new Date(iso);
	return Number.isNaN(d.getTime()) ? EM_DASH : d.toLocaleDateString(undefined, opts);
}

// Date + time, e.g. "Jun 10, 2026, 2:30 PM". '—' on null/invalid.
export function formatDateTime(iso: string | null | undefined): string {
	if (!iso) return EM_DASH;
	const d = new Date(iso);
	return Number.isNaN(d.getTime()) ? EM_DASH : d.toLocaleString();
}

// Compact relative age, e.g. "3d", "5h", "just now". '—' on null/invalid.
// Replaces the duplicated ago() helpers in the admin wallet/pack-stats pages.
export function timeAgo(iso: string | null | undefined): string {
	if (!iso) return EM_DASH;
	const t = new Date(iso).getTime();
	if (Number.isNaN(t)) return EM_DASH;
	const s = Math.max(0, Math.floor((Date.now() - t) / 1000));
	if (s < 60) return 'just now';
	const m = Math.floor(s / 60);
	if (m < 60) return `${m}m`;
	const h = Math.floor(m / 60);
	if (h < 24) return `${h}h`;
	return `${Math.floor(h / 24)}d`;
}

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

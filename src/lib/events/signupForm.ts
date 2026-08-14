// CLIENT-SAFE: the shape of a SIGNUP EVENT — an event whose whole job is to collect a
// list of people plus their answers to a few questions, before the real event exists.
//
// The point is the handoff. An admin opens one of these weeks before they know what
// they're running, asks "how many hours can you play?", and later pushes the people who
// answered into whatever event they actually build — see `convertRoster` in
// $lib/server/signupForm.ts. Nothing here decides what the real event is; this is the
// list and the questions, and that is deliberately all it is.
//
// Questions live in `vs_events.structure.signupForm`; answers live in the `answers`
// jsonb on `vs_event_signups` (db/scripts/signup_forms.sql). Neither is validated by the
// database, so everything that reads them goes through `normalizeForm` /
// `normalizeAnswers` below — a hand-edited row must never be able to break a page.

export const SIGNUP_EVENT_KIND = 'signup';

export type QuestionType = 'short' | 'long' | 'number' | 'choice';

export interface SignupQuestion {
	/** Stable across edits — answers are keyed on it, so renaming a question keeps them. */
	id: string;
	label: string;
	type: QuestionType;
	required: boolean;
	/** Small print under the field. */
	help?: string;
	/** `choice` only. */
	choices?: string[];
	/** `number` only. Inclusive. */
	min?: number;
	max?: number;
}

export interface SignupForm {
	questions: SignupQuestion[];
	/** Shown above the form. The "why am I filling this in" line. */
	intro?: string;
	/** Can someone change their answers after submitting? Default true. */
	allowEdits: boolean;
}

/** One person's answers: question id → value. */
export type SignupAnswers = Record<string, string | number>;

export const QUESTION_TYPES: { value: QuestionType; label: string; hint: string }[] = [
	{ value: 'short', label: 'Short text', hint: 'One line — a name, an RSN, a preference.' },
	{ value: 'long', label: 'Paragraph', hint: 'A few sentences.' },
	{ value: 'number', label: 'Number', hint: 'Hours available, days free, a count.' },
	{ value: 'choice', label: 'Pick one', hint: 'A fixed list of options.' }
];

export const MAX_QUESTIONS = 12;
export const MAX_CHOICES = 12;
const MAX_LABEL = 200;
const MAX_SHORT = 200;
const MAX_LONG = 2000;

const str = (v: unknown, max: number): string =>
	typeof v === 'string' ? v.trim().slice(0, max) : '';

const num = (v: unknown): number | undefined => {
	const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN;
	return Number.isFinite(n) ? n : undefined;
};

/**
 * A question id that survives a round-trip through jsonb and a URL. Generated once, on
 * the first save, and never regenerated — answers are keyed on it.
 */
export function newQuestionId(): string {
	const rand =
		typeof crypto !== 'undefined' && 'randomUUID' in crypto
			? crypto.randomUUID().slice(0, 8)
			: Math.floor(Math.random() * 0xffffffff).toString(16);
	return `q_${rand}`;
}

/** Read whatever is in `structure.signupForm` and hand back something safe to render. */
export function normalizeForm(raw: unknown): SignupForm {
	const obj = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
	const listRaw = Array.isArray(obj.questions) ? obj.questions : [];

	const seen = new Set<string>();
	const questions: SignupQuestion[] = [];
	for (const q of listRaw.slice(0, MAX_QUESTIONS)) {
		if (!q || typeof q !== 'object') continue;
		const r = q as Record<string, unknown>;
		const label = str(r.label, MAX_LABEL);
		if (!label) continue; // a question with no text cannot be answered or displayed

		const type: QuestionType =
			r.type === 'long' || r.type === 'number' || r.type === 'choice' ? r.type : 'short';

		// A duplicate id would make two questions share one answer. Rather than drop the
		// question (losing an admin's work), give it a fresh id.
		let id = str(r.id, 64);
		if (!id || seen.has(id)) id = newQuestionId();
		seen.add(id);

		const out: SignupQuestion = { id, label, type, required: r.required === true };
		const help = str(r.help, MAX_LABEL);
		if (help) out.help = help;

		if (type === 'choice') {
			const choices = (Array.isArray(r.choices) ? r.choices : [])
				.map((c) => str(c, MAX_SHORT))
				.filter(Boolean)
				.slice(0, MAX_CHOICES);
			// A "pick one" with nothing to pick is a broken field; degrade to short text
			// rather than render an empty select.
			if (choices.length === 0) out.type = 'short';
			else out.choices = choices;
		}
		if (type === 'number') {
			const min = num(r.min);
			const max = num(r.max);
			if (min !== undefined) out.min = min;
			if (max !== undefined) out.max = max;
			// Backwards bounds would reject every answer. Drop them both rather than
			// leave a form nobody can submit.
			if (out.min !== undefined && out.max !== undefined && out.min > out.max) {
				delete out.min;
				delete out.max;
			}
		}
		questions.push(out);
	}

	return {
		questions,
		intro: str(obj.intro, MAX_LONG) || undefined,
		allowEdits: obj.allowEdits !== false
	};
}

/** Read whatever is in a signup's `answers` column. */
export function normalizeAnswers(raw: unknown): SignupAnswers {
	if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
	const out: SignupAnswers = {};
	for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
		if (typeof v === 'number' && Number.isFinite(v)) out[k] = v;
		else if (typeof v === 'string') out[k] = v.slice(0, MAX_LONG);
	}
	return out;
}

export interface AnswerCheck {
	ok: boolean;
	answers: SignupAnswers;
	/** question id → what's wrong with it. Empty when ok. */
	errors: Record<string, string>;
}

/**
 * Validate a submitted set of answers against the form.
 *
 * `raw` is whatever came off the request (all strings, from FormData). The result is what
 * to WRITE — coerced to the right types, with unknown keys dropped, so a crafted POST
 * cannot smuggle extra fields into the jsonb.
 */
export function checkAnswers(form: SignupForm, raw: Record<string, unknown>): AnswerCheck {
	const answers: SignupAnswers = {};
	const errors: Record<string, string> = {};

	for (const q of form.questions) {
		const given = raw[q.id];
		const text = typeof given === 'string' ? given.trim() : given == null ? '' : String(given);

		if (!text) {
			if (q.required) errors[q.id] = 'This one is required';
			continue; // optional and blank: store nothing rather than an empty string
		}

		if (q.type === 'number') {
			const n = Number(text);
			if (!Number.isFinite(n)) {
				errors[q.id] = 'Enter a number';
				continue;
			}
			if (q.min !== undefined && n < q.min) {
				errors[q.id] = `Must be ${q.min} or more`;
				continue;
			}
			if (q.max !== undefined && n > q.max) {
				errors[q.id] = `Must be ${q.max} or less`;
				continue;
			}
			answers[q.id] = n;
		} else if (q.type === 'choice') {
			// Never trust the posted value to be one of the options — a select is only a
			// suggestion once it leaves the browser.
			if (!q.choices?.includes(text)) {
				errors[q.id] = 'Pick one of the options';
				continue;
			}
			answers[q.id] = text;
		} else {
			answers[q.id] = text.slice(0, q.type === 'long' ? MAX_LONG : MAX_SHORT);
		}
	}

	return { ok: Object.keys(errors).length === 0, answers, errors };
}

/** One answer, as text — for the roster table and the CSV. */
export function answerText(q: SignupQuestion, answers: SignupAnswers): string {
	const v = answers[q.id];
	if (v === undefined || v === '') return '';
	return String(v);
}

/**
 * The roster as CSV: one row per person, one column per question, in form order.
 *
 * Exists because the whole point of a signup is what you do with it NEXT, and the answer
 * is not always "push these people into an event" — sometimes it's a spreadsheet and a
 * captain arguing about who gets whom.
 */
export function rosterCsv(
	form: SignupForm,
	rows: { rsn: string | null; discord: string | null; joinedAt: string; answers: SignupAnswers }[]
): string {
	const cell = (s: string) => (/[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
	const head = ['RSN', 'Discord', 'Signed up', ...form.questions.map((q) => q.label)];
	const body = rows.map((r) =>
		[
			r.rsn ?? '',
			r.discord ?? '',
			r.joinedAt,
			...form.questions.map((q) => answerText(q, r.answers))
		].map((v) => cell(String(v)))
	);
	return [head.map(cell), ...body].map((cols) => cols.join(',')).join('\n');
}

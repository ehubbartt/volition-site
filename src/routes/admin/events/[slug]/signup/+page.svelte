<script lang="ts">
	import type { PageData, ActionData } from './$types';
	import { enhance } from '$app/forms';
	import {
		MAX_CHOICES,
		MAX_QUESTIONS,
		QUESTION_TYPES,
		answerText,
		rosterCsv,
		type QuestionType,
		type SignupQuestion
	} from '$lib/events/signupForm';

	let { data, form }: { data: PageData; form: ActionData } = $props();

	// ── The question editor ──────────────────────────────────────────────
	// Local state, posted as one JSON blob on save. Add/remove/reorder are pure client
	// operations; nothing hits the server until Save, so an admin can rearrange a form
	// without writing six intermediate versions into a live event.
	let questions = $state<SignupQuestion[]>([]);
	let intro = $state('');
	let allowEdits = $state(true);

	// Re-seed from the server whenever the SAVED form changes — which, because `use:enhance`
	// invalidates on success, means exactly "after a save". Without this the editor keeps
	// showing what was typed rather than what was stored, so a question the server dropped
	// for having no text stays on screen looking saved, and the ids minted for new
	// questions never make it back into local state.
	let seeded = $state('');
	$effect(() => {
		const saved = data.event.form;
		const sig = JSON.stringify(saved);
		if (sig === seeded) return;
		seeded = sig;
		questions = saved.questions.map((q) => ({ ...q, choices: q.choices ? [...q.choices] : undefined }));
		intro = saved.intro ?? '';
		allowEdits = saved.allowEdits;
	});

	// A blank id means "new" — the server mints a stable one on save, and every answer
	// already given stays attached to the questions that kept theirs.
	const blank = (): SignupQuestion => ({ id: '', label: '', type: 'short', required: false });

	function addQuestion() {
		if (questions.length >= MAX_QUESTIONS) return;
		questions = [...questions, blank()];
	}
	function removeQuestion(i: number) {
		questions = questions.filter((_, n) => n !== i);
	}
	function move(i: number, by: number) {
		const j = i + by;
		if (j < 0 || j >= questions.length) return;
		const next = [...questions];
		[next[i], next[j]] = [next[j], next[i]];
		questions = next;
	}
	function setType(i: number, type: QuestionType) {
		const next = [...questions];
		next[i] = { ...next[i], type };
		// Give a fresh "pick one" something to pick, so the field isn't born broken.
		if (type === 'choice' && !next[i].choices?.length) next[i].choices = ['', ''];
		questions = next;
	}
	function addChoice(i: number) {
		const next = [...questions];
		const cs = next[i].choices ?? [];
		if (cs.length >= MAX_CHOICES) return;
		next[i] = { ...next[i], choices: [...cs, ''] };
		questions = next;
	}
	function removeChoice(i: number, c: number) {
		const next = [...questions];
		next[i] = { ...next[i], choices: (next[i].choices ?? []).filter((_, n) => n !== c) };
		questions = next;
	}

	const questionsJson = $derived(JSON.stringify(questions));

	// ── The roster ───────────────────────────────────────────────────────
	// Everyone is selected by default: "send them all over" is the common case, and
	// unticking a few is less work than ticking eighty.
	let selected = $state<Set<string>>(new Set());
	let rosterSeeded = $state('');
	$effect(() => {
		const ids = data.roster.map((r) => r.userId);
		const sig = ids.join(',');
		if (sig === rosterSeeded) return;
		// Keep any deliberate unticking across a reload, but pick up people who have signed
		// up since — a new arrival should not be silently excluded from the handoff.
		const known = new Set(rosterSeeded ? rosterSeeded.split(',') : []);
		const next = new Set(selected);
		for (const id of ids) if (!known.has(id)) next.add(id);
		for (const id of [...next]) if (!ids.includes(id)) next.delete(id);
		rosterSeeded = sig;
		selected = next;
	});
	const allSelected = $derived(selected.size === data.roster.length && data.roster.length > 0);

	function toggle(userId: string) {
		const next = new Set(selected);
		if (next.has(userId)) next.delete(userId);
		else next.add(userId);
		selected = next;
	}
	function toggleAll() {
		selected = allSelected ? new Set() : new Set(data.roster.map((r) => r.userId));
	}

	let targetSlug = $state('');
	let copied = $state(false);

	async function copyCsv() {
		const csv = rosterCsv(data.event.form, data.roster);
		try {
			await navigator.clipboard.writeText(csv);
			copied = true;
			setTimeout(() => (copied = false), 2000);
		} catch {
			copied = false;
		}
	}

	const dt = (s: string) => new Date(s).toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'short' });
</script>

<svelte:head><title>{data.event.name} — signup</title></svelte:head>

<div class="wrap">
	<header class="head">
		<p class="crumb"><a href="/admin/events">← Events</a></p>
		<h1>{data.event.name}</h1>
		<p class="lede">
			Signup form · <a href="/events/{data.event.slug}/signup">see the member view →</a>
			{#if !data.window.open}<span class="shut">{data.window.reason}</span>{/if}
		</p>
	</header>

	{#if form && 'error' in form && form.error}<p class="err">{form.error}</p>{/if}
	{#if form && 'report' in form && form.report}<p class="ok">{form.report}</p>{/if}

	<!-- ── Questions ────────────────────────────────────────────────── -->
	<section class="osrs-panel">
		<h2 class="osrs-titlebar">Questions</h2>
		<p class="hint">
			What each person answers when they sign up. Editing a question keeps the answers
			already given to it; deleting one hides them but does not destroy them.
		</p>

		<form method="POST" action="?/saveForm" use:enhance>
			<input type="hidden" name="questions" value={questionsJson} />

			<label class="introfield">
				<span>Intro (optional)</span>
				<textarea name="intro" rows="2" bind:value={intro}
					placeholder="Shown above the questions — why you're asking."></textarea>
			</label>

			<div class="qlist">
				{#each questions as q, i (i)}
					<div class="qrow osrs-inset">
						<div class="qtop">
							<span class="qn">{i + 1}</span>
							<input class="qlabel" type="text" bind:value={q.label} placeholder="Question text" />
							<select
								class="qtype"
								value={q.type}
								onchange={(e) => setType(i, e.currentTarget.value as QuestionType)}
							>
								{#each QUESTION_TYPES as t (t.value)}<option value={t.value}>{t.label}</option>{/each}
							</select>
							<label class="reqbox"><input type="checkbox" bind:checked={q.required} /> required</label>
							<span class="qmove">
								<button class="btn small" type="button" onclick={() => move(i, -1)} disabled={i === 0} aria-label="Move up">↑</button>
								<button class="btn small" type="button" onclick={() => move(i, 1)} disabled={i === questions.length - 1} aria-label="Move down">↓</button>
								<button class="btn small subtle" type="button" onclick={() => removeQuestion(i)} aria-label="Delete question">✕</button>
							</span>
						</div>

						<input class="qhelp" type="text" bind:value={q.help} placeholder="Help text (optional)" />

						{#if q.type === 'number'}
							<div class="bounds">
								<label>Min <input type="number" bind:value={q.min} /></label>
								<label>Max <input type="number" bind:value={q.max} /></label>
							</div>
						{/if}

						{#if q.type === 'choice'}
							<div class="choices">
								{#each q.choices ?? [] as _, c (c)}
									<span class="choice">
										<input type="text" bind:value={q.choices![c]} placeholder="Option {c + 1}" />
										<button class="btn small subtle" type="button" onclick={() => removeChoice(i, c)} aria-label="Remove option">✕</button>
									</span>
								{/each}
								<button class="btn small" type="button" onclick={() => addChoice(i)}>+ option</button>
							</div>
						{/if}
					</div>
				{/each}
			</div>

			{#if questions.length === 0}
				<p class="muted">No questions yet — people will just add their name.</p>
			{/if}

			<div class="formactions">
				<button class="btn" type="button" onclick={addQuestion} disabled={questions.length >= MAX_QUESTIONS}>
					+ Add question
				</button>
				<label class="reqbox">
					<input type="checkbox" name="allow_edits" bind:checked={allowEdits} />
					let people change their answers afterwards
				</label>
				<button class="btn primary" type="submit">Save questions</button>
			</div>
		</form>
	</section>

	<!-- ── Roster ───────────────────────────────────────────────────── -->
	<section class="osrs-panel">
		<h2 class="osrs-titlebar">Who's signed up ({data.roster.length})</h2>

		{#if data.roster.length === 0}
			<p class="muted">Nobody yet.</p>
		{:else}
			<div class="rosterbar">
				<button class="btn small" type="button" onclick={toggleAll}>
					{allSelected ? 'Select none' : 'Select all'}
				</button>
				<span class="muted">{selected.size} selected</span>
				<button class="btn small" type="button" onclick={copyCsv}>
					{copied ? 'Copied ✓' : 'Copy as CSV'}
				</button>
			</div>

			<div class="tablewrap">
				<table>
					<thead>
						<tr>
							<th class="pick"></th>
							<th>RSN</th>
							<th>Discord</th>
							<th>Signed up</th>
							{#each data.event.form.questions as q (q.id)}<th>{q.label}</th>{/each}
							<th></th>
						</tr>
					</thead>
					<tbody>
						{#each data.roster as r (r.userId)}
							<tr class:unpicked={!selected.has(r.userId)}>
								<td class="pick">
									<input
										type="checkbox"
										checked={selected.has(r.userId)}
										onchange={() => toggle(r.userId)}
										aria-label="Include {r.rsn ?? 'this player'}"
									/>
								</td>
								<td class="rsn">{r.rsn ?? '—'}</td>
								<td class="muted">{r.discord ?? '—'}</td>
								<td class="muted when">{dt(r.joinedAt)}</td>
								{#each data.event.form.questions as q (q.id)}
									<td>{answerText(q, r.answers) || '—'}</td>
								{/each}
								<td>
									<form method="POST" action="?/remove" use:enhance>
										<input type="hidden" name="user_id" value={r.userId} />
										<button class="btn small subtle" type="submit" aria-label="Remove {r.rsn ?? 'player'}">✕</button>
									</form>
								</td>
							</tr>
						{/each}
					</tbody>
				</table>
			</div>
		{/if}
	</section>

	<!-- ── The handoff ──────────────────────────────────────────────── -->
	{#if data.roster.length}
		<section class="osrs-panel">
			<h2 class="osrs-titlebar">Use these people</h2>
			<p class="hint">
				Build the real event first, then send the selected people into it — they land as
				signups, exactly as if they had joined it themselves. Nothing is removed from this
				list, and re-running it only adds whoever is missing, so it is safe to do twice.
			</p>

			<form method="POST" action="?/convert" use:enhance class="convert">
				{#each data.roster as r (r.userId)}
					{#if selected.has(r.userId)}<input type="hidden" name="user_id" value={r.userId} />{/if}
				{/each}

				<select name="target_slug" bind:value={targetSlug}>
					<option value="">— pick the event —</option>
					{#each data.targets as t (t.slug)}
						<option value={t.slug}>{t.name} ({t.kind} · {t.status})</option>
					{/each}
				</select>

				<button class="btn primary" type="submit" disabled={!targetSlug || selected.size === 0}>
					Add {selected.size} {selected.size === 1 ? 'person' : 'people'}
				</button>
			</form>

			{#if form && 'convertedTo' in form && form.convertedTo}
				<p class="ok">
					<a href="/events/{form.convertedTo}">Open the event →</a>
				</p>
			{/if}
		</section>
	{/if}
</div>

<style>
	.wrap { max-width: 72rem; margin: 0 auto; padding: 0 0 3rem; }
	.head { margin: 1.25rem 0 1rem; }
	.crumb { margin: 0 0 0.35rem; font-size: 0.8rem; }
	h1 { font-family: var(--font-heading); color: var(--heading); margin: 0; }
	.lede { color: var(--muted); margin: 0.3rem 0 0; font-size: 0.85rem; }
	.shut { color: var(--danger); margin-left: 0.5rem; }
	.hint { font-size: 0.8rem; color: var(--muted); margin: 0 0 0.75rem; }
	.muted { color: var(--muted); }

	.err, .ok { padding: 0.5rem 0.7rem; border: 1px solid; border-radius: var(--radius);
	            margin: 0 0 0.75rem; font-size: 0.85rem; }
	.err { color: var(--danger); background: var(--danger-bg); border-color: var(--danger); }
	.ok { color: var(--success); background: var(--success-bg); border-color: var(--success); }

	.introfield { display: grid; gap: 0.25rem; margin-bottom: 0.9rem; font-size: 0.85rem; }
	.introfield textarea { width: 100%; }

	.qlist { display: grid; gap: 0.6rem; }
	.qrow { padding: 0.6rem; display: grid; gap: 0.45rem; }
	.qtop { display: flex; align-items: center; gap: 0.5rem; flex-wrap: wrap; }
	.qn { font-family: var(--font-heading); color: var(--muted); min-width: 1.1rem; }
	.qlabel { flex: 1 1 16rem; min-width: 0; }
	.qtype { flex: 0 0 auto; }
	.qhelp { width: 100%; font-size: 0.85rem; }
	.reqbox { display: inline-flex; align-items: center; gap: 0.3rem; font-size: 0.8rem;
	          color: var(--muted); white-space: nowrap; }
	.qmove { display: inline-flex; gap: 0.2rem; margin-left: auto; }

	.bounds { display: flex; gap: 0.75rem; font-size: 0.8rem; }
	.bounds input { width: 6rem; }
	.choices { display: flex; flex-wrap: wrap; gap: 0.35rem; align-items: center; }
	.choice { display: inline-flex; gap: 0.2rem; align-items: center; }
	.choice input { width: 10rem; }

	.formactions { display: flex; align-items: center; gap: 0.75rem; flex-wrap: wrap;
	               margin-top: 0.9rem; }

	.rosterbar { display: flex; align-items: center; gap: 0.75rem; margin-bottom: 0.6rem;
	             flex-wrap: wrap; font-size: 0.85rem; }

	/* A form with a dozen questions is a wide table; scroll it inside its own box rather
	   than making the page scroll sideways. */
	.tablewrap { overflow-x: auto; }
	table { border-collapse: collapse; width: 100%; font-size: 0.82rem; }
	th, td { text-align: left; padding: 0.3rem 0.5rem; border-bottom: 1px solid var(--border);
	         vertical-align: top; }
	th { font-family: var(--font-heading); color: var(--heading); font-size: 0.78rem;
	     white-space: nowrap; }
	.rsn { font-family: var(--font-heading); }
	.when { white-space: nowrap; }
	.pick { width: 1.5rem; }
	tr.unpicked { opacity: 0.45; }

	.convert { display: flex; gap: 0.6rem; align-items: center; flex-wrap: wrap; }

	.btn.primary { color: var(--yellow); }
	.btn.subtle { color: var(--muted); }
	.btn.subtle:hover { color: var(--danger); }
	.btn.small { min-height: 28px; padding: 0 8px; font-size: 0.78rem; }
</style>

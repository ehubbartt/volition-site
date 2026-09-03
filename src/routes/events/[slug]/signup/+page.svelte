<script lang="ts">
	import type { PageData, ActionData } from './$types';
	import { enhance } from '$app/forms';
	import { swrResource } from '$lib/swrResource.svelte';
	import Skeleton from '$lib/Skeleton.svelte';
	import type { SignupQuestion } from '$lib/events/signupForm';
	import type { SignupPageResult } from '$lib/server/signupPage';

	let { data, form }: { data: PageData; form: ActionData } = $props();

	// No server load — the page paints before the payload lands (see docs/PAGES.md).
	const EMPTY = { kind: 'ok', event: null } as unknown as SignupPageResult;
	const res = swrResource(() => data.signup, EMPTY);
	const payload = $derived(res.value as SignupPageResult);
	const ev = $derived(payload?.kind === 'ok' ? payload.event : null);
	const notFound = $derived(payload?.kind === 'not_found');

	const questions = $derived(ev?.form.questions ?? []);
	const mine = $derived(payload?.kind === 'ok' ? payload.mine : null);
	const win = $derived(
		payload?.kind === 'ok' ? payload.window : { open: false, reason: null as string | null }
	);
	const signedUp = $derived(!!mine);
	const canEdit = $derived(win.open && (!signedUp || !!ev?.form.allowEdits));
	const count = $derived(payload?.kind === 'ok' ? payload.signedUpCount : 0);
	const names = $derived(payload?.kind === 'ok' ? payload.names : []);
	// The two camps. A members-only signup has no visitors and renders one flat list.
	const volitionNames = $derived(names.filter((n) => n.volition).map((n) => n.rsn));
	const visitorNames = $derived(names.filter((n) => !n.volition).map((n) => n.rsn));
	const viewerIsAdmin = $derived(payload?.kind === 'ok' && payload.isAdmin);

	const fieldErrors = $derived<Record<string, string>>(
		form && 'fieldErrors' in form && form.fieldErrors
			? (form.fieldErrors as Record<string, string>)
			: {}
	);

	// The value to show in each input: whatever the person last saved. A failed submit
	// re-renders from the saved answers rather than the rejected ones, which is the wrong
	// half of the trade — but the alternative is echoing unvalidated input back into the
	// DOM, and a form of at most twelve fields is cheap to re-check.
	const answerFor = (q: SignupQuestion): string => {
		const v = mine?.answers?.[q.id];
		return v === undefined ? '' : String(v);
	};

	const dt = (s: string | null) =>
		s ? new Date(s).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : null;
</script>

<svelte:head><title>{ev?.name ?? 'Sign up'}</title></svelte:head>

{#if notFound}
	<div class="wrap"><section class="osrs-panel">
		<h2 class="osrs-titlebar">Not found</h2>
		<p class="muted">There's no signup here. It may have been closed or removed.</p>
	</section></div>
{:else if !ev}
	<div class="wrap">
		<Skeleton height="2rem" width="18rem" />
		<div class="skelgap"></div>
		<Skeleton height="12rem" />
	</div>
{:else}
<div class="wrap">
	<header class="head">
		<h1>{ev.name}</h1>
		{#if ev.description}<p class="lede">{ev.description}</p>{/if}
	</header>

	{#if viewerIsAdmin}
		<p class="adminbar osrs-inset">
			<span class="tag">admin</span>
			<a href="/admin/events/{ev.slug}/signup">Questions &amp; roster →</a>
		</p>
	{/if}

	<section class="osrs-panel">
		<h2 class="osrs-titlebar">
			{#if signedUp}You're signed up{:else}Sign up{/if}
		</h2>

		<p class="status">
			<strong>{count}</strong>
			{count === 1 ? 'person has' : 'people have'} signed up.
			{#if ev.signupClosesAt && win.open}
				<span class="muted">Signups close {dt(ev.signupClosesAt)}.</span>
			{/if}
		</p>

		{#if !win.open}
			<p class="err">{win.reason}</p>
		{/if}

		{#if form && 'error' in form && form.error}<p class="err">{form.error}</p>{/if}
		{#if form && 'ok' in form && form.ok}
			<p class="ok">
				{#if 'withdrawn' in form && form.withdrawn}
					You've been taken off the list.
				{:else if 'created' in form && form.created}
					You're on the list. You can change your answers any time before signups close.
				{:else}
					Answers updated.
				{/if}
			</p>
		{/if}

		{#if ev.form.intro}<p class="intro">{ev.form.intro}</p>{/if}

		{#if canEdit}
			<form method="POST" action="?/submit" use:enhance class="qform">
				{#each questions as q (q.id)}
					<div class="field" class:bad={!!fieldErrors[q.id]}>
						<label for="q-{q.id}">
							{q.label}
							{#if q.required}<span class="req" aria-label="required">*</span>{/if}
						</label>
						{#if q.help}<p class="help">{q.help}</p>{/if}

						{#if q.type === 'long'}
							<textarea id="q-{q.id}" name={q.id} rows="4" required={q.required}
								>{answerFor(q)}</textarea>
						{:else if q.type === 'number'}
							<input
								id="q-{q.id}"
								name={q.id}
								type="number"
								inputmode="numeric"
								min={q.min}
								max={q.max}
								required={q.required}
								value={answerFor(q)}
							/>
						{:else if q.type === 'choice'}
							<select id="q-{q.id}" name={q.id} required={q.required} value={answerFor(q)}>
								<option value="">— pick one —</option>
								{#each q.choices ?? [] as c (c)}<option value={c}>{c}</option>{/each}
							</select>
						{:else}
							<input id="q-{q.id}" name={q.id} type="text" required={q.required} value={answerFor(q)} />
						{/if}

						{#if fieldErrors[q.id]}<p class="fielderr">{fieldErrors[q.id]}</p>{/if}
					</div>
				{/each}

				{#if questions.length === 0}
					<p class="muted">No questions — just add your name.</p>
				{/if}

				<div class="actions">
					<button class="btn primary" type="submit">
						{signedUp ? 'Save my answers' : 'Sign me up'}
					</button>
				</div>
			</form>
		{:else if signedUp}
			<!-- Locked, but they should still be able to READ what they said — otherwise the
			     only record of their own answers is one they can't see. -->
			<ul class="readonly">
				{#each questions as q (q.id)}
					<li>
						<span class="qlabel">{q.label}</span>
						<span class="qval">{answerFor(q) || '—'}</span>
					</li>
				{/each}
			</ul>
		{/if}

		<!-- A locked form locks this too: withdrawing and signing up again would otherwise
		     be a way straight round "your answers are final". The server enforces it. -->
		{#if signedUp && win.open && ev.form.allowEdits}
			<form method="POST" action="?/withdraw" use:enhance class="withdraw">
				<button class="btn subtle small" type="submit">Take me off the list</button>
			</form>
		{/if}
	</section>

	{#if names.length}
		<section class="osrs-panel">
			<h2 class="osrs-titlebar">Who's in ({names.length})</h2>
			{#if visitorNames.length && volitionNames.length}
				<div class="camps">
					<div class="camp">
						<h3>Volition ({volitionNames.length})</h3>
						<ul class="names">
							{#each volitionNames as n, i (`${n}-${i}`)}<li>{n}</li>{/each}
						</ul>
					</div>
					<div class="camp">
						<h3>Visitors ({visitorNames.length})</h3>
						<ul class="names">
							{#each visitorNames as n, i (`${n}-${i}`)}<li>{n}</li>{/each}
						</ul>
					</div>
				</div>
			{:else}
				<ul class="names">
					{#each names as n, i (`${n.rsn}-${i}`)}<li>{n.rsn}</li>{/each}
				</ul>
			{/if}
		</section>
	{/if}
</div>
{/if}

<style>
	.wrap { max-width: 46rem; margin: 0 auto; padding: 0 0 3rem; }
	.head { margin: 1.5rem 0 1rem; }
	h1 { font-family: var(--font-heading); color: var(--heading); margin: 0; }
	.lede { color: var(--muted); margin: 0.35rem 0 0; }

	.adminbar { display: flex; align-items: center; gap: 0.6rem; padding: 0.4rem 0.6rem;
	            font-size: 0.85rem; margin-bottom: 0.75rem; }
	.tag { font-size: 0.7rem; text-transform: uppercase; letter-spacing: 0.05em;
	       color: var(--accent); }

	.status { margin: 0 0 0.75rem; font-size: 0.9rem; }
	.muted { color: var(--muted); }
	.intro { margin: 0 0 1rem; color: var(--muted); white-space: pre-wrap; }

	.err, .ok { padding: 0.5rem 0.7rem; border: 1px solid; border-radius: var(--radius);
	            margin: 0 0 0.75rem; font-size: 0.85rem; }
	.err { color: var(--danger); background: var(--danger-bg); border-color: var(--danger); }
	.ok { color: var(--success); background: var(--success-bg); border-color: var(--success); }

	.qform { display: grid; gap: 1rem; }
	.field { display: grid; gap: 0.3rem; }
	.field label { font-family: var(--font-heading); font-size: 0.9rem; text-shadow: var(--ts); }
	.req { color: var(--danger); }
	.help { margin: 0; font-size: 0.78rem; color: var(--muted); }
	.field input, .field select, .field textarea { width: 100%; }
	.field.bad input, .field.bad select, .field.bad textarea { border-color: var(--danger); }
	.fielderr { margin: 0; font-size: 0.78rem; color: var(--danger); }

	.actions { margin-top: 0.25rem; }
	.btn.primary { color: var(--yellow); }
	.btn.subtle { color: var(--muted); }
	.btn.subtle:hover { color: var(--danger); }
	.btn.small { min-height: 30px; padding: 1px 10px; font-size: 0.8rem; }
	.withdraw { margin-top: 1rem; }

	.readonly { list-style: none; margin: 0; padding: 0; display: grid; gap: 0.5rem; }
	.readonly li { display: grid; gap: 0.15rem; }
	.qlabel { font-family: var(--font-heading); font-size: 0.85rem; }
	.qval { color: var(--muted); white-space: pre-wrap; }

	.names { list-style: none; margin: 0; padding: 0; columns: 3; font-size: 0.85rem; }
	@media (max-width: 640px) { .names { columns: 2; } }

	.camps { display: grid; grid-template-columns: 1fr 1fr; gap: 1rem; }
	.camp h3 { font-family: var(--font-heading); font-size: 0.9rem; color: var(--heading);
	           margin: 0 0 0.4rem; text-shadow: var(--ts); }
	.camp .names { columns: 2; }
	@media (max-width: 640px) {
		.camps { grid-template-columns: 1fr; }
		.camp .names { columns: 2; }
	}
</style>

<script lang="ts">
	import type { PageData, ActionData } from './$types';
	import { enhance } from '$app/forms';
	import { invalidateAll } from '$app/navigation';
	import { STEP_META, type StepId } from '$lib/onboarding/steps';

	let { data, form }: { data: PageData; form: ActionData } = $props();

	// SvelteKit's ActionData is a union of every action's return shape; narrowing nested
	// props off it is painful, so read display values through a permissive alias.
	const f = $derived(form as unknown as Record<string, any> | null);

	// Refresh the session (and thus the rail + current step) after any action.
	const refresh = () => invalidateAll();

	let busy = $state(false);
	function submitting() {
		busy = true;
		return async ({ update }: { update: (o?: { reset?: boolean }) => Promise<void> }) => {
			await update({ reset: false });
			await refresh();
			busy = false;
		};
	}

	const session = $derived(data.session ?? null);
	const stepIndex = $derived(session ? session.steps.indexOf(session.currentStep) : 0);
	const isDone = $derived(session ? session.completed.length >= session.steps.length : false);

	function railState(step: StepId): 'done' | 'current' | 'todo' {
		if (!session) return 'todo';
		if (step === session.currentStep) return 'current';
		return session.completed.includes(step) ? 'done' : 'todo';
	}
</script>

<svelte:head><title>Welcome to Volition</title></svelte:head>

{#if data.invalid}
	<section class="wrap">
		<div class="card invalid">
			<h1>This onboarding link isn't usable</h1>
			<p>
				{#if data.invalid === 'expired'}This link has expired — ask an admin for a fresh one.
				{:else if data.invalid === 'wrong_user'}This link was issued to a different Discord account. Sign in as the account it was sent to.
				{:else}We couldn't find this onboarding link. Double-check the URL or ask an admin for a new one.
				{/if}
			</p>
			<a class="btn" href="/">Go to the site</a>
		</div>
	</section>
{:else if session}
	<section class="wrap">
		<!-- Progress rail -->
		<ol class="rail" aria-label="Onboarding steps">
			{#each session.steps as step, i (step)}
				<li class="rail-item {railState(step)}">
					<span class="dot">{railState(step) === 'done' ? '✓' : i + 1}</span>
					<span class="rail-label">{STEP_META[step].short}</span>
				</li>
			{/each}
		</ol>

		<div class="card">
			<h1>{STEP_META[session.currentStep].title}</h1>

			<!-- ── welcome ─────────────────────────────────────────────── -->
			{#if session.currentStep === 'welcome'}
				<p class="lead">
					Welcome, {data.user.discord_username}! This quick flow gets you set up in Volition — we'll
					verify your account, set up rank tracking, take your introduction, and hand you your
					welcome rewards. It takes a few minutes.
				</p>
				<form method="POST" action="?/advance" use:enhance={submitting}>
					<input type="hidden" name="step" value="welcome" />
					<button class="btn primary" disabled={busy}>Let's go →</button>
				</form>

				<!-- ── verify ────────────────────────────────────────────── -->
			{:else if session.currentStep === 'verify'}
				<p class="lead">
					Enter your RuneScape name exactly as it appears in game. We check it against WiseOldMan —
					the clan requirement is <strong>2000+ total level and 150+ EHB</strong>.
				</p>
				<form method="POST" action="?/verify" use:enhance={submitting} class="stack">
					<label>RSN<input name="rsn" maxlength="12" placeholder="e.g. Zezima" value={data.user.rsn ?? ''} required /></label>
					{#if f?.verify}
						{@const v = f.verify}
						<div class="result {v.meets ? 'ok' : 'warn'}">
							<span>Total level: <strong>{v.totalLevel ?? '—'}</strong></span>
							<span>EHB: <strong>{Math.round(v.ehb)}</strong></span>
							<span>{v.meets ? '✓ Meets requirements' : '✗ Below requirements'}</span>
						</div>
					{/if}
					{#if f?.verifyError}<p class="err">{f.verifyError}</p>{/if}
					<div class="row">
						<button class="btn primary" disabled={busy}>Verify</button>
						{#if data.isAdmin && f?.verify && !f.verify.meets}
							<button class="btn" name="force" value="true" disabled={busy}>Force verify (admin)</button>
						{/if}
					</div>
				</form>

				<!-- ── profile ───────────────────────────────────────────── -->
			{:else if session.currentStep === 'profile'}
				<p class="lead">A couple of details for your clan profile.</p>
				<form method="POST" action="?/saveProfile" use:enhance={submitting} class="stack">
					<label>Clan allegiance
						<select name="clan_allegiance" required>
							<option value="" disabled selected={!data.user.clan_allegiance}>Choose…</option>
							{#each data.clanOptions as c (c.value)}
								<option value={c.value} selected={data.user.clan_allegiance === c.value}>{c.label}</option>
							{/each}
						</select>
					</label>
					<label>Account type
						<select name="account_type" required>
							<option value="" disabled selected={!data.user.account_type}>Choose…</option>
							{#each data.accountTypes as a (a.value)}
								<option value={a.value} selected={data.user.account_type === a.value}>{a.label}</option>
							{/each}
						</select>
					</label>
					{#if f?.profileError}<p class="err">{f.profileError}</p>{/if}
					<button class="btn primary" disabled={busy}>Save & continue →</button>
				</form>

				<!-- ── intro ─────────────────────────────────────────────── -->
			{:else if session.currentStep === 'intro'}
				<p class="lead">Introduce yourself — this gets posted to our introductions channel on Discord.</p>
				<form method="POST" action="?/submitIntro" use:enhance={submitting} class="stack">
					<label>RSN, account type & age<input name="basic_info" maxlength="100" placeholder="Zezima, Main, 21 years old" required /></label>
					<label>Total level & time zone<input name="stats_info" maxlength="100" placeholder="2100 total, EST timezone" required /></label>
					<label>Previous clan & why you left<textarea name="clan_history" maxlength="500" placeholder='Your clan history, or "None" if this is your first' required></textarea></label>
					<label>Favorite content & current goals<textarea name="goals_interests" maxlength="500" placeholder="What you love doing + what you're working towards"></textarea></label>
					<label>What are you looking for & anything else?<textarea name="additional_info" maxlength="1000"></textarea></label>
					{#if f?.introError}<p class="err">{f.introError}</p>{/if}
					<button class="btn primary" disabled={busy}>Post introduction →</button>
				</form>

				<!-- ── temple ────────────────────────────────────────────── -->
			{:else if session.currentStep === 'temple'}
				<p class="lead">
					TempleOSRS powers your clan rank and personal bingo. Install the plugin, enable
					collection-log auto-sync, then open your log once to sync it.
				</p>
				<a class="btn" href="/temple-guide" target="_blank" rel="noopener">Open the Temple setup guide ↗</a>
				<form method="POST" action="?/advance" use:enhance={submitting}>
					<input type="hidden" name="step" value="temple" />
					<button class="btn primary" disabled={busy}>Done — continue →</button>
				</form>

				<!-- ── dink ──────────────────────────────────────────────── -->
			{:else if session.currentStep === 'dink'}
				<p class="lead">
					Dink reports your drops so bingo/loot tracking works. In RuneLite's Dink plugin, paste this
					personal URL into <em>Dynamic config URL</em> under Advanced settings.
				</p>
				{#if data.dinkConfigUrl}
					<code class="url">{data.dinkConfigUrl}</code>
				{:else}
					<p class="err">Couldn't generate your Dink URL right now — you can set this up later from the Dink page.</p>
				{/if}
				<form method="POST" action="?/completeDink" use:enhance={submitting}>
					<button class="btn primary" disabled={busy}>Done — continue →</button>
				</form>

				<!-- ── rank ──────────────────────────────────────────────── -->
			{:else if session.currentStep === 'rank'}
				<p class="lead">Let's compute your starting clan rank from your live stats.</p>
				{#if f?.rankOk}
					<div class="result ok">
						<span>Your rank: <strong>{f.rank}</strong></span>
						<span>{f.rankSaved ? '✓ Saved to your clan record' : 'Computed (not saved — a stats source was down)'}</span>
					</div>
					<form method="POST" action="?/advance" use:enhance={submitting}>
						<input type="hidden" name="step" value="rank" />
						<button class="btn primary" disabled={busy}>Continue →</button>
					</form>
				{:else}
					{#if f?.rankError}<p class="err">{f.rankError}</p>{/if}
					<form method="POST" action="?/checkRank" use:enhance={submitting}>
						<button class="btn primary" disabled={busy}>{busy ? 'Checking…' : 'Check my rank'}</button>
					</form>
				{/if}

				<!-- ── rewards ───────────────────────────────────────────── -->
			{:else if session.currentStep === 'rewards'}
				<p class="lead">Welcome to the clan — here are your joining rewards.</p>
				{#if f?.rewarded}
					<div class="result ok">
						{#if f.crate}<span>Loot crate: <strong>{f.crate.label}</strong></span>{/if}
						<span>{f.whitePack ? '✓ A white card pack was added to your collection' : 'White pack already claimed'}</span>
					</div>
					<p class="muted">Open your pack any time on the Gamba page.</p>
					<form method="POST" action="?/advance" use:enhance={submitting}>
						<input type="hidden" name="step" value="rewards" />
						<button class="btn primary" disabled={busy}>Continue →</button>
					</form>
				{:else}
					<form method="POST" action="?/claimRewards" use:enhance={submitting}>
						<button class="btn primary" disabled={busy}>{busy ? 'Opening…' : 'Claim my rewards 🎁'}</button>
					</form>
				{/if}

				<!-- ── join ──────────────────────────────────────────────── -->
			{:else if session.currentStep === 'join'}
				<p class="lead">
					Last step in game: hop into the <strong>Volition clan chat</strong> in OSRS and a member will
					invite and rank you. Your rank syncs to Discord automatically once you're in.
				</p>
				<form method="POST" action="?/advance" use:enhance={submitting}>
					<input type="hidden" name="step" value="join" />
					<button class="btn primary" disabled={busy}>I'm in — finish →</button>
				</form>

				<!-- ── next ──────────────────────────────────────────────── -->
			{:else if session.currentStep === 'next'}
				<p class="lead">You're all set. Welcome to Volition! Here's where to go next:</p>
				<div class="next-grid">
					<a class="next-card" href="/events">🎯 Explore events & bingo</a>
					<a class="next-card" href="/me">👤 Your profile & rank</a>
					<a class="next-card" href="/gamba">🃏 Open your card pack</a>
					<a class="next-card" href="https://discord.com/channels/@me" target="_blank" rel="noopener">💬 Back to Discord</a>
				</div>
				{#if !isDone}
					<form method="POST" action="?/advance" use:enhance={submitting}>
						<input type="hidden" name="step" value="next" />
						<button class="btn primary" disabled={busy}>Finish</button>
					</form>
				{:else}
					<p class="muted">🎉 Onboarding complete.</p>
				{/if}
			{/if}

			<!-- Back to a previous step -->
			{#if stepIndex > 0 && session.currentStep !== 'next'}
				<form method="POST" action="?/goto" use:enhance={submitting} class="back">
					<input type="hidden" name="step" value={session.steps[stepIndex - 1]} />
					<button class="linkbtn" disabled={busy}>← Back</button>
				</form>
			{/if}
		</div>
	</section>
{/if}

<style>
	.wrap {
		max-width: 44rem;
		margin: 2rem auto;
		padding: 0 1rem;
	}
	.rail {
		display: flex;
		flex-wrap: wrap;
		gap: 0.4rem 0.9rem;
		list-style: none;
		padding: 0;
		margin: 0 0 1rem;
	}
	.rail-item {
		display: flex;
		align-items: center;
		gap: 0.35rem;
		font-size: 0.78rem;
		color: var(--muted);
	}
	.rail-item .dot {
		display: flex;
		align-items: center;
		justify-content: center;
		width: 1.35rem;
		height: 1.35rem;
		border-radius: 50%;
		border: 1px solid var(--border-strong);
		font-size: 0.72rem;
		font-family: var(--font-heading);
	}
	.rail-item.done { color: var(--success); }
	.rail-item.done .dot { border-color: var(--success); color: var(--success); }
	.rail-item.current { color: var(--accent); }
	.rail-item.current .dot { border-color: var(--accent); color: var(--accent); background: var(--accent-soft); }

	.card {
		padding: 1.5rem;
		background: linear-gradient(180deg, rgba(58, 48, 36, 0.6), rgba(40, 32, 24, 0.6));
		border: 1px solid var(--border);
		border-radius: var(--radius);
	}
	.card h1 { margin: 0 0 0.75rem; font-size: 1.5rem; }
	.lead { color: var(--text); margin: 0 0 1rem; }
	.muted { color: var(--muted); font-size: 0.85rem; }

	.stack { display: flex; flex-direction: column; gap: 0.75rem; }
	.stack label { display: flex; flex-direction: column; gap: 0.3rem; font-size: 0.85rem; color: var(--accent); }
	.stack input, .stack select, .stack textarea {
		width: 100%;
		padding: 0.5rem 0.6rem;
		background: var(--surface);
		border: 1px solid var(--border-strong);
		border-radius: 3px;
		color: var(--text);
		font-family: var(--font-body);
	}
	.stack textarea { min-height: 4.5rem; resize: vertical; }

	.row { display: flex; gap: 0.5rem; flex-wrap: wrap; }
	.btn {
		display: inline-block;
		margin-top: 0.5rem;
		border-color: var(--border-strong);
		text-decoration: none;
	}
	.btn.primary { border-color: var(--accent); }
	.btn.primary:hover:not(:disabled) { background: var(--accent-soft); }
	.linkbtn { background: none; border: none; color: var(--muted); padding: 0; min-height: 0; }
	.back { margin-top: 1rem; }

	.url {
		display: block;
		padding: 0.6rem 0.7rem;
		margin: 0.5rem 0;
		background: var(--surface);
		border: 1px solid var(--border);
		border-radius: 3px;
		word-break: break-all;
		font-size: 0.82rem;
	}
	.result {
		display: flex;
		flex-wrap: wrap;
		gap: 0.4rem 1rem;
		padding: 0.6rem 0.8rem;
		margin: 0.5rem 0;
		border-radius: var(--radius);
		font-size: 0.9rem;
	}
	.result.ok { background: var(--success-bg); border: 1px solid var(--success); }
	.result.warn { background: var(--danger-bg); border: 1px solid var(--danger); }
	.err { color: var(--danger); font-size: 0.85rem; margin: 0.25rem 0; }

	.next-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(11rem, 1fr)); gap: 0.6rem; margin: 0.5rem 0; }
	.next-card {
		padding: 0.9rem;
		background: var(--surface-alt);
		border: 1px solid var(--border);
		border-radius: var(--radius);
		color: var(--text);
		text-decoration: none;
		text-align: center;
	}
	.next-card:hover { border-color: var(--accent); background: var(--accent-soft); }

	.invalid { text-align: center; }
</style>

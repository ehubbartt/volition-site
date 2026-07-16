<script lang="ts">
	import type { PageData, ActionData } from './$types';
	import { enhance } from '$app/forms';
	import { invalidateAll } from '$app/navigation';
	import { fly, scale, fade } from 'svelte/transition';
	import { STEP_META, type StepId } from '$lib/onboarding/steps';
	import TempleGuide from '$lib/guides/TempleGuide.svelte';
	import DinkGuide from '$lib/guides/DinkGuide.svelte';
	import PackOpener from '$lib/cards/PackOpener.svelte';
	import CrateReveal from '$lib/cards/CrateReveal.svelte';

	let { data, form }: { data: PageData; form: ActionData } = $props();

	// SvelteKit's ActionData is a union of every action's return shape; read display
	// values through a permissive alias.
	const f = $derived(form as unknown as Record<string, any> | null);

	let busy = $state(false);
	function submitting() {
		busy = true;
		return async ({ update }: { update: (o?: { reset?: boolean }) => Promise<void> }) => {
			await update({ reset: false });
			await invalidateAll();
			busy = false;
		};
	}

	const session = $derived(data.session ?? null);
	const stepIndex = $derived(session ? session.steps.indexOf(session.currentStep) : 0);
	const progressPct = $derived(session ? Math.round((session.completed.length / session.steps.length) * 100) : 0);
	const isDone = $derived(session ? session.completed.length >= session.steps.length : false);

	function railState(step: StepId): 'done' | 'current' | 'todo' {
		if (!session) return 'todo';
		if (step === session.currentStep) return 'current';
		return session.completed.includes(step) ? 'done' : 'todo';
	}

	// ── Rewards step: persist claim + opening across the two actions ──────────────
	let claimed = $state(false);
	let crate = $state<Record<string, any> | null>(null);
	let crateDone = $state(false); // the crate reveal has been watched + dismissed
	let packId = $state<string | null>(null);
	let packOpen = $state(false);
	let packCards = $state<any[]>([]);
	let packMeta = $state<{ name: string; front_url: string | null; back_url: string | null } | null>(null);
	$effect(() => {
		if (f?.rewarded) {
			claimed = true;
			crate = f.crate ?? null;
			packId = f.whitePackId ?? packId;
		}
		if (f?.packOpened) {
			packMeta = f.pack;
			packCards = f.opened ?? [];
			packOpen = true;
		}
	});
</script>

<svelte:head><title>Welcome to Volition</title></svelte:head>

{#if data.invalid}
	<section class="wrap">
		<div class="card invalid">
			<h1>This link isn't usable</h1>
			<p>
				{#if data.invalid === 'expired'}It's expired — ask an admin for a fresh one.
				{:else if data.invalid === 'wrong_user'}It was issued to a different Discord account — sign in as that account.
				{:else}We couldn't find this link. Ask an admin for a new one.
				{/if}
			</p>
			<a class="btn" href="/">Go to the site</a>
		</div>
	</section>
{:else if session}
	<section class="wrap">
		<!-- Progress: a bar + a compact scrollable rail (mobile-friendly) -->
		<div class="progress">
			<div class="bar"><span style="width:{progressPct}%"></span></div>
			<ol class="rail" aria-label="Onboarding steps">
				{#each session.steps as step, i (step)}
					<li class="rail-item {railState(step)}">
						<span class="dot">{railState(step) === 'done' ? '✓' : i + 1}</span>
						<span class="rail-label">{STEP_META[step].short}</span>
					</li>
				{/each}
			</ol>
		</div>

		{#key session.currentStep}
			<div class="card" in:fly={{ y: 16, duration: 260 }}>
				<h1>{STEP_META[session.currentStep].title}</h1>

				<!-- ── welcome ─────────────────────────────────────────────── -->
				{#if session.currentStep === 'welcome'}
					<p class="lead">Hey {data.user.discord_username} 👋 — a few quick steps to get you set up. Takes a couple minutes.</p>
					<div class="chips">
						<span class="chip">✅ Verify</span><span class="chip">📊 Rank</span>
						<span class="chip">🖼️ Setup</span><span class="chip">🎁 Rewards</span>
					</div>
					<form method="POST" action="?/advance" use:enhance={submitting}>
						<input type="hidden" name="step" value="welcome" />
						<button class="btn primary big" disabled={busy}>Let's go →</button>
					</form>

					<!-- ── verify ────────────────────────────────────────────── -->
				{:else if session.currentStep === 'verify'}
					{#if f?.verified}
						<!-- Affirmation: celebrate meeting the requirement before moving on. -->
						<div class="affirm" in:scale={{ start: 0.7, duration: 350 }}>
							<div class="affirm-check">✓</div>
							<h2>You're verified!</h2>
							<p class="affirm-stats">Total <strong>{f.verify.totalLevel ?? '—'}</strong> · <strong>{Math.round(f.verify.ehb)}</strong> EHB — welcome aboard.</p>
						</div>
						<form method="POST" action="?/advance" use:enhance={submitting}>
							<input type="hidden" name="step" value="verify" />
							<button class="btn primary big" disabled={busy}>Continue →</button>
						</form>
					{:else}
						<p class="lead">Enter your RSN exactly as in game — we check it on WiseOldMan (need <strong>2000+ total & 150+ EHB</strong>).</p>
						<form method="POST" action="?/verify" use:enhance={submitting} class="stack">
							<input class="big-input" name="rsn" maxlength="12" placeholder="Your RSN" value={data.user.rsn ?? ''} required />
							{#if f?.verify && !f.verify.meets}
								<div class="result warn" in:scale={{ start: 0.9, duration: 200 }}>
									<span>Total <strong>{f.verify.totalLevel ?? '—'}</strong></span>
									<span>EHB <strong>{Math.round(f.verify.ehb)}</strong></span>
									<span>✗ Below requirement</span>
								</div>
							{/if}
							{#if f?.verifyError}<p class="err">{f.verifyError}</p>{/if}
							<div class="row">
								<button class="btn primary" disabled={busy}>Verify</button>
								{#if data.isAdmin && f?.verify && !f.verify.meets}
									<button class="btn" name="force" value="true" disabled={busy}>Force (admin)</button>
								{/if}
							</div>
						</form>
					{/if}

					<!-- ── profile (account type only; clan auto = Volition) ──── -->
				{:else if session.currentStep === 'profile'}
					<p class="lead">What kind of account are you? Tap one.</p>
					<form method="POST" action="?/saveProfile" use:enhance={submitting} class="pick-grid">
						{#each data.accountTypes as a (a.value)}
							<button class="pick" name="account_type" value={a.value} disabled={busy}>
								{a.label}
							</button>
						{/each}
					</form>
					{#if f?.profileError}<p class="err">{f.profileError}</p>{/if}

					<!-- ── intro ─────────────────────────────────────────────── -->
				{:else if session.currentStep === 'intro'}
					<p class="lead">Say hi — this posts to our intros channel on Discord.</p>
					<form method="POST" action="?/submitIntro" use:enhance={submitting} class="stack">
						<input name="basic_info" maxlength="100" placeholder="RSN, account type & age — e.g. Zezima, Main, 21" required />
						<input name="stats_info" maxlength="100" placeholder="Total level & time zone — e.g. 2100, EST" required />
						<textarea name="clan_history" maxlength="500" placeholder='Previous clan & why you left (or "None")' required></textarea>
						<textarea name="goals_interests" maxlength="500" placeholder="Favourite content & current goals"></textarea>
						<textarea name="additional_info" maxlength="1000" placeholder="What are you looking for? Anything else?"></textarea>
						{#if f?.introError}<p class="err">{f.introError}</p>{/if}
						<button class="btn primary" disabled={busy}>Post introduction →</button>
					</form>

					<!-- ── temple (full guide inline) ────────────────────────── -->
				{:else if session.currentStep === 'temple'}
					<TempleGuide compact />
					<form method="POST" action="?/advance" use:enhance={submitting}>
						<input type="hidden" name="step" value="temple" />
						<button class="btn primary" disabled={busy}>Done — continue →</button>
					</form>

					<!-- ── dink (full guide inline + skip) ───────────────────── -->
				{:else if session.currentStep === 'dink'}
					<DinkGuide configUrl={data.dinkConfigUrl} compact />
					<!-- Multi-server flag (reuses the /dink-check dink_tokens setting). -->
					<form method="POST" action="?/setMultiServer" use:enhance={submitting} class="multi">
						<label>
							<input type="checkbox" name="multi" value="true" checked={f?.multiSaved ? f.multi : data.dinkMulti} onchange={(e) => e.currentTarget.form?.requestSubmit()} />
							I also use Dink with another Discord server
						</label>
						<span class="multi-hint">Keeps your other server's alerts from firing on every drop — we whitelist just your tracked items instead.</span>
					</form>
					<div class="row">
						<form method="POST" action="?/completeDink" use:enhance={submitting}>
							<button class="btn primary" disabled={busy}>Done — continue →</button>
						</form>
						<form method="POST" action="?/advance" use:enhance={submitting}>
							<input type="hidden" name="step" value="dink" />
							<button class="btn ghost" disabled={busy}>Skip for now</button>
						</form>
					</div>

					<!-- ── rank ──────────────────────────────────────────────── -->
				{:else if session.currentStep === 'rank'}
					<p class="lead">Let's compute your starting clan rank from your live stats.</p>
					<p class="why"><strong>Why:</strong> your rank is your standing in Volition — earned from your gear, EHB, combat achievements, log and time in clan. It syncs to your Discord role automatically.</p>
					{#if f?.rankOk}
						<div class="rankcard" in:scale={{ start: 0.85, duration: 300 }}>
							<span class="rank-name">{f.rank}</span>
							<span class="muted small">{f.rankSaved ? '✓ Saved — synced to your Discord role' : 'Computed (a stats source was down, not saved)'}</span>
							{#if f.breakdown}
								{#if f.breakdown.nextRank}
									<div class="nextbar" title="Progress to the next rank"><span style="width:{Math.round(f.breakdown.nextRankProgress * 100)}%"></span></div>
									<p class="muted small">{Math.round(f.breakdown.nextRankProgress * 100)}% of the way to <strong>{f.breakdown.nextRank}</strong></p>
								{:else}
									<p class="muted small">Top rank — nothing above you. 👑</p>
								{/if}
								<ul class="comps">
									{#each f.breakdown.components as c (c.label)}
										<li>
											<span class="clabel">{c.label}</span>
											<div class="cbar"><span style="width:{Math.round(Math.min(1, c.normalized) * 100)}%"></span></div>
											<span class="craw">{c.raw}/{c.cap}</span>
										</li>
									{/each}
								</ul>
							{/if}
						</div>
						<p class="why"><strong>How ranks work:</strong> a weighted mix of the bars above. Yours is what it is because of where those land today — <strong>raise your lowest bars to climb</strong>.</p>
						<form method="POST" action="?/advance" use:enhance={submitting}>
							<input type="hidden" name="step" value="rank" />
							<button class="btn primary" disabled={busy}>Continue →</button>
						</form>
					{:else}
						{#if f?.rankError}<p class="err">{f.rankError}</p>{/if}
						<form method="POST" action="?/checkRank" use:enhance={submitting}>
							<button class="btn primary big" disabled={busy}>{busy ? 'Checking…' : 'Reveal my rank'}</button>
						</form>
					{/if}

					<!-- ── rewards (open crate + rip pack in-flow) ───────────── -->
				{:else if session.currentStep === 'rewards'}
					{#if !claimed}
						<p class="lead">Welcome to the clan — here's your joining loot. 🎁</p>
						<p class="why"><strong>Loot crate</strong> = free VP to spend on card packs & clan perks. <strong>Card pack</strong> = collectible cards of OSRS bosses & items — rip it for a shot at rares.</p>
						<form method="POST" action="?/claimRewards" use:enhance={submitting}>
							<button class="btn primary big" disabled={busy}>{busy ? 'Opening…' : 'Open my rewards'}</button>
						</form>
					{:else if !crateDone}
						<!-- The crate is spinning in the CrateReveal overlay (rendered below). -->
						<p class="lead">Opening your crate… 🎁</p>
					{:else}
						<p class="lead">Nice loot! Now rip open your welcome card pack.</p>
						{#if f?.openError}<p class="err">{f.openError}</p>{/if}
						<div class="row">
							{#if !packOpen}
								<form method="POST" action="?/openWhitePack" use:enhance={submitting}>
									<input type="hidden" name="pack_id" value={packId ?? ''} />
									<button class="btn primary big" disabled={busy}>{busy ? 'Ripping…' : '🃏 Rip open your pack'}</button>
								</form>
							{/if}
							<form method="POST" action="?/advance" use:enhance={submitting}>
								<input type="hidden" name="step" value="rewards" />
								<button class="btn {packOpen ? 'primary' : 'ghost'}" disabled={busy}>Continue →</button>
							</form>
						</div>
					{/if}

					<!-- ── join ──────────────────────────────────────────────── -->
				{:else if session.currentStep === 'join'}
					<p class="lead">Last step in game: hop into the <strong>Volition clan chat</strong> in OSRS and a member will invite & rank you. Your rank syncs to Discord automatically.</p>
					<form method="POST" action="?/advance" use:enhance={submitting}>
						<input type="hidden" name="step" value="join" />
						<button class="btn primary big" disabled={busy}>I'm in — finish →</button>
					</form>

					<!-- ── next ──────────────────────────────────────────────── -->
				{:else if session.currentStep === 'next'}
					<p class="lead">You're all set. Welcome to Volition! 🎉</p>
					<div class="next-grid">
						<a class="next-card" href="/events">🎯 Events & bingo</a>
						<a class="next-card" href="/me">👤 Your profile</a>
						<a class="next-card" href="/gamba">🃏 Your cards</a>
						<a class="next-card" href="https://discord.com/channels/@me" target="_blank" rel="noopener">💬 Discord</a>
					</div>
					{#if !isDone}
						<form method="POST" action="?/advance" use:enhance={submitting}>
							<input type="hidden" name="step" value="next" />
							<button class="btn primary" disabled={busy}>Finish</button>
						</form>
					{/if}
				{/if}

				{#if stepIndex > 0 && session.currentStep !== 'next'}
					<form method="POST" action="?/goto" use:enhance={submitting} class="back">
						<input type="hidden" name="step" value={session.steps[stepIndex - 1]} />
						<button class="linkbtn" disabled={busy}>← Back</button>
					</form>
				{/if}
			</div>
		{/key}
	</section>

	<!-- Full gamba-style crate reel: spins to the won reward, then Continue shows the pack. -->
	{#if claimed && crate && !crateDone}
		<CrateReveal reward={crate as any} reel={data.crateReel} onClose={() => (crateDone = true)} />
	{/if}

	{#if packOpen && packMeta}
		<div transition:fade={{ duration: 150 }}>
			<PackOpener pack={packMeta} cards={packCards} onClose={() => (packOpen = false)} />
		</div>
	{/if}
{/if}

<style>
	.wrap {
		max-width: 40rem;
		margin: 1.25rem auto;
		padding: 0 0.9rem;
	}

	/* Progress bar + rail */
	.progress { margin-bottom: 1rem; }
	.bar {
		height: 6px;
		border-radius: 999px;
		background: var(--surface-alt);
		overflow: hidden;
		margin-bottom: 0.6rem;
	}
	.bar span {
		display: block;
		height: 100%;
		background: var(--accent);
		border-radius: 999px;
		transition: width 0.4s ease;
	}
	.rail {
		display: flex;
		gap: 0.35rem 0.8rem;
		list-style: none;
		padding: 0 0 0.2rem;
		margin: 0;
		overflow-x: auto;
		-webkit-overflow-scrolling: touch;
	}
	.rail-item { display: flex; align-items: center; gap: 0.3rem; font-size: 0.72rem; color: var(--muted); white-space: nowrap; }
	.rail-item .dot {
		display: flex; align-items: center; justify-content: center;
		width: 1.25rem; height: 1.25rem; border-radius: 50%;
		border: 1px solid var(--border-strong); font-size: 0.68rem; font-family: var(--font-heading);
	}
	.rail-item.done, .rail-item.done .dot { color: var(--success); border-color: var(--success); }
	.rail-item.current { color: var(--accent); }
	.rail-item.current .dot { border-color: var(--accent); color: var(--accent); background: var(--accent-soft); }

	.card {
		padding: 1.4rem 1.25rem;
		background: linear-gradient(180deg, rgba(58, 48, 36, 0.55), rgba(40, 32, 24, 0.55));
		border: 1px solid var(--border);
		border-radius: 12px;
	}
	.card h1 { margin: 0 0 0.75rem; font-size: 1.4rem; }
	.lead { color: var(--text); margin: 0 0 1rem; line-height: 1.5; }
	/* Concise "why they're doing this" callout — one sentence, easy to skim. */
	.why {
		margin: 0 0 1rem;
		padding: 0.6rem 0.75rem;
		background: var(--accent-soft);
		border: 1px solid var(--accent);
		border-radius: 8px;
		font-size: 0.9rem;
		line-height: 1.45;
	}

	.chips { display: flex; flex-wrap: wrap; gap: 0.45rem; margin-bottom: 1.1rem; }
	.chip {
		padding: 0.3rem 0.7rem; border-radius: 999px; font-size: 0.82rem;
		background: var(--surface-alt); border: 1px solid var(--border);
	}

	.stack { display: flex; flex-direction: column; gap: 0.7rem; }
	.stack input, .stack textarea {
		width: 100%; padding: 0.65rem 0.7rem;
		background: var(--surface); border: 1px solid var(--border-strong);
		border-radius: 8px; color: var(--text); font-family: var(--font-body); font-size: 1rem;
	}
	.stack textarea { min-height: 4rem; resize: vertical; }
	.big-input { font-size: 1.15rem !important; text-align: center; }

	.row { display: flex; gap: 0.6rem; flex-wrap: wrap; align-items: center; }
	.btn {
		display: inline-block; margin-top: 0.6rem; border-color: var(--border-strong);
		text-decoration: none; transition: transform 0.08s ease;
	}
	.btn:active:not(:disabled) { transform: translateY(1px); }
	.btn.primary { border-color: var(--accent); }
	.btn.primary:hover:not(:disabled) { background: var(--accent-soft); }
	.btn.ghost { background: transparent; border-style: dashed; color: var(--muted); }
	.btn.big { font-size: 1.05rem; padding: 0.7rem 1.4rem; }
	.linkbtn { background: none; border: none; color: var(--muted); padding: 0; min-height: 0; }
	.back { margin-top: 1.1rem; }

	/* Account-type picker — big tappable buttons (show, don't tell) */
	.pick-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(8rem, 1fr)); gap: 0.6rem; }
	.pick {
		padding: 1rem 0.6rem; border: 1px solid var(--border-strong); border-radius: 10px;
		background: var(--surface-alt); color: var(--text); font-size: 0.95rem; min-height: 3.2rem;
	}
	.pick:hover:not(:disabled) { border-color: var(--accent); background: var(--accent-soft); }

	.result { display: flex; flex-wrap: wrap; gap: 0.4rem 1rem; padding: 0.7rem 0.9rem; margin: 0.3rem 0; border-radius: 10px; font-size: 0.95rem; }
	.result.ok { background: var(--success-bg); border: 1px solid var(--success); }
	.result.warn { background: var(--danger-bg); border: 1px solid var(--danger); }
	/* Verify affirmation */
	.affirm { text-align: center; padding: 0.5rem 0 1rem; }
	.affirm-check {
		width: 4rem; height: 4rem; margin: 0 auto 0.6rem;
		display: flex; align-items: center; justify-content: center;
		border-radius: 50%; font-size: 2rem; color: #fff;
		background: var(--success); box-shadow: 0 0 0 0 rgba(106, 168, 79, 0.6);
		animation: pop 0.45s ease, ring 1.1s ease 0.2s;
	}
	.affirm h2 { margin: 0 0 0.3rem; }
	.affirm-stats { color: var(--muted); margin: 0; }
	@keyframes pop { 0% { transform: scale(0.4); } 60% { transform: scale(1.15); } 100% { transform: scale(1); } }
	@keyframes ring { 0% { box-shadow: 0 0 0 0 rgba(106, 168, 79, 0.6); } 100% { box-shadow: 0 0 0 22px rgba(106, 168, 79, 0); } }

	/* Dink multi-server toggle */
	.multi { margin: 0.6rem 0 0.2rem; display: flex; flex-direction: column; gap: 0.25rem; }
	.multi label { display: flex; align-items: center; gap: 0.5rem; font-size: 0.9rem; cursor: pointer; }
	.multi-hint { font-size: 0.78rem; color: var(--muted); padding-left: 1.6rem; }

	.rank-name { font-family: var(--font-heading); font-size: 1.8rem; color: var(--accent); text-transform: capitalize; }
	.err { color: var(--danger); font-size: 0.9rem; margin: 0.3rem 0; }
	.small { font-size: 0.8rem; }

	/* Rank breakdown */
	.rankcard {
		display: flex; flex-direction: column; align-items: center; gap: 0.35rem;
		text-align: center; padding: 1.1rem; margin-bottom: 0.6rem;
		background: var(--success-bg); border: 1px solid var(--success); border-radius: 12px;
	}
	.nextbar { width: 100%; height: 7px; border-radius: 999px; background: var(--surface-alt); overflow: hidden; margin-top: 0.4rem; }
	.nextbar span { display: block; height: 100%; background: var(--accent); border-radius: 999px; }
	.comps { list-style: none; padding: 0; margin: 0.6rem 0 0; width: 100%; display: flex; flex-direction: column; gap: 0.35rem; }
	.comps li { display: grid; grid-template-columns: 6.5rem 1fr auto; align-items: center; gap: 0.5rem; font-size: 0.82rem; }
	.clabel { text-align: left; color: var(--muted); }
	.cbar { height: 8px; border-radius: 999px; background: var(--surface); overflow: hidden; }
	.cbar span { display: block; height: 100%; background: var(--accent); border-radius: 999px; }
	.craw { color: var(--muted); font-variant-numeric: tabular-nums; white-space: nowrap; }

	.next-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(9rem, 1fr)); gap: 0.6rem; margin: 0.4rem 0; }
	.next-card {
		padding: 1rem; background: var(--surface-alt); border: 1px solid var(--border);
		border-radius: 10px; color: var(--text); text-decoration: none; text-align: center;
		transition: transform 0.1s ease, border-color 0.1s ease;
	}
	.next-card:hover { border-color: var(--accent); background: var(--accent-soft); transform: translateY(-2px); }

	.invalid { text-align: center; }

	@media (max-width: 30rem) {
		.card { padding: 1.15rem 1rem; }
		.btn.big { width: 100%; text-align: center; }
	}
</style>

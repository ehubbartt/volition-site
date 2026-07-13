<script lang="ts">
	import { invalidateAll } from '$app/navigation';
	import { enhance } from '$app/forms';
	import { onMount } from 'svelte';
	import BingoTile from '$lib/BingoTile.svelte';
	import { itemImageUrl } from '$lib/wikiImage';
	import type { PageData, ActionData } from './$types';

	let { data, form }: { data: PageData; form: ActionData } = $props();

	// ── Setup wizard ──────────────────────────────────────────────────────────
	// Members check off each setup step; state persists per browser so returning
	// visitors land straight on the test. "Already set up" marks everything done.
	const STEP_IDS = ['install', 'reset', 'overwrite', 'url', 'import'] as const;
	type StepId = (typeof STEP_IDS)[number];
	const SETUP_KEY = 'dink-setup-v1';

	let steps = $state<Record<StepId, boolean>>({
		install: false,
		reset: false,
		overwrite: false,
		url: false,
		import: false
	});
	const doneCount = $derived(STEP_IDS.filter((id) => steps[id]).length);
	const setupComplete = $derived(doneCount === STEP_IDS.length);

	function saveSteps() {
		try {
			localStorage.setItem(SETUP_KEY, JSON.stringify(steps));
		} catch {
			/* private mode etc. */
		}
	}
	function setStep(id: StepId, v: boolean) {
		steps[id] = v;
		saveSteps();
	}
	function skipSetup() {
		for (const id of STEP_IDS) steps[id] = true;
		saveSteps();
	}
	function redoSetup() {
		for (const id of STEP_IDS) steps[id] = false;
		saveSteps();
	}

	// ── Test state ────────────────────────────────────────────────────────────
	// "Reset test" stamps a cutoff (per browser) so the tile + list only count drops
	// after it — re-arms the test instantly without touching the tracking ledger.
	let resetAt = $state<string | null>(null);
	const RESET_KEY = 'dink-check-reset';
	function resetTest() {
		resetAt = new Date().toISOString();
		try {
			localStorage.setItem(RESET_KEY, resetAt);
		} catch {
			/* ignore */
		}
	}

	const shownDrops = $derived(
		resetAt ? data.drops.filter((d) => d.received_at > resetAt!) : data.drops
	);
	const working = $derived(shownDrops.length > 0);
	// The test tile completes on a Bones drop — the one item every combat kill can supply.
	const bonesDone = $derived(
		shownDrops.some((d) => d.item_id === 526 || d.item_name?.toLowerCase() === 'bones')
	);

	// After a rotate the action returns the fresh URL; otherwise use the loaded one.
	const configUrl = $derived(form?.configUrl ?? data.configUrl);

	let copied = $state(false);
	async function copy() {
		if (!configUrl) return;
		try {
			await navigator.clipboard.writeText(configUrl);
			copied = true;
			setTimeout(() => (copied = false), 1500);
		} catch {
			copied = false;
		}
	}

	// Poll the server every 10s so a drop shows up shortly after it happens — no manual
	// refresh needed while the player is killing something to test their setup.
	let refreshing = $state(false);
	onMount(() => {
		try {
			resetAt = localStorage.getItem(RESET_KEY);
			const saved = localStorage.getItem(SETUP_KEY);
			if (saved) {
				const parsed = JSON.parse(saved) as Partial<Record<StepId, boolean>>;
				for (const id of STEP_IDS) steps[id] = !!parsed[id];
			}
		} catch {
			/* ignore */
		}
		const t = setInterval(async () => {
			refreshing = true;
			try {
				await invalidateAll();
			} finally {
				refreshing = false;
			}
		}, 10_000);
		return () => clearInterval(t);
	});

	function fmtTime(iso: string): string {
		try {
			return new Date(iso).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit', second: '2-digit' });
		} catch {
			return iso;
		}
	}
</script>

<svelte:head><title>Dink setup &amp; test · Volition</title></svelte:head>

{#snippet urlBlock()}
	{#if configUrl}
		<div class="url-row">
			<code class="url">{configUrl}</code>
			<button type="button" class="copy" onclick={copy}>{copied ? '✓ Copied' : 'Copy'}</button>
		</div>
		<div class="url-actions">
			<form method="POST" action="?/rotate" use:enhance>
				<button type="submit" class="rotate">Rotate link</button>
			</form>
			<span class="muted small">Rotating revokes the current link and issues a new one.</span>
		</div>
	{:else}
		<p class="warn">
			⚠ The proxy URL isn't configured on the site yet (<code>PROXY_BASE_URL</code>), so your link can't
			be shown here. Use the Discord <strong>/dink</strong> command for now.
		</p>
	{/if}
	{#if form?.error}<p class="warn">{form.error}</p>{/if}
{/snippet}

<section class="dc">
	<a class="back" href="/events">← Events</a>
	<h1>Dink setup &amp; test</h1>
	<p class="muted">
		Dink sends your drops from RuneLite to the clan tracker, so events credit your tiles
		automatically — no screenshots. Set it up once below, then prove it works with the test.
	</p>

	<!-- ── 1 · Setup wizard ─────────────────────────────────────────────── -->
	<div class="card">
		<div class="setup-head">
			<h3>1 · Set up Dink</h3>
			<span class="muted small">{doneCount}/{STEP_IDS.length} steps done</span>
		</div>

		{#if setupComplete}
			<p class="ok-note">
				✓ Setup complete — run the test below.
				<button type="button" class="link-btn" onclick={redoSetup}>Redo the setup steps</button>
			</p>
			<details class="guide">
				<summary>Your config URL (copy / rotate)</summary>
				{@render urlBlock()}
			</details>
		{:else}
			<p class="backup-note">
				<strong>Already use Dink with your own settings?</strong> Back them up first: type
				<code>::dinkexport</code> in the game chat — Dink copies your full current settings —
				and paste that somewhere safe. You can restore it any time, so guests joining us for
				an event can go right back to their own setup afterwards.
			</p>

			<ol class="steps">
				<li class="step" class:done={steps.install}>
					<label class="step-head">
						<input type="checkbox" checked={steps.install} onchange={(e) => setStep('install', e.currentTarget.checked)} />
						<span class="step-title">Install RuneLite and enable the <strong>Dink</strong> plugin</span>
					</label>
					{#if !steps.install}
						<div class="step-body">
							<p class="muted small">Dink is on the Plugin Hub: RuneLite → Configuration → Plugin Hub → search "Dink" → Install, then make sure its toggle is on.</p>
						</div>
					{/if}
				</li>

				<li class="step" class:done={steps.reset}>
					<label class="step-head">
						<input type="checkbox" checked={steps.reset} onchange={(e) => setStep('reset', e.currentTarget.checked)} />
						<span class="step-title">Reset Dink's settings</span>
					</label>
					{#if !steps.reset}
						<div class="step-body">
							<p class="muted small">A clean slate means no old values linger under our config:</p>
							<img class="guide-img" src="/dink-guide/reset.png" alt="Resetting the Dink plugin settings in RuneLite" loading="lazy" />
						</div>
					{/if}
				</li>

				<li class="step" class:done={steps.overwrite}>
					<label class="step-head">
						<input type="checkbox" checked={steps.overwrite} onchange={(e) => setStep('overwrite', e.currentTarget.checked)} />
						<span class="step-title">Set <strong>Import Policy</strong> to <strong>Overwrite Item Lists</strong></span>
					</label>
					{#if !steps.overwrite}
						<div class="step-body">
							<p class="muted small">In Dink → Advanced Settings. This keeps your tracked-item list exactly in sync with ours as events come and go:</p>
							<img class="guide-img" src="/dink-guide/overwrite.png" alt="Setting Dink's import policy to overwrite item lists" loading="lazy" />
						</div>
					{/if}
				</li>

				<li class="step" class:done={steps.url}>
					<label class="step-head">
						<input type="checkbox" checked={steps.url} onchange={(e) => setStep('url', e.currentTarget.checked)} />
						<span class="step-title">Paste your personal config URL into <strong>Dynamic Config URL</strong></span>
					</label>
					{#if !steps.url}
						<div class="step-body">
							<p class="muted small">
								Dink → Advanced Settings → <strong>Dynamic Config URL</strong>. That's all the wiring it
								needs — the webhooks come from the config itself. It's tied to your account —
								<strong>don't share it</strong>.
							</p>
							{@render urlBlock()}
						</div>
					{/if}
				</li>

				<li class="step" class:done={steps.import}>
					<label class="step-head">
						<input type="checkbox" checked={steps.import} onchange={(e) => setStep('import', e.currentTarget.checked)} />
						<span class="step-title">Toggle Dink off &amp; on, and confirm the import message</span>
					</label>
					{#if !steps.import}
						<div class="step-body">
							<p class="muted small">
								Log in to OSRS, then flip the Dink plugin off and back on in the plugin list — that
								forces it to load your config right now:
							</p>
							<img class="guide-img" src="/dink-guide/toggle-dink.gif" alt="Toggling the Dink plugin off and back on in RuneLite" loading="lazy" />
							<p class="muted small">
								Watch your chatbox for Dink's confirmation. Seeing it means our config — including the
								test items — is loaded:
							</p>
							<img class="guide-img" src="/dink-guide/config-imported.png" alt="Dink chat message: Success: Updated config settings from import" loading="lazy" />
						</div>
					{/if}
				</li>
			</ol>

			<button type="button" class="skip-btn" onclick={skipSetup}>
				I've already set Dink up — skip to the test
			</button>
		{/if}
	</div>

	<!-- ── 2 · The test ─────────────────────────────────────────────────── -->
	{#if setupComplete}
		<div class="status" class:good={bonesDone} class:wait={!bonesDone}>
			<div class="quest-tile">
				<BingoTile
					image={itemImageUrl('Bones')}
					imageAlt="Bones"
					name="Bones"
					sub="any monster drops them"
					obtained={bonesDone}
					highlighted={bonesDone}
					title={bonesDone ? 'Tile complete!' : 'Kill anything that drops Bones'}
				/>
			</div>
			{#if bonesDone}
				<div>
					<h2>✓ Tile complete — Dink is working!</h2>
					<p>
						Your Bones made it all the way to the tracker. During events, your drops will credit
						your tiles exactly like this — no screenshots needed.
					</p>
					<button type="button" class="reset-btn" onclick={resetTest}>Reset test</button>
				</div>
			{:else}
				<div>
					<h2>2 · Complete this tile</h2>
					<p>
						Log in on <strong>{data.rsn}</strong> and kill <strong>anything that drops Bones</strong>
						— a chicken, cow, or goblin works. When the drop lands, the tile checks off like a
						real bingo tile. This page watches for it automatically{#if refreshing} <span class="dot">●</span>{/if}.
					</p>
					{#if working}
						<p class="muted small">
							We're already receiving your drops ({shownDrops.length} in the last
							{data.windowMinutes} min) — grab those Bones to finish the tile.
						</p>
					{/if}
					{#if !data.selfTestReady}
						<p class="warn small">⚠ The self-test isn't enabled right now — ask an admin.</p>
					{/if}
				</div>
			{/if}
		</div>

		<p class="muted small event-note">
			That's it — you never need to touch Dink again. Event items are matched on our side, so
			when you join an event your drops start counting automatically.
		</p>

		<div class="card">
			<h3>Recent drops <span class="muted small">(last {data.windowMinutes} min)</span></h3>
			{#if shownDrops.length === 0}
				<p class="muted">Nothing yet{resetAt ? ' since your last reset' : ''}.</p>
			{:else}
				<ul class="drops">
					{#each shownDrops as d (d.id)}
						<li>
							<span class="item">{d.item_name ?? `#${d.item_id}`}{#if d.quantity > 1} ×{d.quantity}{/if}</span>
							{#if d.source}<span class="src muted">from {d.source}</span>{/if}
							{#if d.event_name}<span class="ev">{d.event_name}</span>{/if}
							<span class="time muted">{fmtTime(d.received_at)}</span>
						</li>
					{/each}
				</ul>
			{/if}
		</div>
	{:else}
		<div class="card locked">
			<h3>2 · Test your connection</h3>
			<p class="muted">
				Finish the setup steps above (or mark them done) and the test unlocks: you'll get one
				bingo tile — <strong>Bones</strong> — to complete, proving your drops reach the tracker.
			</p>
		</div>
	{/if}
</section>

<style>
	.dc { max-width: 720px; margin: 0 auto; padding: 1.5rem 1rem 4rem; }
	.back { color: var(--accent); text-decoration: none; font-size: 0.9rem; }
	h1 { margin: 0.3rem 0 0.4rem; }
	.muted { color: var(--muted); }
	.small { font-size: 0.85rem; }

	.card {
		background: linear-gradient(180deg, rgba(58, 48, 36, 0.85), rgba(40, 32, 24, 0.85));
		border: 1px solid var(--border); border-radius: var(--radius);
		box-shadow: var(--shadow-card); padding: 1.1rem 1.2rem; margin-top: 1.1rem;
	}
	.card h3 { margin: 0 0 0.6rem; }
	.card.locked { opacity: 0.75; }
	.card.locked p { margin: 0; }

	/* ── setup wizard ── */
	.setup-head { display: flex; align-items: baseline; justify-content: space-between; gap: 0.8rem; }
	.backup-note {
		margin: 0.2rem 0 0.9rem; padding: 0.6rem 0.8rem; font-size: 0.9rem;
		background: var(--accent-soft); border: 1px solid var(--accent);
		border-radius: var(--radius); color: var(--text);
	}
	.backup-note code { background: var(--surface-alt); padding: 0.05rem 0.35rem; border-radius: 3px; }
	.steps { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 0.55rem; counter-reset: step; }
	.step {
		background: var(--surface-alt); border: 1px solid var(--border);
		border-radius: var(--radius); padding: 0.6rem 0.8rem;
	}
	.step.done { opacity: 0.65; }
	.step.done .step-title { text-decoration: line-through; text-decoration-color: var(--muted); }
	.step-head { display: flex; align-items: flex-start; gap: 0.6rem; cursor: pointer; }
	.step-head input { width: 1.1rem; height: 1.1rem; margin-top: 0.15rem; min-height: 0; accent-color: var(--accent); flex-shrink: 0; cursor: pointer; }
	.step-title { line-height: 1.4; }
	.step-body { margin: 0.5rem 0 0.1rem 1.7rem; }
	.step-body p { margin: 0 0 0.4rem; }
	.skip-btn { margin-top: 0.9rem; font-size: 0.9rem; }
	.ok-note { color: var(--success); margin: 0 0 0.6rem; }
	.link-btn {
		background: none; border: none; padding: 0; min-height: 0; margin-left: 0.4rem;
		color: var(--accent); font-size: 0.85rem; text-decoration: underline; cursor: pointer;
	}
	.link-btn:hover { background: none; color: var(--yellow); }
	.guide { margin-top: 0.4rem; }
	.guide summary { cursor: pointer; color: var(--accent); font-size: 0.92rem; }
	.guide[open] summary { margin-bottom: 0.5rem; }
	.guide-img {
		display: block; max-width: 100%; margin: 0.4rem 0 0.8rem;
		border: 1px solid var(--border); border-radius: var(--radius);
	}

	/* ── test panel ── */
	.status {
		display: flex; align-items: center; gap: 1.2rem; flex-wrap: wrap;
		padding: 1.1rem 1.2rem; margin: 1.1rem 0 0.6rem;
		background-color: var(--stone-fill);
		background-image: var(--stone-tile);
		background-repeat: repeat;
		border: 4px solid transparent;
		border-image: url('/osrs/border-tiny.png') 4 / 4px round;
		border-radius: 4px;
	}
	/* status colour accents shift the inner glow rather than the gold frame */
	.status.good { box-shadow: inset 0 0 0 2px var(--success); }
	.status.wait { box-shadow: inset 0 0 0 2px var(--yellow); }
	.status h2 { margin: 0 0 0.2rem; font-size: 1.1rem; }
	.status.good h2 { color: var(--success); }
	.status.wait h2 { color: var(--yellow); }
	.status p { margin: 0 0 0.35rem; }
	.status p:last-child { margin-bottom: 0; }
	/* The single quest tile: give the grid-item tile a fixed footprint. */
	.quest-tile { flex-shrink: 0; width: 8.5rem; display: grid; }
	.reset-btn { margin-top: 0.6rem; padding: 0.3rem 0.8rem; min-height: 0; font-size: 0.85rem; }
	.dot { color: var(--success); animation: pulse 1s infinite; }
	@keyframes pulse { 0%, 100% { opacity: 0.3; } 50% { opacity: 1; } }
	.event-note { margin: 0 0 0.4rem; }

	/* ── drops + url ── */
	.drops { list-style: none; margin: 0; padding: 0; }
	.drops li {
		display: flex; align-items: baseline; gap: 0.6rem; flex-wrap: wrap;
		padding: 0.45rem 0; border-bottom: 1px solid var(--border);
	}
	.drops li:last-child { border-bottom: none; }
	.item { font-family: var(--font-heading); color: var(--accent); }
	.ev { font-size: 0.78rem; padding: 0.05rem 0.4rem; border-radius: 3px; border: 1px solid var(--border); }
	.time { margin-left: auto; font-size: 0.85rem; }
	.url-row { display: flex; gap: 0.5rem; align-items: stretch; margin: 0.6rem 0 0; flex-wrap: wrap; }
	.url { flex: 1; min-width: 14rem; padding: 0.5rem 0.7rem; background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); overflow-x: auto; white-space: nowrap; font-size: 0.85rem; color: var(--text); }
	.copy { white-space: nowrap; }
	.url-actions { display: flex; align-items: center; gap: 0.7rem; margin-top: 0.6rem; flex-wrap: wrap; }
	.rotate { border-color: var(--yellow); color: var(--yellow); }
	.rotate:hover { background: var(--surface-alt); }
	.warn { color: var(--yellow); margin: 0.6rem 0 0; }
</style>

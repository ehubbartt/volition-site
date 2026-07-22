<script lang="ts">
	// The TempleOSRS setup guide body, extracted so it can be shown both on the
	// standalone /temple-guide page AND inline in the onboarding flow. `compact` tightens
	// spacing/headings for embedding in the onboarding card.
	let { compact = false }: { compact?: boolean } = $props();
</script>

<div class="temple-guide" class:compact>
	{#if compact}
		<p class="why"><strong>Why:</strong> Temple reads your collection log — it's what powers your clan rank and builds your personal bingo boards. Link once, stays synced.</p>
	{/if}
	{#if !compact}
		<header class="guide-head">
			<p class="kicker">Volition · Setup Guide</p>
			<h2>Link TempleOSRS</h2>
			<p class="lead">
				Temple reads your <strong>collection log</strong> — it powers your <strong>clan rank</strong>
				and <strong>personal bingo</strong>. One two-minute setup and it stays synced as you play.
			</p>
		</header>
	{/if}

	<!-- The gif does the teaching — install → settings → enable both sync options. -->
	<figure class="demo">
		<img
			src="/temple-guide/plugin-guide.gif"
			alt="Install the TempleOSRS plugin from the Plugin Hub, open its settings, and enable Collection log auto sync + button sync"
			loading="lazy"
		/>
		<figcaption>Install from the Plugin Hub → settings → enable both collection-log sync options.</figcaption>
	</figure>

	<ol class="steps">
		<li>In RuneLite, open the <strong>Plugin Hub</strong> and install the <strong>TempleOSRS</strong> plugin.</li>
		<li>In its settings, turn on <strong>Collection log auto sync</strong> and <strong>Collection log button sync</strong>.</li>
		<li>Open your <strong>collection log</strong> in game once — it uploads to Temple and keeps itself fresh as you play.</li>
		<li>Make sure your <strong>site RSN</strong> matches your in-game name exactly — that's how the site finds your log.</li>
	</ol>

	<p class="muted">
		Check it worked: search your RSN on
		<a href="https://templeosrs.com" target="_blank" rel="noreferrer noopener">templeosrs.com ↗</a> —
		your Collection Log tab should show your unlocks.
	</p>

	<!-- Reuse the standalone guide's deeper explanation, tucked into a dropdown. -->
	<details class="more">
		<summary>How it works & why we use it</summary>
		<p>
			Temple stores a snapshot of your collection log every time the plugin syncs — the site
			reads that snapshot, so it never needs your login or manual uploads. New unlocks appear
			the next time your log syncs (automatic with auto-sync on, or hit the sync button on the
			collection-log window).
		</p>
		<p>
			It powers your <strong>clan rank</strong> (collection-log slots are one component) and
			<strong>personal bingo</strong> (your board is built from items you're missing). Temple
			pairs with <strong>Dink</strong>: Dink credits bingo tiles <em>instantly</em> on a drop,
			while Temple is the periodic source of truth for your whole log — you want both linked.
		</p>
	</details>
</div>

<style>
	.temple-guide {
		display: flex;
		flex-direction: column;
		gap: 1rem;
	}
	.guide-head .kicker {
		margin: 0 0 0.25rem;
		font-family: var(--font-heading);
		font-size: 0.8rem;
		letter-spacing: 0.08em;
		text-transform: uppercase;
		color: var(--muted);
	}
	.guide-head h2 {
		margin: 0 0 0.5rem;
	}
	.lead {
		color: var(--muted);
		line-height: 1.55;
		margin: 0;
	}
	.why {
		margin: 0;
		padding: 0.6rem 0.75rem;
		background: var(--accent-soft);
		border: 1px solid var(--accent);
		border-radius: 8px;
		font-size: 0.9rem;
		line-height: 1.45;
	}
	.demo {
		margin: 0;
	}
	.demo img {
		display: block;
		width: 100%;
		max-width: 100%;
		border-radius: 8px;
		box-shadow: 0 2px 10px rgba(0, 0, 0, 0.4);
	}
	.demo figcaption {
		margin-top: 0.4rem;
		font-size: 0.82rem;
		color: var(--muted);
	}
	.steps {
		margin: 0;
		padding-left: 1.2rem;
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
		line-height: 1.5;
	}
	.compact .steps {
		font-size: 0.92rem;
	}
	.muted {
		color: var(--muted);
		line-height: 1.5;
		margin: 0;
	}
	.more {
		border: 1px solid var(--border);
		border-radius: 8px;
		padding: 0.4rem 0.7rem;
		background: var(--surface-alt);
	}
	.more summary {
		cursor: pointer;
		font-size: 0.88rem;
		color: var(--accent);
	}
	.more p {
		margin: 0.6rem 0 0;
		font-size: 0.88rem;
		line-height: 1.5;
		color: var(--muted);
	}
</style>

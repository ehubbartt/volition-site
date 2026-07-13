<svelte:head>
	<title>Temple Setup Guide · Volition</title>
	<meta
		name="description"
		content="How to link TempleOSRS so your collection log syncs — powers your clan rank and personal bingo boards."
	/>
</svelte:head>

<section class="guide">
	<header class="guide-head">
		<p class="kicker">Volition · Setup Guide</p>
		<h1>Link TempleOSRS</h1>
		<p class="lead">
			Temple is how the site reads your <strong>collection log</strong>. It powers two things:
			your <strong>clan rank</strong> (collection-log slots are one of its components) and
			<strong>personal bingo</strong> (your board is generated from items you're missing, and
			"Check progress" ticks tiles from your log). One two-minute setup and it stays synced as
			you play.
		</p>
	</header>

	<!-- Setup steps -->
	<section class="card">
		<div class="section-header"><h2>Setup — one time, ~2 minutes</h2></div>
		<ol class="steps">
			<li>
				In RuneLite, open the <strong>Plugin Hub</strong> (wrench icon → the plugin panel's
				“Plugin Hub” button) and install the <strong>TempleOSRS</strong> plugin.
			</li>
			<li>
				Open the plugin's <strong>settings</strong> and turn on
				<strong>Collection log auto sync</strong> and <strong>Collection log button sync</strong>.
			</li>
			<li>
				In game, open your <strong>collection log</strong> once — it uploads to Temple. With both
				settings on, it keeps itself fresh: the log syncs automatically as you play, and the
				sync button on the collection log window lets you push it manually any time.
			</li>
		</ol>

		<figure class="demo">
			<img
				src="/temple-guide/plugin-guide.gif"
				alt="Installing the TempleOSRS plugin from the Plugin Hub, opening its settings, and enabling Collection log auto sync and Collection log button sync"
				loading="lazy"
			/>
			<figcaption>The whole flow: install from the Plugin Hub → settings → enable both collection log sync options.</figcaption>
		</figure>
	</section>

	<!-- Verify -->
	<section class="card">
		<div class="section-header"><h2>Check it worked</h2></div>
		<ol class="steps">
			<li>
				Search your RSN on
				<a href="https://templeosrs.com" target="_blank" rel="noreferrer noopener">templeosrs.com ↗</a>
				— your player page should show a Collection Log tab with your unlocks.
			</li>
			<li>
				Make sure the <strong>RSN on your <a href="/me">site profile</a></strong> matches your
				in-game name exactly — that's how the site finds your Temple log.
			</li>
			<li>
				Done? Head to <a href="/events/personal-bingo">Personal Bingo</a> and generate a board.
				If generation says your log can't be read, open your collection log in game again and
				give it a minute.
			</li>
		</ol>
	</section>

	<!-- How it works -->
	<section class="card">
		<div class="section-header"><h2>How it works</h2></div>
		<p>
			Temple stores a snapshot of your collection log every time the plugin syncs it. The site
			reads that snapshot — it never needs your login or any manual uploads. New unlocks appear
			on Temple the next time your log syncs (automatic with auto sync on; or hit the sync
			button on the collection log window).
		</p>
		<p>
			Temple pairs with <a href="/dink-check">Dink</a>: Dink credits your bingo tiles
			<em>instantly</em> when a drop lands, while Temple is the periodic source of truth for
			your whole log and your rank breakdown. You want both linked.
		</p>
		<p class="muted">
			More detail on Temple's collection log syncing lives in the
			<a href="https://templeosrs.com/faq.php#CATEGORY_06" target="_blank" rel="noreferrer noopener">
				TempleOSRS FAQ ↗</a>.
		</p>
	</section>
</section>

<style>
	.guide {
		max-width: 46rem;
		margin: 0 auto;
		padding: 1.5rem 1rem 3rem;
		display: flex;
		flex-direction: column;
		gap: 1.25rem;
	}
	.guide-head .kicker {
		margin: 0 0 0.25rem;
		font-family: var(--font-heading);
		font-size: 0.8rem;
		letter-spacing: 0.08em;
		text-transform: uppercase;
		color: var(--muted);
	}
	.guide-head h1 {
		margin: 0 0 0.6rem;
	}
	.lead {
		color: var(--muted);
		line-height: 1.55;
		margin: 0;
	}
	.card {
		background: var(--panel, rgba(0, 0, 0, 0.25));
		border: 4px solid transparent;
		border-image: url('/osrs/border-tiny.png') 4 / 4px round;
		border-radius: 6px;
		padding: 1.1rem 1.25rem;
	}
	.section-header h2 {
		margin: 0 0 0.75rem;
		font-size: 1.15rem;
		color: var(--accent);
	}
	.steps {
		margin: 0;
		padding-left: 1.25rem;
		display: flex;
		flex-direction: column;
		gap: 0.6rem;
		line-height: 1.5;
	}
	.demo {
		margin: 1rem 0 0;
	}
	.demo img {
		max-width: 100%;
		border-radius: 6px;
		box-shadow: 0 2px 10px rgba(0, 0, 0, 0.4);
	}
	.demo figcaption {
		margin-top: 0.4rem;
		font-size: 0.85rem;
		color: var(--muted);
	}
	p {
		line-height: 1.55;
	}
	.muted {
		color: var(--muted);
	}
</style>

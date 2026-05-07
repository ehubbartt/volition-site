<svelte:head>
	<title>Volition</title>
</svelte:head>

<section class="hero">
	<img src="/logo.png" alt="Volition clan logo" class="logo" />
	<h1>Volition</h1>
	<p class="tagline">An OSRS clan home for events, sign-ups, and bragging rights.</p>
	<a href="/auth/discord/login" class="cta">Sign in with Discord</a>
	<p class="small muted">
		We use Discord just to identify you. We never post on your behalf.
	</p>
</section>

<style>
	.hero {
		max-width: 32rem;
		margin: 3rem auto;
		text-align: center;
		padding: 2rem 1.5rem;
		background: rgba(58, 48, 36, 0.5);
		border: 1px solid #4d4336;
		border-radius: 4px;
		box-shadow:
			inset 0 0 0 1px rgba(255, 152, 31, 0.05),
			0 4px 24px rgba(0, 0, 0, 0.6);
	}

	.logo {
		width: 128px;
		height: 128px;
		object-fit: contain;
		margin-bottom: 1rem;
		filter: drop-shadow(2px 2px 0 #000) drop-shadow(0 0 12px rgba(255, 152, 31, 0.25));
	}

	h1 {
		font-size: clamp(2.5rem, 7vw, 4rem);
		letter-spacing: 2px;
		margin: 0 0 0.5rem;
	}

	.tagline {
		color: rgba(255, 255, 255, 0.7);
		font-size: 1.1rem;
		margin-bottom: 1.75rem;
	}

	.cta {
		display: inline-block;
		background: #3a3024;
		border: 1px solid #5d5346;
		color: #ff981f;
		padding: 10px 24px;
		border-radius: 4px;
		font-family: 'rsbold', ui-sans-serif, Arial, sans-serif;
		font-size: 1.1rem;
		letter-spacing: 1px;
		text-decoration: none;
		text-shadow: 2px 2px #000;
		transition: background 0.15s, border-color 0.15s;
	}

	.cta:hover {
		background: #4d4336;
		border-color: #ff981f;
		text-decoration: none;
	}

	.muted {
		color: rgba(255, 255, 255, 0.4);
	}

	.small {
		font-size: 0.9rem;
		margin-top: 1.5rem;
	}
</style>

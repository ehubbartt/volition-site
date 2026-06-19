<svelte:head><title>Sign-in busy · Volition</title></svelte:head>

<section class="busy">
	<div class="panel">
		<h1>Sign-in is busy</h1>
		<p class="lead">
			Discord is briefly rate-limiting sign-ins to Volition. This isn't your account — it
			usually clears in a moment.
		</p>
		<p class="muted">Give it a few seconds, then try again. If it keeps happening, let an admin know on Discord.</p>

		<a class="retry" href="/auth/discord/login">Try signing in again</a>
		<a class="home" href="/">Back to home</a>
	</div>
</section>

<style>
	.busy {
		max-width: 32rem;
		margin: 3rem auto;
	}
	.panel {
		padding: 1.5rem 1.6rem;
		background: linear-gradient(180deg, var(--accent-soft), rgba(40, 32, 24, 0.6));
		border: 1px solid var(--accent);
		border-radius: var(--radius);
		box-shadow: var(--shadow-card);
	}
	h1 {
		font-family: var(--font-heading);
		font-size: 2rem;
		margin: 0 0 0.5rem;
		color: var(--accent);
		text-shadow: var(--ts-strong);
	}
	.lead {
		margin: 0 0 1rem;
	}
	.muted {
		color: var(--muted);
		font-size: 0.9rem;
		margin: 0 0 1.25rem;
	}
	.retry {
		display: inline-block;
		background: var(--surface);
		border: 1px solid var(--accent);
		color: var(--accent);
		padding: 0.5rem 1rem;
		border-radius: var(--radius);
		text-decoration: none;
		margin-right: 0.75rem;
	}
	.retry:hover {
		background: var(--accent-soft);
	}
	.home {
		color: var(--muted);
		font-size: 0.9rem;
	}
</style>

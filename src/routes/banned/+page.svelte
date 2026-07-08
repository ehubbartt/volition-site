<script lang="ts">
	import type { PageData } from './$types';
	let { data }: { data: PageData } = $props();
</script>

<svelte:head><title>Banned · Volition</title></svelte:head>

<section class="banned">
	<div class="panel">
		<h1>You're banned</h1>
		<p class="lead">
			{#if data.name}{data.name}, your{:else}Your{/if} access to Volition has been revoked, so you
			can't use the site.
		</p>

		{#if data.reason}
			<div class="reason">
				<span class="label">Reason</span>
				<p>{data.reason}</p>
			</div>
		{/if}

		<p class="muted">
			If you think this is a mistake, reach out to a Volition admin on Discord.
		</p>

		<!-- Deliberately NOT use:enhance: the full document load this causes is what
	     wipes the client-side swr cache on logout (see clearSwrCache in swr.ts). -->
	<form method="POST" action="/auth/logout">
			<button type="submit">Sign out</button>
		</form>
	</div>
</section>

<style>
	.banned {
		max-width: 32rem;
		margin: 3rem auto;
	}
	.panel {
		padding: 1.5rem 1.6rem;
		background: linear-gradient(180deg, rgba(255, 0, 0, 0.08), rgba(40, 32, 24, 0.6));
		border: 1px solid var(--danger);
		border-radius: var(--radius);
		box-shadow: var(--shadow-card);
	}
	h1 {
		font-family: var(--font-heading);
		font-size: 2rem;
		margin: 0 0 0.5rem;
		color: var(--danger);
		text-shadow: var(--ts);
	}
	.lead {
		margin: 0 0 1rem;
	}
	.reason {
		padding: 0.75rem 0.9rem;
		background: var(--surface-alt);
		border: 1px solid var(--border);
		border-radius: var(--radius);
		margin-bottom: 1rem;
	}
	.reason .label {
		display: block;
		font-size: 0.7rem;
		text-transform: uppercase;
		letter-spacing: 0.05em;
		color: var(--danger);
		margin-bottom: 0.25rem;
	}
	.reason p {
		margin: 0;
	}
	.muted {
		color: var(--muted);
		font-size: 0.9rem;
	}
	form {
		margin-top: 1.25rem;
	}
	button {
		background: var(--surface);
		border: 1px solid var(--border-strong);
		color: var(--text);
		padding: 0.5rem 1rem;
		border-radius: var(--radius);
		cursor: pointer;
	}
	button:hover {
		border-color: var(--accent);
		color: var(--accent);
	}
</style>

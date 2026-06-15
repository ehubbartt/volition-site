<script lang="ts">
	import { enhance } from '$app/forms';
	import type { SubmitFunction } from '@sveltejs/kit';
	import type { PageData, ActionData } from './$types';

	let { data, form }: { data: PageData; form: ActionData } = $props();

	let sending = $state(false);

	const onSubmit: SubmitFunction = () => {
		sending = true;
		return async ({ update }) => {
			await update({ reset: false });
			sending = false;
		};
	};
</script>

<svelte:head>
	<title>Bridge test · Volition</title>
</svelte:head>

<section>
	<a class="back" href="/admin">← Admin</a>
	<h1>Bot bridge test</h1>
	<p class="muted">
		Sends a harmless <code>ping</code> through the site→bot Discord webhook so you can confirm it
		delivers. Success here means the site reached Discord and the message landed in the bridge
		channel — check that channel (and, once the bot listener is built, that it reacts).
	</p>

	{#if !data.configured}
		<div class="warn">
			<strong>DISCORD_BOT_BRIDGE_WEBHOOK_URL is not set.</strong> Add the bridge webhook URL to your
			env (local <code>.env</code> / Fly secret) before testing.
		</div>
	{/if}

	{#if form?.sent}
		<div class="ok">✅ Sent (HTTP {form.status}). Check the bridge channel for a “bridge:ping” message.</div>
	{:else if form && !form.sent}
		<div class="err">❌ Failed: {form.message}</div>
	{/if}

	<form method="POST" use:enhance={onSubmit} class="test-form">
		<label>
			<span>Optional note (shown in the message)</span>
			<input name="note" type="text" maxlength="200" placeholder="e.g. testing from staging" />
		</label>
		<button type="submit" class="primary" disabled={sending || !data.configured}>
			{sending ? 'Sending…' : 'Send test message'}
		</button>
	</form>
</section>

<style>
	.back {
		display: inline-block;
		margin-bottom: 0.5rem;
		color: var(--muted);
		font-size: 0.9rem;
	}

	h1 {
		margin-bottom: 0.25rem;
	}

	.muted {
		color: var(--muted);
		max-width: 42rem;
		line-height: 1.5;
	}

	code {
		font-family: ui-monospace, monospace;
		background: var(--surface-alt);
		padding: 0.05rem 0.3rem;
		border-radius: 4px;
	}

	.test-form {
		display: flex;
		flex-direction: column;
		gap: 0.75rem;
		max-width: 32rem;
		margin-top: 1.25rem;
	}

	label {
		display: flex;
		flex-direction: column;
		gap: 0.35rem;
	}

	label span {
		font-size: 0.85rem;
		color: var(--muted);
	}

	button.primary {
		border-color: var(--accent);
		font-family: 'rsbold', ui-sans-serif, Arial, sans-serif;
		align-self: flex-start;
	}

	button.primary:hover:not(:disabled) {
		background: var(--accent-soft);
	}

	button.primary:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}

	.ok,
	.err,
	.warn {
		padding: 0.6rem 0.8rem;
		border-radius: 4px;
		margin: 1rem 0;
		max-width: 42rem;
	}

	.ok {
		background: var(--success-bg);
		border: 1px solid var(--success);
		color: var(--success);
	}

	.err {
		background: var(--danger-bg);
		border: 1px solid var(--danger);
		color: var(--danger);
	}

	.warn {
		background: var(--accent-soft);
		border: 1px solid var(--accent);
	}
</style>

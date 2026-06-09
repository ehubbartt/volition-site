<script lang="ts">
	import type { PageData, ActionData } from './$types';
	import { enhance } from '$app/forms';
	import type { SubmitFunction } from '@sveltejs/kit';

	let { data, form }: { data: PageData; form: ActionData } = $props();

	let target = $state<'one' | 'all'>('one');
	let submitting = $state(false);

	function memberLabel(m: PageData['members'][number]): string {
		return m.rsn || m.discord_username || 'Unknown member';
	}

	// Confirm before a mass grant; keep the form's typed values after submit.
	const onSubmit: SubmitFunction = ({ formData, cancel }) => {
		if (formData.get('target') === 'all') {
			const qty = formData.get('quantity') ?? '1';
			const packName =
				data.packs.find((p) => p.id === formData.get('pack_id'))?.name ?? 'this pack';
			if (!confirm(`Give ${qty} × ${packName} to all ${data.members.length} members?`)) {
				cancel();
				return;
			}
		}
		submitting = true;
		return async ({ update }) => {
			await update({ reset: false });
			submitting = false;
		};
	};
</script>

<svelte:head>
	<title>Admin · Grant Packs</title>
</svelte:head>

<section>
	<h1>Grant Packs</h1>
	<p class="muted">
		Award card packs to members. Only members who have <strong>signed into the site</strong> can receive
		packs.
	</p>

	{#if form?.ok && form?.message}
		<div class="ok">{form.message}</div>
	{/if}
	{#if form?.error}
		<div class="error">{form.error}</div>
	{/if}

	<form method="POST" action="?/grantPacks" use:enhance={onSubmit} class="grant-form">
		<label>
			<span>Pack</span>
			<select name="pack_id" required>
				<option value="" disabled selected>Pick a pack…</option>
				{#each data.packs as p (p.id)}
					<option value={p.id}>{p.name}{p.released ? '' : ' · unreleased'}</option>
				{/each}
			</select>
		</label>

		<fieldset class="target">
			<legend>Award to</legend>
			<label class="radio">
				<input type="radio" name="target" value="one" bind:group={target} />
				<span>A member</span>
			</label>
			<label class="radio">
				<input type="radio" name="target" value="all" bind:group={target} />
				<span>Everyone ({data.members.length} members)</span>
			</label>
		</fieldset>

		{#if target === 'one'}
			<label>
				<span>Member</span>
				<select name="user_id" required>
					<option value="" disabled selected>Pick a member…</option>
					{#each data.members as m (m.id)}
						<option value={m.id}>{memberLabel(m)}</option>
					{/each}
				</select>
			</label>
		{/if}

		<label>
			<span>Quantity</span>
			<input type="number" name="quantity" min="1" max="100" value="1" required />
		</label>

		<button type="submit" class="primary" disabled={submitting}>
			{submitting ? 'Awarding…' : 'Award pack(s)'}
		</button>
	</form>
</section>

<style>
	h1 {
		margin-bottom: 0.25rem;
	}

	.muted {
		color: var(--muted);
	}

	.grant-form {
		display: flex;
		flex-direction: column;
		gap: 0.85rem;
		max-width: 26rem;
		margin-top: 1.5rem;
	}

	.grant-form label {
		display: flex;
		flex-direction: column;
		gap: 0.3rem;
	}

	.grant-form label > span {
		font-size: 0.85rem;
		color: var(--muted);
	}

	.target {
		border: 1px solid var(--border);
		border-radius: var(--radius);
		padding: 0.75rem;
		display: flex;
		gap: 1rem;
		margin: 0;
	}

	.target legend {
		font-size: 0.85rem;
		color: var(--muted);
		padding: 0 0.35rem;
	}

	.target .radio {
		flex-direction: row;
		align-items: center;
		gap: 0.4rem;
		cursor: pointer;
	}

	.target .radio input {
		width: auto;
	}

	button.primary {
		border-color: var(--accent);
		font-family: 'rsbold', ui-sans-serif, Arial, sans-serif;
		align-self: flex-start;
	}

	button.primary:hover:not(:disabled) {
		background: var(--accent-soft);
		box-shadow: 0 0 0.8rem -0.2rem var(--accent);
	}

	button.primary:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}

	.ok,
	.error {
		margin-top: 1rem;
		padding: 0.6rem 0.85rem;
		border-radius: var(--radius);
		font-size: 0.9rem;
	}

	.ok {
		background: rgba(63, 176, 116, 0.15);
		border: 1px solid var(--accent);
		color: var(--text);
	}

	.error {
		background: rgba(220, 70, 70, 0.12);
		border: 1px solid var(--danger);
		color: var(--text);
	}
</style>

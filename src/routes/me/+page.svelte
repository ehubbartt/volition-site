<script lang="ts">
	import type { PageData, ActionData } from './$types';

	let { data, form }: { data: PageData; form: ActionData } = $props();
</script>

<svelte:head>
	<title>Profile · Volition</title>
</svelte:head>

<section class="card">
	<h1>Your profile</h1>

	{#if form?.success}
		<div class="success">Saved.</div>
	{:else if form?.error}
		<div class="error">{form.error}</div>
	{/if}

	<dl>
		<dt>Discord</dt>
		<dd>{data.user.discord_username}</dd>
	</dl>

	<form method="POST">
		<label>
			<span>OSRS RSN</span>
			<input name="rsn" type="text" maxlength="12" required value={data.user.rsn ?? ''} />
		</label>

		<label>
			<span>Clan allegiance</span>
			<select name="clan_allegiance" required>
				<option value="" disabled selected={!data.user.clan_allegiance}>Pick a clan…</option>
				{#each data.clanOptions as opt}
					<option value={opt.value} selected={data.user.clan_allegiance === opt.value}>
						{opt.label}
					</option>
				{/each}
			</select>
		</label>

		<button type="submit" class="primary">Save</button>
	</form>

	<form method="POST" action="/auth/logout" class="logout">
		<button type="submit">Sign out</button>
	</form>
</section>

<style>
	.card {
		max-width: 30rem;
		margin: 2rem auto;
		padding: 1.75rem;
		background: linear-gradient(180deg, rgba(58, 48, 36, 0.9), rgba(40, 32, 24, 0.9));
		border: 1px solid var(--border);
		border-radius: var(--radius);
		box-shadow: var(--shadow-card);
	}

	h1 {
		margin-top: 0;
	}

	dl {
		margin: 0 0 1.5rem;
		display: grid;
		grid-template-columns: 7rem 1fr;
		gap: 0.4rem;
	}

	dt {
		color: var(--muted);
	}

	dd {
		margin: 0;
	}

	form {
		display: flex;
		flex-direction: column;
		gap: 1rem;
	}

	form.logout {
		margin-top: 1.5rem;
		padding-top: 1.5rem;
		border-top: 1px solid var(--border);
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

	.error {
		background: var(--danger-bg);
		border: 1px solid var(--danger);
		color: var(--danger);
		padding: 0.6rem 0.8rem;
		border-radius: 4px;
		margin-bottom: 1rem;
	}

	.success {
		background: var(--success-bg);
		border: 1px solid var(--success);
		color: var(--success);
		padding: 0.6rem 0.8rem;
		border-radius: 4px;
		margin-bottom: 1rem;
	}

	button.primary {
		border-color: var(--accent);
		font-family: 'rsbold', ui-sans-serif, Arial, sans-serif;
	}

	button.primary:hover {
		background: var(--accent-soft);
	}
</style>

<script lang="ts">
	import type { PageData, ActionData } from './$types';

	let { data, form }: { data: PageData; form: ActionData } = $props();
</script>

<svelte:head>
	<title>Set up your profile · Volition</title>
</svelte:head>

<section class="card">
	<h1>Welcome, {data.user.discord_username}</h1>
	<p class="muted">
		Tell us your RSN and which clan you're representing. You can change this later from your
		profile.
	</p>

	{#if form?.error}
		<div class="error">{form.error}</div>
	{/if}

	<form method="POST">
		<label>
			<span>OSRS RSN</span>
			<input
				name="rsn"
				type="text"
				maxlength="12"
				required
				autocomplete="off"
				value={form?.rsn ?? ''}
				placeholder="Exact spelling, please"
			/>
		</label>

		<label>
			<span>Clan allegiance</span>
			<select name="clan_allegiance" required>
				<option value="" disabled selected={!form?.clan_allegiance}>Pick a clan…</option>
				{#each data.clanOptions as opt}
					<option value={opt.value} selected={form?.clan_allegiance === opt.value}>
						{opt.label}
					</option>
				{/each}
			</select>
		</label>

		<button type="submit">Continue</button>
	</form>
</section>

<style>
	.card {
		max-width: 28rem;
		margin: 3rem auto;
		padding: 1.75rem;
		background: linear-gradient(180deg, rgba(58, 48, 36, 0.9), rgba(40, 32, 24, 0.9));
		border: 1px solid var(--border);
		border-radius: var(--radius);
		box-shadow: var(--shadow-card);
	}

	h1 {
		margin-top: 0;
	}

	.muted {
		color: var(--muted);
		margin-bottom: 1.5rem;
	}

	form {
		display: flex;
		flex-direction: column;
		gap: 1rem;
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

	button[type='submit'] {
		border-color: var(--accent);
		font-family: 'rsbold', ui-sans-serif, Arial, sans-serif;
	}

	button[type='submit']:hover {
		background: var(--accent-soft);
	}
</style>

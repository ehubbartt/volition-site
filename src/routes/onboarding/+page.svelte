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
		Tell us your RSN, account type, and which clan you're representing. You can change these later
		from your profile.
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

		<fieldset class="account-picker">
			<legend>Account type</legend>
			<div class="account-options">
				{#each data.accountTypes as opt}
					<label class="account-option" title={opt.label}>
						<input
							type="radio"
							name="account_type"
							value={opt.value}
							checked={form?.account_type === opt.value}
							required
						/>
						<span class="opt-card">
							<img src={opt.icon} alt={opt.label} class="opt-icon" />
						</span>
					</label>
				{/each}
			</div>
		</fieldset>

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
		max-width: 32rem;
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
		font-family: var(--font-heading);
	}

	button[type='submit']:hover {
		background: var(--accent-soft);
	}

	.account-picker {
		border: none;
		padding: 0;
		margin: 0;
	}

	.account-picker legend {
		font-size: 0.85rem;
		color: var(--muted);
		padding: 0;
		margin-bottom: 0.45rem;
	}

	.account-options {
		display: flex;
		flex-wrap: wrap;
		gap: 0.5rem;
	}

	.account-option {
		display: block;
		gap: 0;
		cursor: pointer;
	}

	.account-option input {
		position: absolute;
		opacity: 0;
		width: 0;
		height: 0;
		pointer-events: none;
	}

	.opt-card {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 56px;
		height: 56px;
		background: var(--surface-alt);
		border: 1px solid var(--border);
		border-radius: var(--radius);
		text-shadow: var(--ts);
		transition: border-color 0.15s, background 0.15s, box-shadow 0.15s;
	}

	.account-option:hover .opt-card {
		border-color: var(--border-strong);
	}

	.account-option input:checked + .opt-card {
		border-color: var(--accent);
		background: var(--accent-soft);
		box-shadow: inset 0 0 0 1px rgba(255, 152, 31, 0.3);
	}

	.account-option input:focus-visible + .opt-card {
		box-shadow: 0 0 0 3px rgba(255, 152, 31, 0.3);
	}

	.opt-icon {
		width: 30px;
		height: 30px;
		image-rendering: pixelated;
		image-rendering: crisp-edges;
		object-fit: contain;
	}
</style>

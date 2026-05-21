<script lang="ts">
	import type { PageData, ActionData } from './$types';
	import { enhance } from '$app/forms';

	let { data, form }: { data: PageData; form: ActionData } = $props();

	function toLocalInput(iso: string | null): string {
		if (!iso) return '';
		const d = new Date(iso);
		if (Number.isNaN(d.getTime())) return '';
		const pad = (n: number) => n.toString().padStart(2, '0');
		return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
	}
</script>

<svelte:head>
	<title>Admin · Events</title>
</svelte:head>

<section>
	<h1>Events admin</h1>

	{#if form?.error}
		<div class="error">{form.error}</div>
	{/if}

	<details class="card">
		<summary><strong>Create new event</strong></summary>
		<form method="POST" action="?/create" use:enhance>
			<label>
				<span>Slug (URL)</span>
				<input name="slug" type="text" pattern="[a-z0-9-]+" required placeholder="tile-race-2026" />
			</label>
			<label>
				<span>Name</span>
				<input name="name" type="text" required placeholder="Tile Race 2026" />
			</label>
			<label>
				<span>Description (markdown ok)</span>
				<textarea name="description" rows="4"></textarea>
			</label>
			<div class="row">
				<label>
					<span>Team size</span>
					<input name="team_size" type="number" min="1" max="20" value="2" />
				</label>
				<label>
					<span>Status</span>
					<select name="status">
						<option value="draft">draft</option>
						<option value="preview">preview (admin-only)</option>
						<option value="open" selected>open</option>
						<option value="locked">locked</option>
						<option value="closed">closed</option>
					</select>
				</label>
			</div>
			<div class="row">
				<label>
					<span>Signups open at</span>
					<input name="signup_opens_at" type="datetime-local" />
				</label>
				<label>
					<span>Signups close at</span>
					<input name="signup_closes_at" type="datetime-local" />
				</label>
			</div>
			<div class="row">
				<label>
					<span>Event starts at</span>
					<input name="starts_at" type="datetime-local" />
				</label>
				<label>
					<span>Event ends at</span>
					<input name="ends_at" type="datetime-local" />
				</label>
			</div>
			<button type="submit" class="primary">Create</button>
		</form>
	</details>

	<h2>Existing events</h2>
	{#if data.events.length === 0}
		<p class="muted">No events yet.</p>
	{:else}
		<ul class="event-list">
			{#each data.events as ev}
				<li class="card">
					<div class="event-head">
						<div>
							<strong>{ev.name}</strong>
							<span class="muted">/{ev.slug}</span>
						</div>
						<form method="POST" action="?/updateStatus" use:enhance>
							<input type="hidden" name="id" value={ev.id} />
							<select name="status" onchange={(e) => (e.currentTarget.form as HTMLFormElement).requestSubmit()}>
								{#each ['draft', 'preview', 'open', 'locked', 'closed'] as s}
									<option value={s} selected={ev.status === s}>{s}</option>
								{/each}
							</select>
						</form>
					</div>
					{#if ev.description_preview}
						<p class="muted">{ev.description_preview}</p>
					{/if}
					<div class="meta muted">
						team_size: {ev.team_size}
						{#if ev.signup_closes_at}
							· closes {new Date(ev.signup_closes_at).toLocaleString()}
						{/if}
					</div>

					<details class="edit-block">
						<summary>Edit details</summary>
						<form method="POST" action="?/update" use:enhance class="edit-form">
							<input type="hidden" name="id" value={ev.id} />
							<label>
								<span>Slug (URL)</span>
								<input name="slug" type="text" pattern="[a-z0-9-]+" required value={ev.slug} />
							</label>
							<label>
								<span>Name</span>
								<input name="name" type="text" required value={ev.name} />
							</label>
							<label>
								<span>Description (markdown ok)</span>
								<textarea name="description" rows="6">{ev.description ?? ''}</textarea>
							</label>
							<div class="row">
								<label>
									<span>Team size</span>
									<input name="team_size" type="number" min="1" max="20" value={ev.team_size} />
								</label>
								<label>
									<span>Status</span>
									<select name="status">
										{#each ['draft', 'preview', 'open', 'locked', 'closed'] as s}
											<option value={s} selected={ev.status === s}>{s}</option>
										{/each}
									</select>
								</label>
							</div>
							<div class="row">
								<label>
									<span>Signups open at</span>
									<input
										name="signup_opens_at"
										type="datetime-local"
										value={toLocalInput(ev.signup_opens_at)}
									/>
								</label>
								<label>
									<span>Signups close at</span>
									<input
										name="signup_closes_at"
										type="datetime-local"
										value={toLocalInput(ev.signup_closes_at)}
									/>
								</label>
							</div>
							<div class="row">
								<label>
									<span>Event starts at</span>
									<input
										name="starts_at"
										type="datetime-local"
										value={toLocalInput(ev.starts_at)}
									/>
								</label>
								<label>
									<span>Event ends at</span>
									<input
										name="ends_at"
										type="datetime-local"
										value={toLocalInput(ev.ends_at)}
									/>
								</label>
							</div>
							<button type="submit" class="primary">Save changes</button>
						</form>
					</details>
				</li>
			{/each}
		</ul>
	{/if}
</section>

<style>
	h1 {
		margin-bottom: 1rem;
	}

	h2 {
		margin: 2rem 0 1rem;
	}

	.muted {
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

	.card {
		padding: 1.25rem;
		background: linear-gradient(180deg, rgba(58, 48, 36, 0.85), rgba(40, 32, 24, 0.85));
		border: 1px solid var(--border);
		border-radius: var(--radius);
		margin-bottom: 1rem;
		box-shadow: var(--shadow-card);
	}

	form {
		display: flex;
		flex-direction: column;
		gap: 0.75rem;
		margin-top: 1rem;
	}

	label {
		display: flex;
		flex-direction: column;
		gap: 0.25rem;
	}

	label span {
		font-size: 0.8rem;
		color: var(--muted);
	}

	.row {
		display: grid;
		grid-template-columns: 1fr 1fr;
		gap: 0.75rem;
	}

	.event-list {
		list-style: none;
		padding: 0;
		margin: 0;
	}

	.event-head {
		display: flex;
		justify-content: space-between;
		align-items: center;
		gap: 1rem;
	}

	.meta {
		font-size: 0.85rem;
		margin-top: 0.5rem;
	}

	.edit-block {
		margin-top: 0.75rem;
		padding-top: 0.75rem;
		border-top: 1px solid var(--border);
	}

	.edit-block summary {
		cursor: pointer;
		color: var(--accent);
		font-size: 0.95rem;
	}

	.edit-block summary:hover {
		color: var(--accent);
		text-decoration: underline;
	}

	.edit-form {
		margin-top: 0.75rem;
	}

	button.primary {
		border-color: var(--accent);
		font-family: 'rsbold', ui-sans-serif, Arial, sans-serif;
		align-self: flex-start;
	}

	button.primary:hover {
		background: var(--accent-soft);
	}
</style>

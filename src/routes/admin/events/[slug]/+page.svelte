<script lang="ts">
	import type { PageData, ActionData } from './$types';
	import { enhance } from '$app/forms';
	import type { SubmitFunction } from '@sveltejs/kit';
	import EventsTasksTabs from '$lib/admin/EventsTasksTabs.svelte';
	import { rewardLabel, eventTypeLabel } from '$lib/events/simple';
	import { dateFormEnhance } from '$lib/datetime';

	let { data, form }: { data: PageData; form: ActionData } = $props();

	const keepValues: SubmitFunction = () => async ({ update }) => update({ reset: false });

	function toLocalInput(iso: string | null): string {
		if (!iso) return '';
		const d = new Date(iso);
		if (Number.isNaN(d.getTime())) return '';
		const pad = (n: number) => n.toString().padStart(2, '0');
		return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
	}

	const STATUSES = ['draft', 'preview', 'open', 'locked', 'closed'];
</script>

<svelte:head>
	<title>Manage · {data.event.name} · Volition</title>
</svelte:head>

<section>
	<EventsTasksTabs />

	{#if form?.error}
		<div class="error">{form.error}</div>
	{/if}

	<div class="head">
		<div>
			<h1>{data.event.name}</h1>
			<p class="muted">
				{eventTypeLabel(data.event.kind)} event · <code>/{data.event.slug}</code> ·
				<span class="status status-{data.event.status}">{data.event.status}</span>
			</p>
		</div>
		<div class="head-actions">
			<a class="link-btn" href="/event/{data.event.slug}" target="_blank" rel="noopener">View player page →</a>
			<a class="link-btn" href="/admin/submissions">Review submissions{#if data.pendingTotal > 0} ({data.pendingTotal}){/if} →</a>
		</div>
	</div>

	<!-- Status -->
	<div class="card status-card">
		<form method="POST" action="?/setStatus" use:enhance>
			<label class="inline">
				<span>Status</span>
				<select name="status" onchange={(e) => (e.currentTarget.form as HTMLFormElement).requestSubmit()}>
					{#each STATUSES as s}
						<option value={s} selected={data.event.status === s}>{s}</option>
					{/each}
				</select>
			</label>
		</form>
		<p class="muted small">
			Players can submit only while <strong>open</strong> and after the <strong>Starts at</strong>
			time — set a future start to schedule it (it shows as “Upcoming” and posts to Discord when it
			starts). <strong>draft</strong>/<strong>preview</strong> are admin-only;
			<strong>locked</strong> pauses submissions; <strong>closed</strong> ends it (shows under past
			events).
		</p>
	</div>

	<!-- Tasks -->
	<h2>Tasks ({data.tasks.length})</h2>
	{#if data.tasks.length === 0}
		<p class="muted">No tasks yet — add one below.</p>
	{:else}
		<ul class="task-list">
			{#each data.tasks as t (t.id)}
				<li class="card">
					<div class="task-head">
						<div>
							<strong>{t.name}</strong>
							{#if rewardLabel(t.vp_reward, t.pack_reward)}
								<span class="reward">🎁 {rewardLabel(t.vp_reward, t.pack_reward)}</span>
							{:else}
								<span class="muted small">no reward</span>
							{/if}
						</div>
						<form method="POST" action="?/deleteTask" use:enhance class="inline-form">
							<input type="hidden" name="id" value={t.id} />
							<button
								type="submit"
								class="danger small"
								onclick={(e) => {
									if (!confirm(`Delete task "${t.name}"?`)) e.preventDefault();
								}}
							>
								Delete
							</button>
						</form>
					</div>
					{#if t.description}<p class="muted">{t.description}</p>{/if}

					<details class="edit-block">
						<summary>Edit</summary>
						<form method="POST" action="?/updateTask" use:enhance={keepValues} class="edit-form">
							<input type="hidden" name="id" value={t.id} />
							<label>
								<span>Name</span>
								<input name="name" type="text" required value={t.name} />
							</label>
							<label>
								<span>Description</span>
								<input name="description" type="text" value={t.description ?? ''} />
							</label>
							<div class="reward-row">
								<label>
									<span>VP reward</span>
									<input name="vp_reward" type="number" min="0" value={t.vp_reward ?? 0} />
								</label>
								<label>
									<span>Pack reward</span>
									<input name="pack_reward" type="text" list="pack-names" value={t.pack_reward ?? ''} />
								</label>
							</div>
							<button type="submit" class="primary">Save task</button>
						</form>
					</details>
				</li>
			{/each}
		</ul>
	{/if}

	<!-- Add task -->
	<details class="card">
		<summary><strong>Add task</strong></summary>
		<form method="POST" action="?/addTask" use:enhance>
			<label>
				<span>Name</span>
				<input name="name" type="text" required placeholder="Kill Zulrah" />
			</label>
			<label>
				<span>Description (optional)</span>
				<input name="description" type="text" placeholder="Short requirement" />
			</label>
			<div class="reward-row">
				<label>
					<span>VP reward</span>
					<input name="vp_reward" type="number" min="0" value="0" />
				</label>
				<label>
					<span>Pack reward (optional)</span>
					<input name="pack_reward" type="text" list="pack-names" placeholder="e.g. White Pack" />
				</label>
			</div>
			<button type="submit" class="primary">Add task</button>
		</form>
	</details>

	<datalist id="pack-names">
		{#each data.packNames as p}<option value={p}></option>{/each}
	</datalist>

	<!-- Edit meta -->
	<details class="card">
		<summary><strong>Edit event details</strong></summary>
		<form method="POST" action="?/updateEvent" use:enhance={dateFormEnhance}>
			<label>
				<span>Type</span>
				<select name="kind">
					<option value="simple" selected={data.event.kind === 'simple'}>Open — any task, any time</option>
					<option value="sequential" selected={data.event.kind === 'sequential'}>Sequential — in order</option>
				</select>
			</label>
			<label>
				<span>Name</span>
				<input name="name" type="text" required value={data.event.name} />
			</label>
			<label>
				<span>Description (markdown ok)</span>
				<textarea name="description" rows="4">{data.event.description ?? ''}</textarea>
			</label>
			<div class="reward-row">
				<label>
					<span>Starts at</span>
					<input name="starts_at" type="datetime-local" value={toLocalInput(data.event.starts_at)} />
				</label>
				<label>
					<span>Ends at</span>
					<input name="ends_at" type="datetime-local" value={toLocalInput(data.event.ends_at)} />
				</label>
			</div>
			<button type="submit" class="primary">Save details</button>
		</form>
	</details>

	{#if data.tasks.length === 0}
		<form method="POST" action="?/deleteEvent" use:enhance class="delete-event">
			<button
				type="submit"
				class="danger"
				onclick={(e) => {
					if (!confirm('Delete this event permanently?')) e.preventDefault();
				}}
			>
				Delete event
			</button>
		</form>
	{/if}
</section>

<style>
	h1 {
		margin: 0 0 0.25rem;
	}

	h2 {
		margin: 2rem 0 1rem;
	}

	code {
		padding: 0.05rem 0.35rem;
		background: rgba(0, 0, 0, 0.35);
		border: 1px solid var(--border);
		border-radius: 3px;
		font-size: 0.9em;
	}

	.muted {
		color: var(--muted);
	}

	.small {
		font-size: 0.8rem;
	}

	.error {
		background: var(--danger-bg);
		border: 1px solid var(--danger);
		color: var(--danger);
		padding: 0.6rem 0.8rem;
		border-radius: 4px;
		margin-bottom: 1rem;
	}

	.head {
		display: flex;
		justify-content: space-between;
		align-items: flex-start;
		gap: 1rem;
		flex-wrap: wrap;
	}

	.head-actions {
		display: flex;
		gap: 0.5rem;
		flex-wrap: wrap;
	}

	.link-btn {
		display: inline-flex;
		align-items: center;
		min-height: 38px;
		padding: 0 0.8rem;
		background: var(--accent-soft);
		border: 1px solid var(--accent);
		border-radius: var(--radius);
		color: var(--accent);
		font-size: 0.85rem;
		text-decoration: none;
		text-shadow: var(--ts);
	}

	.link-btn:hover {
		background: var(--accent);
		color: #1a1208;
		text-decoration: none;
		text-shadow: none;
	}

	.status {
		text-transform: uppercase;
		font-family: var(--font-heading);
		font-size: 0.75rem;
		letter-spacing: 0.5px;
		padding: 0.05rem 0.4rem;
		border-radius: 3px;
		border: 1px solid var(--border);
	}

	.status-open {
		border-color: var(--accent);
		color: var(--accent);
		background: var(--accent-soft);
	}

	.card {
		padding: 1.25rem;
		background: linear-gradient(180deg, rgba(58, 48, 36, 0.85), rgba(40, 32, 24, 0.85));
		border: 1px solid var(--border);
		border-radius: var(--radius);
		margin-bottom: 1rem;
		box-shadow: var(--shadow-card);
	}

	.status-card {
		margin-top: 1.25rem;
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
	}

	.status-card .small {
		margin: 0;
	}

	form {
		display: flex;
		flex-direction: column;
		gap: 0.75rem;
		margin-top: 1rem;
	}

	.status-card form,
	.inline-form {
		margin-top: 0;
	}

	label {
		display: flex;
		flex-direction: column;
		gap: 0.25rem;
	}

	label.inline {
		flex-direction: row;
		align-items: center;
		gap: 0.5rem;
	}

	label span {
		font-size: 0.8rem;
		color: var(--muted);
	}

	.reward-row {
		display: grid;
		grid-template-columns: 1fr 2fr;
		gap: 0.75rem;
	}

	.task-list {
		list-style: none;
		padding: 0;
		margin: 0;
	}

	.task-head {
		display: flex;
		justify-content: space-between;
		align-items: center;
		gap: 1rem;
	}

	.reward {
		font-size: 0.75rem;
		color: var(--yellow);
		margin-left: 0.5rem;
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

	.edit-form {
		margin-top: 0.75rem;
	}

	button.primary {
		border-color: var(--accent);
		font-family: var(--font-heading);
		align-self: flex-start;
	}

	button.primary:hover {
		background: var(--accent-soft);
	}

	button.danger {
		border-color: var(--danger);
		color: var(--danger);
	}

	button.danger:hover {
		background: var(--danger-bg);
	}

	button.danger.small {
		font-size: 0.78rem;
		padding: 0.25rem 0.55rem;
		min-height: 0;
	}

	.delete-event {
		margin-top: 1.5rem;
	}
</style>

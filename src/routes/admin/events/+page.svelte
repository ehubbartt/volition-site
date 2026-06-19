<script lang="ts">
	import type { PageData, ActionData } from './$types';
	import { enhance } from '$app/forms';
	import EventsTasksTabs from '$lib/admin/EventsTasksTabs.svelte';
	import { isTaskEvent, isEventEnded } from '$lib/events/simple';
	import { dateFormEnhance } from '$lib/datetime';
	import { BINGO_EVENT_SLUG } from '$lib/bingo/config';

	// Client-safe duo slug (mirrors DUO_WOLF_EVENT_SLUG in the server-only duoWolfTiles.ts).
	const DUO_SLUG = 'duo-wolf';

	let { data, form }: { data: PageData; form: ActionData } = $props();

	type EventRow = (typeof data.events)[number];

	// "Past" = archived (status=closed) OR an open event whose end time has passed (ended but
	// not yet flipped to closed). Everything else (draft/preview/open-live/upcoming/locked) is active.
	function isPastEvent(ev: EventRow): boolean {
		return ev.status === 'closed' || isEventEnded(ev.status, ev.ends_at);
	}
	const activeEvents = $derived(data.events.filter((ev) => !isPastEvent(ev)));
	const pastEvents = $derived(data.events.filter(isPastEvent));

	// ── Event creator ─────────────────────────────────────────────────────────
	// The type dropdown drives which fields show: 'simple'/'sequential' are
	// task-based (a list of objectives); 'custom' is the advanced signup-based form.
	let eventType = $state<'simple' | 'sequential' | 'custom'>('simple');
	type TaskRow = { name: string; description: string; vp: number; pack: string };
	const blankTask = (): TaskRow => ({ name: '', description: '', vp: 0, pack: '' });
	let taskRows = $state<TaskRow[]>([blankTask(), blankTask(), blankTask()]);
	function addTaskRow() {
		taskRows = [...taskRows, blankTask()];
	}
	function removeTaskRow(i: number) {
		taskRows = taskRows.filter((_, idx) => idx !== i);
	}

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
	<EventsTasksTabs />

	<details class="card status-help">
		<summary><strong>What do the event statuses mean?</strong></summary>
		<dl>
			<dt>draft</dt>
			<dd>Hidden from players (admin-only). Use it while you build the event and add tasks.</dd>
			<dt>preview</dt>
			<dd>Admin-only too, but you can test submissions end-to-end before launch.</dd>
			<dt>open</dt>
			<dd>
				Published &amp; visible to members. Submissions <em>and</em> the Discord announcement go
				live at the <strong>Starts at</strong> time — set a future start to <strong>schedule</strong>
				it (it shows as “Upcoming” until then), or leave the start empty/in the past to open right away.
			</dd>
			<dt>locked</dt>
			<dd>Visible but submissions paused (not ended). Use to temporarily halt without archiving.</dd>
			<dt>closed</dt>
			<dd>Ended. Moves to “Past events”; no more submissions.</dd>
		</dl>
	</details>

	{#if form?.error}
		<div class="error">{form.error}</div>
	{/if}

	<details class="card" open>
		<summary><strong>Create event</strong></summary>
		<form method="POST" action="?/createEvent" use:enhance={dateFormEnhance}>
			<label>
				<span>Event type</span>
				<select name="kind" bind:value={eventType}>
					<option value="simple">Open — complete any task, any time</option>
					<option value="sequential">Sequential — complete tasks in order</option>
					<option value="custom">Advanced — signup-based / custom</option>
				</select>
			</label>

			{#if eventType === 'custom'}
				<p class="muted small">Advanced: a bespoke / signup-based event (e.g. a future bingo or duo). You wire up its page separately.</p>
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
				<button type="submit" class="primary">Create event</button>
			{:else}
				<p class="muted small">
					{eventType === 'sequential'
						? 'Players complete the tasks in the order below — each unlocks after the previous is approved.'
						: 'Players can complete the tasks in any order.'}
				</p>
				<label>
					<span>Event name</span>
					<input name="name" type="text" required placeholder="Summer Boss Hunt" />
				</label>
				<label>
					<span>Description (markdown ok)</span>
					<textarea name="description" rows="3" placeholder="What this event is about…"></textarea>
				</label>
				<div class="row">
					<label>
						<span>Starts at (optional)</span>
						<input name="starts_at" type="datetime-local" />
					</label>
					<label>
						<span>Ends at (optional)</span>
						<input name="ends_at" type="datetime-local" />
					</label>
				</div>

				<fieldset class="tasks">
					<legend>
						Tasks
						<span class="muted small">
							(each needs proof + grants its own reward; blank rows ignored{eventType === 'sequential' ? '; unlocked top→bottom' : ''})
						</span>
					</legend>
					{#each taskRows as row, i (i)}
						<div class="task-row">
							<div class="task-row-head">
								<strong class="task-num">Task {i + 1}</strong>
								{#if taskRows.length > 1}
									<button type="button" class="link-danger" onclick={() => removeTaskRow(i)}>Remove</button>
								{/if}
							</div>
							<input name="task_name" type="text" placeholder="Task name (e.g. Kill Zulrah)" bind:value={row.name} />
							<input name="task_desc" type="text" placeholder="Short description / requirement (optional)" bind:value={row.description} />
							<div class="reward-row">
								<label class="reward-field">
									<span>VP reward</span>
									<input name="task_vp" type="number" min="0" bind:value={row.vp} />
								</label>
								<label class="reward-field">
									<span>Pack reward (optional)</span>
									<input name="task_pack" type="text" list="pack-names" placeholder="e.g. White Pack" bind:value={row.pack} />
								</label>
							</div>
						</div>
					{/each}
					<button type="button" class="add-task" onclick={addTaskRow}>+ Add task</button>
				</fieldset>

				<datalist id="pack-names">
					{#each data.packNames as p}<option value={p}></option>{/each}
				</datalist>

				<p class="muted small">Created as a draft — open it from its manage page when you're ready for players to submit.</p>
				<button type="submit" class="primary">Create event</button>
			{/if}
		</form>
	</details>

	{#snippet eventCard(ev: EventRow)}
			<li class="card">
					<div class="event-head">
						<div>
							<strong>{ev.name}</strong>
							<span class="muted">/{ev.slug}</span>
						</div>
						<div class="head-actions">
							{#if isTaskEvent(ev.kind)}
								<a class="review-link" href="/admin/events/{ev.slug}">Manage tasks →</a>
							{/if}
							{#if ev.slug === BINGO_EVENT_SLUG}
								<a class="review-link" href="/admin/bingo/{ev.slug}/review">
									Review submissions →
								</a>
							{/if}
							{#if ev.slug === DUO_SLUG}
								<a class="review-link" href="/admin/duo/{ev.slug}/tiles">Board tiles →</a>
								<a class="review-link" href="/admin/duo/{ev.slug}/review">Review submissions →</a>
							{/if}
							<form method="POST" action="?/updateStatus" use:enhance>
								<input type="hidden" name="id" value={ev.id} />
								<select name="status" onchange={(e) => (e.currentTarget.form as HTMLFormElement).requestSubmit()}>
									{#each ['draft', 'preview', 'open', 'locked', 'closed'] as s}
										<option value={s} selected={ev.status === s}>{s}</option>
									{/each}
								</select>
							</form>
						</div>
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

					<details class="dates-block">
						<summary><strong>Dates</strong> <span class="muted small">(update without touching other fields)</span></summary>
						<form method="POST" action="?/updateDates" use:enhance={dateFormEnhance} class="dates-form">
							<input type="hidden" name="id" value={ev.id} />
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
							<button type="submit" class="primary">Save dates</button>
						</form>
					</details>

					<details class="edit-block">
						<summary>Edit details</summary>
						<form method="POST" action="?/update" use:enhance={dateFormEnhance} class="edit-form">
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
	{/snippet}

	<h2>Active events <span class="count">({activeEvents.length})</span></h2>
	{#if data.events.length === 0}
		<p class="muted">No events yet.</p>
	{:else if activeEvents.length === 0}
		<p class="muted">No active events — see past events below.</p>
	{:else}
		<ul class="event-list">
			{#each activeEvents as ev (ev.id)}{@render eventCard(ev)}{/each}
		</ul>
	{/if}

	{#if pastEvents.length > 0}
		<details class="past-block">
			<summary>Past events <span class="count">({pastEvents.length})</span></summary>
			<ul class="event-list">
				{#each pastEvents as ev (ev.id)}{@render eventCard(ev)}{/each}
			</ul>
		</details>
	{/if}
</section>

<style>
	h2 {
		margin: 2rem 0 1rem;
	}

	.count {
		color: var(--muted);
		font-weight: normal;
		font-size: 0.8em;
	}

	.past-block {
		margin-top: 2rem;
	}

	.past-block > summary {
		cursor: pointer;
		font-family: var(--font-heading);
		font-size: 1.3rem;
		color: var(--accent);
		text-shadow: var(--ts);
		margin-bottom: 1rem;
	}

	.past-block[open] > summary {
		margin-bottom: 0.5rem;
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

	.status-help summary {
		cursor: pointer;
		color: var(--accent);
	}

	.status-help dl {
		margin: 0.85rem 0 0;
		display: grid;
		grid-template-columns: auto 1fr;
		gap: 0.4rem 0.85rem;
		align-items: baseline;
	}

	.status-help dt {
		font-family: var(--font-heading);
		text-transform: uppercase;
		font-size: 0.78rem;
		letter-spacing: 0.05em;
		color: var(--accent);
	}

	.status-help dd {
		margin: 0;
		color: var(--muted);
		font-size: 0.9rem;
	}

	.head-actions {
		display: flex;
		align-items: center;
		gap: 0.5rem;
	}

	.head-actions form {
		display: flex;
		flex-direction: row;
		align-items: center;
		gap: 0;
		margin: 0;
	}

	.dates-block {
		margin-top: 0.75rem;
		padding: 0.4rem 0.6rem;
		background: var(--surface-alt);
		border: 1px solid var(--border);
		border-radius: 3px;
	}

	.dates-block summary {
		cursor: pointer;
		padding: 0.15rem 0;
		font-size: 0.9rem;
	}

	.dates-block .small {
		font-size: 0.8rem;
		margin-left: 0.35rem;
	}

	.dates-form {
		margin-top: 0.75rem;
	}

	.review-link {
		display: inline-flex;
		align-items: center;
		min-height: 40px;
		padding: 0 0.85rem;
		background: var(--accent-soft);
		border: 1px solid var(--accent);
		border-radius: var(--radius);
		color: var(--accent);
		font-family: var(--font-heading);
		font-size: 0.85rem;
		text-decoration: none;
		letter-spacing: 1px;
		text-shadow: var(--ts);
	}

	.review-link:hover {
		background: var(--accent);
		color: #1a1208;
		text-decoration: none;
		text-shadow: none;
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

	.small {
		font-size: 0.8rem;
	}

	.tasks {
		border: 1px solid var(--border);
		border-radius: var(--radius);
		padding: 0.85rem;
		display: flex;
		flex-direction: column;
		gap: 0.85rem;
		margin: 0;
	}

	.tasks legend {
		font-size: 0.85rem;
		color: var(--muted);
		padding: 0 0.35rem;
	}

	.task-row {
		display: flex;
		flex-direction: column;
		gap: 0.4rem;
		padding: 0.75rem;
		background: var(--surface-alt);
		border: 1px solid var(--border);
		border-radius: var(--radius);
	}

	.task-row-head {
		display: flex;
		align-items: center;
		justify-content: space-between;
	}

	.task-num {
		font-family: var(--font-heading);
		font-size: 0.85rem;
		letter-spacing: 0.5px;
		color: var(--accent);
	}

	.reward-row {
		display: grid;
		grid-template-columns: 1fr 2fr;
		gap: 0.6rem;
	}

	.reward-field {
		gap: 0.2rem;
	}

	.link-danger {
		background: none;
		border: none;
		min-height: 0;
		padding: 0;
		color: var(--danger);
		font-size: 0.8rem;
		cursor: pointer;
		text-decoration: underline;
	}

	.link-danger:hover {
		background: none;
	}

	.add-task {
		align-self: flex-start;
		font-size: 0.85rem;
		border-color: var(--accent);
		color: var(--accent);
	}

	.add-task:hover {
		background: var(--accent-soft);
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

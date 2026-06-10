<script lang="ts">
	import { enhance } from '$app/forms';
	import type { PageData, ActionData } from './$types';

	let { data, form }: { data: PageData; form: ActionData } = $props();

	let createMode = $state<'template' | 'active'>('template');
	let createKind = $state<'weekly' | 'custom'>('weekly');
	let editing = $state<string | null>(null);

	function rewardLabel(vp: number | null, pack: string | null): string {
		const parts: string[] = [];
		if (pack) parts.push(pack);
		if (vp && vp > 0) parts.push(`${vp} VP`);
		return parts.length ? parts.join(' + ') : 'No reward';
	}

	function fmt(iso: string | null): string {
		if (!iso) return 'no deadline';
		try {
			return new Date(iso).toLocaleString();
		} catch {
			return iso;
		}
	}
</script>

<svelte:head><title>Tasks · Admin · Volition</title></svelte:head>

<nav class="crumbs"><a href="/admin">← Admin</a></nav>

<section class="head">
	<h1>Tasks</h1>
	<p class="muted">The weekly rotation pool + active tasks. Tasks are separate from full events.</p>
</section>

{#if form?.error}<div class="error">{form.error}</div>{/if}

<!-- Create -->
<section class="panel">
	<h2>Create a task</h2>
	<form method="POST" action="?/createTask" use:enhance>
		<div class="grid">
			<label class="field span2">
				<span>Name</span>
				<input name="name" type="text" placeholder="e.g. Gather 2,000 red spider eggs" required />
			</label>
			<label class="field span2">
				<span>Description</span>
				<textarea name="description" rows="2" placeholder="What to do / what proof to submit (markdown ok)"></textarea>
			</label>
			<label class="field">
				<span>Type</span>
				<select name="kind" bind:value={createKind}>
					<option value="weekly">Weekly task</option>
					<option value="custom">Custom task</option>
				</select>
			</label>
			<label class="field">
				<span>VP reward</span>
				<input name="vp_reward" type="number" min="0" value="5" />
			</label>
			<label class="field">
				<span>Pack reward (optional)</span>
				<input name="pack_reward" type="text" placeholder="e.g. White Pack" />
			</label>
			<label class="field">
				<span>Save as</span>
				<select name="mode" bind:value={createMode}>
					<option value="template">Add to rotation pool</option>
					<option value="active">Activate now</option>
				</select>
			</label>
			{#if createMode === 'template'}
				<label class="field check">
					<input type="checkbox" name="in_rotation" checked />
					<span>Eligible for weekly auto-rotation</span>
				</label>
			{:else}
				<label class="field">
					<span>Active for (days — blank: weekly ends Sunday midnight)</span>
					<input name="days" type="number" min="1" placeholder="days" />
				</label>
			{/if}
		</div>
		<div class="actions">
			<button type="submit" class="primary">Create task</button>
		</div>
	</form>
</section>

<!-- Pool -->
<section class="panel">
	<h2>Weekly rotation pool <span class="count">{data.templates.length}</span></h2>
	<p class="muted small">Templates the weekly auto-rotation picks from. Toggle rotation, or activate one now.</p>
	{#if data.templates.length === 0}
		<p class="muted">No templates yet. Create one above (Save as → Add to rotation pool).</p>
	{:else}
		<ul class="list">
			{#each data.templates as t (t.id)}
				<li class="row">
					<div class="row-main">
						<div class="row-title">
							<strong>{t.name}</strong>
							<span class="kind">{t.kind === 'custom_task' ? 'custom' : 'weekly'}</span>
							<span class="reward">{rewardLabel(t.vp_reward, t.pack_reward)}</span>
							{#if t.in_rotation}
								<span class="pill on">In rotation</span>
							{:else}
								<span class="pill off">Not in rotation</span>
							{/if}
						</div>
						{#if t.description}<p class="row-desc muted">{t.description}</p>{/if}
					</div>

					<div class="row-actions">
						<form method="POST" action="?/toggleRotation" use:enhance>
							<input type="hidden" name="id" value={t.id} />
							<input type="hidden" name="value" value={(!t.in_rotation).toString()} />
							<button type="submit">{t.in_rotation ? 'Disable' : 'Enable'} rotation</button>
						</form>
						{#if t.in_rotation}
							<form method="POST" action="?/activateTemplate" use:enhance class="activate">
								<input type="hidden" name="id" value={t.id} />
								<input name="days" type="number" min="1" placeholder="days" title="Active for N days. Blank: weekly tasks end Sunday midnight; others have no deadline." />
								<button type="submit" class="primary">Activate now</button>
							</form>
						{:else}
							<span class="muted small used-note">Used — enable rotation to reuse</span>
						{/if}
						<button type="button" onclick={() => (editing = editing === t.id ? null : t.id)}>
							{editing === t.id ? 'Cancel' : 'Edit'}
						</button>
						<form method="POST" action="?/deleteTask" use:enhance>
							<input type="hidden" name="id" value={t.id} />
							<button type="submit" class="danger">Delete</button>
						</form>
					</div>

					{#if editing === t.id}
						<form method="POST" action="?/updateTask" class="edit" use:enhance={() => async ({ result, update }) => {
							await update();
							if (result.type === 'success') editing = null;
						}}>
							<input type="hidden" name="id" value={t.id} />
							<div class="grid">
								<label class="field span2"><span>Name</span><input name="name" value={t.name} required /></label>
								<label class="field span2"><span>Description</span><textarea name="description" rows="2">{t.description ?? ''}</textarea></label>
								<label class="field"><span>VP reward</span><input name="vp_reward" type="number" min="0" value={t.vp_reward ?? 0} /></label>
								<label class="field"><span>Pack reward</span><input name="pack_reward" type="text" value={t.pack_reward ?? ''} /></label>
							</div>
							<div class="actions"><button type="submit" class="primary">Save changes</button></div>
						</form>
					{/if}
				</li>
			{/each}
		</ul>
	{/if}
</section>

<!-- Active -->
<section class="panel">
	<h2>Active tasks <span class="count">{data.active.length}</span></h2>
	<p class="muted small">Live now — players see these on the To Do page and can submit proof.</p>
	{#if data.active.length === 0}
		<p class="muted">No active tasks. Activate one from the pool, or create one with “Activate now”.</p>
	{:else}
		<ul class="list">
			{#each data.active as t (t.id)}
				<li class="row">
					<div class="row-main">
						<div class="row-title">
							<strong>{t.name}</strong>
							<span class="kind">{t.kind === 'custom_task' ? 'custom' : 'weekly'}</span>
							<span class="reward">{rewardLabel(t.vp_reward, t.pack_reward)}</span>
							<span class="muted small">ends {fmt(t.ends_at)}</span>
						</div>
						{#if t.description}<p class="row-desc muted">{t.description}</p>{/if}
					</div>
					<div class="row-actions">
						<button type="button" onclick={() => (editing = editing === t.id ? null : t.id)}>
							{editing === t.id ? 'Cancel' : 'Edit'}
						</button>
						<form method="POST" action="?/closeTask" use:enhance>
							<input type="hidden" name="id" value={t.id} />
							<button type="submit" class="danger">Close</button>
						</form>
					</div>

					{#if editing === t.id}
						<form method="POST" action="?/updateTask" class="edit" use:enhance={() => async ({ result, update }) => {
							await update();
							if (result.type === 'success') editing = null;
						}}>
							<input type="hidden" name="id" value={t.id} />
							<div class="grid">
								<label class="field span2"><span>Name</span><input name="name" value={t.name} required /></label>
								<label class="field span2"><span>Description</span><textarea name="description" rows="2">{t.description ?? ''}</textarea></label>
								<label class="field"><span>VP reward</span><input name="vp_reward" type="number" min="0" value={t.vp_reward ?? 0} /></label>
								<label class="field"><span>Pack reward</span><input name="pack_reward" type="text" value={t.pack_reward ?? ''} /></label>
								<label class="field span2"><span>Deadline (days from now — blank = unchanged, 0 = none)</span><input name="days" type="number" min="0" placeholder="leave blank to keep" /></label>
							</div>
							<div class="actions"><button type="submit" class="primary">Save changes</button></div>
						</form>
					{/if}
				</li>
			{/each}
		</ul>
	{/if}
</section>

<style>
	.crumbs {
		margin-bottom: 0.75rem;
		font-size: 0.9rem;
	}
	.crumbs a {
		color: var(--muted);
		text-decoration: none;
	}
	.crumbs a:hover {
		color: var(--accent);
	}
	.head h1 {
		margin: 0 0 0.2rem;
	}
	.muted {
		color: var(--muted);
	}
	.small {
		font-size: 0.85rem;
	}
	.panel {
		margin-top: 1.25rem;
		padding: 1.1rem 1.25rem;
		background: linear-gradient(180deg, rgba(58, 48, 36, 0.6), rgba(40, 32, 24, 0.6));
		border: 1px solid var(--border);
		border-radius: var(--radius);
		box-shadow: var(--shadow-card);
	}
	.panel h2 {
		margin: 0 0 0.5rem;
		display: flex;
		align-items: center;
		gap: 0.5rem;
	}
	.count {
		font-family: var(--font-heading);
		font-size: 0.8rem;
		color: var(--accent);
		background: var(--accent-soft);
		border: 1px solid var(--accent);
		border-radius: 999px;
		padding: 0.05rem 0.5rem;
	}
	.error {
		margin: 0.75rem 0 0;
		padding: 0.5rem 0.7rem;
		background: var(--danger-bg);
		border: 1px solid var(--danger);
		color: var(--danger);
		border-radius: 3px;
		font-size: 0.9rem;
	}
	.grid {
		display: grid;
		grid-template-columns: 1fr 1fr;
		gap: 0.75rem;
	}
	.field {
		display: flex;
		flex-direction: column;
		gap: 0.25rem;
		font-size: 0.85rem;
	}
	.field.span2 {
		grid-column: 1 / -1;
	}
	.field.check {
		flex-direction: row;
		align-items: center;
		gap: 0.5rem;
	}
	.field > span {
		color: var(--muted);
	}
	.field input,
	.field textarea,
	.field select {
		font-size: 0.95rem;
	}
	.actions {
		margin-top: 0.75rem;
	}
	button.primary {
		border-color: var(--accent);
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
	.list {
		list-style: none;
		margin: 0.5rem 0 0;
		padding: 0;
		display: flex;
		flex-direction: column;
		gap: 0.6rem;
	}
	.row {
		padding: 0.75rem 0.85rem;
		background: var(--surface-alt);
		border: 1px solid var(--border);
		border-radius: var(--radius);
		display: flex;
		flex-wrap: wrap;
		align-items: flex-start;
		justify-content: space-between;
		gap: 0.6rem;
	}
	.row-main {
		min-width: 0;
		flex: 1 1 20rem;
	}
	.row-title {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		flex-wrap: wrap;
	}
	.row-desc {
		margin: 0.3rem 0 0;
		font-size: 0.85rem;
	}
	.kind {
		font-family: var(--font-heading);
		font-size: 0.68rem;
		text-transform: uppercase;
		letter-spacing: 1px;
		color: var(--muted);
		border: 1px solid var(--border);
		border-radius: 3px;
		padding: 0.02rem 0.35rem;
	}
	.reward {
		font-size: 0.75rem;
		color: var(--yellow);
		background: rgba(255, 255, 0, 0.08);
		border: 1px solid rgba(255, 255, 0, 0.3);
		border-radius: var(--radius);
		padding: 0.05rem 0.4rem;
	}
	.pill {
		font-size: 0.68rem;
		text-transform: uppercase;
		letter-spacing: 0.04em;
		border-radius: 999px;
		padding: 0.05rem 0.45rem;
		border: 1px solid transparent;
	}
	.pill.on {
		color: #7fd18a;
		border-color: rgba(127, 209, 138, 0.4);
		background: rgba(127, 209, 138, 0.1);
	}
	.pill.off {
		color: var(--muted);
		border-color: var(--border);
	}
	.row-actions {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.4rem;
	}
	.row-actions form {
		display: flex;
		gap: 0.3rem;
		align-items: center;
	}
	.row-actions .activate input {
		width: 4rem;
	}
	.edit {
		flex-basis: 100%;
		margin-top: 0.6rem;
		padding-top: 0.6rem;
		border-top: 1px dashed var(--border);
	}
	@media (max-width: 640px) {
		.grid {
			grid-template-columns: 1fr;
		}
	}
</style>

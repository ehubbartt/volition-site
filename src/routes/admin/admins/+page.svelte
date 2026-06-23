<script lang="ts">
	import { enhance } from '$app/forms';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();

	let grantStatus = $state<{ ok: boolean; msg: string } | null>(null);
	let revokeStatus = $state<{ ok: boolean; msg: string } | null>(null);
	let role = $state<'admin' | 'card_tester'>('admin');

	function name(id: string): string {
		return data.usernames[id] ?? '';
	}
	function fmtDate(iso: string): string {
		const d = new Date(iso);
		return isNaN(d.getTime())
			? iso
			: d.toLocaleString(undefined, {
					month: 'short',
					day: 'numeric',
					year: 'numeric',
					hour: '2-digit',
					minute: '2-digit'
				});
	}
	const roleLabel = (r: string) => (r === 'card_tester' ? 'Card Tester' : 'Admin');
</script>

<svelte:head>
	<title>Admin Access · Volition Admin</title>
</svelte:head>

<section>
	<h1>Admin Access</h1>
	<p class="muted">
		Grant or revoke website admin access. Owners (super admins) are set via the
		<code>SUPER_ADMIN_DISCORD_IDS</code> environment variable and can't be changed here. Grants take
		effect within ~30 seconds.
	</p>

	{#if data.loadError}
		<p class="error">Failed to load grants: {data.loadError}</p>
	{/if}

	<div class="card">
		<h2>Grant a role</h2>
		<form
			method="POST"
			action="?/grant"
			use:enhance={() => {
				return async ({ result, update }) => {
					if (result.type === 'success') {
						grantStatus = { ok: true, msg: 'Role granted.' };
						await update({ reset: true });
					} else if (result.type === 'failure') {
						grantStatus = {
							ok: false,
							msg: (result.data as { error?: string })?.error ?? 'Grant failed'
						};
					} else {
						grantStatus = { ok: false, msg: 'Grant failed' };
					}
				};
			}}
		>
			<div class="grant-row">
				<label>
					<span>Discord user ID</span>
					<input name="discord_id" placeholder="e.g. 123456789012345678" inputmode="numeric" required />
				</label>
				<label>
					<span>Role</span>
					<select name="role" bind:value={role}>
						<option value="admin">Admin</option>
						<option value="card_tester">Card Tester</option>
					</select>
				</label>
				<label class="grow">
					<span>Note (optional)</span>
					<input name="note" placeholder="Who is this / why" />
				</label>
				<button class="primary" type="submit">Grant</button>
			</div>
			{#if grantStatus}
				<p class="status" class:ok={grantStatus.ok} class:bad={!grantStatus.ok}>{grantStatus.msg}</p>
			{/if}
		</form>
		<p class="muted tiny">
			Tip: enable Developer Mode in Discord, then right-click a user → “Copy User ID”.
		</p>
	</div>

	<div class="card">
		<h2>Granted via this page</h2>
		{#if data.grants.length === 0}
			<p class="muted">No DB-granted roles yet.</p>
		{:else}
			<table>
				<thead>
					<tr>
						<th>User</th>
						<th>Role</th>
						<th>Granted by</th>
						<th>When</th>
						<th></th>
					</tr>
				</thead>
				<tbody>
					{#each data.grants as g (g.id)}
						<tr>
							<td>
								<span class="who">{name(g.discord_id) || g.discord_id}</span>
								{#if name(g.discord_id)}<span class="muted tiny mono">{g.discord_id}</span>{/if}
								{#if g.note}<span class="muted tiny note">{g.note}</span>{/if}
							</td>
							<td><span class="pill">{roleLabel(g.role)}</span></td>
							<td class="muted tiny">{name(g.granted_by) || g.granted_by}</td>
							<td class="muted tiny">{fmtDate(g.created_at)}</td>
							<td>
								<form
									method="POST"
									action="?/revoke"
									use:enhance={() => {
										return async ({ result, update }) => {
											if (result.type === 'success') {
												revokeStatus = { ok: true, msg: 'Revoked.' };
												await update();
											} else {
												revokeStatus = {
													ok: false,
													msg:
														(result.type === 'failure' &&
															(result.data as { error?: string })?.error) ||
														'Revoke failed'
												};
											}
										};
									}}
								>
									<input type="hidden" name="id" value={g.id} />
									<button class="danger" type="submit">Revoke</button>
								</form>
							</td>
						</tr>
					{/each}
				</tbody>
			</table>
			{#if revokeStatus}
				<p class="status" class:ok={revokeStatus.ok} class:bad={!revokeStatus.ok}>
					{revokeStatus.msg}
				</p>
			{/if}
		{/if}
	</div>

	<div class="card">
		<h2>Root access (environment variables)</h2>
		<p class="muted tiny">Read-only — change via deploy env vars, not here.</p>

		{@render rootList('Owners (super admin)', data.envSuperAdmins)}
		{@render rootList('Admins', data.envAdmins)}
		{@render rootList('Card testers', data.envCardTesters)}
	</div>
</section>

{#snippet rootList(title: string, ids: string[])}
	<div class="root-group">
		<strong>{title}</strong>
		{#if ids.length === 0}
			<span class="muted tiny">none</span>
		{:else}
			<ul>
				{#each ids as id (id)}
					<li>
						<span class="who">{name(id) || id}</span>
						{#if name(id)}<span class="muted tiny mono">{id}</span>{/if}
					</li>
				{/each}
			</ul>
		{/if}
	</div>
{/snippet}

<style>
	h1 {
		margin-bottom: 0.25rem;
	}
	h2 {
		margin: 0 0 0.75rem;
		font-size: 1.1rem;
		color: var(--accent);
		text-shadow: var(--ts);
	}
	.muted {
		color: var(--muted);
	}
	.tiny {
		font-size: 0.75rem;
	}
	.mono {
		font-family: ui-monospace, 'SF Mono', Menlo, monospace;
		margin-left: 0.4rem;
	}
	code {
		background: var(--surface-alt);
		padding: 0.05rem 0.3rem;
		border-radius: 3px;
		font-size: 0.85em;
	}

	.card {
		padding: 1.25rem;
		background: linear-gradient(180deg, rgba(58, 48, 36, 0.85), rgba(40, 32, 24, 0.85));
		border: 1px solid var(--border);
		border-radius: var(--radius);
		box-shadow: var(--shadow-card);
		margin: 1rem 0;
	}

	.grant-row {
		display: flex;
		gap: 0.75rem;
		align-items: flex-end;
		flex-wrap: wrap;
	}
	label {
		display: flex;
		flex-direction: column;
		gap: 0.3rem;
		font-size: 0.85rem;
	}
	label.grow {
		flex: 1;
		min-width: 12rem;
	}
	input,
	select {
		padding: 0.45rem 0.6rem;
		background: var(--surface-alt);
		border: 1px solid var(--border);
		border-radius: var(--radius);
		color: var(--text);
		font-family: var(--font-body);
	}
	input:focus,
	select:focus {
		outline: none;
		border-color: var(--accent);
	}

	table {
		width: 100%;
		border-collapse: collapse;
	}
	th,
	td {
		text-align: left;
		padding: 0.5rem 0.6rem;
		border-bottom: 1px solid var(--border);
		vertical-align: top;
	}
	th {
		font-size: 0.75rem;
		text-transform: uppercase;
		letter-spacing: 0.5px;
		color: var(--muted);
	}
	.who {
		display: block;
		font-weight: 600;
	}
	.note {
		display: block;
		margin-top: 0.15rem;
	}

	.root-group {
		margin-bottom: 0.85rem;
	}
	.root-group ul {
		margin: 0.3rem 0 0;
		padding-left: 1.1rem;
	}
	.root-group li {
		margin: 0.15rem 0;
	}

	.pill {
		display: inline-block;
		padding: 0.05rem 0.45rem;
		border-radius: 999px;
		font-size: 0.7rem;
		text-transform: uppercase;
		letter-spacing: 0.5px;
		background: var(--accent-soft);
		border: 1px solid var(--accent);
		color: var(--accent);
	}

	.primary {
		padding: 0.45rem 1rem;
		background: var(--accent-soft);
		border: 1px solid var(--accent);
		border-radius: var(--radius);
		color: var(--accent);
		font-family: var(--font-body);
		cursor: pointer;
	}
	.primary:hover {
		background: var(--accent);
		color: #000;
	}
	.danger {
		padding: 0.35rem 0.7rem;
		background: transparent;
		border: 1px solid var(--danger);
		border-radius: var(--radius);
		color: var(--danger);
		font-family: var(--font-body);
		cursor: pointer;
		font-size: 0.8rem;
	}
	.danger:hover {
		background: var(--danger);
		color: #000;
	}

	.status {
		font-size: 0.85rem;
		margin-top: 0.6rem;
	}
	.status.ok {
		color: var(--success);
	}
	.status.bad {
		color: var(--danger);
	}
	.error {
		color: var(--danger);
	}
</style>

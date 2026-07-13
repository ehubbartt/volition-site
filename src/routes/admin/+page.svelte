<script lang="ts">
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();

	type Tool = { href: string; title: string; desc: string; show: boolean };

	let tools = $derived<Tool[]>([
		{
			href: '/admin/events',
			title: 'Events & Tasks',
			desc: 'Manage events, the weekly task pool, and review pending submissions.',
			show: data.admin
		},
		{
			href: '/admin/cards',
			title: 'Cards & Packs',
			desc: data.cardTester
				? 'Author cards & packs, grant packs, and test/simulate opens.'
				: 'View cards & packs (read-only), grant packs, and test/simulate opens.',
			show: data.admin || data.cardTester
		},
		{
			href: '/admin/moderation',
			title: 'Moderation',
			desc: 'Bans, warnings, and the audit log of every admin action.',
			show: data.admin
		},
		{
			href: '/admin/stats',
			title: 'Clan Stats',
			desc: 'Members & economy stats, member wallets, and voice activity.',
			show: data.admin
		},
		{
			href: '/admin/crate-sim',
			title: 'Crate Simulator',
			desc: 'Bulk-simulate gamba crate opens — VP/GP generated, return ratio, and drop rates.',
			show: data.admin
		},
		{
			href: '/admin/rank-sim',
			title: 'Rank Simulator',
			desc: 'Tune the composite rank formula and preview the clan-wide rank spread before applying.',
			show: data.admin
		},
		{
			href: '/admin/guides',
			title: 'Guides',
			desc: 'Admin documentation: tile event, join process, bot commands.',
			show: data.admin
		},
		{
			href: '/admin/config',
			title: 'Database',
			desc: 'Bot config, any database table, and player card inventories. Super-admins only.',
			show: data.superAdmin
		},
		{
			href: '/admin/admins',
			title: 'Admin Access',
			desc: 'Grant or revoke who has admin access to the website. Super-admins only.',
			show: data.superAdmin
		},
		{
			href: '/admin/overview',
			title: 'Bot Overview',
			desc: 'Read-only snapshot of current bot config and who has admin access.',
			show: data.admin
		},
		{
			href: '/admin/ehb',
			title: 'EHB Drop Tool 🧪',
			desc: 'Experimental: look up an item’s drop rate & EHB cost, or find drops matching an EHB target. (Temporary.)',
			show: data.admin
		},
		{
			href: '/admin/dink-test',
			title: 'Dink Tracking',
			desc: 'Simulate drops, inspect the matched-drops log with each verdict, and manage Dink config tokens.',
			show: data.admin
		}
	]);

	let visible = $derived(tools.filter((t) => t.show));
</script>

<svelte:head>
	<title>Admin · Volition</title>
</svelte:head>

<section>
	<h1>Admin</h1>
	<p class="muted">Tools and controls for managing the site.</p>

	<div class="tool-grid">
		{#each visible as tool (tool.href)}
			<a class="tool" href={tool.href}>
				<strong>{tool.title}</strong>
				<span class="muted">{tool.desc}</span>
			</a>
		{/each}
	</div>

	<!-- VIEW-AS (real super admins only — see hooks.server.ts). Deliberately a
	     NATIVE form: the full document load it causes wipes the client swr cache,
	     so payloads fetched under a higher role can never first-paint into a
	     lower-role preview. While a preview is active this page is unreachable —
	     the header shows an "exit preview" chip instead (root +layout.svelte). -->
	{#if data.realSuperAdmin}
		<div class="view-as-card">
			<div>
				<strong>View site as</strong>
				<p class="muted">
					Preview the whole site as a lower role — nav, pages, and permissions all follow.
					A chip in the header brings you back.
				</p>
			</div>
			<form method="POST" action="/admin/view-as">
				<select name="role" aria-label="View site as role">
					<option value="admin">Admin</option>
					<option value="member">Member</option>
					<option value="guest">Non-clan member</option>
				</select>
				<button type="submit">Preview</button>
			</form>
		</div>
	{/if}
</section>

<style>
	h1 {
		margin-bottom: 0.25rem;
	}

	.muted {
		color: var(--muted);
	}

	.tool-grid {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(15rem, 1fr));
		gap: 1rem;
		margin-top: 1.5rem;
	}

	.tool {
		display: flex;
		flex-direction: column;
		gap: 0.4rem;
		padding: 1.25rem;
		background-color: var(--stone-fill);
		background-image: var(--stone-tile);
		background-repeat: repeat;
		border: 4px solid transparent;
		border-image: url('/osrs/border-tiny.png') 4 / 4px round;
		border-radius: 4px;
		text-decoration: none;
		color: var(--text);
		transition: transform 0.15s, box-shadow 0.15s;
	}

	.tool:hover {
		transform: translateY(-2px);
		box-shadow: 0 6px 20px rgba(0, 0, 0, 0.5), 0 0 0 2px rgba(255, 152, 31, 0.4);
		text-decoration: none;
	}

	.tool strong {
		font-family: var(--font-heading);
		font-size: 1.15rem;
		color: var(--accent);
		text-shadow: var(--ts);
	}

	.tool span {
		font-size: 0.9rem;
		line-height: 1.4;
	}

	.view-as-card {
		margin-top: 1.5rem;
		padding: 1rem 1.25rem;
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 1rem;
		flex-wrap: wrap;
		background: linear-gradient(180deg, rgba(58, 48, 36, 0.85), rgba(40, 32, 24, 0.85));
		border: 1px solid var(--border);
		border-radius: var(--radius);
	}
	.view-as-card strong {
		font-family: var(--font-heading);
		color: var(--accent);
		text-shadow: var(--ts);
	}
	.view-as-card p {
		margin: 0.15rem 0 0;
		font-size: 0.85rem;
		max-width: 34rem;
	}
	.view-as-card form {
		display: flex;
		gap: 0.5rem;
		align-items: center;
	}
	.view-as-card select,
	.view-as-card button {
		background: var(--surface-alt);
		color: var(--text);
		border: 1px solid var(--border);
		border-radius: 6px;
		padding: 0.35rem 0.6rem;
		font: inherit;
		cursor: pointer;
	}
	.view-as-card button:hover {
		border-color: var(--accent);
		color: var(--accent);
	}
</style>

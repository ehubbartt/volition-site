<script lang="ts">
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();

	const rows = $derived([
		{ label: 'Table — vs_rls_test', probe: data.probes.table },
		{ label: 'View — vs_rls_test_view', probe: data.probes.view },
		{ label: 'Function — vs_rls_test_fn()', probe: data.probes.rpc }
	]);
</script>

<svelte:head><title>RLS Test · Volition Admin</title></svelte:head>

<section>
	<h1>RLS lockdown test</h1>
	<p class="muted">
		Probes the throwaway <code>vs_rls_test</code> objects with the app's own Supabase client.
		Run <code>db/scripts/rls_test.sql</code> section by section and refresh this page to watch
		the results flip. Staging-only.
	</p>

	<div class="mode" class:service={data.usingServiceKey}>
		App is querying with the <strong>{data.usingServiceKey ? 'service-role key' : 'anon key'}</strong>.
		{#if data.usingServiceKey}
			With RLS enabled, everything below should stay <strong>readable</strong> — the service key
			bypasses RLS (this is the real post-lockdown state).
		{:else}
			With RLS enabled, everything below should become <strong>blocked</strong> — proving the
			anon key can't read locked objects.
		{/if}
	</div>

	<table>
		<thead>
			<tr><th>Object</th><th>Result</th><th>Detail</th></tr>
		</thead>
		<tbody>
			{#each rows as r (r.label)}
				<tr>
					<td>{r.label}</td>
					<td class:ok={r.probe.readable} class:blocked={!r.probe.readable}>
						{r.probe.readable ? '✓ readable' : '✗ blocked'}
					</td>
					<td class="detail">{r.probe.detail}</td>
				</tr>
			{/each}
		</tbody>
	</table>

	<ol class="steps muted">
		<li>Run <strong>SECTION 1 (SETUP)</strong> → refresh → all three readable (RLS off).</li>
		<li>Run <strong>SECTION 2 (ENABLE)</strong> → refresh → results flip per the banner above.</li>
		<li>Optionally run the anon-key curl probes in the SQL header (external anon path).</li>
		<li>Optionally set the service key on staging → refresh → readable again.</li>
		<li>Run <strong>SECTION 3 (CLEANUP)</strong> when done.</li>
	</ol>
</section>

<style>
	section {
		max-width: 46rem;
	}
	h1 {
		margin-bottom: 0.25rem;
	}
	.muted {
		color: var(--muted);
	}
	code {
		background: var(--surface-alt);
		padding: 0.05rem 0.3rem;
		border-radius: 3px;
		font-size: 0.85em;
	}
	.mode {
		margin: 1rem 0;
		padding: 0.75rem 1rem;
		border: 1px solid var(--border);
		border-left: 3px solid var(--muted);
		border-radius: var(--radius);
		background: var(--surface-alt);
		font-size: 0.9rem;
	}
	.mode.service {
		border-left-color: var(--accent);
	}
	table {
		width: 100%;
		border-collapse: collapse;
		margin: 1rem 0;
	}
	th,
	td {
		text-align: left;
		padding: 0.5rem 0.6rem;
		border-bottom: 1px solid var(--border);
	}
	th {
		color: var(--muted);
		font-size: 0.8rem;
		text-transform: uppercase;
		letter-spacing: 0.4px;
	}
	td.ok {
		color: var(--success, #5fc35f);
		font-weight: 600;
	}
	td.blocked {
		color: var(--danger, #d9534f);
		font-weight: 600;
	}
	.detail {
		font-family: monospace;
		font-size: 0.8rem;
		color: var(--muted);
	}
	.steps {
		font-size: 0.9rem;
		line-height: 1.6;
		padding-left: 1.2rem;
	}
</style>

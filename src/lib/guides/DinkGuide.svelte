<script lang="ts">
	// The Dink setup guide, extracted for reuse (onboarding + anywhere else). Shows the
	// member their personal Dynamic Config URL with a one-tap copy, plus the short
	// install steps. `compact` tightens it for embedding.
	let { configUrl = null, compact = false }: { configUrl?: string | null; compact?: boolean } = $props();

	let copied = $state(false);
	async function copyUrl() {
		if (!configUrl) return;
		try {
			await navigator.clipboard.writeText(configUrl);
			copied = true;
			setTimeout(() => (copied = false), 1500);
		} catch {
			/* clipboard blocked — the URL is visible to copy manually */
		}
	}
</script>

<div class="dink-guide" class:compact>
	{#if !compact}
		<p class="lead">
			Dink reports your drops the instant they land, so bingo tiles and loot tracking credit you
			automatically. Two minutes in RuneLite.
		</p>
	{/if}

	<ol class="steps">
		<li>In RuneLite's <strong>Plugin Hub</strong>, install <strong>Dink</strong>.</li>
		<li>Open Dink's settings and <strong>reset them to defaults</strong> (so nothing conflicts).</li>
		<li>
			Under <strong>Advanced settings</strong>, paste your personal URL into
			<strong>Dynamic config URL</strong>:
		</li>
	</ol>

	{#if configUrl}
		<div class="urlbox">
			<code>{configUrl}</code>
			<button type="button" class="copy" onclick={copyUrl}>{copied ? '✓ Copied' : 'Copy'}</button>
		</div>
	{:else}
		<p class="muted">Your Dink URL isn't available right now — you can grab it later from the Dink page.</p>
	{/if}

	<ol class="steps" start="4">
		<li>Click <strong>Import</strong> — Dink pulls the clan config. Done.</li>
	</ol>

	<details class="more">
		<summary>What Dink does & more info</summary>
		<p>
			Dink watches your client and fires the instant a drop, collection-log unlock, or
			achievement lands — that's what credits your <strong>bingo tiles in real time</strong> and
			feeds the loot channel. The config URL above is personal to you; it tells Dink exactly
			what to report and where, so you don't have to configure anything by hand.
		</p>
		<p>
			It pairs with <strong>TempleOSRS</strong>: Dink is the instant signal, Temple is the
			periodic full-log source of truth. You want both.
		</p>
	</details>
</div>

<style>
	.dink-guide {
		display: flex;
		flex-direction: column;
		gap: 0.85rem;
	}
	.lead {
		color: var(--muted);
		line-height: 1.55;
		margin: 0;
	}
	.steps {
		margin: 0;
		padding-left: 1.2rem;
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
		line-height: 1.5;
	}
	.compact .steps {
		font-size: 0.92rem;
	}
	.urlbox {
		display: flex;
		gap: 0.4rem;
		align-items: stretch;
	}
	.urlbox code {
		flex: 1;
		min-width: 0;
		padding: 0.55rem 0.65rem;
		background: var(--surface);
		border: 1px solid var(--border-strong);
		border-radius: 6px;
		word-break: break-all;
		font-size: 0.8rem;
	}
	.copy {
		flex-shrink: 0;
		border-color: var(--accent);
		white-space: nowrap;
	}
	.muted {
		color: var(--muted);
		margin: 0;
	}
	.more {
		border: 1px solid var(--border);
		border-radius: 8px;
		padding: 0.4rem 0.7rem;
		background: var(--surface-alt);
	}
	.more summary {
		cursor: pointer;
		font-size: 0.88rem;
		color: var(--accent);
	}
	.more p {
		margin: 0.6rem 0 0;
		font-size: 0.88rem;
		line-height: 1.5;
		color: var(--muted);
	}
</style>

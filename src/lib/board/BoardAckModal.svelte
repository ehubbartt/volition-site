<script lang="ts">
	// First-visit gate for the live DuoWolf board. The player must tick every box (codeword,
	// timestamps, read the guide, screenshot rules) before they can use the board. Acknowledgement
	// is remembered via a per-event cookie set by the parent on confirm — this is a UX nudge, not a
	// security gate (the server still validates every submission).
	interface Props {
		eventName: string;
		codeword: string;
		guideHref: string;
		onConfirm: () => void;
	}

	let { eventName, codeword, guideHref, onConfirm }: Props = $props();

	let ackCodeword = $state(false);
	let ackTimestamps = $state(false);
	let ackGuide = $state(false);
	let ackRules = $state(false);

	const allChecked = $derived(ackCodeword && ackTimestamps && ackGuide && ackRules);
</script>

<div class="backdrop" role="presentation">
	<div class="modal" role="dialog" aria-modal="true" aria-labelledby="ack-title">
		<header class="head">
			<span class="badge" aria-hidden="true">📋</span>
			<div>
				<h2 id="ack-title">Before you start</h2>
				<p class="sub">{eventName} — please confirm you've read the evidence rules.</p>
			</div>
		</header>

		<p class="intro">
			Every submission must follow our evidence rules. Tick each box below to confirm, then
			continue to the board.
		</p>

		<ul class="checks">
			<li>
				<label>
					<input type="checkbox" bind:checked={ackCodeword} />
					<span>
						I have the codeword <strong class="code">{codeword}</strong> typed into my
						<strong>Wise Old Man</strong> plug-in — or, if I'm on <strong>mobile</strong>, I
						understand I must type it into my chat box for <strong>every</strong> submission.
					</span>
				</label>
			</li>
			<li>
				<label>
					<input type="checkbox" bind:checked={ackTimestamps} />
					<span>I have <strong>chat timestamps enabled</strong> in my chat box.</span>
				</label>
			</li>
			<li>
				<label>
					<input type="checkbox" bind:checked={ackGuide} />
					<span>
						I have opened, viewed and read the
						<a href={guideHref} target="_blank" rel="noopener">Evidence Guide ↗</a>.
					</span>
				</label>
			</li>
			<li>
				<label>
					<input type="checkbox" bind:checked={ackRules} />
					<span>
						I understand I must follow the screenshot rules, or my submission is
						<strong>subject to rejection</strong>.
					</span>
				</label>
			</li>
		</ul>

		<div class="actions">
			<a class="guide-cta" href={guideHref} target="_blank" rel="noopener">Open the Evidence Guide ↗</a>
			<p class="hint" class:ready={allChecked} aria-live="polite">
				{allChecked ? '✓ All set — you can enter the board.' : 'Tick every box above to continue.'}
			</p>
			<button type="button" class="primary" disabled={!allChecked} onclick={onConfirm}>
				Confirm &amp; enter the board
			</button>
		</div>
	</div>
</div>

<style>
	.backdrop {
		position: fixed;
		inset: 0;
		background: rgba(0, 0, 0, 0.82);
		z-index: 200;
		display: flex;
		align-items: center;
		justify-content: center;
		padding: 2rem 1rem;
		overflow-y: auto;
		backdrop-filter: blur(2px);
		-webkit-backdrop-filter: blur(2px);
	}

	.modal {
		position: relative;
		/* margin:auto keeps it centered but still scrollable if it ever exceeds the viewport */
		margin: auto;
		width: 100%;
		max-width: 34rem;
		padding: 1.5rem;
		background: linear-gradient(180deg, rgba(58, 48, 36, 0.98), rgba(40, 32, 24, 0.98));
		border: 1px solid var(--accent);
		border-radius: var(--radius);
		box-shadow: var(--shadow-card);
		color: var(--text);
		font-family: var(--font-body);
	}

	.head {
		display: flex;
		align-items: center;
		gap: 0.75rem;
		margin-bottom: 0.85rem;
	}

	.badge {
		font-size: 1.6rem;
		line-height: 1;
		flex-shrink: 0;
	}

	.head h2 {
		margin: 0;
		font-size: 1.35rem;
		color: var(--accent);
		text-shadow: var(--ts);
	}

	.sub {
		margin: 0.15rem 0 0;
		font-size: 0.85rem;
		color: var(--muted);
	}

	.intro {
		margin: 0 0 1rem;
		font-size: 0.9rem;
		line-height: 1.45;
		color: var(--text);
	}

	.checks {
		list-style: none;
		padding: 0;
		margin: 0 0 1.25rem;
		display: flex;
		flex-direction: column;
		gap: 0.6rem;
	}

	.checks li {
		background: var(--surface-alt);
		border: 1px solid var(--border);
		border-radius: var(--radius);
	}

	.checks label {
		display: flex;
		align-items: flex-start;
		gap: 0.65rem;
		padding: 0.7rem 0.85rem;
		cursor: pointer;
		line-height: 1.4;
		font-size: 0.9rem;
	}

	/* Fully custom checkbox (appearance:none) so it inherits NONE of the global input
	   styling (padding/border/min-height). That over-constrained native box re-resolved a
	   sub-pixel on focus/check and nudged the row's text — this keeps a fixed 1.15rem box. */
	.checks input[type='checkbox'] {
		appearance: none;
		-webkit-appearance: none;
		box-sizing: border-box;
		width: 1.15rem;
		height: 1.15rem;
		min-height: 0;
		margin: 0.08rem 0 0;
		padding: 0;
		flex: 0 0 auto;
		display: grid;
		place-content: center;
		border: 1px solid var(--border-strong);
		border-radius: 4px;
		background: var(--surface);
		cursor: pointer;
		transition: border-color 0.12s, background 0.12s;
	}

	.checks input[type='checkbox']::before {
		content: '';
		width: 0.62rem;
		height: 0.62rem;
		transform: scale(0);
		transition: transform 0.1s ease;
		background: var(--accent);
		clip-path: polygon(14% 44%, 0 65%, 50% 100%, 100% 16%, 80% 0%, 43% 62%);
	}

	.checks input[type='checkbox']:checked {
		border-color: var(--accent);
	}

	.checks input[type='checkbox']:checked::before {
		transform: scale(1);
	}

	.checks input[type='checkbox']:focus-visible {
		outline: none;
		box-shadow: 0 0 0 3px rgba(255, 152, 31, 0.3);
	}

	.checks li:has(input:checked) {
		border-color: var(--success);
		background: var(--success-bg);
	}

	.code {
		font-family: var(--font-heading);
		letter-spacing: 1px;
		color: var(--yellow);
		background: rgba(255, 152, 31, 0.16);
		border: 1px solid var(--accent);
		padding: 0.02rem 0.4rem;
		border-radius: 3px;
	}

	.checks a {
		color: var(--accent);
	}

	.actions {
		display: flex;
		flex-direction: column;
		gap: 0.6rem;
	}

	/* Fixed-height hint so toggling all-checked never reflows the modal (no jiggle). */
	.hint {
		margin: 0;
		min-height: 1.1rem;
		text-align: center;
		font-size: 0.82rem;
		color: var(--muted);
	}

	.hint.ready {
		color: var(--success);
	}

	.guide-cta {
		text-align: center;
		font-size: 0.88rem;
		color: var(--accent);
		text-decoration: none;
		padding: 0.5rem;
		border: 1px dashed var(--accent);
		border-radius: var(--radius);
	}

	.guide-cta:hover {
		background: var(--accent-soft);
	}

	button.primary {
		width: 100%;
		font-family: var(--font-heading);
		border-color: var(--accent);
	}

	button.primary:hover:not(:disabled) {
		background: var(--accent-soft);
	}

	button.primary:disabled {
		opacity: 0.55;
		cursor: not-allowed;
	}
</style>

<svelte:head>
	<title>Admin Guides · Volition Admin</title>
</svelte:head>

<section>
	<a href="/admin" class="back">← Admin</a>

	<h1>Admin Guides</h1>
	<p class="muted">Documentation and guides for managing the Volition Discord bot</p>

	<div class="guides-grid">
		<a href="/admin/guides/tile-event" class="card guide-card">
			<div class="guide-card-text">
				<h2 class="guide-card-title">Tile Event Admin Guide</h2>
				<p class="guide-card-desc">
					Complete guide for managing the tile event: opening/closing, admin commands,
					troubleshooting
				</p>
			</div>
			<span class="guide-arrow">→</span>
		</a>

		<a href="/admin/guides/join-process" class="card guide-card">
			<div class="guide-card-text">
				<h2 class="guide-card-title">Join Process Guide</h2>
				<p class="guide-card-desc">
					How new members join and get verified: tickets, verification, and introduction flow
				</p>
			</div>
			<span class="guide-arrow">→</span>
		</a>

		<a href="/admin/guides/bot-commands" class="card guide-card">
			<div class="guide-card-text">
				<h2 class="guide-card-title">Bot Commands Reference</h2>
				<p class="guide-card-desc">
					Complete reference for all 41 bot commands: admin, verification, tile event, and more
				</p>
			</div>
			<span class="guide-arrow">→</span>
		</a>
	</div>
</section>

<style>
	.muted {
		color: var(--muted);
	}

	.back {
		display: inline-block;
		margin-bottom: 1rem;
		color: var(--muted);
		text-decoration: none;
		font-size: 0.9rem;
	}

	.back:hover {
		color: var(--accent);
	}

	h1 {
		margin: 0 0 0.25rem;
		font-size: 1.8rem;
		color: var(--accent);
		text-shadow: var(--ts);
	}

	.guides-grid {
		display: grid;
		grid-template-columns: 1fr;
		gap: 1rem;
		margin-top: 1.5rem;
	}

	@media (min-width: 768px) {
		.guides-grid {
			grid-template-columns: repeat(2, 1fr);
		}
	}

	.card {
		padding: 1.25rem;
		background: linear-gradient(180deg, rgba(58, 48, 36, 0.85), rgba(40, 32, 24, 0.85));
		border: 1px solid var(--border);
		border-radius: var(--radius);
		box-shadow: var(--shadow-card);
	}

	.guide-card {
		display: flex;
		align-items: flex-start;
		gap: 1rem;
		text-decoration: none;
		color: var(--text);
		transition:
			transform 0.15s ease,
			border-color 0.15s ease;
	}

	.guide-card:hover {
		transform: translateY(-2px);
		border-color: var(--accent);
	}

	.guide-card-text {
		flex: 1;
		min-width: 0;
	}

	.guide-card-title {
		margin: 0 0 0.3rem;
		font-size: 1.1rem;
		color: var(--accent);
		text-shadow: var(--ts);
	}

	.guide-card-desc {
		margin: 0;
		font-size: 0.9rem;
		color: var(--muted);
		line-height: 1.4;
	}

	.guide-arrow {
		flex-shrink: 0;
		color: var(--accent);
		font-size: 1.2rem;
	}
</style>

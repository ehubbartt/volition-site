<svelte:head>
	<title>Tile Event Admin Guide · Volition Admin</title>
</svelte:head>

<section>
	<div class="topnav">
		<a href="/admin/guides" class="back">← Back to guides</a>
		<a href="/admin" class="back">← Admin</a>
	</div>

	<h1>Tile Event Admin Guide</h1>
	<p class="muted">Complete guide for managing the tile event from start to finish</p>

	<!-- Table of Contents -->
	<div class="card">
		<h2>Table of Contents</h2>
		<ul class="toc-list">
			<li><a href="#quick-start">Quick Start Checklist</a></li>
			<li><a href="#opening-closing">Opening &amp; Closing the Event</a></li>
			<li><a href="#admin-commands">Admin Commands Reference</a></li>
			<li><a href="#managing-teams">Managing Teams</a></li>
			<li><a href="#board-management">Board Management</a></li>
			<li><a href="#troubleshooting">Troubleshooting</a></li>
			<li><a href="#database-tables">Database Tables</a></li>
		</ul>
	</div>

	<!-- Quick Start -->
	<section id="quick-start" class="card">
		<div class="section-header">
			<h2>✅ Quick Start Checklist</h2>
		</div>

		<div class="checklist">
			<div class="checklist-item">
				<span class="step-number">1</span>
				<div>
					<strong>Initialize the Board</strong>
					<p class="muted sm">
						Go to the channel where you want the board displayed and run <code>/initboard</code>
					</p>
				</div>
			</div>
			<div class="checklist-item">
				<span class="step-number">2</span>
				<div>
					<strong>Verify Teams Exist</strong>
					<p class="muted sm">
						Check the <code>tile_event_teams</code> table in the database to ensure teams are set up
					</p>
				</div>
			</div>
			<div class="checklist-item">
				<span class="step-number">3</span>
				<div>
					<strong>Open the Event</strong>
					<p class="muted sm">
						Run <code>/admintile open</code> to allow players to use commands
					</p>
				</div>
			</div>
			<div class="checklist-item">
				<span class="step-number">4</span>
				<div>
					<strong>Announce to Players</strong>
					<p class="muted sm">
						The bot will automatically send an announcement in the event channel
					</p>
				</div>
			</div>
		</div>
	</section>

	<!-- Opening & Closing -->
	<section id="opening-closing" class="card">
		<div class="section-header">
			<h2>▶ Opening &amp; Closing the Event</h2>
		</div>

		<div class="command-grid">
			<div class="command-card open">
				<div class="command-header">
					<code>/admintile open</code>
				</div>
				<p class="sm dim">Opens the tile event for all players.</p>
				<div class="command-details">
					<strong>What happens:</strong>
					<ul>
						<li>Sets <code>is_event_active</code> to <code>true</code> in the database</li>
						<li>Players can now use <code>/roll</code>, <code>/submit</code>, <code>/reroll</code>, etc.</li>
						<li>Sends an announcement in the event channel</li>
					</ul>
				</div>
			</div>

			<div class="command-card close">
				<div class="command-header">
					<code>/admintile close</code>
				</div>
				<p class="sm dim">Closes the tile event, blocking all player commands.</p>
				<div class="command-details">
					<strong>What happens:</strong>
					<ul>
						<li>Sets <code>is_event_active</code> to <code>false</code> in the database</li>
						<li>All player commands return "event is closed" message</li>
						<li>Sends a closure announcement in the event channel</li>
					</ul>
				</div>
			</div>

			<div class="command-card status">
				<div class="command-header">
					<code>/admintile status</code>
				</div>
				<p class="sm dim">Check current event status without making changes.</p>
				<div class="command-details">
					<strong>Shows:</strong>
					<ul>
						<li>Whether event is OPEN or CLOSED</li>
						<li>Event channel configuration</li>
						<li>Board channel configuration</li>
						<li>Whether auto-updates are enabled</li>
					</ul>
				</div>
			</div>
		</div>

		<div class="alert alert-warning">
			<div>
				<strong>Important:</strong> When you close the event, teams' progress is NOT lost. You can close/open
				the event as needed for breaks, maintenance, etc.
			</div>
		</div>
	</section>

	<!-- Admin Commands Reference -->
	<section id="admin-commands" class="card">
		<div class="section-header">
			<h2>⚙ Admin Commands Reference</h2>
		</div>

		<p class="muted">
			All admin commands require the Admin role. These commands work even when the event is closed.
		</p>

		<div class="command-table">
			<div class="command-row">
				<div class="command-name">
					<code>/admintile roll</code>
				</div>
				<div class="command-desc">
					<p><strong>Roll for another team</strong></p>
					<p class="muted sm">
						Manually trigger a roll for any team. Useful if a team leader is unavailable.
					</p>
					<div class="params">
						<span class="param"><code>team</code> - Team name (autocomplete)</span>
					</div>
				</div>
			</div>

			<div class="command-row">
				<div class="command-name">
					<code>/admintile submit</code>
				</div>
				<div class="command-desc">
					<p><strong>Submit a drop for another team</strong></p>
					<p class="muted sm">
						Credit a team with items without requiring proof. Great for fixing missed submissions.
					</p>
					<div class="params">
						<span class="param"><code>team</code> - Team name (autocomplete)</span>
						<span class="param"><code>item</code> - Item name (autocomplete based on tile)</span>
						<span class="param"><code>quantity</code> - Number obtained</span>
						<span class="param"><code>proof</code> - Optional proof link</span>
					</div>
				</div>
			</div>

			<div class="command-row">
				<div class="command-name">
					<code>/admintile move</code>
				</div>
				<div class="command-desc">
					<p><strong>Move a team to a specific tile</strong></p>
					<p class="muted sm">
						Directly set a team's position. Use for corrections or special circumstances.
					</p>
					<div class="params">
						<span class="param"><code>team</code> - Team name (autocomplete)</span>
						<span class="param"><code>tile</code> - Target tile number (0-40)</span>
						<span class="param"><code>initialize_progress</code> - Create progress entries (default: true)</span>
					</div>
				</div>
			</div>

			<div class="command-row">
				<div class="command-name">
					<code>/admintile setprogress</code>
				</div>
				<div class="command-desc">
					<p><strong>Override progress for a specific item</strong></p>
					<p class="muted sm">
						Directly set the quantity for any item on a team's current tile.
					</p>
					<div class="params">
						<span class="param"><code>team</code> - Team name (autocomplete)</span>
						<span class="param"><code>item</code> - Item name (autocomplete)</span>
						<span class="param"><code>quantity</code> - New quantity value</span>
					</div>
				</div>
			</div>

			<div class="command-row">
				<div class="command-name">
					<code>/admintile refresh</code>
				</div>
				<div class="command-desc">
					<p><strong>Force refresh the tile board</strong></p>
					<p class="muted sm">
						Regenerates and updates the board image. Use if the board gets out of sync.
					</p>
					<div class="params">
						<span class="param">No parameters</span>
					</div>
				</div>
			</div>
		</div>
	</section>

	<!-- Managing Teams -->
	<section id="managing-teams" class="card">
		<div class="section-header">
			<h2>👥 Managing Teams</h2>
		</div>

		<h3>Creating Teams</h3>
		<p class="muted">Teams are created via the database. Each team needs:</p>
		<ul class="info-list">
			<li><code>team_name</code> - Display name for the team</li>
			<li><code>leader_id</code> - Discord user ID of the team leader</li>
			<li><code>current_tile</code> - Starting tile (usually 0 or 1)</li>
			<li><code>sabotage_tokens</code> - Number of sabotage tokens (default 0)</li>
		</ul>

		<h3 class="mt">Adding Team Members</h3>
		<p class="muted">Team members are stored in the <code>tile_event_team_members</code> table:</p>
		<ul class="info-list">
			<li><code>team_id</code> - References the team</li>
			<li><code>discord_id</code> - Member's Discord user ID</li>
		</ul>

		<div class="alert alert-info">
			<div>
				<strong>Tip:</strong> You can manage teams directly from the
				<a href="/tables/tile_event_teams" class="link">Table Editor</a> in this dashboard.
			</div>
		</div>

		<h3 class="mt">Common Team Operations</h3>
		<div class="operation-grid">
			<div class="operation-card">
				<h4>Reset a Team's Tile</h4>
				<p class="muted sm">Use <code>/admintile move [team] [tile]</code> to move them back</p>
			</div>
			<div class="operation-card">
				<h4>Fix Wrong Progress</h4>
				<p class="muted sm">Use <code>/admintile setprogress [team] [item] [quantity]</code></p>
			</div>
			<div class="operation-card">
				<h4>Award Sabotage Token</h4>
				<p class="muted sm">Edit <code>sabotage_tokens</code> in the database directly</p>
			</div>
			<div class="operation-card">
				<h4>Change Team Leader</h4>
				<p class="muted sm">Update <code>leader_id</code> in <code>tile_event_teams</code> table</p>
			</div>
		</div>
	</section>

	<!-- Board Management -->
	<section id="board-management" class="card">
		<div class="section-header">
			<h2>🔄 Board Management</h2>
		</div>

		<h3>Initial Setup</h3>
		<div class="code-block">
			<code>/initboard</code>
		</div>
		<p class="muted">Run this command in the channel where you want the board displayed. It will:</p>
		<ul class="info-list">
			<li>Generate the board image with current team positions</li>
			<li>Post it as a message in the channel</li>
			<li>Save the channel and message IDs to config</li>
			<li>Enable automatic updates on roll/reroll commands</li>
		</ul>

		<h3 class="mt">Manual Updates</h3>
		<p class="muted">The board updates automatically when teams roll. If it gets out of sync:</p>
		<div class="code-block">
			<code>/admintile refresh</code>
		</div>
		<p class="muted">or</p>
		<div class="code-block">
			<code>/updateboard</code>
		</div>

		<h3 class="mt">Recreating the Board</h3>
		<p class="muted">If the board message is deleted or you need to move it:</p>
		<ol class="numbered-list">
			<li>Go to the new channel</li>
			<li>Run <code>/initboard</code> again</li>
			<li>The config will update automatically</li>
		</ol>
	</section>

	<!-- Troubleshooting -->
	<section id="troubleshooting" class="card">
		<div class="section-header">
			<h2>⚠ Troubleshooting</h2>
		</div>

		<div class="trouble-item">
			<div class="trouble-header">
				<strong>❌ "The tile event is currently closed"</strong>
			</div>
			<p class="muted">
				The event needs to be opened. Run <code>/admintile open</code> to enable player commands.
			</p>
		</div>

		<div class="trouble-item">
			<div class="trouble-header">
				<strong>❌ Board not updating after rolls</strong>
			</div>
			<p class="muted">
				Check that <code>boardConfig.json</code> has the correct <code>boardChannelId</code> and
				<code>boardMessageId</code>. Try <code>/admintile refresh</code> to force an update.
			</p>
		</div>

		<div class="trouble-item">
			<div class="trouble-header">
				<strong>❌ Team can't roll (tile not complete)</strong>
			</div>
			<p class="muted">
				The team hasn't completed their current tile requirements. Check their progress with
				<code>/checkprogress</code> or use <code>/admintile submit</code> to credit missing items.
			</p>
		</div>

		<div class="trouble-item">
			<div class="trouble-header">
				<strong>❌ Progress not showing correctly</strong>
			</div>
			<p class="muted">
				Progress might not be initialized. Use <code>/admintile move [team] [current_tile]</code> with
				<code>initialize_progress: true</code> to reset progress tracking.
			</p>
		</div>

		<div class="trouble-item">
			<div class="trouble-header">
				<strong>❌ "Team already started different option"</strong>
			</div>
			<p class="muted">
				Teams can only work on one option per tile. If they need to switch, you'll need to manually
				clear their progress in the database (<code>tile_event_team_progress</code> table) and
				reinitialize.
			</p>
		</div>

		<div class="trouble-item">
			<div class="trouble-header">
				<strong>❌ Commands only work in specific channel</strong>
			</div>
			<p class="muted">
				Player commands are restricted to <code>tileEventChannelId</code> in
				<code>boardConfig.json</code>. Admin commands work anywhere.
			</p>
		</div>
	</section>

	<!-- Database Tables -->
	<section id="database-tables" class="card">
		<div class="section-header">
			<h2>⚙ Database Tables Reference</h2>
		</div>

		<p class="muted">
			Quick reference for the tile event database tables. Access them via the
			<a href="/tables" class="link">Table Editor</a>.
		</p>

		<div class="table-ref">
			<h4>tile_event_teams</h4>
			<p class="muted sm">Main team data</p>
			<div class="table-fields">
				<span><code>id</code> - Team ID</span>
				<span><code>team_name</code> - Display name</span>
				<span><code>leader_id</code> - Discord ID of leader</span>
				<span><code>current_tile</code> - Current position (0-40)</span>
				<span><code>sabotage_tokens</code> - Available tokens</span>
				<span><code>total_rolls</code> - Number of rolls made</span>
			</div>
		</div>

		<div class="table-ref">
			<h4>tile_event_team_members</h4>
			<p class="muted sm">Team membership</p>
			<div class="table-fields">
				<span><code>team_id</code> - References team</span>
				<span><code>discord_id</code> - Member's Discord ID</span>
			</div>
		</div>

		<div class="table-ref">
			<h4>tile_event_team_progress</h4>
			<p class="muted sm">Item progress per tile</p>
			<div class="table-fields">
				<span><code>team_id</code> - Team reference</span>
				<span><code>tile_number</code> - Which tile</span>
				<span><code>option_id</code> - Which requirement option</span>
				<span><code>item_name</code> - Item being tracked</span>
				<span><code>required_quantity</code> - Amount needed</span>
				<span><code>current_quantity</code> - Amount obtained</span>
				<span><code>is_completed</code> - Item done?</span>
			</div>
		</div>

		<div class="table-ref">
			<h4>tile_event_roll_log</h4>
			<p class="muted sm">History of all rolls</p>
			<div class="table-fields">
				<span><code>team_id</code> - Team that rolled</span>
				<span><code>from_tile</code> - Starting position</span>
				<span><code>roll_value</code> - Dice result</span>
				<span><code>to_tile</code> - Ending position</span>
				<span><code>was_capped</code> - Stopped by keystone?</span>
				<span><code>rolled_by</code> - Discord ID of roller</span>
			</div>
		</div>

		<div class="table-ref">
			<h4>tile_event_tiles</h4>
			<p class="muted sm">Tile requirements configuration</p>
			<div class="table-fields">
				<span><code>tile_number</code> - Tile ID (1-40)</span>
				<span><code>requirement_json</code> - JSON array of options</span>
				<span><code>rules</code> - Special rules text</span>
				<span><code>is_raid_tile</code> - Awards sabotage token?</span>
			</div>
		</div>

		<div class="table-ref">
			<h4>tile_event_config</h4>
			<p class="muted sm">Event configuration</p>
			<div class="table-fields">
				<span><code>key</code> - Config key name</span>
				<span><code>value</code> - Config value</span>
				<span class="highlight"><code>is_event_active</code> - Controls open/closed state</span>
			</div>
		</div>
	</section>
</section>

<style>
	.topnav {
		display: flex;
		gap: 1.25rem;
		margin-bottom: 1rem;
	}

	.back {
		color: var(--muted);
		text-decoration: none;
		font-size: 0.9rem;
	}

	.back:hover {
		color: var(--accent);
	}

	.muted {
		color: var(--muted);
	}

	.sm {
		font-size: 0.85rem;
	}

	.dim {
		color: rgba(255, 255, 255, 0.7);
	}

	h1 {
		margin: 0 0 0.25rem;
		font-size: 1.8rem;
		color: var(--accent);
		text-shadow: var(--ts);
	}

	.card {
		padding: 1.25rem;
		background: linear-gradient(180deg, rgba(58, 48, 36, 0.85), rgba(40, 32, 24, 0.85));
		border: 1px solid var(--border);
		border-radius: var(--radius);
		box-shadow: var(--shadow-card);
		margin-top: 1.25rem;
	}

	.card h2 {
		margin: 0;
		font-size: 1.1rem;
		color: var(--accent);
		text-shadow: var(--ts);
	}

	h3 {
		margin: 0 0 0.6rem;
		font-size: 1rem;
		color: var(--text);
		text-shadow: var(--ts);
	}

	h3.mt {
		margin-top: 1.5rem;
	}

	h4 {
		margin: 0 0 0.4rem;
		font-size: 0.9rem;
		color: var(--text);
	}

	.toc-list {
		list-style: none;
		padding: 0;
		margin: 0.6rem 0 0;
	}

	.toc-list li {
		margin-bottom: 0.4rem;
	}

	.toc-list a {
		color: var(--accent);
		text-decoration: none;
	}

	.toc-list a:hover {
		text-decoration: underline;
	}

	.section-header {
		margin-bottom: 1.25rem;
		padding-bottom: 0.9rem;
		border-bottom: 1px solid var(--border);
	}

	.checklist {
		display: flex;
		flex-direction: column;
		gap: 0.75rem;
	}

	.checklist-item {
		display: flex;
		align-items: flex-start;
		gap: 1rem;
		padding: 0.9rem;
		background: var(--surface-alt);
		border: 1px solid var(--border);
		border-radius: var(--radius);
	}

	.step-number {
		display: flex;
		align-items: center;
		justify-content: center;
		width: 30px;
		height: 30px;
		background: var(--accent);
		color: #000;
		border-radius: 50%;
		font-family: var(--font-heading);
		flex-shrink: 0;
	}

	.command-grid {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
		gap: 0.9rem;
	}

	.command-card {
		padding: 0.9rem;
		background: var(--surface-alt);
		border: 1px solid var(--border);
		border-radius: var(--radius);
	}

	.command-card.open {
		border-left: 3px solid var(--success);
	}

	.command-card.close {
		border-left: 3px solid var(--danger);
	}

	.command-card.status {
		border-left: 3px solid var(--accent);
	}

	.command-header {
		margin-bottom: 0.6rem;
	}

	.command-header code {
		font-size: 0.95rem;
	}

	.command-details ul {
		margin: 0.5rem 0 0;
		padding-left: 1.25rem;
		font-size: 0.85rem;
		color: var(--muted);
	}

	.command-details li {
		margin-bottom: 0.25rem;
	}

	.command-table {
		display: flex;
		flex-direction: column;
		gap: 0.9rem;
		margin-top: 1rem;
	}

	.command-row {
		display: grid;
		grid-template-columns: 200px 1fr;
		gap: 1rem;
		padding: 0.9rem;
		background: var(--surface-alt);
		border: 1px solid var(--border);
		border-radius: var(--radius);
	}

	@media (max-width: 640px) {
		.command-row {
			grid-template-columns: 1fr;
		}
	}

	.command-desc p {
		margin: 0 0 0.3rem;
	}

	.command-desc .params {
		margin-top: 0.6rem;
		display: flex;
		flex-wrap: wrap;
		gap: 0.5rem;
	}

	.param {
		font-size: 0.75rem;
		padding: 0.25rem 0.5rem;
		background: var(--surface);
		border: 1px solid var(--border);
		border-radius: var(--radius);
		color: rgba(255, 255, 255, 0.7);
	}

	code {
		background: var(--surface);
		border: 1px solid var(--border);
		padding: 0.1rem 0.35rem;
		border-radius: var(--radius);
		font-family: ui-monospace, 'SFMono-Regular', Menlo, monospace;
		font-size: 0.85em;
	}

	.info-list {
		list-style: none;
		padding: 0;
		margin: 0;
	}

	.info-list li {
		padding: 0.4rem 0 0.4rem 1.5rem;
		position: relative;
	}

	.info-list li::before {
		content: '•';
		position: absolute;
		left: 0;
		color: var(--accent);
	}

	.numbered-list {
		padding-left: 1.5rem;
		margin: 0;
		color: rgba(255, 255, 255, 0.8);
	}

	.numbered-list li {
		margin-bottom: 0.4rem;
	}

	.operation-grid {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
		gap: 0.9rem;
		margin-top: 1rem;
	}

	.operation-card {
		padding: 0.9rem;
		background: var(--surface-alt);
		border: 1px solid var(--border);
		border-radius: var(--radius);
	}

	.code-block {
		background: var(--surface-alt);
		border: 1px solid var(--border);
		padding: 0.9rem;
		border-radius: var(--radius);
		margin: 0.7rem 0;
	}

	.code-block code {
		background: none;
		border: none;
		padding: 0;
		font-size: 0.95rem;
		color: var(--success);
	}

	.trouble-item {
		padding: 0.9rem;
		background: var(--surface-alt);
		border: 1px solid var(--border);
		border-radius: var(--radius);
		margin-bottom: 0.9rem;
	}

	.trouble-header {
		margin-bottom: 0.4rem;
	}

	.table-ref {
		padding: 0.9rem;
		background: var(--surface-alt);
		border: 1px solid var(--border);
		border-radius: var(--radius);
		margin-bottom: 0.9rem;
	}

	.table-fields {
		display: flex;
		flex-wrap: wrap;
		gap: 0.5rem;
		margin-top: 0.5rem;
	}

	.table-fields span {
		font-size: 0.75rem;
		padding: 0.25rem 0.5rem;
		background: var(--surface);
		border: 1px solid var(--border);
		border-radius: var(--radius);
		color: rgba(255, 255, 255, 0.7);
	}

	.table-fields span.highlight {
		background: var(--accent-soft);
		border: 1px solid var(--accent);
	}

	.link {
		color: var(--accent);
		text-decoration: none;
	}

	.link:hover {
		text-decoration: underline;
	}

	.alert {
		display: flex;
		align-items: flex-start;
		gap: 0.75rem;
		padding: 0.9rem;
		border-radius: var(--radius);
		margin-top: 1.25rem;
	}

	.alert-warning {
		background: var(--accent-soft);
		border: 1px solid var(--accent);
	}

	.alert-info {
		background: var(--accent-soft);
		border: 1px solid var(--border-strong);
		margin: 1.25rem 0;
	}
</style>

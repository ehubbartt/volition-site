<svelte:head>
	<title>Join Process Admin Guide · Volition Admin</title>
</svelte:head>

<section>
	<div class="topnav">
		<a href="/admin/guides" class="back">← Back to guides</a>
		<a href="/admin" class="back">← Admin</a>
	</div>

	<h1>Join Process Admin Guide</h1>
	<p class="muted">Complete guide for managing new member verification and onboarding</p>

	<!-- Table of Contents -->
	<div class="card">
		<h2>Table of Contents</h2>
		<ul class="toc-list">
			<li><a href="#overview">Process Overview</a></li>
			<li><a href="#auto-ticket">Automatic Ticket Creation</a></li>
			<li><a href="#verification-flow">Verification Flow</a></li>
			<li><a href="#guest-flow">Guest Verification Flow</a></li>
			<li><a href="#admin-actions">Admin Actions &amp; Controls</a></li>
			<li><a href="#force-verify">Force Verification</a></li>
			<li><a href="#ticket-management">Ticket Management</a></li>
			<li><a href="#introduction-system">Introduction System</a></li>
			<li><a href="#troubleshooting">Troubleshooting</a></li>
		</ul>
	</div>

	<!-- Overview -->
	<section id="overview" class="card">
		<div class="section-header">
			<h2>👤 Process Overview</h2>
		</div>

		<p class="dim">
			When a new user joins the Volition Discord server, an automated process begins to verify their
			identity and onboard them properly.
		</p>

		<div class="flow-diagram">
			<div class="flow-step">
				<div class="flow-content">
					<strong>User Joins</strong>
					<p class="muted sm">Receives Unverified role automatically</p>
				</div>
			</div>
			<div class="flow-arrow">→</div>
			<div class="flow-step">
				<div class="flow-content">
					<strong>Ticket Created</strong>
					<p class="muted sm">Personal join channel with verification buttons</p>
				</div>
			</div>
			<div class="flow-arrow">→</div>
			<div class="flow-step">
				<div class="flow-content">
					<strong>Verified</strong>
					<p class="muted sm">Gets verified role, fills intro, joins clan</p>
				</div>
			</div>
		</div>

		<div class="requirements-box">
			<h3>Verification Requirements</h3>
			<p class="dim">Users must meet ONE of the following to auto-verify:</p>
			<div class="req-grid">
				<div class="req-item">
					<strong class="good">1750+ Total Level</strong>
					<p class="muted sm">Minimum total skill level</p>
				</div>
				<div class="req-or">OR</div>
				<div class="req-item">
					<strong class="good">50+ EHB</strong>
					<p class="muted sm">Efficient Hours Bossing</p>
				</div>
			</div>
			<p class="muted sm mt">Stats are pulled from Wise Old Man API using the RSN provided.</p>
		</div>
	</section>

	<!-- Auto Ticket Creation -->
	<section id="auto-ticket" class="card">
		<div class="section-header">
			<h2>💬 Automatic Ticket Creation</h2>
		</div>

		<p class="dim">When a user joins, a personal ticket channel is automatically created.</p>

		<h3 class="mt">Channel Details</h3>
		<div class="info-grid">
			<div class="info-item">
				<strong>Name Format</strong>
				<code>join-{'{'}displayName{'}'}</code>
			</div>
			<div class="info-item">
				<strong>Category</strong>
				<code>TICKET_JOIN_CATEGORY_ID</code>
			</div>
			<div class="info-item">
				<strong>Visibility</strong>
				<span>User + Admins only</span>
			</div>
		</div>

		<h3 class="mt">Ticket Status Indicators</h3>
		<div class="status-grid">
			<div class="status-item">
				<span class="status-emoji">🔸</span>
				<div>
					<strong>Unverified</strong>
					<p class="muted sm">User hasn't completed verification yet</p>
				</div>
			</div>
			<div class="status-item">
				<span class="status-emoji">✅</span>
				<div>
					<strong>Verified</strong>
					<p class="muted sm">User has been verified successfully</p>
				</div>
			</div>
			<div class="status-item">
				<span class="status-emoji">🔲</span>
				<div>
					<strong>Unclaimed</strong>
					<p class="muted sm">No admin has claimed this ticket</p>
				</div>
			</div>
		</div>

		<h3 class="mt">Admin Control Panel</h3>
		<p class="muted">Each ticket includes an admin control panel with buttons:</p>
		<div class="button-grid">
			<div class="button-item">
				<strong>Claim Ticket</strong>
				<p class="muted sm">Assign yourself to help this user</p>
			</div>
			<div class="button-item">
				<strong>Close Ticket</strong>
				<p class="muted sm">Close and optionally archive the ticket</p>
			</div>
			<div class="button-item">
				<strong>Soft Close</strong>
				<p class="muted sm">24-hour inactivity timeout</p>
			</div>
		</div>
	</section>

	<!-- Verification Flow -->
	<section id="verification-flow" class="card">
		<div class="section-header">
			<h2>✅ Verification Flow</h2>
		</div>

		<p class="dim">When users click "Verify My Account" in their ticket:</p>

		<div class="step-list">
			<div class="step-item">
				<span class="step-number">1</span>
				<div>
					<strong>Enter RSN</strong>
					<p class="muted sm">A modal opens asking for their RuneScape username</p>
				</div>
			</div>
			<div class="step-item">
				<span class="step-number">2</span>
				<div>
					<strong>Wise Old Man Lookup</strong>
					<p class="muted sm">Bot checks their stats via WOM API (total level, EHB, rank)</p>
				</div>
			</div>
			<div class="step-item">
				<span class="step-number">3</span>
				<div>
					<strong>Requirements Check</strong>
					<p class="muted sm">Verifies 1750+ total OR 50+ EHB requirement</p>
				</div>
			</div>
		</div>

		<div class="outcome-grid">
			<div class="outcome-card success">
				<div class="outcome-header">
					<strong>✅ If Requirements Met</strong>
				</div>
				<ul>
					<li>Verified role added</li>
					<li>Unverified role removed</li>
					<li>Nickname updated to RSN</li>
					<li>Discord ID linked to WOM ID in database</li>
					<li>Ticket emoji changes: 🔸 → ✅</li>
					<li>"Fill Out Introduction" button appears</li>
					<li>Admin notification sent</li>
				</ul>
			</div>
			<div class="outcome-card warning">
				<div class="outcome-header">
					<strong>❌ If Requirements NOT Met</strong>
				</div>
				<ul>
					<li>Orange "Does Not Meet Requirements" embed shown</li>
					<li>Admins pinged for manual review</li>
					<li>"Force Verify (Admin Only)" button appears</li>
					<li>User can still be manually verified</li>
				</ul>
			</div>
		</div>
	</section>

	<!-- Guest Flow -->
	<section id="guest-flow" class="card">
		<div class="section-header">
			<h2>👥 Guest Verification Flow</h2>
		</div>

		<p class="dim">
			When users click "Join as Guest" - for people with connections to clan members:
		</p>

		<div class="guest-flow">
			<div class="guest-step">
				<h4>Question: Do you know someone in the clan?</h4>
				<div class="guest-options">
					<div class="guest-option yes">
						<strong>YES</strong>
						<div class="guest-substeps">
							<div class="substep">
								<span>1.</span>
								<p>User enters RSN of their friend/main account</p>
							</div>
							<div class="substep">
								<span>2.</span>
								<p>Bot checks if that RSN is in Volition clan via WOM</p>
							</div>
							<div class="substep success">
								<span>✅</span>
								<p><strong>Found:</strong> Auto-verified as guest, gets verified role</p>
							</div>
							<div class="substep warning">
								<span>⚠</span>
								<p><strong>Not Found:</strong> Request sent to admins for manual review</p>
							</div>
						</div>
					</div>
					<div class="guest-option no">
						<strong>NO</strong>
						<p class="muted">Request submitted to admins for manual review</p>
					</div>
				</div>
			</div>
		</div>

		<div class="alert alert-info">
			<div>
				<strong>Note:</strong> Guest verification does NOT require stats requirements. It's based on
				connections to existing clan members.
			</div>
		</div>
	</section>

	<!-- Admin Actions -->
	<section id="admin-actions" class="card">
		<div class="section-header">
			<h2>🛡 Admin Actions &amp; Controls</h2>
		</div>

		<div class="command-table">
			<div class="command-row">
				<div class="command-name">
					<code>/adminverify</code>
				</div>
				<div class="command-desc">
					<p><strong>Verify a specific user with WOM lookup</strong></p>
					<p class="muted sm">Runs the same verification check but for any user.</p>
					<div class="params">
						<span class="param"><code>user</code> - Discord @mention</span>
						<span class="param"><code>rsn</code> - RuneScape username</span>
					</div>
				</div>
			</div>

			<div class="command-row">
				<div class="command-name">
					<code>/forceverify</code>
				</div>
				<div class="command-desc">
					<p><strong>Force verify regardless of stats</strong></p>
					<p class="muted sm">Bypasses all requirements. Use for special cases.</p>
					<div class="params">
						<span class="param"><code>user</code> - Discord @mention</span>
						<span class="param"><code>guest</code> - Optional: true for guest verification</span>
					</div>
				</div>
			</div>

			<div class="command-row">
				<div class="command-name">
					<code>/createverifymessage</code>
				</div>
				<div class="command-desc">
					<p><strong>Create verification panel in any channel</strong></p>
					<p class="muted sm">Deploys the "Verify My Account" and "Join as Guest" buttons.</p>
				</div>
			</div>

			<div class="command-row">
				<div class="command-name">
					<code>/createticketmessage</code>
				</div>
				<div class="command-desc">
					<p><strong>Create ticket creation panel</strong></p>
					<p class="muted sm">Includes buttons for: Join, General Support, Shop Payout tickets.</p>
				</div>
			</div>
		</div>
	</section>

	<!-- Force Verify -->
	<section id="force-verify" class="card">
		<div class="section-header">
			<h2>✅ Force Verification</h2>
		</div>

		<p class="dim">
			Use <code>/forceverify</code> when a user can't meet normal requirements but should be allowed
			in.
		</p>

		<h3 class="mt">When to Use</h3>
		<ul class="info-list">
			<li>User is a known friend of clan members</li>
			<li>User is returning after a break (stats may not be tracked)</li>
			<li>User has a new account but is vouched for</li>
			<li>Technical issues with WOM lookup</li>
		</ul>

		<h3 class="mt">What Happens</h3>
		<div class="action-list">
			<div class="action-item">
				<span class="good">✅</span>
				<span>Removes Unverified role</span>
			</div>
			<div class="action-item">
				<span class="good">✅</span>
				<span>Adds Verified role</span>
			</div>
			<div class="action-item">
				<span class="good">✅</span>
				<span>Updates ticket channel emoji (🔸 → ✅)</span>
			</div>
			<div class="action-item">
				<span class="good">✅</span>
				<span>Marks ticket as verified in system</span>
			</div>
		</div>

		<div class="outcome-grid">
			<div class="outcome-card">
				<div class="outcome-header">
					<strong>Regular Force Verify</strong>
				</div>
				<p class="muted sm">Sends intro message with "Fill Out Introduction" button</p>
			</div>
			<div class="outcome-card">
				<div class="outcome-header">
					<strong>Guest Force Verify</strong>
				</div>
				<p class="muted sm">Sends simple welcome message (no intro required)</p>
			</div>
		</div>
	</section>

	<!-- Ticket Management -->
	<section id="ticket-management" class="card">
		<div class="section-header">
			<h2>💬 Ticket Management</h2>
		</div>

		<h3>Ticket Categories</h3>
		<div class="category-grid">
			<div class="category-item">
				<strong>Join Tickets</strong>
				<p class="muted sm">Auto-created for new members</p>
			</div>
			<div class="category-item">
				<strong>General Support</strong>
				<p class="muted sm">Manually created by users</p>
			</div>
			<div class="category-item">
				<strong>Shop Payout</strong>
				<p class="muted sm">For VP shop redemptions</p>
			</div>
		</div>

		<h3 class="mt">Ticket States</h3>
		<div class="state-flow">
			<span class="state">Unclaimed</span>
			<span class="arrow">→</span>
			<span class="state">Claimed</span>
			<span class="arrow">→</span>
			<span class="state">Verified</span>
			<span class="arrow">→</span>
			<span class="state">Closed</span>
		</div>

		<h3 class="mt">Closing Tickets</h3>
		<p class="muted">Use <code>/close</code> or the Close Ticket button. Admin options:</p>
		<div class="close-options">
			<div class="close-option">
				<strong>Delete Ticket</strong>
				<p class="muted sm">Permanently removes the channel</p>
			</div>
			<div class="close-option">
				<strong>Transcript</strong>
				<p class="muted sm">Archives all messages before deletion</p>
			</div>
		</div>

		<h3 class="mt">Soft Close</h3>
		<p class="muted">
			24-hour inactivity timeout. If no response within 24 hours, admins are notified and the ticket
			can be closed.
		</p>
	</section>

	<!-- Introduction System -->
	<section id="introduction-system" class="card">
		<div class="section-header">
			<h2>❓ Introduction System</h2>
		</div>

		<p class="dim">After verification, users are prompted to fill out an introduction.</p>

		<h3 class="mt">Introduction Fields</h3>
		<div class="intro-fields">
			<div class="intro-field">
				<strong>1. Basic Info</strong>
				<p class="muted sm">RSN, Account Type, Age</p>
			</div>
			<div class="intro-field">
				<strong>2. Stats &amp; Location</strong>
				<p class="muted sm">Total Level, Timezone</p>
			</div>
			<div class="intro-field">
				<strong>3. Previous Clan History</strong>
				<p class="muted sm">Optional - past clan experience</p>
			</div>
			<div class="intro-field">
				<strong>4. Favorite Content &amp; Goals</strong>
				<p class="muted sm">What they enjoy and want to achieve</p>
			</div>
			<div class="intro-field">
				<strong>5. What Looking For</strong>
				<p class="muted sm">Additional info about why they're joining</p>
			</div>
		</div>

		<h3 class="mt">After Introduction</h3>
		<ul class="info-list">
			<li>Introduction posted to the designated intro channel/forum</li>
			<li>Admins pinged with link to the introduction</li>
			<li>"How to Join" embed sent with clan chat instructions</li>
		</ul>
	</section>

	<!-- Troubleshooting -->
	<section id="troubleshooting" class="card">
		<div class="section-header">
			<h2>⚠ Troubleshooting</h2>
		</div>

		<div class="trouble-item">
			<div class="trouble-header">
				<strong>❌ Ticket not created on join</strong>
			</div>
			<p class="muted">
				Check that <code>autoJoinTickets</code> is enabled in config. Verify the
				<code>TICKET_JOIN_CATEGORY_ID</code> is set correctly and bot has permissions.
			</p>
		</div>

		<div class="trouble-item">
			<div class="trouble-header">
				<strong>❌ User not getting Unverified role</strong>
			</div>
			<p class="muted">
				Check <code>autoAddUnverifiedRole</code> is enabled. Verify the
				<code>unverifiedRoleID</code> in config and that bot's role is higher than Unverified role.
			</p>
		</div>

		<div class="trouble-item">
			<div class="trouble-header">
				<strong>❌ WOM lookup failing</strong>
			</div>
			<p class="muted">
				User's RSN may not be tracked on Wise Old Man. Have them search themselves on wiseoldman.net
				first to get indexed, then try again.
			</p>
		</div>

		<div class="trouble-item">
			<div class="trouble-header">
				<strong>❌ Can't change user's nickname</strong>
			</div>
			<p class="muted">
				Bot needs "Manage Nicknames" permission and its role must be higher than the user's highest
				role. Server owners can't have their nickname changed by bots.
			</p>
		</div>

		<div class="trouble-item">
			<div class="trouble-header">
				<strong>❌ Guest verification not finding clan member</strong>
			</div>
			<p class="muted">
				The RSN they entered must be an active member in Volition clan on WOM. Check spelling and
				ensure the person is actually in the clan.
			</p>
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

	.dim {
		color: rgba(255, 255, 255, 0.8);
	}

	.sm {
		font-size: 0.85rem;
	}

	.mt {
		margin-top: 1.5rem;
	}

	.good {
		color: var(--success);
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

	.flow-diagram {
		display: flex;
		align-items: center;
		justify-content: center;
		flex-wrap: wrap;
		gap: 1rem;
		padding: 1.25rem;
		background: var(--surface-alt);
		border: 1px solid var(--border);
		border-radius: var(--radius);
		margin: 1.25rem 0;
	}

	.flow-step {
		display: flex;
		align-items: center;
		gap: 0.75rem;
		padding: 0.9rem;
		background: var(--surface);
		border: 1px solid var(--border);
		border-radius: var(--radius);
		min-width: 180px;
	}

	.flow-arrow {
		color: var(--accent);
		font-size: 1.2rem;
	}

	.requirements-box {
		padding: 1.25rem;
		background: var(--surface-alt);
		border: 1px solid var(--border);
		border-left: 3px solid var(--success);
		border-radius: var(--radius);
		margin-top: 1.5rem;
	}

	.req-grid {
		display: flex;
		align-items: center;
		gap: 1rem;
		flex-wrap: wrap;
	}

	.req-item {
		padding: 0.9rem;
		background: var(--surface);
		border: 1px solid var(--border);
		border-radius: var(--radius);
		text-align: center;
		min-width: 150px;
	}

	.req-or {
		font-family: var(--font-heading);
		color: var(--muted);
	}

	.info-grid {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
		gap: 0.9rem;
	}

	.info-item {
		padding: 0.9rem;
		background: var(--surface-alt);
		border: 1px solid var(--border);
		border-radius: var(--radius);
	}

	.info-item strong {
		display: block;
		color: var(--muted);
		font-size: 0.75rem;
		text-transform: uppercase;
		margin-bottom: 0.3rem;
	}

	.status-grid {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
		gap: 0.9rem;
	}

	.status-item {
		display: flex;
		align-items: center;
		gap: 1rem;
		padding: 0.9rem;
		background: var(--surface-alt);
		border: 1px solid var(--border);
		border-radius: var(--radius);
	}

	.status-emoji {
		font-size: 1.4rem;
	}

	.button-grid {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
		gap: 0.9rem;
	}

	.button-item {
		padding: 0.9rem;
		background: var(--surface-alt);
		border: 1px solid var(--border);
		border-radius: var(--radius);
	}

	.step-list {
		display: flex;
		flex-direction: column;
		gap: 0.75rem;
		margin: 1.25rem 0;
	}

	.step-item {
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

	.outcome-grid {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
		gap: 0.9rem;
		margin-top: 1.25rem;
	}

	.outcome-card {
		padding: 0.9rem;
		background: var(--surface-alt);
		border: 1px solid var(--border);
		border-radius: var(--radius);
	}

	.outcome-card.success {
		border-left: 3px solid var(--success);
	}

	.outcome-card.warning {
		border-left: 3px solid var(--accent);
	}

	.outcome-header {
		margin-bottom: 0.6rem;
	}

	.outcome-card ul {
		margin: 0;
		padding-left: 1.25rem;
		font-size: 0.85rem;
		color: rgba(255, 255, 255, 0.8);
	}

	.outcome-card li {
		margin-bottom: 0.25rem;
	}

	.guest-flow {
		padding: 1.25rem;
		background: var(--surface-alt);
		border: 1px solid var(--border);
		border-radius: var(--radius);
	}

	.guest-options {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
		gap: 0.9rem;
		margin-top: 1rem;
	}

	.guest-option {
		padding: 0.9rem;
		background: var(--surface);
		border: 1px solid var(--border);
		border-radius: var(--radius);
	}

	.guest-option.yes {
		border-left: 3px solid var(--success);
	}

	.guest-option.no {
		border-left: 3px solid var(--danger);
	}

	.guest-substeps {
		margin-top: 0.6rem;
	}

	.substep {
		display: flex;
		align-items: flex-start;
		gap: 0.5rem;
		padding: 0.4rem 0;
		font-size: 0.85rem;
		color: rgba(255, 255, 255, 0.8);
	}

	.substep p {
		margin: 0;
	}

	.substep.success {
		color: var(--success);
	}

	.substep.warning {
		color: var(--accent);
	}

	.command-table {
		display: flex;
		flex-direction: column;
		gap: 0.9rem;
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

	.command-name code {
		font-size: 0.9rem;
	}

	.params {
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

	.action-list {
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
	}

	.action-item {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		color: rgba(255, 255, 255, 0.8);
	}

	.category-grid {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
		gap: 0.9rem;
	}

	.category-item {
		padding: 0.9rem;
		background: var(--surface-alt);
		border: 1px solid var(--border);
		border-radius: var(--radius);
	}

	.state-flow {
		display: flex;
		align-items: center;
		gap: 0.75rem;
		flex-wrap: wrap;
		padding: 0.9rem;
		background: var(--surface-alt);
		border: 1px solid var(--border);
		border-radius: var(--radius);
	}

	.state-flow .arrow {
		color: var(--accent);
	}

	.state {
		padding: 0.5rem 1rem;
		background: var(--surface);
		border: 1px solid var(--border);
		border-radius: var(--radius);
		color: rgba(255, 255, 255, 0.8);
	}

	.close-options {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
		gap: 0.9rem;
	}

	.close-option {
		padding: 0.9rem;
		background: var(--surface-alt);
		border: 1px solid var(--border);
		border-radius: var(--radius);
	}

	.intro-fields {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
		gap: 0.9rem;
	}

	.intro-field {
		padding: 0.9rem;
		background: var(--surface-alt);
		border: 1px solid var(--border);
		border-radius: var(--radius);
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

	.alert {
		display: flex;
		align-items: flex-start;
		gap: 0.75rem;
		padding: 0.9rem;
		border-radius: var(--radius);
		margin-top: 1.25rem;
	}

	.alert-info {
		background: var(--accent-soft);
		border: 1px solid var(--border-strong);
	}
</style>

<svelte:head>
	<title>Bot Commands Reference · Volition Admin</title>
</svelte:head>

<section>
	<div class="topnav">
		<a href="/admin/guides" class="back">← Back to guides</a>
		<a href="/admin" class="back">← Admin</a>
	</div>

	<h1>Bot Commands Reference</h1>
	<p class="muted">Complete list of all Discord bot commands and their usage</p>

	<!-- Table of Contents -->
	<div class="card">
		<h2>Categories</h2>
		<div class="category-nav">
			<a href="#admin" class="category-link admin">
				<span>Admin Commands</span>
				<span class="count">5</span>
			</a>
			<a href="#verification" class="category-link verify">
				<span>Verification</span>
				<span class="count">6</span>
			</a>
			<a href="#tile-event" class="category-link tile">
				<span>Tile Event</span>
				<span class="count">12</span>
			</a>
			<a href="#points" class="category-link points">
				<span>Points &amp; Rewards</span>
				<span class="count">5</span>
			</a>
			<a href="#clan" class="category-link clan">
				<span>Clan Management</span>
				<span class="count">7</span>
			</a>
			<a href="#fun" class="category-link fun">
				<span>Fun &amp; Games</span>
				<span class="count">4</span>
			</a>
		</div>
	</div>

	<!-- Permission Legend -->
	<div class="card">
		<h2>Permission Levels</h2>
		<div class="permission-legend">
			<div class="perm-item">
				<span class="perm-badge admin">Admin</span>
				<span class="muted sm">Requires Admin role</span>
			</div>
			<div class="perm-item">
				<span class="perm-badge leader">Team Leader</span>
				<span class="muted sm">Tile event team leaders only</span>
			</div>
			<div class="perm-item">
				<span class="perm-badge user">Everyone</span>
				<span class="muted sm">Available to all verified members</span>
			</div>
		</div>
	</div>

	<!-- Admin Commands -->
	<section id="admin" class="card">
		<div class="section-header">
			<h2>🛡 Admin Commands</h2>
			<span class="perm-badge admin">Admin Only</span>
		</div>

		<div class="command-list">
			<div class="command-item">
				<div class="command-header">
					<code>/updateconfig</code>
				</div>
				<p class="command-desc">Update bot configuration remotely without restarting.</p>
				<div class="command-params">
					<div class="param">
						<code>feature</code>
						<span>Feature path (e.g., <code>events.autoJoinTickets</code>)</span>
					</div>
					<div class="param">
						<code>value</code>
						<span>New value (true/false/number/string)</span>
					</div>
					<div class="param optional">
						<code>reason</code>
						<span>Reason for the change (optional)</span>
					</div>
				</div>
				<div class="command-example">
					<strong>Example:</strong>
					<code>/updateconfig feature:events.autoJoinTickets value:false reason:Maintenance</code>
				</div>
			</div>

			<div class="command-item">
				<div class="command-header">
					<code>/syncconfig</code>
				</div>
				<p class="command-desc">
					Sync local features.json to remote Supabase database. Enables remote config management.
				</p>
			</div>

			<div class="command-item">
				<div class="command-header">
					<code>/senddailywordle</code>
				</div>
				<p class="command-desc">
					Manually trigger the daily Wordle post. Fetches from database and posts to announcement
					channel.
				</p>
			</div>

			<div class="command-item">
				<div class="command-header">
					<code>/sendweeklytask</code>
				</div>
				<p class="command-desc">
					Manually trigger the weekly task post. Includes 7-day deadline and role ping.
				</p>
			</div>

			<div class="command-item">
				<div class="command-header">
					<code>/tom</code>
				</div>
				<p class="command-desc">Easter egg command. Only works for one specific user ID.</p>
			</div>
		</div>
	</section>

	<!-- Verification Commands -->
	<section id="verification" class="card">
		<div class="section-header">
			<h2>✅ Verification Commands</h2>
		</div>

		<div class="command-list">
			<div class="command-item">
				<div class="command-header">
					<code>/verify</code>
					<span class="perm-badge user">Everyone</span>
				</div>
				<p class="command-desc">
					Start the verification process. Opens a modal to enter your RSN, then checks your stats on
					Wise Old Man.
				</p>
				<div class="command-note">
					<strong>Requirements:</strong> 1750+ Total Level OR 50+ EHB
				</div>
			</div>

			<div class="command-item">
				<div class="command-header">
					<code>/adminverify</code>
					<span class="perm-badge admin">Admin</span>
				</div>
				<p class="command-desc">Verify a specific user by checking their RSN on Wise Old Man.</p>
				<div class="command-params">
					<div class="param">
						<code>user</code>
						<span>Discord @mention of user to verify</span>
					</div>
					<div class="param">
						<code>rsn</code>
						<span>Their RuneScape username</span>
					</div>
				</div>
			</div>

			<div class="command-item">
				<div class="command-header">
					<code>/forceverify</code>
					<span class="perm-badge admin">Admin</span>
				</div>
				<p class="command-desc">Force verify a user regardless of stats. Bypasses all requirements.</p>
				<div class="command-params">
					<div class="param">
						<code>user</code>
						<span>Discord @mention of user</span>
					</div>
					<div class="param optional">
						<code>guest</code>
						<span>Set to true for guest verification (no intro required)</span>
					</div>
				</div>
			</div>

			<div class="command-item">
				<div class="command-header">
					<code>/createverifymessage</code>
					<span class="perm-badge admin">Admin</span>
				</div>
				<p class="command-desc">
					Create a verification panel with "Verify My Account" and "Join as Guest" buttons in the
					current channel.
				</p>
			</div>

			<div class="command-item">
				<div class="command-header">
					<code>/createticketmessage</code>
					<span class="perm-badge admin">Admin</span>
				</div>
				<p class="command-desc">
					Create a ticket creation panel with buttons for: Join, General Support, and Shop Payout
					tickets.
				</p>
			</div>

			<div class="command-item">
				<div class="command-header">
					<code>/close</code>
					<span class="perm-badge user">Everyone</span>
				</div>
				<p class="command-desc">Request to close the current ticket. Admin approval may be required.</p>
			</div>
		</div>
	</section>

	<!-- Tile Event Commands -->
	<section id="tile-event" class="card">
		<div class="section-header">
			<h2>🎮 Tile Event Commands</h2>
		</div>

		<p class="muted">
			Commands for the tile-based clan competition. Most require the event to be open and must be used
			in the designated event channel.
		</p>

		<div class="command-list">
			<div class="command-item">
				<div class="command-header">
					<code>/roll</code>
					<span class="perm-badge leader">Team Leader</span>
				</div>
				<p class="command-desc">
					Roll the dice to advance your team to the next tile. Can only roll after completing current
					tile requirements.
				</p>
				<div class="command-note">
					<strong>Roll weights:</strong> 1 (40%), 2 (30%), 3 (20%), 4 (10%)
				</div>
			</div>

			<div class="command-item">
				<div class="command-header">
					<code>/reroll</code>
					<span class="perm-badge leader">Team Leader</span>
				</div>
				<p class="command-desc">
					Use your team's reroll token to skip the current tile entirely. One token per team per
					event.
				</p>
				<div class="command-note">
					<strong>Restrictions:</strong> Cannot use on keystone tiles (10, 20, 30, 40)
				</div>
			</div>

			<div class="command-item">
				<div class="command-header">
					<code>/submit</code>
					<span class="perm-badge user">Everyone</span>
				</div>
				<p class="command-desc">Submit a drop/item for your team's current tile requirements.</p>
				<div class="command-params">
					<div class="param">
						<code>item</code>
						<span>Item name (autocomplete based on tile)</span>
					</div>
					<div class="param">
						<code>quantity</code>
						<span>Number obtained</span>
					</div>
					<div class="param">
						<code>proof</code>
						<span>Discord message link to screenshot</span>
					</div>
				</div>
			</div>

			<div class="command-item">
				<div class="command-header">
					<code>/submitpet</code>
					<span class="perm-badge user">Everyone</span>
				</div>
				<p class="command-desc">Submit a pet drop for your team. Similar to /submit but for pets.</p>
			</div>

			<div class="command-item">
				<div class="command-header">
					<code>/checkprogress</code>
					<span class="perm-badge user">Everyone</span>
				</div>
				<p class="command-desc">
					Check your team's current tile progress - requirements, submissions, and completion status.
				</p>
				<div class="command-params">
					<div class="param optional">
						<code>team</code>
						<span>Team name (optional, defaults to your team)</span>
					</div>
				</div>
			</div>

			<div class="command-item">
				<div class="command-header">
					<code>/sabotage</code>
					<span class="perm-badge leader">Team Leader</span>
				</div>
				<p class="command-desc">
					Use a sabotage token to reset another team's progress on a specific item.
				</p>
				<div class="command-params">
					<div class="param">
						<code>team</code>
						<span>Target team name</span>
					</div>
					<div class="param">
						<code>item</code>
						<span>Item to sabotage</span>
					</div>
				</div>
				<div class="command-note">
					<strong>Restrictions:</strong> Cannot sabotage teams behind you. Cannot sabotage on keystone
					tiles. Can only sabotage once per tile.
				</div>
			</div>

			<div class="command-item">
				<div class="command-header">
					<code>/checksabotage</code>
					<span class="perm-badge user">Everyone</span>
				</div>
				<p class="command-desc">Check your team's available sabotage tokens.</p>
			</div>

			<div class="command-item">
				<div class="command-header">
					<code>/tileleaderboard</code>
					<span class="perm-badge user">Everyone</span>
				</div>
				<p class="command-desc">Display the current tile event standings for all teams.</p>
			</div>

			<div class="command-item">
				<div class="command-header">
					<code>/addplayer</code>
					<span class="perm-badge admin">Admin / Team Leader</span>
				</div>
				<p class="command-desc">Add a player to a tile event team.</p>
				<div class="command-params">
					<div class="param">
						<code>player</code>
						<span>Discord @mention</span>
					</div>
					<div class="param">
						<code>team</code>
						<span>Team name</span>
					</div>
				</div>
			</div>

			<div class="command-item">
				<div class="command-header">
					<code>/admintile</code>
					<span class="perm-badge admin">Admin</span>
				</div>
				<p class="command-desc">Admin tile event management with multiple subcommands.</p>
				<div class="subcommand-list">
					<div class="subcommand">
						<code>open</code>
						<span>Open the tile event for players</span>
					</div>
					<div class="subcommand">
						<code>close</code>
						<span>Close the tile event</span>
					</div>
					<div class="subcommand">
						<code>status</code>
						<span>Check event status</span>
					</div>
					<div class="subcommand">
						<code>roll</code>
						<span>Roll for another team</span>
					</div>
					<div class="subcommand">
						<code>submit</code>
						<span>Submit a drop for another team (proof optional)</span>
					</div>
					<div class="subcommand">
						<code>move</code>
						<span>Move a team to a specific tile</span>
					</div>
					<div class="subcommand">
						<code>setprogress</code>
						<span>Override progress for a specific item</span>
					</div>
					<div class="subcommand">
						<code>refresh</code>
						<span>Force refresh the tile board</span>
					</div>
				</div>
			</div>

			<div class="command-item">
				<div class="command-header">
					<code>/initboard</code>
					<span class="perm-badge admin">Admin</span>
				</div>
				<p class="command-desc">
					Initialize the tile event board in the current channel. Sets up automatic board updates.
				</p>
			</div>

			<div class="command-item">
				<div class="command-header">
					<code>/updateboard</code>
					<span class="perm-badge admin">Admin</span>
				</div>
				<p class="command-desc">Manually update/refresh the tile event board display.</p>
			</div>
		</div>
	</section>

	<!-- Points & Rewards -->
	<section id="points" class="card">
		<div class="section-header">
			<h2>🏆 Points &amp; Rewards</h2>
		</div>

		<p class="muted">Commands for the Volition Points (VP) gamification system.</p>

		<div class="command-list">
			<div class="command-item">
				<div class="command-header">
					<code>/checkpoints</code>
					<span class="perm-badge user">Everyone</span>
				</div>
				<p class="command-desc">Check VP balance for yourself or another player.</p>
				<div class="command-params">
					<div class="param optional">
						<code>player</code>
						<span>RSN or @mention (optional, defaults to you)</span>
					</div>
				</div>
			</div>

			<div class="command-item">
				<div class="command-header">
					<code>/leaderboard</code>
					<span class="perm-badge user">Everyone</span>
				</div>
				<p class="command-desc">Display the top 10 VP holders. Auto-deletes after 20 seconds.</p>
			</div>

			<div class="command-item">
				<div class="command-header">
					<code>/adjustpoints</code>
					<span class="perm-badge admin">Admin</span>
				</div>
				<p class="command-desc">Add or remove VP from players.</p>
				<div class="command-params">
					<div class="param">
						<code>players</code>
						<span>Comma-separated list of RSNs</span>
					</div>
					<div class="param">
						<code>amount</code>
						<span>Points to add (negative to remove)</span>
					</div>
				</div>
				<div class="command-example">
					<strong>Example:</strong> <code>/adjustpoints players:Player1,Player2 amount:100</code>
				</div>
			</div>

			<div class="command-item">
				<div class="command-header">
					<code>/rewardevent</code>
					<span class="perm-badge admin">Admin</span>
				</div>
				<p class="command-desc">Reward points for competition results using WOM competition data.</p>
				<div class="command-params">
					<div class="param">
						<code>competition_id</code>
						<span>Wise Old Man competition ID</span>
					</div>
					<div class="param">
						<code>first_place</code>
						<span>Points for 1st place</span>
					</div>
					<div class="param">
						<code>second_place</code>
						<span>Points for 2nd place</span>
					</div>
					<div class="param">
						<code>third_place</code>
						<span>Points for 3rd place</span>
					</div>
				</div>
			</div>

			<div class="command-item">
				<div class="command-header">
					<code>/lootcrate</code>
					<span class="perm-badge user">Everyone</span>
				</div>
				<p class="command-desc">
					Open a Volition loot crate for VP and prizes. Includes daily free claim and paid options.
				</p>
			</div>
		</div>
	</section>

	<!-- Clan Management -->
	<section id="clan" class="card">
		<div class="section-header">
			<h2>👥 Clan Management</h2>
		</div>

		<div class="command-list">
			<div class="command-item">
				<div class="command-header">
					<code>/sync</code>
					<span class="perm-badge admin">Admin</span>
				</div>
				<p class="command-desc">
					Full clan sync from Wise Old Man to database and Discord. Syncs all members, roles, and
					points.
				</p>
			</div>

			<div class="command-item">
				<div class="command-header">
					<code>/syncuser</code>
					<span class="perm-badge admin">Admin</span>
				</div>
				<p class="command-desc">Sync a specific user's data from WOM.</p>
				<div class="command-params">
					<div class="param">
						<code>user</code>
						<span>Discord @mention or RSN</span>
					</div>
				</div>
			</div>

			<div class="command-item">
				<div class="command-header">
					<code>/syncWomDiscIds</code>
					<span class="perm-badge admin">Admin</span>
				</div>
				<p class="command-desc">Sync Wise Old Man and Discord IDs in the database.</p>
			</div>

			<div class="command-item">
				<div class="command-header">
					<code>/updateRanksEhb</code>
					<span class="perm-badge admin">Admin</span>
				</div>
				<p class="command-desc">Update Discord roles based on EHB rankings.</p>
			</div>

			<div class="command-item">
				<div class="command-header">
					<code>/age</code>
					<span class="perm-badge user">Everyone</span>
				</div>
				<p class="command-desc">Check how long a player has been in the clan.</p>
				<div class="command-params">
					<div class="param optional">
						<code>player</code>
						<span>RSN or @mention (optional, defaults to you)</span>
					</div>
				</div>
			</div>

			<div class="command-item">
				<div class="command-header">
					<code>/inactive</code>
					<span class="perm-badge admin">Admin</span>
				</div>
				<p class="command-desc">
					Find inactive clan members who haven't synced recently. Exempts recent joins (&lt;1 month).
				</p>
			</div>

			<div class="command-item">
				<div class="command-header">
					<code>/undonicknames</code>
					<span class="perm-badge admin">Admin</span>
				</div>
				<p class="command-desc">Undo nickname changes made by the bot.</p>
			</div>
		</div>
	</section>

	<!-- Fun & Games -->
	<section id="fun" class="card">
		<div class="section-header">
			<h2>🎲 Fun &amp; Games</h2>
		</div>

		<div class="command-list">
			<div class="command-item">
				<div class="command-header">
					<code>/duel</code>
					<span class="perm-badge user">Everyone</span>
				</div>
				<p class="command-desc">
					Challenge another player to a 50/50 points duel. Both players must be registered.
				</p>
				<div class="command-params">
					<div class="param">
						<code>opponent</code>
						<span>Discord @mention</span>
					</div>
					<div class="param">
						<code>points</code>
						<span>Amount to wager (min 1)</span>
					</div>
				</div>
			</div>

			<div class="command-item">
				<div class="command-header">
					<code>/dailywordle</code>
					<span class="perm-badge user">Everyone</span>
				</div>
				<p class="command-desc">Get today's daily Wordle challenge from the database.</p>
			</div>

			<div class="command-item">
				<div class="command-header">
					<code>/weeklytask</code>
					<span class="perm-badge user">Everyone</span>
				</div>
				<p class="command-desc">Get the current weekly task/challenge with its 7-day deadline.</p>
			</div>

			<div class="command-item">
				<div class="command-header">
					<code>/allset</code>
					<span class="perm-badge admin">Admin</span>
				</div>
				<p class="command-desc">
					Send the "You're All Set!" welcome embed with server info, channels, and emojis.
				</p>
			</div>
		</div>
	</section>

	<!-- Utility Commands -->
	<section id="utility" class="card">
		<div class="section-header">
			<h2>⚙ Utility Commands</h2>
			<span class="perm-badge admin">Admin Only</span>
		</div>

		<div class="command-list">
			<div class="command-item">
				<div class="command-header">
					<code>/debugTasks</code>
				</div>
				<p class="command-desc">Debug tile event tasks. For troubleshooting issues.</p>
			</div>

			<div class="command-item">
				<div class="command-header">
					<code>/fixArchivePerms</code>
				</div>
				<p class="command-desc">Fix permissions on archived ticket channels.</p>
			</div>
		</div>
	</section>

	<!-- Quick Reference -->
	<section class="card">
		<div class="section-header">
			<h2>❓ Quick Reference</h2>
		</div>

		<div class="quick-ref-grid">
			<div class="quick-ref-section">
				<h4>Most Used Admin Commands</h4>
				<ul>
					<li><code>/admintile open</code> - Start tile event</li>
					<li><code>/admintile close</code> - End tile event</li>
					<li><code>/forceverify</code> - Verify user manually</li>
					<li><code>/adjustpoints</code> - Give/take VP</li>
					<li><code>/sync</code> - Full clan sync</li>
				</ul>
			</div>
			<div class="quick-ref-section">
				<h4>Most Used Player Commands</h4>
				<ul>
					<li><code>/verify</code> - Start verification</li>
					<li><code>/roll</code> - Advance in tile event</li>
					<li><code>/submit</code> - Submit drop</li>
					<li><code>/checkprogress</code> - See tile progress</li>
					<li><code>/checkpoints</code> - Check VP balance</li>
				</ul>
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

	h4 {
		margin: 0 0 0.6rem;
		font-size: 0.95rem;
		color: var(--text);
	}

	.section-header {
		display: flex;
		align-items: center;
		gap: 0.75rem;
		margin-bottom: 1.25rem;
		padding-bottom: 0.9rem;
		border-bottom: 1px solid var(--border);
		flex-wrap: wrap;
	}

	.category-nav {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
		gap: 0.75rem;
		margin-top: 0.6rem;
	}

	.category-link {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		padding: 0.75rem 1rem;
		background: var(--surface-alt);
		border: 1px solid var(--border);
		border-radius: var(--radius);
		text-decoration: none;
		color: rgba(255, 255, 255, 0.8);
		transition:
			background 0.15s,
			color 0.15s;
		border-left: 3px solid transparent;
	}

	.category-link:hover {
		background: var(--surface);
		color: var(--text);
	}

	.category-link.admin {
		border-left-color: var(--danger);
	}
	.category-link.verify {
		border-left-color: var(--success);
	}
	.category-link.tile {
		border-left-color: var(--yellow);
	}
	.category-link.points {
		border-left-color: var(--accent);
	}
	.category-link.clan {
		border-left-color: var(--accent);
	}
	.category-link.fun {
		border-left-color: var(--yellow);
	}

	.category-link .count {
		margin-left: auto;
		font-size: 0.75rem;
		padding: 0.125rem 0.5rem;
		background: var(--surface);
		border: 1px solid var(--border);
		border-radius: 999px;
	}

	.permission-legend {
		display: flex;
		flex-wrap: wrap;
		gap: 1.5rem;
		margin-top: 0.6rem;
	}

	.perm-item {
		display: flex;
		align-items: center;
		gap: 0.5rem;
	}

	.perm-badge {
		font-size: 0.75rem;
		padding: 0.25rem 0.5rem;
		border-radius: var(--radius);
	}

	.perm-badge.admin {
		background: var(--danger-bg);
		color: var(--danger);
		border: 1px solid var(--danger);
	}

	.perm-badge.leader {
		background: rgba(255, 255, 0, 0.15);
		color: var(--yellow);
		border: 1px solid var(--yellow);
	}

	.perm-badge.user {
		background: var(--success-bg);
		color: var(--success);
		border: 1px solid var(--success);
	}

	.command-list {
		display: flex;
		flex-direction: column;
		gap: 0.9rem;
		margin-top: 1rem;
	}

	.command-item {
		padding: 0.9rem;
		background: var(--surface-alt);
		border: 1px solid var(--border);
		border-radius: var(--radius);
	}

	.command-header {
		display: flex;
		align-items: center;
		gap: 0.75rem;
		margin-bottom: 0.5rem;
		flex-wrap: wrap;
	}

	.command-header code {
		font-size: 0.95rem;
		background: var(--surface);
		border: 1px solid var(--border);
		padding: 0.2rem 0.5rem;
		border-radius: var(--radius);
	}

	.command-desc {
		color: rgba(255, 255, 255, 0.8);
		font-size: 0.9rem;
		margin: 0 0 0.6rem;
	}

	.command-params {
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
		margin-bottom: 0.6rem;
	}

	.param {
		display: flex;
		align-items: flex-start;
		gap: 0.75rem;
		font-size: 0.85rem;
		padding: 0.5rem;
		background: var(--surface);
		border: 1px solid var(--border);
		border-radius: var(--radius);
	}

	.param code {
		flex-shrink: 0;
	}

	.param span {
		color: var(--muted);
	}

	.param.optional > code::after {
		content: '?';
		color: var(--muted-soft);
		margin-left: 0.25rem;
	}

	.command-note {
		font-size: 0.8rem;
		padding: 0.5rem;
		background: var(--accent-soft);
		border-left: 2px solid var(--accent);
		border-radius: var(--radius);
		color: rgba(255, 255, 255, 0.8);
	}

	.command-example {
		font-size: 0.8rem;
		padding: 0.5rem;
		background: var(--surface);
		border: 1px solid var(--border);
		border-radius: var(--radius);
		color: var(--muted);
	}

	.subcommand-list {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(250px, 1fr));
		gap: 0.5rem;
		margin-top: 0.6rem;
	}

	.subcommand {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		font-size: 0.85rem;
		padding: 0.5rem;
		background: var(--surface);
		border: 1px solid var(--border);
		border-radius: var(--radius);
	}

	.subcommand span {
		color: var(--muted);
		font-size: 0.8rem;
	}

	code {
		background: var(--surface);
		border: 1px solid var(--border);
		padding: 0.1rem 0.35rem;
		border-radius: var(--radius);
		font-family: ui-monospace, 'SFMono-Regular', Menlo, monospace;
		font-size: 0.85em;
	}

	.quick-ref-grid {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(250px, 1fr));
		gap: 0.9rem;
	}

	.quick-ref-section {
		padding: 0.9rem;
		background: var(--surface-alt);
		border: 1px solid var(--border);
		border-radius: var(--radius);
	}

	.quick-ref-section ul {
		list-style: none;
		padding: 0;
		margin: 0;
	}

	.quick-ref-section li {
		padding: 0.25rem 0;
		font-size: 0.85rem;
		color: rgba(255, 255, 255, 0.8);
	}
</style>

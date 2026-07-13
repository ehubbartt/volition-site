<script lang="ts">
	// Shared Stats tab body for /me and /u/[rsn] — VP / cards / packs / crates /
	// wallet mini-stat groups. Both pages feed the same shapes (cardProfile.ts).
	interface CardStats {
		cardsOwned: number;
		packsOpened: number;
		cardsPulled: number;
		vpSpent: number;
	}
	interface CrateStats {
		totalOpens: number;
		freeOpens: number;
		paidOpens: number;
		vpWon: number;
		vpSpent: number;
		biggestWin: number;
	}

	let {
		vp,
		cards,
		crateStats,
		collectionOwned,
		collectionTotal,
		packTotal,
		walletTotal
	}: {
		vp: number;
		cards: CardStats;
		crateStats: CrateStats;
		collectionOwned: number;
		collectionTotal: number;
		packTotal: number;
		walletTotal: number;
	} = $props();
</script>

<div class="stats-grid">
	<section class="stat-card">
		<h3>Volition Points</h3>
		<div class="mini-stats">
			<div class="ms"><span class="ms-num">{vp.toLocaleString()}</span><span class="ms-lbl">Current VP</span></div>
		</div>
	</section>

	<section class="stat-card">
		<h3>Cards</h3>
		<div class="mini-stats">
			<div class="ms"><span class="ms-num">{cards.cardsOwned}</span><span class="ms-lbl">Cards owned</span></div>
			<div class="ms"><span class="ms-num">{collectionOwned} / {collectionTotal}</span><span class="ms-lbl">Variants collected</span></div>
		</div>
	</section>

	<section class="stat-card">
		<h3>Packs</h3>
		<div class="mini-stats">
			<div class="ms"><span class="ms-num">{packTotal}</span><span class="ms-lbl">Unopened</span></div>
			<div class="ms"><span class="ms-num">{cards.packsOpened}</span><span class="ms-lbl">Opened</span></div>
			<div class="ms"><span class="ms-num">{cards.cardsPulled}</span><span class="ms-lbl">Cards pulled</span></div>
			<div class="ms"><span class="ms-num">{cards.vpSpent.toLocaleString()}</span><span class="ms-lbl">VP spent</span></div>
		</div>
	</section>

	<section class="stat-card">
		<h3>Gamba crates</h3>
		<div class="mini-stats">
			<div class="ms"><span class="ms-num">{crateStats.totalOpens}</span><span class="ms-lbl">Opened</span></div>
			<div class="ms"><span class="ms-num">{crateStats.freeOpens}</span><span class="ms-lbl">Free</span></div>
			<div class="ms"><span class="ms-num">{crateStats.paidOpens}</span><span class="ms-lbl">Paid</span></div>
			<div class="ms"><span class="ms-num">{crateStats.vpWon.toLocaleString()}</span><span class="ms-lbl">VP won</span></div>
			<div class="ms"><span class="ms-num">{crateStats.vpSpent.toLocaleString()}</span><span class="ms-lbl">VP spent</span></div>
			<div class="ms"><span class="ms-num">{crateStats.biggestWin.toLocaleString()}</span><span class="ms-lbl">Biggest win</span></div>
		</div>
	</section>

	<section class="stat-card">
		<h3>Wallet</h3>
		<div class="mini-stats">
			<div class="ms"><span class="ms-num">{walletTotal}</span><span class="ms-lbl">Unpaid items</span></div>
		</div>
	</section>
</div>

<style>
	.stats-grid {
		display: flex;
		flex-direction: column;
		gap: 1.5rem;
	}

	.stat-card h3 {
		margin: 0 0 0.6rem;
		font-size: 1rem;
		color: var(--accent);
		text-shadow: var(--ts);
	}

	.mini-stats {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(7rem, 1fr));
		gap: 0.75rem;
		margin: 0;
	}

	.ms {
		display: flex;
		flex-direction: column;
		gap: 0.15rem;
		padding: 0.7rem 0.9rem;
		background: var(--surface-alt);
		border: 1px solid var(--border);
		border-radius: var(--radius);
	}

	.ms-num {
		font-family: var(--font-heading);
		font-size: 1.3rem;
		color: var(--accent);
		text-shadow: var(--ts);
	}

	.ms-lbl {
		font-size: 0.78rem;
		color: var(--muted);
	}
</style>

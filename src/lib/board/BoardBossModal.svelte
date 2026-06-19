<script lang="ts">
	// Boss "room": clicking a boss tile opens this combat view instead of the standard
	// submit modal. The boss's HP pool = the tile's `required`; each approved drop deals
	// its `quantity` as damage (same vs_submissions pipeline as every other tile — see
	// BoardSubmitModal). When damage ≥ HP the boss is defeated and the stage clears.
	import { enhance } from '$app/forms';
	import AccountIcon from '$lib/AccountIcon.svelte';
	import { MAX_IMAGES_PER_SUBMISSION } from '$lib/bingo/config';
	import type { BoardStatus } from './state';

	type SubmissionStatus = 'pending' | 'approved' | 'rejected';

	interface TeamSubmission {
		id: string;
		proof_urls: string[];
		quantity: number;
		submitted_at: string;
		status: SubmissionStatus;
		reviewed_by_name: string | null;
		review_note: string | null;
		submitted_by_name: string;
	}

	interface Completion {
		id: string;
		user_id: string;
		rsn: string | null;
		discord_username: string;
		account_type: string | null;
		team_name: string | null;
		submitted_at: string;
		proof_urls: string[];
		quantity: number;
		reviewed_by_name: string | null;
		isMine: boolean;
	}

	interface Props {
		tile: { id: string; name: string; img: string | null; faq_html: string | null; autoClear?: string | null };
		status: BoardStatus;
		teamSubmissions: TeamSubmission[];
		community: Completion[];
		communityCount: number;
		canSubmit: boolean;
		// Whether the viewer is on a team (canSubmit folds this in; passed separately so the
		// locked message can distinguish "no team" from "this boss just isn't your active one").
		hasTeam: boolean;
		isAdmin: boolean;
		progress?: { approved: number; required: number; pending: number; rejected: number } | null;
		onZoom: (url: string) => void;
		onclose: () => void;
		// Fired the moment a hit takes the boss from alive → defeated (the killing blow), so the
		// board can play the victory fireworks + advance to the next floor.
		onDefeat?: () => void;
	}

	let {
		tile,
		status,
		teamSubmissions,
		community,
		communityCount,
		canSubmit,
		hasTeam,
		isAdmin,
		progress = null,
		onZoom,
		onclose,
		onDefeat
	}: Props = $props();

	const submittable = $derived(status === 'open' && canSubmit);

	// Boss HP model (optimistic). HP pool = required. Damage counts the moment it's
	// submitted — confirmed (approved) + pending — so the team progresses without waiting
	// for approval. Pending damage is provisional: if an admin rejects it, the HP comes
	// back and the boss must be finished again.
	const maxHp = $derived(Math.max(1, progress?.required ?? 1));
	const confirmedDmg = $derived(Math.min(maxHp, progress?.approved ?? 0));
	const pendingDmg = $derived(Math.max(0, progress?.pending ?? 0));
	const totalDmg = $derived(Math.min(maxHp, confirmedDmg + pendingDmg));
	const hp = $derived(Math.max(0, maxHp - totalDmg));
	const defeated = $derived(totalDmg >= maxHp);
	const hpPct = $derived((hp / maxHp) * 100);
	// The provisional (pending) slice of damage, striped just past the remaining HP.
	const pendingPct = $derived(((totalDmg - confirmedDmg) / maxHp) * 100);
	const lowHp = $derived(hpPct <= 30 && !defeated);
	// A hit bounced: rejected drops on an undefeated boss → the team must keep attacking.
	const wasRejected = $derived(!!progress && progress.rejected > 0 && !defeated);
	const rejectionNote = $derived(
		teamSubmissions
			.filter((s) => s.status === 'rejected' && s.review_note)
			.map((s) => s.review_note)
			.at(-1) ?? null
	);
	// Floors 1 & 2 bosses accept a special "auto-clear" drop (mutagen/pet, minion item)
	// that instantly defeats the boss (a full-HP hit). null = no auto-clear (floor 3).
	const autoClear = $derived(tile.autoClear ?? null);
	let autoClearMode = $state(false);

	// Each regular drop is one hit (1 damage); an auto-clear deals the boss's full HP.
	const submitQty = $derived(autoClearMode ? maxHp : 1);

	let fileInput: HTMLInputElement | null = $state(null);
	let staged = $state<Array<{ file: File; url: string }>>([]);
	let dragOver = $state(false);
	let submitting = $state(false);
	let error = $state<string | null>(null);

	function syncInput() {
		if (!fileInput) return;
		const dt = new DataTransfer();
		for (const s of staged) dt.items.add(s.file);
		fileInput.files = dt.files;
	}

	function addFiles(files: FileList | File[]) {
		error = null;
		for (const f of Array.from(files)) {
			if (!f.type.startsWith('image/')) continue;
			if (staged.length >= MAX_IMAGES_PER_SUBMISSION) {
				error = `You can attach up to ${MAX_IMAGES_PER_SUBMISSION} images per drop.`;
				break;
			}
			staged = [...staged, { file: f, url: URL.createObjectURL(f) }];
		}
		syncInput();
	}

	function removeStaged(i: number) {
		const s = staged[i];
		if (s) URL.revokeObjectURL(s.url);
		staged = staged.filter((_, idx) => idx !== i);
		syncInput();
	}

	function clearStaged() {
		for (const s of staged) URL.revokeObjectURL(s.url);
		staged = [];
		if (fileInput) fileInput.value = '';
	}

	function handleDrop(e: DragEvent) {
		e.preventDefault();
		dragOver = false;
		if (!submittable) return;
		if (e.dataTransfer?.files?.length) addFiles(e.dataTransfer.files);
	}

	function handleSelect(e: Event) {
		const target = e.target as HTMLInputElement;
		if (target.files?.length) addFiles(target.files);
	}

	function handlePaste(e: ClipboardEvent) {
		if (!submittable) return;
		const items = e.clipboardData?.items;
		if (!items) return;
		for (const item of items) {
			if (item.kind === 'file' && item.type.startsWith('image/')) {
				const f = item.getAsFile();
				if (f) {
					e.preventDefault();
					addFiles([f]);
					return;
				}
			}
		}
	}

	function onKey(e: KeyboardEvent) {
		if (e.key === 'Escape') onclose();
	}

	function backdropClick(e: MouseEvent) {
		if (e.target === e.currentTarget) onclose();
	}

	function fmtDate(iso: string): string {
		try {
			return new Date(iso).toLocaleString();
		} catch {
			return iso;
		}
	}
</script>

<svelte:window onkeydown={onKey} onpaste={handlePaste} />

<!-- svelte-ignore a11y_click_events_have_key_events -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="backdrop" onclick={backdropClick}>
	<div class="room" class:defeated role="dialog" aria-labelledby="boss-title" aria-modal="true">
		<button type="button" class="close" aria-label="Close" onclick={onclose}>×</button>

		<header class="boss-hero">
			{#if tile.img}
				<img class="boss-img" src={tile.img} alt={tile.name} referrerpolicy="no-referrer" />
			{/if}
			<div class="boss-name-row">
				<span class="boss-tag">Boss</span>
				<h2 id="boss-title">{tile.name}</h2>
			</div>

			<div class="hpbar" class:low={lowHp} role="img" aria-label={`${hp} of ${maxHp} HP`}>
				<div class="hp-fill" style="width: {hpPct}%"></div>
				{#if pendingPct > 0}
					<div class="hp-pending" style="left: {hpPct}%; width: {pendingPct}%"></div>
				{/if}
				<span class="hp-text">
					{#if defeated}
						{confirmedDmg >= maxHp ? 'DEFEATED' : 'DEFEATED (pending approval)'}
					{:else}
						{hp.toLocaleString()} / {maxHp.toLocaleString()} HP
					{/if}
				</span>
			</div>
			<div class="hp-sub">
				<span>{confirmedDmg.toLocaleString()} damage confirmed</span>
				{#if pendingDmg > 0}<span class="pending">· {pendingDmg.toLocaleString()} pending (counts now)</span>{/if}
			</div>
		</header>

		{#if wasRejected}
			<div class="reject-banner" role="alert">
				<strong>⚠ A hit was rejected — the boss recovered.</strong>
				<p>
					An admin rejected one of your team's drops, so that damage was undone. Keep
					attacking — your team can't move on until the boss is down.
				</p>
				{#if rejectionNote}
					<p class="reject-reason">Admin note: “{rejectionNote}”</p>
				{/if}
			</div>
		{/if}

		{#if tile.faq_html}
			<section class="details">
				<h3>How to defeat</h3>
				<div class="details-body">{@html tile.faq_html}</div>
			</section>
		{/if}

		{#if teamSubmissions.length > 0}
			<section class="hits">
				<h3>Your team's hits ({teamSubmissions.length})</h3>
				<ul class="hit-list">
					{#each teamSubmissions as sub (sub.id)}
						<li class="hit-item status-{sub.status}">
							<div class="thumb-row">
								{#each sub.proof_urls as url, idx (url)}
									<button type="button" class="proof-link" onclick={() => onZoom(url)} aria-label={`View drop ${idx + 1}`}>
										<img src={url} alt={`Drop proof ${idx + 1}`} />
									</button>
								{/each}
							</div>
							<div class="hit-meta">
								<div class="hit-meta-left">
									<span class="dmg-pill">{sub.quantity.toLocaleString()} dmg</span>
									<span class="status-pill status-{sub.status}">
										{sub.status === 'pending' ? 'In review' : sub.status === 'approved' ? 'Landed' : 'Missed'}
									</span>
									<span class="meta">By {sub.submitted_by_name} · {fmtDate(sub.submitted_at)}</span>
									{#if sub.status === 'rejected' && sub.review_note}
										<span class="reject-reason-inline">✗ {sub.review_note}</span>
									{/if}
								</div>
								{#if submittable}
									<form
										method="POST"
										action="?/remove"
										use:enhance={() => {
											return async ({ result, update }) => {
												await update({ reset: false });
												if (result.type === 'failure') {
													const data = result.data as { error?: string } | undefined;
													error = data?.error ?? 'Remove failed';
												}
											};
										}}
									>
										<input type="hidden" name="submission_id" value={sub.id} />
										<button type="submit" class="danger small">Remove</button>
									</form>
								{/if}
							</div>
						</li>
					{/each}
				</ul>
			</section>
		{/if}

		{#if submittable}
			<form
				method="POST"
				enctype="multipart/form-data"
				action="?/submit"
				use:enhance={() => {
					submitting = true;
					// Captured before submit: does this drop deal the killing blow? (boss was alive
					// and this hit's damage finishes the HP pool). Drives the victory celebration.
					const killingBlow = !defeated && totalDmg + submitQty >= maxHp;
					return async ({ result, update }) => {
						await update({ reset: false });
						submitting = false;
						if (result.type === 'success') {
							clearStaged();
							if (killingBlow) onDefeat?.();
						} else if (result.type === 'failure') {
							const data = result.data as { error?: string } | undefined;
							error = data?.error ?? 'Submit failed';
						} else if (result.type === 'error') {
							error = result.error?.message ?? 'Something went wrong';
						}
					};
				}}
			>
				<input type="hidden" name="tile_id" value={tile.id} />

				<h3 class="attack-head">⚔ Attack the boss</h3>

				<!-- Single source of truth for damage dealt: full HP for an auto-clear, else
				     the chosen amount. -->
				<input type="hidden" name="quantity" value={submitQty} />

				{#if autoClear}
					<label class="autoclear-toggle" class:on={autoClearMode}>
						<input type="checkbox" bind:checked={autoClearMode} />
						<span>💥 <strong>Auto-clear</strong> — {autoClear} (instantly defeats the boss)</span>
					</label>
				{/if}

				<!-- svelte-ignore a11y_no_static_element_interactions -->
				<label
					class="dropzone"
					class:drag-over={dragOver}
					ondragover={(e) => {
						e.preventDefault();
						dragOver = true;
					}}
					ondragleave={() => (dragOver = false)}
					ondrop={handleDrop}
				>
					<input
						bind:this={fileInput}
						type="file"
						name="proof"
						accept="image/png,image/jpeg,image/webp,image/gif"
						multiple
						onchange={handleSelect}
						hidden
					/>
					<span class="big">{staged.length > 0 ? 'Add another image' : 'Drop or paste your proof'}</span>
					<span class="hint">click to choose · paste (Ctrl/Cmd+V) · up to {MAX_IMAGES_PER_SUBMISSION} images, 10 MB each</span>
				</label>

				{#if staged.length > 0}
					<div class="staged">
						{#each staged as s, i (s.url)}
							<div class="staged-item">
								<img src={s.url} alt={`Staged ${i + 1}`} />
								<button type="button" class="staged-remove" aria-label="Remove image" onclick={() => removeStaged(i)}>×</button>
							</div>
						{/each}
					</div>
				{/if}

				{#if error}<p class="error">{error}</p>{/if}

				<p class="optimistic-hint">Your hit lands right away — if an admin rejects it, the HP comes back and you'll have to finish the boss again.</p>

				<div class="actions">
					<button type="submit" class="attack" class:autoclear={autoClearMode} disabled={staged.length === 0 || submitting}>
						{#if submitting}
							Attacking…
						{:else if autoClearMode}
							💥 Auto-clear the boss
						{:else}
							⚔ Deal 1 damage
						{/if}
					</button>
					{#if staged.length > 0}
						<button type="button" onclick={clearStaged}>Clear</button>
					{/if}
				</div>
			</form>
		{:else}
			<p class="locked-msg">
				{#if defeated}
					🏆 This boss is defeated — your team has cleared it.
				{:else if status === 'past-locked'}
					The event has ended — this boss is locked.
				{:else if !hasTeam && status === 'open'}
					Only teams can attack this boss. Join the event and pair up with a teammate first.
				{:else}
					This boss isn't open for your team yet.
				{/if}
			</p>
		{/if}

		{#if community.length > 0}
			<section class="raid">
				<h3>Other teams ({community.length})</h3>
				<ul>
					{#each community as c (c.id)}
						<li>
							<div class="thumb-row">
								{#each c.proof_urls as url, idx (url)}
									<button type="button" class="proof-thumb" onclick={() => onZoom(url)} aria-label={`View drop ${idx + 1} by ${c.rsn ?? c.discord_username}`}>
										<img src={url} alt={`Drop ${idx + 1} by ${c.rsn ?? c.discord_username}`} />
									</button>
								{/each}
							</div>
							<div class="who">
								<AccountIcon type={c.account_type} />
								<strong>{c.rsn ?? c.discord_username}</strong>
								{#if c.team_name}<span class="team-tag">{c.team_name}</span>{/if}
								{#if c.isMine}<span class="me-tag">your team</span>{/if}
								<span class="dmg-pill small">{c.quantity.toLocaleString()} dmg</span>
							</div>
							{#if isAdmin}
								<form
									method="POST"
									action="?/adminReject"
									use:enhance={() => {
										return async ({ result, update }) => {
											await update({ reset: false });
											if (result.type === 'failure') {
												const data = result.data as { error?: string } | undefined;
												error = data?.error ?? 'Reject failed';
											}
										};
									}}
								>
									<input type="hidden" name="submission_id" value={c.id} />
									<button type="submit" class="danger small">Reject</button>
								</form>
							{/if}
						</li>
					{/each}
				</ul>
			</section>
		{:else if communityCount > 0}
			<section class="raid raid-count-only">
				<h3>{communityCount} drop{communityCount === 1 ? '' : 's'} from other teams</h3>
				<p class="muted small">Individual proofs are visible to admins only.</p>
			</section>
		{/if}
	</div>
</div>

<style>
	.backdrop {
		position: fixed;
		inset: 0;
		background: rgba(0, 0, 0, 0.8);
		z-index: 100;
		display: flex;
		align-items: flex-start;
		justify-content: center;
		padding: 2rem 1rem 4rem;
		overflow-y: auto;
	}

	.room {
		position: relative;
		width: 100%;
		max-width: 42rem;
		padding: 0 0 1.5rem;
		background:
			radial-gradient(ellipse 80% 50% at 50% 0%, rgba(255, 80, 40, 0.18), transparent 70%),
			linear-gradient(180deg, rgba(40, 24, 20, 0.98), rgba(24, 18, 16, 0.98));
		border: 1px solid var(--accent);
		border-radius: var(--radius);
		box-shadow: 0 0 40px rgba(255, 80, 40, 0.25), var(--shadow-card);
		color: var(--text);
		font-family: var(--font-body);
		overflow: hidden;
	}

	.room.defeated {
		border-color: var(--border);
		box-shadow: var(--shadow-card);
	}

	.close {
		position: absolute;
		top: 6px;
		right: 8px;
		width: 32px;
		height: 32px;
		min-height: 0;
		padding: 0;
		z-index: 3;
		font-family: var(--font-heading);
		font-size: 1.5rem;
		background: rgba(0, 0, 0, 0.4);
		border-color: transparent;
		color: #fff;
	}

	.close:hover {
		color: var(--accent);
		background: rgba(0, 0, 0, 0.6);
	}

	.boss-hero {
		position: relative;
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 0.5rem;
		padding: 1.5rem 1.5rem 1rem;
		text-align: center;
	}

	.boss-img {
		width: min(18rem, 70%);
		max-height: 14rem;
		object-fit: contain;
		image-rendering: auto;
		filter: drop-shadow(0 6px 14px rgba(0, 0, 0, 0.7));
		animation: bossFloat 4s ease-in-out infinite;
	}

	.room.defeated .boss-img {
		filter: grayscale(1) brightness(0.5) drop-shadow(0 6px 14px rgba(0, 0, 0, 0.7));
		animation: none;
	}

	@keyframes bossFloat {
		0%,
		100% {
			transform: translateY(0);
		}
		50% {
			transform: translateY(-7px);
		}
	}

	.boss-name-row {
		display: flex;
		align-items: center;
		gap: 0.6rem;
	}

	.boss-tag {
		font-family: var(--font-heading);
		font-size: 0.7rem;
		letter-spacing: 2px;
		text-transform: uppercase;
		color: var(--accent);
		border: 1px solid var(--accent);
		border-radius: 3px;
		padding: 0.05rem 0.4rem;
	}

	.boss-name-row h2 {
		margin: 0;
		font-size: 1.5rem;
	}

	.hpbar {
		position: relative;
		width: 100%;
		max-width: 30rem;
		height: 1.4rem;
		margin-top: 0.4rem;
		background: #1a0d0a;
		border: 1px solid #000;
		border-radius: 4px;
		overflow: hidden;
		box-shadow: inset 0 2px 4px rgba(0, 0, 0, 0.6);
	}

	.hp-fill {
		position: absolute;
		left: 0;
		top: 0;
		bottom: 0;
		background: linear-gradient(180deg, #4ade80, #16a34a);
		transition: width 0.4s ease;
	}

	/* Low HP → the bar runs red. */
	.hpbar.low .hp-fill {
		background: linear-gradient(180deg, #f87171, #dc2626);
	}

	.hp-pending {
		position: absolute;
		top: 0;
		bottom: 0;
		background-image: repeating-linear-gradient(
			45deg,
			rgba(255, 200, 60, 0.55),
			rgba(255, 200, 60, 0.55) 6px,
			rgba(255, 200, 60, 0.2) 6px,
			rgba(255, 200, 60, 0.2) 12px
		);
	}

	.hp-text {
		position: absolute;
		inset: 0;
		display: flex;
		align-items: center;
		justify-content: center;
		font-family: var(--font-heading);
		font-size: 0.85rem;
		color: #fff;
		text-shadow: 1px 1px 2px #000, 0 0 3px #000;
	}

	.hp-sub {
		display: flex;
		gap: 0.4rem;
		font-size: 0.8rem;
		color: var(--muted);
	}

	.hp-sub .pending {
		color: var(--accent);
	}

	.details,
	.hits,
	.raid {
		margin: 0 1.5rem 1rem;
	}

	.details {
		padding: 0.85rem 1rem;
		border: 1px solid var(--border);
		background: rgba(0, 0, 0, 0.25);
		border-radius: var(--radius);
	}

	.details h3,
	.attack-head {
		margin: 0 0 0.5rem;
		font-size: 0.95rem;
		color: var(--accent);
		letter-spacing: 1px;
	}

	.attack-head {
		margin: 0 1.5rem 0.5rem;
	}

	.details-body :global(p) {
		margin: 0 0 0.5rem;
	}

	.details-body :global(:last-child) {
		margin-bottom: 0;
	}

	.details-body :global(a) {
		color: var(--accent);
	}

	.hits h3,
	.raid h3 {
		margin: 0 0 0.6rem;
		font-size: 0.95rem;
	}

	.thumb-row {
		display: flex;
		flex-wrap: wrap;
		gap: 0.35rem;
	}

	.thumb-row .proof-link,
	.thumb-row .proof-thumb {
		display: block;
		border-radius: 3px;
		overflow: hidden;
		padding: 0;
		background: transparent;
		border: 0;
		cursor: pointer;
		min-height: 0;
	}

	.thumb-row img {
		display: block;
		width: 5.5rem;
		height: 5.5rem;
		object-fit: cover;
		border-radius: 3px;
		border: 1px solid var(--border);
		background: #000;
	}

	.thumb-row .proof-link:hover,
	.thumb-row .proof-thumb:hover {
		outline: 1px solid var(--accent);
	}

	.hit-list {
		list-style: none;
		padding: 0;
		margin: 0;
		display: flex;
		flex-direction: column;
		gap: 0.6rem;
	}

	.hit-list li {
		display: flex;
		flex-direction: column;
		gap: 0.35rem;
	}

	.hit-meta {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 0.5rem;
		flex-wrap: wrap;
	}

	.hit-meta-left {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		flex-wrap: wrap;
	}

	.meta {
		color: var(--muted);
		font-size: 0.8rem;
	}

	.dmg-pill {
		font-family: var(--font-heading);
		font-size: 0.72rem;
		background: rgba(255, 152, 31, 0.18);
		border: 1px solid var(--accent);
		color: var(--accent);
		padding: 0.05rem 0.45rem;
		border-radius: 3px;
	}

	.dmg-pill.small {
		font-size: 0.65rem;
	}

	.status-pill {
		display: inline-block;
		padding: 0.05rem 0.45rem;
		font-family: var(--font-heading);
		font-size: 0.68rem;
		letter-spacing: 1px;
		text-transform: uppercase;
		border-radius: 3px;
		border: 1px solid transparent;
	}

	.status-pill.status-pending {
		background: rgba(255, 152, 31, 0.18);
		border-color: var(--accent);
		color: var(--accent);
	}

	.status-pill.status-approved {
		background: var(--success-bg);
		border-color: var(--success);
		color: var(--success);
	}

	.status-pill.status-rejected {
		background: var(--danger-bg);
		border-color: var(--danger);
		color: var(--danger);
	}

	.hit-item.status-rejected .proof-link img {
		opacity: 0.55;
		filter: saturate(0.5);
	}

	form {
		margin: 0 1.5rem;
		display: flex;
		flex-direction: column;
		gap: 0.6rem;
	}


	.autoclear-toggle {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		padding: 0.55rem 0.75rem;
		background: rgba(180, 100, 255, 0.1);
		border: 1px solid rgba(180, 100, 255, 0.45);
		border-radius: var(--radius);
		font-size: 0.85rem;
		cursor: pointer;
	}

	.autoclear-toggle.on {
		background: rgba(180, 100, 255, 0.22);
		border-color: #b06bff;
	}

	.autoclear-toggle input {
		width: 1.05rem;
		height: 1.05rem;
		accent-color: #b06bff;
	}

	.dropzone {
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		gap: 0.4rem;
		min-height: 8rem;
		padding: 1rem;
		background: rgba(0, 0, 0, 0.25);
		border: 2px dashed var(--border-strong);
		border-radius: var(--radius);
		text-align: center;
		cursor: pointer;
		transition: border-color 0.15s, background 0.15s;
	}

	.dropzone:hover,
	.dropzone.drag-over {
		border-color: var(--accent);
		background: var(--accent-soft);
	}

	.staged {
		display: flex;
		flex-wrap: wrap;
		gap: 0.4rem;
	}

	.staged-item {
		position: relative;
	}

	.staged-item img {
		display: block;
		width: 5rem;
		height: 5rem;
		object-fit: cover;
		border-radius: 3px;
		border: 1px solid var(--border);
		background: #000;
	}

	.staged-remove {
		position: absolute;
		top: -6px;
		right: -6px;
		width: 20px;
		height: 20px;
		min-height: 0;
		padding: 0;
		line-height: 1;
		font-size: 1rem;
		border-radius: 50%;
		background: var(--danger);
		color: #fff;
		border: 1px solid #000;
		display: flex;
		align-items: center;
		justify-content: center;
	}

	.big {
		font-family: var(--font-heading);
		font-size: 1.05rem;
		color: var(--accent);
	}

	.hint {
		font-size: 0.8rem;
		color: var(--muted);
	}

	.optimistic-hint {
		margin: 0;
		font-size: 0.78rem;
		color: var(--muted);
		font-style: italic;
	}

	.actions {
		display: flex;
		gap: 0.5rem;
		flex-wrap: wrap;
	}

	button.attack {
		padding: 0.6rem 1.4rem;
		font-family: var(--font-heading);
		letter-spacing: 1px;
		background: linear-gradient(180deg, rgba(255, 120, 40, 0.25), rgba(220, 60, 20, 0.25));
		border-color: var(--accent);
		color: var(--accent);
	}

	button.attack:hover:not(:disabled) {
		background: linear-gradient(180deg, rgba(255, 120, 40, 0.4), rgba(220, 60, 20, 0.4));
	}

	button.attack.autoclear {
		background: linear-gradient(180deg, rgba(180, 100, 255, 0.28), rgba(130, 60, 220, 0.28));
		border-color: #b06bff;
		color: #d9bcff;
	}

	button.attack.autoclear:hover:not(:disabled) {
		background: linear-gradient(180deg, rgba(180, 100, 255, 0.45), rgba(130, 60, 220, 0.45));
	}

	button.danger {
		border-color: var(--danger);
		color: var(--danger);
	}

	button.danger.small {
		font-size: 0.78rem;
		padding: 0.25rem 0.55rem;
		min-height: 0;
	}

	.error {
		margin: 0;
		padding: 0.5rem 0.7rem;
		background: var(--danger-bg);
		border: 1px solid var(--danger);
		color: var(--danger);
		border-radius: 3px;
		font-size: 0.85rem;
	}

	.reject-banner {
		margin: 0 1.5rem 1rem;
		padding: 0.75rem 0.9rem;
		background: var(--danger-bg);
		border: 1px solid var(--danger);
		border-left-width: 4px;
		border-radius: var(--radius);
	}

	.reject-banner strong {
		color: var(--danger);
	}

	.reject-banner p {
		margin: 0.35rem 0 0;
		font-size: 0.85rem;
		color: var(--text);
	}

	.reject-banner .reject-reason {
		margin-top: 0.4rem;
		font-style: italic;
		color: var(--muted);
	}

	.reject-reason-inline {
		flex-basis: 100%;
		font-size: 0.8rem;
		font-style: italic;
		color: var(--danger);
	}


	.locked-msg {
		margin: 0 1.5rem;
		padding: 0.75rem;
		background: rgba(0, 0, 0, 0.25);
		border: 1px solid var(--border);
		border-radius: var(--radius);
		color: var(--muted);
		text-align: center;
	}

	.raid {
		margin-top: 1.25rem;
		padding-top: 1rem;
		border-top: 1px solid var(--border);
	}

	.raid ul {
		list-style: none;
		padding: 0;
		margin: 0;
		display: grid;
		gap: 0.6rem;
		grid-template-columns: repeat(auto-fill, minmax(11rem, 1fr));
	}

	.raid li {
		display: flex;
		flex-direction: column;
		gap: 0.3rem;
		padding: 0.45rem;
		background: rgba(0, 0, 0, 0.25);
		border: 1px solid var(--border);
		border-radius: 3px;
	}

	.raid .who {
		display: flex;
		align-items: center;
		gap: 0.35rem;
		font-size: 0.85rem;
		flex-wrap: wrap;
	}

	.raid li form {
		margin: 0.15rem 0 0;
	}

	.raid li form button {
		width: 100%;
	}

	.team-tag {
		font-size: 0.65rem;
		background: var(--surface);
		border: 1px solid var(--border);
		color: var(--muted);
		padding: 0.02rem 0.32rem;
		border-radius: 3px;
	}

	.me-tag {
		font-size: 0.65rem;
		text-transform: uppercase;
		background: var(--accent-soft);
		border: 1px solid var(--accent);
		color: var(--accent);
		padding: 0.02rem 0.32rem;
		border-radius: 3px;
	}

	.raid-count-only .muted.small {
		margin: 0;
		font-size: 0.8rem;
	}

	@media (prefers-reduced-motion: reduce) {
		.boss-img {
			animation: none;
		}
	}
</style>

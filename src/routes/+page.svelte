<script lang="ts">
	import { enhance } from '$app/forms';
	import { page } from '$app/state';
	import type { SubmitFunction } from '@sveltejs/kit';
	import { itemColor, type CalendarItem } from '$lib/calendar';
	import { datetimeLocalToIso } from '$lib/datetime';
	import { rankLabel, rankColor, rankIndex, rankImg } from '$lib/ranks';
	import { rsnToSlug } from '$lib/rsn';
	import type { PageData, ActionData } from './$types';

	let { data, form }: { data: PageData; form: ActionData } = $props();

	const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
	const MONTHS = [
		'January', 'February', 'March', 'April', 'May', 'June',
		'July', 'August', 'September', 'October', 'November', 'December'
	];

	const today = new Date();

	let viewYear = $state(today.getFullYear());
	let viewMonth = $state(today.getMonth()); // 0-11
	let selectedKey = $state<string | null>(null);

	// Member lookup
	let search = $state('');
	let sortBy = $state<'rsn' | 'vp' | 'rank'>('rsn');

	// Live clock for the next-event countdown (client-only via $effect). Only ticks
	// on the member dashboard — the logged-out page has no countdown.
	let now = $state(today.getTime());
	$effect(() => {
		if (!data.user) return;
		const id = setInterval(() => (now = Date.now()), 1000);
		return () => clearInterval(id);
	});

	// Admin calendar modal
	let showModal = $state(false);
	let editingId = $state<string | null>(null);
	let saving = $state(false);
	let mTitle = $state('');
	let mDesc = $state('');
	let mStart = $state('');
	let mEnd = $state('');
	let mLoc = $state('');
	let mLink = $state('');
	let mCat = $state('event');

	let canViewProfiles = $derived(Boolean(page.data.user));

	function dayKey(d: Date): string {
		return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
	}
	const todayKey = dayKey(today);

	const itemsByDay = $derived.by(() => {
		const m = new Map<string, CalendarItem[]>();
		for (const it of data.calendar) {
			const k = dayKey(new Date(it.date));
			let arr = m.get(k);
			if (!arr) {
				arr = [];
				m.set(k, arr);
			}
			arr.push(it);
		}
		return m;
	});

	const weeks = $derived.by(() => {
		const first = new Date(viewYear, viewMonth, 1);
		const startWeekday = first.getDay();
		const daysInMonth = new Date(viewYear, viewMonth + 1, 0).getDate();
		const cells: (Date | null)[] = [];
		for (let i = 0; i < startWeekday; i++) cells.push(null);
		for (let d = 1; d <= daysInMonth; d++) cells.push(new Date(viewYear, viewMonth, d));
		while (cells.length % 7 !== 0) cells.push(null);
		const w: (Date | null)[][] = [];
		for (let i = 0; i < cells.length; i += 7) w.push(cells.slice(i, i + 7));
		return w;
	});

	const agendaItems = $derived.by(() => {
		if (selectedKey) return itemsByDay.get(selectedKey) ?? [];
		const startOfToday = new Date();
		startOfToday.setHours(0, 0, 0, 0);
		return data.calendar
			.filter((it) => new Date(it.date).getTime() >= startOfToday.getTime())
			.slice(0, 8);
	});

	// Soonest upcoming item drives the countdown banner (calendar is sorted asc).
	const nextItem = $derived(data.calendar.find((it) => new Date(it.date).getTime() >= now) ?? null);
	const countdown = $derived.by(() => {
		if (!nextItem) return '';
		let ms = new Date(nextItem.date).getTime() - now;
		if (ms < 0) ms = 0;
		const s = Math.floor(ms / 1000);
		const d = Math.floor(s / 86400);
		const h = Math.floor((s % 86400) / 3600);
		const m = Math.floor((s % 3600) / 60);
		const sec = s % 60;
		const pad = (n: number) => String(n).padStart(2, '0');
		return d > 0 ? `${d}d ${pad(h)}h ${pad(m)}m ${pad(sec)}s` : `${pad(h)}h ${pad(m)}m ${pad(sec)}s`;
	});

	const filteredMembers = $derived.by(() => {
		const q = search.trim().toLowerCase();
		const list = data.members.filter((m) => !q || m.rsn.toLowerCase().includes(q));
		const sorted = [...list];
		if (sortBy === 'vp') {
			sorted.sort((a, b) => b.points - a.points || a.rsn.localeCompare(b.rsn, undefined, { sensitivity: 'base' }));
		} else if (sortBy === 'rank') {
			sorted.sort((a, b) => rankIndex(b.rank) - rankIndex(a.rank) || a.rsn.localeCompare(b.rsn, undefined, { sensitivity: 'base' }));
		} else {
			sorted.sort((a, b) => a.rsn.localeCompare(b.rsn, undefined, { sensitivity: 'base' }));
		}
		return sorted;
	});

	const maxRankCount = $derived(Math.max(1, ...data.rankBreakdown.map((r) => r.count)));

	function prevMonth() {
		if (viewMonth === 0) {
			viewMonth = 11;
			viewYear -= 1;
		} else viewMonth -= 1;
	}
	function nextMonth() {
		if (viewMonth === 11) {
			viewMonth = 0;
			viewYear += 1;
		} else viewMonth += 1;
	}
	function goToday() {
		viewYear = today.getFullYear();
		viewMonth = today.getMonth();
		selectedKey = null;
	}
	function selectDay(d: Date) {
		const k = dayKey(d);
		selectedKey = selectedKey === k ? null : k;
	}

	function fmtDateTime(iso: string): string {
		return new Date(iso).toLocaleString(undefined, {
			month: 'short',
			day: 'numeric',
			hour: 'numeric',
			minute: '2-digit'
		});
	}
	function fmtTime(iso: string): string {
		return new Date(iso).toLocaleString(undefined, { hour: 'numeric', minute: '2-digit' });
	}
	function fmtJoined(iso: string | null): string {
		if (!iso) return '';
		return new Date(iso).toLocaleDateString(undefined, {
			month: 'short',
			day: 'numeric',
			year: 'numeric'
		});
	}
	function selectedHeading(key: string): string {
		const [y, m, d] = key.split('-').map(Number);
		return new Date(y, m - 1, d).toLocaleDateString(undefined, {
			weekday: 'long',
			month: 'long',
			day: 'numeric'
		});
	}

	function toLocalInput(iso: string | null): string {
		if (!iso) return '';
		const d = new Date(iso);
		const pad = (n: number) => String(n).padStart(2, '0');
		return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
	}

	function selectedHeadingDate(key: string): Date {
		const [y, m, d] = key.split('-').map(Number);
		return new Date(y, m - 1, d, 20, 0); // default 8pm on the picked day
	}
	function openCreate() {
		editingId = null;
		mTitle = '';
		mDesc = '';
		mStart = selectedKey ? toLocalInput(selectedHeadingDate(selectedKey).toISOString()) : '';
		mEnd = '';
		mLoc = '';
		mLink = '';
		mCat = 'event';
		showModal = true;
	}
	function openEdit(item: CalendarItem) {
		editingId = item.id;
		mTitle = item.title;
		mDesc = item.description ?? '';
		mStart = toLocalInput(item.date);
		mEnd = toLocalInput(item.endDate);
		mLoc = item.location ?? '';
		mLink = item.href ?? '';
		mCat = item.category ?? 'event';
		showModal = true;
	}
	function closeModal() {
		showModal = false;
	}

	const onMutate: SubmitFunction = ({ formData }) => {
		// Convert the local datetime-local values to UTC ISO before POST, so the
		// server stores the right instant regardless of its timezone (see datetime.ts).
		for (const f of ['starts_at', 'ends_at']) {
			const v = formData.get(f);
			if (typeof v === 'string' && v.trim()) {
				const iso = datetimeLocalToIso(v);
				if (iso) formData.set(f, iso);
			}
		}
		saving = true;
		return async ({ result, update }) => {
			await update();
			saving = false;
			if (result.type === 'success') closeModal();
		};
	};

	const onDelete: SubmitFunction = ({ cancel }) => {
		if (!confirm('Delete this calendar entry?')) {
			cancel();
			return;
		}
		saving = true;
		return async ({ update }) => {
			await update();
			saving = false;
		};
	};
</script>

<svelte:head>
	<title>Volition</title>
</svelte:head>

{#snippet rankBadge(rank: string | null, color: string, label: string)}
	{@const img = rankImg(rank)}
	{#if img}
		<img class="rank-img" src={img} alt={label} title={label} />
	{:else}
		<span class="rank-dot-wrap" title={label}>
			<span class="rank-dot" style="background:{color}"></span>
		</span>
	{/if}
{/snippet}

{#if !data.user}
	<!-- ── Public landing ── -->
	<section class="hero">
		<img src="/logo.png" alt="Volition clan logo" class="logo" />
		<h1>Volition</h1>
		<p class="tagline">An OSRS clan home for events, sign-ups, and bragging rights.</p>
		<a href="/auth/discord/login" class="cta">Sign in with Discord</a>
		<p class="small muted">We use Discord just to identify you. We never post on your behalf.</p>
	</section>

	<div class="public-stats">
		<div class="stat">
			<span class="stat-value">{data.stats.members}</span>
			<span class="stat-label">Members</span>
		</div>
		<div class="stat">
			<span class="stat-value">{data.stats.activeEvents}</span>
			<span class="stat-label">Active events</span>
		</div>
		<div class="stat">
			<span class="stat-value">{data.stats.totalEvents}</span>
			<span class="stat-label">Events all-time</span>
		</div>
	</div>

	{#if agendaItems.length > 0}
		<section class="panel teaser">
			<h2>What's coming up</h2>
			<ul class="agenda">
				{#each agendaItems as it (it.id)}
					<li class="agenda-item">
						<span class="cal-dot" style="background:{itemColor(it)}"></span>
						<div class="agenda-main">
							<span class="agenda-title">{it.title}</span>
							<span class="agenda-when">{fmtDateTime(it.date)}</span>
						</div>
					</li>
				{/each}
			</ul>
			<p class="muted small">Sign in to see the full calendar and member directory.</p>
		</section>
	{/if}
{:else}
	<!-- ── Member dashboard ── -->
	<section class="welcome">
		<div>
			<h1>Welcome back, {data.user.rsn}</h1>
			<p class="muted">Here's what's happening in Volition.</p>
		</div>
		{#if nextItem}
			{#if nextItem.href}
				<a class="countdown" href={nextItem.href}>
					<span class="cd-label">Next up</span>
					<span class="cd-title">{nextItem.title}</span>
					<span class="cd-time">{countdown}</span>
				</a>
			{:else}
				<div class="countdown">
					<span class="cd-label">Next up</span>
					<span class="cd-title">{nextItem.title}</span>
					<span class="cd-time">{countdown}</span>
				</div>
			{/if}
		{/if}
	</section>

	<div class="stat-strip">
		<div class="stat">
			<span class="stat-value">{data.stats.members}</span>
			<span class="stat-label">Members</span>
		</div>
		<div class="stat">
			<span class="stat-value">{data.stats.activeEvents}</span>
			<span class="stat-label">Active events</span>
		</div>
		<div class="stat">
			<span class="stat-value">{data.stats.totalEvents}</span>
			<span class="stat-label">Events all-time</span>
		</div>
		<div class="stat">
			<span class="stat-value">{data.stats.packsOpened}</span>
			<span class="stat-label">Packs opened</span>
		</div>
	</div>

	{#if data.taskSummary}
		<a class="todo-card" href="/tasks">
			<div class="todo-text">
				<span class="todo-label">Your to-do</span>
				<span class="todo-line">
					{#if data.taskSummary.todoCount > 0}
						<strong>{data.taskSummary.todoCount}</strong>
						{data.taskSummary.todoCount === 1 ? 'thing' : 'things'} to do
					{:else}
						All caught up
					{/if}
				</span>
			</div>
			<span class="todo-go">View all →</span>
		</a>
	{/if}

	{#if form?.error}
		<div class="err">{form.error}</div>
	{/if}

	<div class="grid">
		<!-- Calendar -->
		<section class="panel calendar-panel">
			<div class="cal-head">
				<h2>{MONTHS[viewMonth]} {viewYear}</h2>
				<div class="cal-nav">
					<button class="icon-btn" onclick={prevMonth} aria-label="Previous month">‹</button>
					<button class="today-btn" onclick={goToday}>Today</button>
					<button class="icon-btn" onclick={nextMonth} aria-label="Next month">›</button>
					{#if data.isAdmin}
						<button class="add-btn" onclick={openCreate}>+ Add</button>
					{/if}
				</div>
			</div>

			<div class="cal-grid">
				{#each WEEKDAYS as wd (wd)}
					<div class="weekday">{wd}</div>
				{/each}
				{#each weeks as week, wi (wi)}
					{#each week as cell, ci (ci)}
						{#if cell}
							{@const k = dayKey(cell)}
							{@const dayItems = itemsByDay.get(k) ?? []}
							<button
								class="day"
								class:today={k === todayKey}
								class:selected={k === selectedKey}
								class:has-items={dayItems.length > 0}
								onclick={() => selectDay(cell)}
							>
								<span class="daynum">{cell.getDate()}</span>
								{#if dayItems.length > 0}
									<span class="pills">
										{#each dayItems.slice(0, 2) as it (it.id)}
											<span class="pill" style="--c:{itemColor(it)}">{it.title}</span>
										{/each}
										{#if dayItems.length > 2}
											<span class="more">+{dayItems.length - 2} more</span>
										{/if}
									</span>
									<span class="count-badge">{dayItems.length}</span>
								{/if}
							</button>
						{:else}
							<div class="day empty"></div>
						{/if}
					{/each}
				{/each}
			</div>

			<div class="agenda-head">
				<h3>{selectedKey ? selectedHeading(selectedKey) : 'Upcoming'}</h3>
				{#if selectedKey}
					<button class="link-btn" onclick={() => (selectedKey = null)}>Show upcoming</button>
				{/if}
			</div>

			{#if agendaItems.length === 0}
				<p class="muted small">Nothing scheduled.</p>
			{:else}
				<ul class="agenda">
					{#each agendaItems as it (it.id)}
						<li class="agenda-item">
							<span class="cal-dot" style="background:{itemColor(it)}"></span>
							<div class="agenda-main">
								<div class="agenda-top">
									{#if it.href}
										<a href={it.href} class="agenda-title">{it.title}</a>
									{:else}
										<span class="agenda-title">{it.title}</span>
									{/if}
									<span class="agenda-when">
										{selectedKey ? fmtTime(it.date) : fmtDateTime(it.date)}
									</span>
								</div>
								{#if it.location || it.description}
									<div class="agenda-sub muted">
										{#if it.location}<span>📍 {it.location}</span>{/if}
										{#if it.description}<span>{it.description}</span>{/if}
									</div>
								{/if}
							</div>
							{#if data.isAdmin && it.editable}
								<div class="agenda-actions">
									<button class="mini" onclick={() => openEdit(it)}>Edit</button>
									<form method="POST" action="?/deleteCalendarEntry" use:enhance={onDelete}>
										<input type="hidden" name="id" value={it.id} />
										<button class="mini danger" aria-label="Delete">✕</button>
									</form>
								</div>
							{/if}
						</li>
					{/each}
				</ul>
			{/if}
		</section>

		<!-- Clan stats -->
		<aside class="side">
			<section class="panel">
				<h2>Rank breakdown</h2>
				{#if data.rankBreakdown.length === 0}
					<p class="muted small">No ranked members yet.</p>
				{:else}
					<div class="bars">
						{#each data.rankBreakdown as r (r.value)}
							<div class="bar-row">
								<span class="bar-label">{@render rankBadge(r.value, r.color, r.label)}{r.label}</span>
								<div class="bar-track">
									<div class="bar-fill" style="width:{(r.count / maxRankCount) * 100}%; background:{r.color}"></div>
								</div>
								<span class="bar-count">{r.count}</span>
							</div>
						{/each}
					</div>
				{/if}
			</section>

			<section class="panel">
				<h2>Recently joined</h2>
				{#if data.recentMembers.length === 0}
					<p class="muted small">No members yet.</p>
				{:else}
					<ul class="recent">
						{#each data.recentMembers as m (m.rsn)}
							<li>
								{@render rankBadge(m.rank, rankColor(m.rank), rankLabel(m.rank))}
								{#if canViewProfiles && m.hasProfile}
									<a href={`/u/${rsnToSlug(m.rsn)}`} class="recent-name">{m.rsn}</a>
								{:else}
									<span class="recent-name">{m.rsn}</span>
								{/if}
								<span class="recent-when muted">{fmtJoined(m.joinedAt)}</span>
							</li>
						{/each}
					</ul>
				{/if}
			</section>
		</aside>
	</div>

	<!-- Member lookup -->
	<section class="panel lookup">
		<div class="lookup-head">
			<h2>Members</h2>
			<div class="filters">
				<input class="search" type="search" placeholder="Search by RSN…" bind:value={search} />
				<select bind:value={sortBy} aria-label="Sort members">
					<option value="rsn">RSN A–Z</option>
					<option value="vp">VP high→low</option>
					<option value="rank">Rank high→low</option>
				</select>
			</div>
		</div>
		<p class="muted small">{filteredMembers.length} of {data.members.length} members</p>

		<div class="table-wrap">
			<table>
				<thead>
					<tr>
						<th>RSN</th>
						<th>Rank</th>
						<th class="vp-col">VP</th>
					</tr>
				</thead>
				<tbody>
					{#each filteredMembers as m (m.rsn)}
						<tr>
							<td class="rsn-cell">
								{#if canViewProfiles && m.hasProfile}
									<a href={`/u/${rsnToSlug(m.rsn)}`}>{m.rsn}</a>
								{:else}
									{m.rsn}
								{/if}
							</td>
							<td>
								<span class="rank-pill">
									{@render rankBadge(m.rank, rankColor(m.rank), rankLabel(m.rank))}
									{rankLabel(m.rank)}
								</span>
							</td>
							<td class="vp-col value">{m.points.toLocaleString()}</td>
						</tr>
					{/each}
					{#if filteredMembers.length === 0}
						<tr><td colspan="3" class="muted empty-row">No members match.</td></tr>
					{/if}
				</tbody>
			</table>
		</div>
	</section>

	<!-- Admin add/edit modal -->
	{#if showModal}
		<div
			class="modal-backdrop"
			role="button"
			tabindex="0"
			onclick={closeModal}
			onkeydown={(e) => e.key === 'Escape' && closeModal()}
		>
			<div
				class="modal"
				role="dialog"
				aria-modal="true"
				tabindex="-1"
				onclick={(e) => e.stopPropagation()}
				onkeydown={(e) => e.stopPropagation()}
			>
				<h2>{editingId ? 'Edit calendar entry' : 'New calendar entry'}</h2>
				<form
					method="POST"
					action={editingId ? '?/updateCalendarEntry' : '?/createCalendarEntry'}
					use:enhance={onMutate}
				>
					{#if editingId}<input type="hidden" name="id" value={editingId} />{/if}

					<label>
						<span>Title</span>
						<input name="title" maxlength="120" required bind:value={mTitle} placeholder="e.g. Sunday CoX night" />
					</label>

					<div class="row">
						<label>
							<span>Starts</span>
							<input name="starts_at" type="datetime-local" required bind:value={mStart} />
						</label>
						<label>
							<span>Ends (optional)</span>
							<input name="ends_at" type="datetime-local" bind:value={mEnd} />
						</label>
					</div>

					<div class="row">
						<label>
							<span>Category</span>
							<select name="category" bind:value={mCat}>
								{#each data.categoryOptions as c (c.value)}
									<option value={c.value}>{c.label}</option>
								{/each}
							</select>
						</label>
						<label>
							<span>Location (optional)</span>
							<input name="location" maxlength="120" bind:value={mLoc} placeholder="e.g. Discord, CoX" />
						</label>
					</div>

					<label>
						<span>Link (optional)</span>
						<input name="link_url" maxlength="500" bind:value={mLink} placeholder="https://…" />
					</label>

					<label>
						<span>Description (optional)</span>
						<textarea name="description" maxlength="2000" rows="3" bind:value={mDesc}></textarea>
					</label>

					{#if form?.error}<div class="err">{form.error}</div>{/if}

					<div class="modal-actions">
						<button type="button" class="ghost" onclick={closeModal}>Cancel</button>
						<button type="submit" class="primary" disabled={saving}>
							{saving ? 'Saving…' : editingId ? 'Save' : 'Add entry'}
						</button>
					</div>
				</form>
			</div>
		</div>
	{/if}
{/if}

<style>
	/* ── Public landing ── */
	.hero {
		max-width: 32rem;
		margin: 2rem auto 1.5rem;
		text-align: center;
		padding: 2rem 1.5rem;
		background: #3a3024;
		border: 1px solid var(--border);
		border-radius: var(--radius);
		box-shadow: inset 0 0 0 1px rgba(255, 152, 31, 0.05), 0 4px 24px rgba(0, 0, 0, 0.6);
	}
	.logo {
		width: 128px;
		height: 128px;
		object-fit: contain;
		margin-bottom: 1rem;
		filter: drop-shadow(2px 2px 0 #000) drop-shadow(0 0 12px rgba(255, 152, 31, 0.25));
	}
	.hero h1 {
		font-size: clamp(2.5rem, 7vw, 4rem);
		letter-spacing: 2px;
		margin: 0 0 0.5rem;
	}
	.tagline {
		color: rgba(255, 255, 255, 0.7);
		font-size: 1.1rem;
		margin-bottom: 1.5rem;
	}
	.cta {
		display: inline-block;
		background: var(--surface);
		border: 1px solid var(--border-strong);
		color: var(--accent);
		padding: 10px 24px;
		border-radius: var(--radius);
		font-family: var(--font-heading);
		font-size: 1.1rem;
		letter-spacing: 1px;
		text-decoration: none;
		text-shadow: var(--ts-strong);
		transition: background 0.15s, border-color 0.15s;
	}
	.cta:hover {
		background: var(--border);
		border-color: var(--accent);
		text-decoration: none;
	}
	.small {
		font-size: 0.9rem;
		margin-top: 1.25rem;
	}
	.public-stats {
		display: flex;
		justify-content: center;
		gap: 1rem;
		flex-wrap: wrap;
		margin: 0 auto 1.5rem;
		max-width: 32rem;
	}
	.teaser {
		max-width: 36rem;
		margin: 0 auto;
	}

	/* ── Welcome + countdown ── */
	.welcome {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 1rem;
		flex-wrap: wrap;
		margin-bottom: 1.25rem;
	}
	.welcome h1 {
		margin: 0 0 0.15rem;
	}
	.countdown {
		display: flex;
		flex-direction: column;
		align-items: flex-end;
		gap: 0.1rem;
		padding: 0.55rem 0.95rem;
		background: linear-gradient(180deg, rgba(58, 48, 36, 0.9), rgba(40, 32, 24, 0.9));
		border: 1px solid var(--accent);
		border-radius: var(--radius);
		text-decoration: none;
		color: var(--text);
		box-shadow: var(--shadow-card);
		min-width: 0;
		max-width: 100%;
	}
	a.countdown:hover {
		background: var(--border);
		text-decoration: none;
	}
	.cd-label {
		font-size: 0.7rem;
		text-transform: uppercase;
		letter-spacing: 0.08em;
		color: var(--muted);
	}
	.cd-title {
		font-family: var(--font-heading);
		color: var(--accent);
		text-shadow: var(--ts);
		max-width: 18rem;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.cd-time {
		font-family: var(--font-heading);
		color: var(--yellow);
		text-shadow: var(--ts);
		font-size: 1.1rem;
		font-variant-numeric: tabular-nums;
	}

	/* ── Stat cards ── */
	.stat-strip,
	.public-stats {
		display: grid;
		grid-template-columns: repeat(4, 1fr);
		gap: 0.75rem;
		margin-bottom: 1.5rem;
	}
	.public-stats {
		grid-template-columns: repeat(3, 1fr);
	}
	.stat {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 0.15rem;
		padding: 0.9rem 0.5rem;
		background: linear-gradient(180deg, rgba(58, 48, 36, 0.85), rgba(40, 32, 24, 0.85));
		border: 1px solid var(--border);
		border-radius: var(--radius);
		box-shadow: var(--shadow-card);
	}
	.stat-value {
		font-family: var(--font-heading);
		font-size: 1.7rem;
		color: var(--yellow);
		text-shadow: var(--ts);
		line-height: 1;
	}
	.stat-label {
		font-size: 0.8rem;
		color: var(--muted);
		text-align: center;
	}

	/* ── To-do summary card ── */
	.todo-card {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 1rem;
		margin-bottom: 1rem;
		padding: 0.85rem 1.1rem;
		text-decoration: none;
		color: var(--text);
		background: linear-gradient(180deg, rgba(255, 152, 31, 0.1), rgba(40, 32, 24, 0.6));
		border: 1px solid rgba(255, 152, 31, 0.4);
		border-radius: var(--radius);
		box-shadow: var(--shadow-card);
		transition: border-color 0.12s ease, transform 0.12s ease;
	}
	.todo-card:hover {
		border-color: var(--accent);
		transform: translateY(-1px);
	}
	.todo-text {
		display: flex;
		flex-direction: column;
		gap: 0.1rem;
	}
	.todo-label {
		font-size: 0.7rem;
		text-transform: uppercase;
		letter-spacing: 0.04em;
		color: var(--accent);
	}
	.todo-line {
		font-family: var(--font-heading);
		font-size: 1.05rem;
		text-shadow: var(--ts);
	}
	.todo-go {
		font-family: var(--font-heading);
		color: var(--accent);
		font-size: 0.9rem;
		white-space: nowrap;
	}

	/* ── Layout grid ── */
	.grid {
		display: grid;
		grid-template-columns: minmax(0, 2fr) minmax(0, 1fr);
		gap: 1rem;
		align-items: start;
		margin-bottom: 1.5rem;
	}
	.side {
		display: flex;
		flex-direction: column;
		gap: 1rem;
		min-width: 0;
	}

	.panel {
		background: linear-gradient(180deg, rgba(58, 48, 36, 0.6), rgba(40, 32, 24, 0.6));
		border: 1px solid var(--border);
		border-radius: var(--radius);
		padding: 1.1rem 1.25rem;
		box-shadow: var(--shadow-card);
		min-width: 0;
	}
	.panel h2 {
		margin: 0 0 0.85rem;
	}

	/* ── Calendar ── */
	.cal-head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 0.75rem;
		margin-bottom: 0.85rem;
		flex-wrap: wrap;
	}
	.cal-head h2 {
		margin: 0;
	}
	.cal-nav {
		display: flex;
		align-items: center;
		gap: 0.4rem;
	}
	.icon-btn {
		min-width: 2.1rem;
		padding: 0.3rem 0.5rem;
		font-size: 1.2rem;
		line-height: 1;
	}
	.today-btn,
	.add-btn {
		padding: 0.35rem 0.7rem;
		font-size: 0.9rem;
	}
	.add-btn {
		border-color: var(--accent);
		color: var(--accent);
	}
	.cal-grid {
		display: grid;
		grid-template-columns: repeat(7, 1fr);
		gap: 4px;
	}
	.weekday {
		text-align: center;
		font-size: 0.72rem;
		text-transform: uppercase;
		letter-spacing: 0.05em;
		color: var(--muted);
		padding-bottom: 0.25rem;
	}
	.day {
		position: relative;
		display: flex;
		flex-direction: column;
		align-items: stretch;
		gap: 2px;
		padding: 0.3rem;
		min-height: 4.75rem;
		background: var(--surface-alt);
		border: 1px solid var(--border);
		border-radius: 3px;
		color: var(--text);
		text-shadow: var(--ts);
		cursor: pointer;
		overflow: hidden;
		transition: border-color 0.12s, background 0.12s;
	}
	.day:hover:not(.empty) {
		border-color: var(--accent);
	}
	.day.empty {
		background: transparent;
		border-color: transparent;
		cursor: default;
		min-height: 0;
	}
	.day.has-items {
		background: rgba(255, 152, 31, 0.07);
		border-color: var(--border-strong);
	}
	.day.today {
		border-color: var(--accent);
		box-shadow: inset 0 0 0 1px var(--accent);
	}
	.day.selected {
		background: var(--accent-soft);
		border-color: var(--accent);
	}
	.daynum {
		font-size: 0.8rem;
		font-family: var(--font-heading);
		text-align: left;
	}
	.day.today .daynum {
		color: var(--accent);
	}
	.pills {
		display: flex;
		flex-direction: column;
		gap: 2px;
		min-width: 0;
	}
	.pill {
		display: block;
		font-size: 0.64rem;
		line-height: 1.3;
		padding: 1px 4px;
		border-left: 3px solid var(--c);
		background: color-mix(in srgb, var(--c) 20%, transparent);
		border-radius: 2px;
		color: var(--text);
		text-shadow: none;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		text-align: left;
	}
	.more {
		font-size: 0.62rem;
		color: var(--muted);
		padding-left: 2px;
	}
	.count-badge {
		display: none;
		position: absolute;
		top: 2px;
		right: 2px;
		min-width: 1.05rem;
		height: 1.05rem;
		padding: 0 0.2rem;
		font-size: 0.68rem;
		font-family: var(--font-heading);
		line-height: 1.05rem;
		text-align: center;
		color: #1a1208;
		background: var(--accent);
		border-radius: 999px;
		text-shadow: none;
	}

	.agenda-head {
		display: flex;
		align-items: baseline;
		justify-content: space-between;
		gap: 0.75rem;
		margin: 1.1rem 0 0.5rem;
	}
	.agenda-head h3 {
		margin: 0;
		color: var(--accent);
	}
	.link-btn {
		background: none;
		border: none;
		padding: 0;
		min-height: 0;
		color: var(--accent);
		font-size: 0.85rem;
		text-decoration: underline;
	}
	.link-btn:hover {
		background: none;
		color: var(--yellow);
	}
	.agenda {
		list-style: none;
		margin: 0;
		padding: 0;
		display: flex;
		flex-direction: column;
		gap: 0.35rem;
	}
	.agenda-item {
		display: flex;
		align-items: flex-start;
		gap: 0.6rem;
		padding: 0.5rem 0.6rem;
		background: var(--surface-alt);
		border: 1px solid var(--border);
		border-radius: 3px;
	}
	.cal-dot {
		width: 10px;
		height: 10px;
		border-radius: 50%;
		margin-top: 0.3rem;
		flex-shrink: 0;
	}
	.agenda-main {
		flex: 1;
		min-width: 0;
	}
	.agenda-top {
		display: flex;
		align-items: baseline;
		justify-content: space-between;
		gap: 0.6rem;
	}
	.agenda-title {
		font-family: var(--font-heading);
		color: var(--text);
		text-shadow: var(--ts);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	a.agenda-title:hover {
		color: var(--accent);
		text-decoration: none;
	}
	.agenda-when {
		font-size: 0.82rem;
		color: var(--yellow);
		font-family: var(--font-heading);
		white-space: nowrap;
		flex-shrink: 0;
	}
	.agenda-sub {
		display: flex;
		gap: 0.6rem;
		flex-wrap: wrap;
		font-size: 0.82rem;
		margin-top: 0.15rem;
	}
	.agenda-actions {
		display: flex;
		align-items: center;
		gap: 0.3rem;
		flex-shrink: 0;
	}
	.mini {
		padding: 0.2rem 0.45rem;
		font-size: 0.78rem;
		min-height: 0;
	}
	.mini.danger {
		color: var(--danger);
		border-color: var(--danger);
	}

	/* ── Rank breakdown ── */
	.bars {
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
	}
	.bar-row {
		display: grid;
		grid-template-columns: 6.5rem 1fr 2rem;
		align-items: center;
		gap: 0.5rem;
	}
	.bar-label {
		display: flex;
		align-items: center;
		gap: 0.4rem;
		font-size: 0.85rem;
		color: var(--muted);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.rank-dot-wrap {
		width: 18px;
		height: 18px;
		flex-shrink: 0;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		vertical-align: middle;
	}
	.rank-dot {
		width: 9px;
		height: 9px;
		border-radius: 50%;
		flex-shrink: 0;
		display: inline-block;
	}
	.rank-img {
		width: 18px;
		height: 18px;
		flex-shrink: 0;
		object-fit: contain;
		vertical-align: middle;
		image-rendering: -webkit-optimize-contrast;
	}
	.bar-track {
		height: 0.6rem;
		background: var(--surface-alt);
		border-radius: 999px;
		overflow: hidden;
	}
	.bar-fill {
		height: 100%;
		border-radius: 999px;
		min-width: 2px;
	}
	.bar-count {
		text-align: right;
		font-family: var(--font-heading);
		color: var(--yellow);
		font-size: 0.9rem;
	}

	/* ── Recently joined ── */
	.recent {
		list-style: none;
		margin: 0;
		padding: 0;
		display: flex;
		flex-direction: column;
		gap: 0.4rem;
	}
	.recent li {
		display: flex;
		align-items: center;
		gap: 0.5rem;
	}
	.recent-name {
		flex: 1;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.recent-when {
		font-size: 0.8rem;
		flex-shrink: 0;
	}

	/* ── Member lookup ── */
	.lookup-head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 1rem;
		flex-wrap: wrap;
	}
	.lookup-head h2 {
		margin: 0;
	}
	.filters {
		display: flex;
		gap: 0.5rem;
		flex-wrap: wrap;
	}
	.search {
		min-width: 12rem;
	}
	.table-wrap {
		overflow-x: auto;
		margin-top: 0.5rem;
	}
	table {
		width: 100%;
		border-collapse: collapse;
	}
	th,
	td {
		text-align: left;
		padding: 0.5rem 0.6rem;
		border-bottom: 1px solid var(--border);
	}
	th {
		font-size: 0.75rem;
		text-transform: uppercase;
		letter-spacing: 0.05em;
		color: var(--muted);
		font-weight: normal;
	}
	tbody tr:hover {
		background: var(--surface-alt);
	}
	.rsn-cell {
		font-family: var(--font-heading);
	}
	.rank-pill {
		display: inline-flex;
		align-items: center;
		gap: 0.4rem;
		font-size: 0.9rem;
	}
	.vp-col {
		text-align: right;
		white-space: nowrap;
	}
	.empty-row {
		text-align: center;
		padding: 1.5rem;
	}

	/* ── Modal ── */
	.modal-backdrop {
		position: fixed;
		inset: 0;
		background: rgba(0, 0, 0, 0.65);
		backdrop-filter: blur(3px);
		display: flex;
		align-items: center;
		justify-content: center;
		padding: 1rem;
		z-index: 100;
	}
	.modal {
		width: 100%;
		max-width: 32rem;
		max-height: 90vh;
		overflow-y: auto;
		background: var(--surface);
		border: 1px solid var(--border-strong);
		border-radius: var(--radius-lg);
		padding: 1.25rem 1.4rem;
		box-shadow: 0 12px 48px rgba(0, 0, 0, 0.7);
	}
	.modal h2 {
		margin: 0 0 1rem;
	}
	.modal form {
		display: flex;
		flex-direction: column;
		gap: 0.7rem;
	}
	.modal label {
		display: flex;
		flex-direction: column;
		gap: 0.3rem;
	}
	.modal label span {
		font-size: 0.82rem;
		color: var(--muted);
	}
	.modal .row {
		display: grid;
		grid-template-columns: 1fr 1fr;
		gap: 0.7rem;
	}
	.modal-actions {
		display: flex;
		justify-content: flex-end;
		gap: 0.6rem;
		margin-top: 0.4rem;
	}
	.modal .primary {
		border-color: var(--accent);
		color: var(--accent);
		font-family: var(--font-heading);
	}
	.modal .ghost {
		color: var(--muted);
	}

	.err {
		background: var(--danger-bg);
		border: 1px solid var(--danger);
		color: #ffb3b3;
		padding: 0.5rem 0.7rem;
		border-radius: var(--radius);
		margin-bottom: 1rem;
		font-size: 0.9rem;
	}
	.muted {
		color: var(--muted);
	}

	@media (max-width: 820px) {
		.grid {
			grid-template-columns: 1fr;
		}
		.cd-title {
			max-width: 12rem;
		}
	}

	@media (max-width: 560px) {
		.stat-strip {
			grid-template-columns: repeat(2, 1fr);
		}
		.public-stats {
			grid-template-columns: repeat(3, 1fr);
		}
		.stat-value {
			font-size: 1.4rem;
		}
		.welcome {
			align-items: flex-start;
		}
		.countdown {
			align-items: flex-start;
			width: 100%;
		}
		.day {
			min-height: 2.6rem;
			padding: 0.2rem;
		}
		.daynum {
			font-size: 0.72rem;
		}
		.pills {
			display: none;
		}
		.count-badge {
			display: block;
		}
		.filters {
			width: 100%;
		}
		.search {
			flex: 1;
			min-width: 0;
		}
	}
</style>

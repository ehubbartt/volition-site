<script lang="ts">
	import '../app.css';
	import { page, navigating } from '$app/state';
	import AccountIcon from '$lib/AccountIcon.svelte';
	import type { LayoutData } from './$types';

	let { data, children }: { data: LayoutData; children: import('svelte').Snippet } = $props();

	let path = $derived(page.url.pathname);
	let menuOpen = $state(false);

	// Collapse the mobile menu whenever the route changes.
	$effect(() => {
		path;
		menuOpen = false;
	});
</script>

<!-- Feedback while a navigation's data is in flight — but only for SLOW ones: the
     bar stays invisible for its first 150ms, so fast navigations show nothing and
     feel instant instead of flashing a loading bar. -->
{#if navigating.to}
	<div class="nav-progress" aria-hidden="true"></div>
{/if}

<header>
	<div class="container nav">
		<a href="/" class="brand">
			<img src="/logo.png" alt="" class="brand-logo" />
			<span>Volition</span>
		</a>

		{#if data.user && !data.banned}
			<button
				type="button"
				class="menu-toggle"
				aria-label="Toggle menu"
				aria-expanded={menuOpen}
				onclick={() => (menuOpen = !menuOpen)}
			>
				<span class="bars" class:open={menuOpen}></span>
			</button>

			<nav class="primary-nav" class:open={menuOpen}>
				<a href="/events" class:active={path.startsWith('/events')}>Events</a>
				<a href="/tasks" class:active={path.startsWith('/tasks')}>To Do</a>
				<a href="/gamba" class:active={path.startsWith('/gamba')}>Gamba</a>
				{#if data.isAdmin || data.isCardTester}
					<a href="/admin" class:active={path.startsWith('/admin')}>Admin</a>
				{/if}
				<!-- Shown ONLY while a view-as preview is active (started from /admin —
				     which is unreachable in a preview, so this chip is the way back).
				     NATIVE form on purpose: the full reload wipes the client swr cache. -->
				{#if data.viewAs}
					<form method="POST" action="/admin/view-as" class="view-as" title="Exit the role preview">
						<input type="hidden" name="role" value="super" />
						<button type="submit">
							Viewing as {data.viewAs === 'admin' ? 'Admin' : data.viewAs === 'member' ? 'Member' : 'Non-member'} ✕
						</button>
					</form>
				{/if}
			</nav>

			<a href="/me" class="user-pill" class:active={path === '/me'} title="Profile">
				<AccountIcon type={data.user.account_type} size={22} />
				<span class="user-name">{data.user.rsn ?? data.user.discord_username}</span>
			</a>
		{:else if !data.user}
			<a href="/auth/discord/login" class="cta">Sign in with Discord</a>
		{/if}
	</div>
</header>

<main class="container page">
	{@render children()}
</main>

<footer>
	<div class="container footer-row">
		<span class="muted">Volition · OSRS <span class="credit">— site &amp; Discord bot by Bajj</span></span>
		<a
			class="discord-link"
			href="https://discord.gg/fwFPKzJkSJ"
			target="_blank"
			rel="noopener noreferrer"
		>
			Join our Discord →
		</a>
	</div>
</footer>

<style>
	.container {
		max-width: 1100px;
		margin: 0 auto;
		padding: 0 1rem;
	}

	header {
		position: sticky;
		top: 0;
		z-index: 50;
		border-bottom: 2px solid var(--gold-mid);
		background-color: rgba(20, 16, 10, 0.98);
		background-image: url('/osrs/tile-dark.png');
		background-repeat: repeat;
		box-shadow: inset 0 1px 0 rgba(255, 232, 180, 0.16);
		backdrop-filter: blur(8px);
		-webkit-backdrop-filter: blur(8px);
	}

	.nav {
		display: flex;
		align-items: center;
		gap: 1rem;
		padding: 0.75rem 1rem;
		min-width: 0;
	}

	.brand {
		display: flex;
		align-items: center;
		gap: 0.6rem;
		font-family: var(--font-heading);
		font-size: 1.7rem;
		letter-spacing: 1px;
		color: var(--accent);
		text-decoration: none;
		text-shadow: 2px 2px #000;
		flex: 0 0 auto;
		margin-right: auto;
	}

	.brand:hover {
		text-decoration: none;
	}

	.brand-logo {
		width: 36px;
		height: 36px;
		object-fit: contain;
		image-rendering: -webkit-optimize-contrast;
		filter: drop-shadow(1px 1px 0 #000);
	}

	.primary-nav {
		display: flex;
		align-items: center;
		gap: 0.25rem;
	}

	.primary-nav a {
		color: rgba(255, 255, 255, 0.7);
		text-decoration: none;
		text-shadow: 1px 1px #000;
		font-size: 1rem;
		padding: 0.45rem 0.85rem;
		border-radius: 4px;
		border: 1px solid transparent;
		transition: color 0.15s, background 0.15s, border-color 0.15s;
	}

	.primary-nav a:hover {
		color: var(--accent);
		background: rgba(255, 152, 31, 0.08);
	}

	.primary-nav a.active {
		color: var(--accent);
		background: #4d4336;
		border: 9px solid transparent;
		border-image: url('/osrs/button.png') 9 / 9px stretch;
		padding: 0 0.55rem;
	}

	/* Mobile hamburger — hidden on desktop, shown in the narrow media query below. */
	.menu-toggle {
		display: none;
		background: none;
		border: none;
		cursor: pointer;
		padding: 0.45rem;
		margin-left: 0.25rem;
	}

	.bars,
	.bars::before,
	.bars::after {
		display: block;
		width: 22px;
		height: 2px;
		background: var(--accent);
		border-radius: 2px;
		transition: transform 0.2s ease, top 0.2s ease, background 0.2s ease;
	}

	.bars {
		position: relative;
	}

	.bars::before,
	.bars::after {
		content: '';
		position: absolute;
		left: 0;
	}

	.bars::before {
		top: -7px;
	}

	.bars::after {
		top: 7px;
	}

	.bars.open {
		background: transparent;
	}

	.bars.open::before {
		top: 0;
		transform: rotate(45deg);
	}

	.bars.open::after {
		top: 0;
		transform: rotate(-45deg);
	}

	.user-pill {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		padding: 0.2rem 0.85rem;
		background: #4d4336;
		border: 9px solid transparent;
		border-image: url('/osrs/button.png') 9 / 9px stretch;
		color: var(--accent);
		text-decoration: none;
		text-shadow: 1px 1px #000;
		font-size: 0.95rem;
		transition: background 0.15s;
	}

	.user-pill:hover,
	.user-pill.active {
		background: #423726;
		text-decoration: none;
	}

	.user-name {
		display: inline-block;
		max-width: 10rem;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		vertical-align: middle;
	}

	.cta {
		background: #4d4336;
		border: 9px solid transparent;
		border-image: url('/osrs/button.png') 9 / 9px stretch;
		color: var(--accent);
		padding: 0.3rem 1rem;
		text-decoration: none;
	}

	.cta:hover {
		background: #423726;
		text-decoration: none;
	}

	main.page {
		padding: 2rem 1rem 4rem;
		min-height: calc(100vh - 8rem);
	}

	.nav-progress {
		position: fixed;
		top: 0;
		left: 0;
		right: 0;
		height: 3px;
		z-index: 1000;
		background: linear-gradient(90deg, transparent, #d9b65e, transparent);
		background-size: 40% 100%;
		background-repeat: no-repeat;
		/* Invisible for the first 150ms (sub-150ms navigations never show it), then
		   fade in and slide. */
		opacity: 0;
		animation:
			nav-progress-appear 0.15s linear 0.15s forwards,
			nav-progress-slide 1s ease-in-out infinite;
	}

	@keyframes nav-progress-appear {
		to {
			opacity: 1;
		}
	}

	@keyframes nav-progress-slide {
		from {
			background-position: -40% 0;
		}
		to {
			background-position: 140% 0;
		}
	}

	footer {
		border-top: 2px solid #0c0904;
		background-color: rgba(20, 16, 10, 0.98);
		background-image: url('/osrs/tile-dark.png');
		background-repeat: repeat;
		box-shadow: inset 0 2px 0 rgba(217, 182, 94, 0.22);
		padding: 1rem 0;
		margin-top: 2rem;
	}

	.footer-row {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 0.75rem;
		flex-wrap: wrap;
	}

	.discord-link {
		color: var(--accent);
		font-size: 0.9rem;
		text-decoration: none;
		text-shadow: 1px 1px #000;
	}

	.discord-link:hover {
		text-decoration: underline;
	}

	.muted {
		color: rgba(255, 255, 255, 0.4);
		font-size: 0.9rem;
	}

	.credit {
		color: rgba(255, 255, 255, 0.3);
		font-size: 0.8rem;
	}

	@media (max-width: 720px) {
		.nav {
			gap: 0.6rem;
			padding: 0.6rem 0.75rem;
		}

		.brand {
			font-size: 1.35rem;
			letter-spacing: 1px;
			gap: 0.45rem;
		}

		.brand-logo {
			width: 30px;
			height: 30px;
		}

		.menu-toggle {
			display: inline-flex;
			align-items: center;
		}

		/* Collapse the links into a dropdown panel under the header. */
		.primary-nav {
			display: none;
			position: absolute;
			top: 100%;
			left: 0;
			right: 0;
			flex-direction: column;
			align-items: stretch;
			gap: 0.15rem;
			padding: 0.5rem;
			background-color: rgba(20, 16, 10, 0.99);
			background-image: url('/osrs/tile-dark.png');
			background-repeat: repeat;
			border-bottom: 2px solid var(--gold-mid);
			box-shadow: 0 10px 18px rgba(0, 0, 0, 0.45);
		}

		.primary-nav.open {
			display: flex;
		}

		.primary-nav a {
			padding: 0.65rem 0.8rem;
			font-size: 1.05rem;
		}

		.primary-nav a.active {
			border: 1px solid var(--gold-mid);
			background: rgba(255, 152, 31, 0.12);
			padding: 0.65rem 0.8rem;
		}

		.user-name {
			max-width: 7rem;
		}
	}

	@media (max-width: 480px) {
		.brand span {
			display: none;
		}

		.brand-logo {
			width: 32px;
			height: 32px;
		}

		.user-pill {
			padding: 0.4rem 0.55rem;
			gap: 0.35rem;
		}

		.user-name {
			display: none;
		}

		main.page {
			padding: 1.25rem 0.75rem 3rem;
		}
	}

	/* View-as exit chip: only exists while a preview is active (the picker lives
	   on /admin). Accent so the not-your-real-role state is unmissable. */
	.view-as {
		display: flex;
		align-items: center;
	}
	.view-as button {
		background: transparent;
		color: var(--accent);
		border: 1px solid var(--accent);
		border-radius: 999px;
		padding: 0.25rem 0.7rem;
		font: inherit;
		font-size: 0.78rem;
		cursor: pointer;
		white-space: nowrap;
	}
	.view-as button:hover {
		background: rgba(255, 152, 31, 0.12);
	}
</style>

<script lang="ts">
	import '../app.css';
	import { page } from '$app/state';
	import AccountIcon from '$lib/AccountIcon.svelte';
	import type { LayoutData } from './$types';

	let { data, children }: { data: LayoutData; children: import('svelte').Snippet } = $props();

	let path = $derived(page.url.pathname);
</script>

<header>
	<div class="container nav">
		<a href="/" class="brand">
			<img src="/logo.png" alt="" class="brand-logo" />
			<span>Volition</span>
		</a>

		{#if data.user}
			<nav class="primary-nav">
				<a href="/events" class:active={path.startsWith('/events')}>Events</a>
				{#if data.isAdmin}
					<a href="/admin/events" class:active={path.startsWith('/admin')}>Admin</a>
				{/if}
			</nav>

			<a href="/me" class="user-pill" class:active={path === '/me'} title="Profile">
				<AccountIcon type={data.user.account_type} size={22} />
				<span class="user-name">{data.user.rsn ?? data.user.discord_username}</span>
			</a>
		{:else}
			<a href="/auth/discord/login" class="cta">Sign in with Discord</a>
		{/if}
	</div>
</header>

<main class="container page">
	{#key path}
		<div class="page-fade">
			{@render children()}
		</div>
	{/key}
</main>

<footer>
	<div class="container">
		<span class="muted">Volition · OSRS</span>
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
		border-bottom: 1px solid #4d4336;
		background: rgba(0, 0, 0, 0.7);
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
		font-family: 'rsbold', ui-sans-serif, Arial, sans-serif;
		font-size: 1.7rem;
		letter-spacing: 1px;
		color: #ff981f;
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
		color: #ff981f;
		background: rgba(255, 152, 31, 0.08);
	}

	.primary-nav a.active {
		color: #ff981f;
		background: rgba(255, 152, 31, 0.12);
		border-color: rgba(255, 152, 31, 0.4);
	}

	.user-pill {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		padding: 0.4rem 0.85rem;
		background: rgba(58, 48, 36, 0.7);
		border: 1px solid #5d5346;
		border-radius: 999px;
		color: #ff981f;
		text-decoration: none;
		text-shadow: 1px 1px #000;
		font-size: 0.95rem;
		transition: background 0.15s, border-color 0.15s;
	}

	.user-pill:hover,
	.user-pill.active {
		background: rgba(77, 67, 54, 0.9);
		border-color: #ff981f;
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
		background: #3a3024;
		border: 1px solid #5d5346;
		color: #ff981f;
		padding: 0.5rem 1rem;
		border-radius: 4px;
		text-decoration: none;
	}

	.cta:hover {
		background: #4d4336;
		border-color: #ff981f;
		text-decoration: none;
	}

	main.page {
		padding: 2rem 1rem 4rem;
		min-height: calc(100vh - 8rem);
	}

	.page-fade {
		animation: fade-in 0.25s ease-out;
	}

	@keyframes fade-in {
		from {
			opacity: 0;
			transform: translateY(4px);
		}
		to {
			opacity: 1;
			transform: none;
		}
	}

	footer {
		border-top: 1px solid #4d4336;
		padding: 1rem 0;
	}

	.muted {
		color: rgba(255, 255, 255, 0.4);
		font-size: 0.9rem;
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

		.primary-nav a {
			padding: 0.4rem 0.6rem;
			font-size: 0.95rem;
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
</style>

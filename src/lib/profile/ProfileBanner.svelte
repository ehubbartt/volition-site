<script lang="ts">
	import AccountIcon from '$lib/AccountIcon.svelte';
	import OsrsCounter from '$lib/OsrsCounter.svelte';

	// Shared profile header for /me and /u/[rsn]: identity (account-type icon, name,
	// @discord · clan) on the left, the VP counter on the right. Keeping it one
	// component is what keeps the two profile pages pixel-identical.
	let {
		accountType,
		name,
		username,
		clanLabel = null,
		vp = 0
	}: {
		accountType: string | null | undefined;
		name: string;
		username: string;
		clanLabel?: string | null;
		vp?: number;
	} = $props();
</script>

<header class="banner">
	<div class="identity">
		<AccountIcon type={accountType} size={48} />
		<div class="who">
			<h1>{name}</h1>
			<span class="sub">@{username}{#if clanLabel} · {clanLabel}{/if}</span>
		</div>
	</div>
	<OsrsCounter value={vp} label="VP" title="Volition Points" />
</header>

<style>
	.banner {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 1rem;
		flex-wrap: wrap;
		padding: 1.5rem;
		background-color: var(--stone-fill);
		background-image: var(--stone-tile);
		background-repeat: repeat;
		background-blend-mode: var(--stone-blend);
		border: 4px solid transparent;
		border-image: url('/osrs/border-tiny.png') 4 / 4px round;
		border-radius: 4px;
	}

	.identity {
		display: flex;
		align-items: center;
		gap: 1rem;
		min-width: 0;
	}

	.who {
		min-width: 0;
	}

	h1 {
		margin: 0;
		font-size: 1.8rem;
		line-height: 1.1;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.sub {
		color: var(--muted);
		font-size: 0.9rem;
	}

	@media (max-width: 480px) {
		h1 {
			font-size: 1.4rem;
		}
	}
</style>

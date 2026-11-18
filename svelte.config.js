import adapter from '@sveltejs/adapter-node';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';

/** @type {import('@sveltejs/kit').Config} */
const config = {
	preprocess: vitePreprocess(),

	kit: {
		adapter: adapter(),
		// Check for a new deploy once a minute. An open tab otherwise keeps running the code
		// it first loaded for as long as it stays open; the root layout turns the next
		// in-app navigation into a full page load once this reports an update.
		version: { pollInterval: 60_000 }
	}
};

export default config;

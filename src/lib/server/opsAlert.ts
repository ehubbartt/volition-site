import { env } from '$env/dynamic/private';

// SERVER-ONLY ops alert → a private Discord channel via its OWN webhook
// (DISCORD_OPS_WEBHOOK_URL). Fire-and-forget, best-effort, NEVER throws — mirrors the
// postEmbed pattern in dropsFeed.ts. Used to ping the team the instant a privileged
// path degrades. Current caller: the OAuth callback, when Discord 429-rate-limits /
// is unreachable from Fly's egress IP (the shared-IP ban that locks members out of
// sign-in). Separate from the people-facing drops feed and the bot bridge.

let warnedNoWebhook = false;

export function postOpsAlert(a: {
	title: string;
	detail?: string;
	fields?: { name: string; value: string }[];
}): void {
	const url = env.DISCORD_OPS_WEBHOOK_URL;
	if (!url) {
		// One-time hint so a missing webhook is obvious in the logs instead of silent.
		if (!warnedNoWebhook) {
			warnedNoWebhook = true;
			console.warn('[ops-alert] DISCORD_OPS_WEBHOOK_URL not set — alert dropped:', a.title);
		}
		return;
	}

	const region = env.FLY_REGION ?? 'local';
	const machine = env.FLY_MACHINE_ID ?? 'n/a';
	const embed: Record<string, unknown> = {
		title: a.title,
		description: a.detail,
		color: 0xff5555, // alert red
		fields: [
			{ name: 'Region', value: region, inline: true },
			{ name: 'Machine', value: machine, inline: true },
			...(a.fields ?? []).map((f) => ({ ...f, inline: true }))
		],
		timestamp: new Date().toISOString()
	};

	// Kick off the post and swallow everything — an alert must never break the request.
	void fetch(url, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ username: 'Volition Ops', embeds: [embed] })
	}).then(
		(res) => {
			if (!res.ok) console.error('[ops-alert] post failed:', res.status);
		},
		(e) => console.error('[ops-alert] post error:', e instanceof Error ? e.message : e)
	);
}

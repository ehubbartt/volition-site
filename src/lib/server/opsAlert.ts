import { env } from '$env/dynamic/private';

// SERVER-ONLY ops alert → a Discord channel via a webhook. Prefers a dedicated
// DISCORD_OPS_WEBHOOK_URL, else falls back to the existing bot-bridge webhook
// (DISCORD_BOT_BRIDGE_WEBHOOK_URL) so alerts land in the same channel as the gamba
// role grants with no new secret to set. Fire-and-forget, best-effort, NEVER throws —
// mirrors the postEmbed pattern in dropsFeed.ts. Current caller: the OAuth callback,
// when Discord 429-rate-limits / is unreachable from Fly's egress IP (the shared-IP
// ban that locks members out of sign-in).
//
// Posting to the bridge channel is safe: this sends ONLY an embed (no ```json `content`
// command block), so the bot's bridge parser finds no command `type` and ignores it.

let warnedNoWebhook = false;

export function postOpsAlert(a: {
	title: string;
	detail?: string;
	fields?: { name: string; value: string }[];
}): void {
	const url = env.DISCORD_OPS_WEBHOOK_URL ?? env.DISCORD_BOT_BRIDGE_WEBHOOK_URL;
	if (!url) {
		// One-time hint so a missing webhook is obvious in the logs instead of silent.
		if (!warnedNoWebhook) {
			warnedNoWebhook = true;
			console.warn(
				'[ops-alert] no webhook set (DISCORD_OPS_WEBHOOK_URL / DISCORD_BOT_BRIDGE_WEBHOOK_URL) — alert dropped:',
				a.title
			);
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

import { env } from '$env/dynamic/private';

// SERVER-ONLY site→bot bridge. Posts a structured message to a Discord webhook
// (DISCORD_BOT_BRIDGE_WEBHOOK_URL) pointing at a dedicated bridge channel that the
// bot listens to (messageCreate). Used for things the site can't do itself — e.g.
// assigning a Discord role from a gamba-crate roll. Best-effort: a webhook failure
// is logged and swallowed so it never breaks the action that triggered it.
//
// SECURITY: the bot must only trust messages from THIS webhook's id in THAT
// channel (it ignores everyone else) — that check lives in the bot repo.

export type BotMessageType = 'grant_role';

export interface GrantRolePayload {
	discord_id: string;
	role_id: string;
	reason?: string;
	username?: string | null;
}

type PayloadFor<T extends BotMessageType> = T extends 'grant_role' ? GrantRolePayload : Record<string, unknown>;

export function isBridgeConfigured(): boolean {
	return !!env.DISCORD_BOT_BRIDGE_WEBHOOK_URL;
}

export interface WebhookResult {
	ok: boolean;
	status?: number;
	error?: string;
}

// Low-level POST to the bridge webhook. Returns a structured result so callers can
// report it (the test page) or just check ok (the open flow).
async function postToWebhook(body: unknown): Promise<WebhookResult> {
	const url = env.DISCORD_BOT_BRIDGE_WEBHOOK_URL;
	if (!url) return { ok: false, error: 'DISCORD_BOT_BRIDGE_WEBHOOK_URL is not set' };
	try {
		const res = await fetch(url, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify(body)
		});
		if (!res.ok) return { ok: false, status: res.status, error: (await res.text().catch(() => '')) || `HTTP ${res.status}` };
		return { ok: true, status: res.status };
	} catch (e) {
		return { ok: false, error: e instanceof Error ? e.message : String(e) };
	}
}

// Builds the standard bridge message body: a machine-parseable JSON code block in
// `content` (what the bot parses) plus a human-readable embed for the audit log.
function buildBody(type: string, payload: Record<string, unknown>) {
	return {
		username: 'Volition Site Bridge',
		content: `\`\`\`json\n${JSON.stringify({ type, ...payload })}\n\`\`\``,
		embeds: [
			{
				title: `bridge:${type}`,
				description: `Site requested **${type}**${payload && payload.username ? ` for ${payload.username}` : ''}.`,
				fields: Object.entries(payload).map(([name, value]) => ({
					name,
					value: String(value ?? '—'),
					inline: true
				}))
			}
		]
	};
}

export async function sendBotMessage<T extends BotMessageType>(type: T, payload: PayloadFor<T>): Promise<boolean> {
	const res = await postToWebhook(buildBody(type, payload as Record<string, unknown>));
	if (!res.ok) console.error('[bot-bridge] send failed:', type, res.status ?? '', res.error ?? '');
	return res.ok;
}

// Harmless connectivity test: posts a `ping` message to the bridge channel and
// returns the detailed result. No side effects (the bot can ack/ignore `ping`).
export async function sendBridgeTest(note: string): Promise<WebhookResult> {
	return postToWebhook(buildBody('ping', { note, at: new Date().toISOString() }));
}

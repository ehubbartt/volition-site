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

export async function sendBotMessage<T extends BotMessageType>(type: T, payload: PayloadFor<T>): Promise<boolean> {
	const url = env.DISCORD_BOT_BRIDGE_WEBHOOK_URL;
	if (!url) {
		console.error('[bot-bridge] DISCORD_BOT_BRIDGE_WEBHOOK_URL not set — dropping', type, payload);
		return false;
	}

	// A machine-parseable embed: the bot reads the fields; the description is a
	// human-readable audit line. content carries a compact JSON copy as a backstop.
	const body = {
		username: 'Volition Site Bridge',
		content: `\`\`\`json\n${JSON.stringify({ type, ...payload })}\n\`\`\``,
		embeds: [
			{
				title: `bridge:${type}`,
				description: `Site requested **${type}**${payload && 'username' in payload && payload.username ? ` for ${payload.username}` : ''}.`,
				fields: Object.entries(payload).map(([name, value]) => ({
					name,
					value: String(value ?? '—'),
					inline: true
				}))
			}
		]
	};

	try {
		const res = await fetch(url, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify(body)
		});
		if (!res.ok) {
			console.error('[bot-bridge] webhook returned', res.status, await res.text().catch(() => ''));
			return false;
		}
		return true;
	} catch (e) {
		console.error('[bot-bridge] webhook post failed:', e instanceof Error ? e.message : e);
		return false;
	}
}

import { env } from '$env/dynamic/private';
import { RARITY_BY_KEY, DEFAULT_RARITY, isValidRarity } from '$lib/cards/rarity';

// Where the embed title links to — the gamba store, so viewers can go open their own.
// ALWAYS prod: this feed posts to a public Discord channel, so the link must never
// be a dev/localhost origin even when a drop is triggered from a local run.
const OPEN_URL = 'https://volition-osrs.com/gamba';

// SERVER-ONLY "live drops" feed → a public Discord channel via its OWN webhook
// (DISCORD_DROPS_WEBHOOK_URL). Posts human-readable embeds for notable pack pulls
// (rares: dragon+) and loot-crate rewards (rare drops). Unlike botBridge.ts — which
// posts machine-readable commands the bot consumes — this posts directly to a
// channel for people to read; no bot is involved (a webhook can post embeds on its
// own). Best-effort: any failure is logged and swallowed so it never breaks an open.

export function isDropsFeedConfigured(): boolean {
	return !!env.DISCORD_DROPS_WEBHOOK_URL;
}

// Discord embed colours are integers; convert a CSS hex (with or without '#').
function hexToInt(hex: string | null | undefined): number | undefined {
	if (!hex) return undefined;
	const m = /^#?([0-9a-fA-F]{6})$/.exec(hex.trim());
	return m ? parseInt(m[1], 16) : undefined;
}

// Discord can only load absolute http(s) thumbnails — drop relative/local paths.
function absUrl(url: string | null | undefined): string | undefined {
	return url && /^https?:\/\//.test(url) ? url : undefined;
}

// Posts the embed. With `attachment`, the image is uploaded inline (multipart) and
// the embed should reference it as `attachment://<name>`; otherwise JSON only.
async function postEmbed(
	embed: Record<string, unknown>,
	attachment?: { name: string; data: Buffer }
): Promise<void> {
	const url = env.DISCORD_DROPS_WEBHOOK_URL;
	if (!url) return;
	try {
		let res: Response;
		if (attachment) {
			const form = new FormData();
			form.append('payload_json', JSON.stringify({ username: 'Volition Drops', embeds: [embed] }));
			form.append('files[0]', new Blob([new Uint8Array(attachment.data)], { type: 'image/png' }), attachment.name);
			res = await fetch(url, { method: 'POST', body: form }); // fetch sets the multipart boundary
		} else {
			res = await fetch(url, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ username: 'Volition Drops', embeds: [embed] })
			});
		}
		if (!res.ok) {
			console.error('[drops-feed] post failed:', res.status, (await res.text().catch(() => '')) || '');
		}
	} catch (e) {
		console.error('[drops-feed] post error:', e instanceof Error ? e.message : e);
	}
}

async function fetchBuffer(url: string): Promise<Buffer | null> {
	try {
		const res = await fetch(url);
		if (!res.ok) return null;
		return Buffer.from(await res.arrayBuffer());
	} catch {
		return null;
	}
}

// Flattens a card's front + its stacked depth layers (bottom→top) into a single PNG
// — the layers are separate images in 3D, but a webhook embed shows one flat image.
// sharp is loaded lazily (only when a layered card actually drops) and any failure
// returns null so the caller falls back to the plain front image.
async function flattenCard(frontUrl: string, layerUrls: string[]): Promise<Buffer | null> {
	try {
		const { default: sharp } = await import('sharp');
		const front = await fetchBuffer(frontUrl);
		if (!front) return null;
		const meta = await sharp(front).metadata();
		const w = meta.width ?? 0;
		const h = meta.height ?? 0;
		const overlays: { input: Buffer; top: number; left: number }[] = [];
		for (const lu of layerUrls) {
			const buf = await fetchBuffer(lu);
			if (!buf) continue;
			// Layers should already match the front's size; resize as a safety net so
			// composite never throws on a mismatched layer.
			const input = w && h ? await sharp(buf).resize(w, h, { fit: 'fill' }).toBuffer() : buf;
			overlays.push({ input, top: 0, left: 0 });
		}
		if (!overlays.length) return null;
		return await sharp(front).composite(overlays).png().toBuffer();
	} catch (e) {
		console.error('[drops-feed] flatten failed:', e instanceof Error ? e.message : e);
		return null;
	}
}

const FINISH_LABEL: Record<string, string> = { holo: 'Holo', reverse: 'Reverse Holo' };

// Announce a rare card pull. `by` = player display name (RSN preferred). For cards
// with 3D depth `layerUrls`, the front + layers are flattened into one PNG and sent
// as an attachment (a webhook embed can't stack the layers itself).
export async function postCardDrop(d: {
	by: string;
	cardName: string;
	rarity: string;
	finish?: string | null;
	packName?: string | null;
	imageUrl?: string | null;
	layerUrls?: string[];
}): Promise<void> {
	if (!isDropsFeedConfigured()) return;
	const meta = RARITY_BY_KEY[isValidRarity(d.rarity) ? d.rarity : DEFAULT_RARITY];
	const finishLabel = d.finish && FINISH_LABEL[d.finish] ? ` ${FINISH_LABEL[d.finish]}` : '';
	const from = d.packName ? ` from ${d.packName}` : '';
	const embed: Record<string, unknown> = {
		author: { name: `🎴 ${d.by}` },
		title: d.cardName,
		url: OPEN_URL, // makes the title a clickable link to the store
		description: `Pulled a **${meta.label}**${finishLabel} card${from}! · [Open packs](${OPEN_URL})`,
		color: hexToInt(meta.color)
	};

	const front = absUrl(d.imageUrl);
	// Layered card → flatten front + layers into one image and attach it.
	if (front && d.layerUrls && d.layerUrls.length) {
		const flat = await flattenCard(front, d.layerUrls.filter((u): u is string => !!u));
		if (flat) {
			embed.image = { url: 'attachment://card.png' };
			await postEmbed(embed, { name: 'card.png', data: flat });
			return;
		}
	}
	// No layers (or flatten failed) → use the front image directly.
	if (front) embed.image = { url: front }; // big, full-width — the focus of the embed
	await postEmbed(embed);
}

// Format a percent for the "Drop Rate" field (up to 2 decimals, no trailing zeros).
function fmtPct(p: number): string {
	return String(Math.round(p * 100) / 100);
}

// Announce a notable loot-crate reward, mirroring the bot's crate message: the prize
// plus Loot Table / Drop Rate / New Total VP. `reward` = what they found (e.g. "2 VP",
// item name, role name); `lootTable` = the table/tier (e.g. "Common (1–3 VP)").
export async function postCrateDrop(d: {
	by: string;
	reward: string;
	isFree: boolean;
	colorHex?: string | null;
	imageUrl?: string | null;
	lootTable?: string | null;
	dropRate?: number | null;
	newTotalVp?: number | null;
}): Promise<void> {
	if (!isDropsFeedConfigured()) return;
	const img = absUrl(d.imageUrl);
	const fields: { name: string; value: string; inline: boolean }[] = [];
	if (d.lootTable) fields.push({ name: 'Loot Table', value: d.lootTable, inline: true });
	if (typeof d.dropRate === 'number') fields.push({ name: 'Drop Rate', value: `${fmtPct(d.dropRate)}%`, inline: true });
	if (typeof d.newTotalVp === 'number') fields.push({ name: 'New Total VP', value: d.newTotalVp.toLocaleString(), inline: true });
	await postEmbed({
		author: { name: `🎁 ${d.by}` },
		title: d.reward,
		url: OPEN_URL, // clickable title → the store
		description: `Opened ${d.isFree ? 'their daily' : 'a VP'} crate and found **${d.reward}**! · [Open a crate](${OPEN_URL})`,
		color: hexToInt(d.colorHex),
		fields: fields.length ? fields : undefined,
		image: img ? { url: img } : undefined // big, full-width — same as card drops
	});
}

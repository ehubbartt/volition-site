import { redirect, error, fail } from '@sveltejs/kit';
import { isAdmin } from '$lib/server/auth';
import {
	abandonTask,
	bankTrade,
	completeTask,
	drawDevCard,
	exchangeGold,
	grantTokens,
	loadGame,
	placeRoad,
	placeSettlement,
	playDevCard,
	rollTask,
	upgradeCity
} from '$lib/server/catan';
import type { TileType } from '$lib/catan/board';
import type { Actions, PageServerLoad, RequestEvent } from './$types';

export const load: PageServerLoad = async ({ locals, params }) => {
	if (!locals.user) throw redirect(303, '/');
	if (!isAdmin(locals.user)) throw error(403, 'Not allowed');
	const game = await loadGame(params.slug);
	if (!game) throw error(404, 'Game not found');
	return { game };
};

const TOKEN_TYPES = new Set(['boss', 'skilling', 'raids', 'custom']);

function fields(form: FormData, ...names: string[]): string[] {
	return names.map((n) => form.get(n)?.toString().trim() ?? '');
}

function asTile(v: string): TileType | null {
	return TOKEN_TYPES.has(v) ? (v as TileType) : null;
}

/** All actions share the same shape: gate → parse → call store → fail/ok. */
function gameAction(
	run: (slug: string, form: FormData) => Promise<{ ok: true } | { ok: false; error: string }>
) {
	return async ({ locals, params, request }: RequestEvent) => {
		if (!locals.user || !isAdmin(locals.user)) throw error(403, 'Not allowed');
		const form = await request.formData();
		const res = await run(params.slug, form);
		if (!res.ok) return fail(400, { error: res.error });
		return { ok: true };
	};
}

export const actions: Actions = {
	settle: gameAction((slug, form) => {
		const [team, loc] = fields(form, 'team', 'loc');
		return placeSettlement(slug, team, loc);
	}),

	road: gameAction((slug, form) => {
		const [team, loc] = fields(form, 'team', 'loc');
		return placeRoad(slug, team, loc);
	}),

	city: gameAction((slug, form) => {
		const [team, loc] = fields(form, 'team', 'loc');
		return upgradeCity(slug, team, loc);
	}),

	roll: gameAction((slug, form) => {
		const [team, loc] = fields(form, 'team', 'loc');
		return rollTask(slug, team, loc);
	}),

	complete: gameAction((slug, form) => {
		const [team, task] = fields(form, 'team', 'task');
		return completeTask(slug, team, task);
	}),

	abandon: gameAction((slug, form) => {
		const [team, task] = fields(form, 'team', 'task');
		return abandonTask(slug, team, task);
	}),

	grant: gameAction((slug, form) => {
		const [team] = fields(form, 'team');
		const grant: Record<string, number> = {};
		for (const t of ['boss', 'skilling', 'raids', 'custom', 'gold']) {
			const n = Number(form.get(`grant_${t}`)?.toString() ?? '0');
			if (Number.isFinite(n) && n !== 0) grant[t] = Math.trunc(n);
		}
		if (Object.keys(grant).length === 0)
			return Promise.resolve({ ok: false as const, error: 'Nothing to grant' });
		return grantTokens(slug, team, grant);
	}),

	gold: gameAction((slug, form) => {
		const [team, getRaw, countRaw] = fields(form, 'team', 'get', 'count');
		const get = asTile(getRaw);
		const count = Number(countRaw || '1');
		if (!get) return Promise.resolve({ ok: false as const, error: 'Pick a token type' });
		return exchangeGold(slug, team, get, Math.trunc(count));
	}),

	trade: gameAction((slug, form) => {
		const [team, giveRaw, getRaw, countRaw] = fields(form, 'team', 'give', 'get', 'count');
		const give = asTile(giveRaw);
		const get = asTile(getRaw);
		const count = Number(countRaw || '1');
		if (!give || !get) return Promise.resolve({ ok: false as const, error: 'Pick token types' });
		return bankTrade(slug, team, give, get, Math.trunc(count));
	}),

	draw: gameAction((slug, form) => {
		const [team] = fields(form, 'team');
		return drawDevCard(slug, team);
	}),

	play: gameAction((slug, form) => {
		const [team, card, vertex, tokenTypeRaw, take1, take2] = fields(
			form,
			'team',
			'card',
			'loc',
			'token_type',
			'take1',
			'take2'
		);
		const take = [asTile(take1), asTile(take2)].filter((t): t is TileType => t !== null);
		return playDevCard(slug, team, card, {
			vertex: vertex || undefined,
			tokenType: asTile(tokenTypeRaw) ?? undefined,
			take: take.length ? take : undefined
		});
	})
};

// Seed (or repair) the `rank_scoring` bot_config row with the default composite-rank
// weights/thresholds/caps. Idempotent: only inserts when the row is missing, so it won't
// stomp tuning done in /admin/rank-sim. Use the SQL in rank_sim_setup.sql to also create
// the vs_rank_sim table.
//
// Run (Node 20+, from the repo root):
//   node --env-file=.env db/scripts/seedRankConfig.mjs
// Needs SUPABASE_URL + SUPABASE_ANON_KEY (same anon key the app uses).

import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
	console.error('Missing SUPABASE_URL / SUPABASE_ANON_KEY. Try: node --env-file=.env db/scripts/seedRankConfig.mjs');
	process.exit(1);
}
const sb = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// Keep in sync with DEFAULT_RANK_CONFIG in src/lib/server/rankConfig.ts.
const DEFAULT_RANK_CONFIG = {
	weights: { gear: 0.35, ehb: 0.25, ca: 0.1, time: 0.1, clog: 0.1, level: 0.1 },
	caps: { ehb: 3000, months: 24, clog: 1200, levelMin: 2000, levelRange: 376 },
	thresholds: [
		{ scoreMin: 0.0, womRole: 'bronze' },
		{ scoreMin: 0.08, womRole: 'iron' },
		{ scoreMin: 0.14, womRole: 'steel' },
		{ scoreMin: 0.2, womRole: 'gold' },
		{ scoreMin: 0.27, womRole: 'mithril' },
		{ scoreMin: 0.35, womRole: 'adamant' },
		{ scoreMin: 0.43, womRole: 'rune' },
		{ scoreMin: 0.52, womRole: 'dragon' },
		{ scoreMin: 0.62, womRole: 'sage' },
		{ scoreMin: 0.72, womRole: 'legend' },
		{ scoreMin: 0.82, womRole: 'myth' },
		{ scoreMin: 0.9, womRole: 'tztok' },
		{ scoreMin: 0.95, womRole: 'tzkal' }
	]
};

const { data: existing, error: readErr } = await sb
	.from('bot_config')
	.select('config_name')
	.eq('config_name', 'rank_scoring')
	.maybeSingle();
if (readErr) {
	console.error('Read failed:', readErr.message);
	process.exit(1);
}
if (existing) {
	console.log('rank_scoring config already exists — leaving it untouched.');
	process.exit(0);
}

const { error } = await sb.from('bot_config').insert({
	config_name: 'rank_scoring',
	config_group: 'ranks',
	config_value: DEFAULT_RANK_CONFIG,
	description: 'Composite rank scoring: weights, score→rank thresholds, normalization caps.',
	updated_at: new Date().toISOString()
});
if (error) {
	console.error('Insert failed:', error.message);
	process.exit(1);
}
console.log('Seeded rank_scoring config with defaults.');

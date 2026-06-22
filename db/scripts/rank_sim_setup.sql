-- Schema for the on-site rank system. Run in the Supabase SQL editor once.
--
-- 1) vs_rank_sim — cached raw per-player inputs for the admin Rank Simulator
--    (/admin/rank-sim). The web tool fetches WOM + TempleOSRS + WikiSync into these
--    rows (in batches), then re-scores the clan instantly as the formula is tuned.
--    Mirrors the `rank_simulation` table the bot's scripts/simulateRanks.js prints to.
CREATE TABLE IF NOT EXISTS vs_rank_sim (
  rsn                text PRIMARY KEY,
  wom_id             integer,
  ehb                numeric(8,2) DEFAULT 0,
  total_level        integer,
  gear_points        integer DEFAULT 0,
  clog_finished      integer DEFAULT 0,
  clog_available     integer DEFAULT 0,
  months_in_clan     numeric(6,2) DEFAULT 0,
  ca_points          integer DEFAULT 0,
  temple_available   boolean DEFAULT false,
  wikisync_available boolean DEFAULT false,
  ca_tier            text DEFAULT 'none',
  fetched_at         timestamptz DEFAULT now()
);

-- 2) rank_scoring bot_config row — the TUNABLE composite weights, score→rank
--    thresholds, and normalization caps. Editable from /admin/rank-sim AND the generic
--    /admin/config editor (it's just another bot_config row). The site's "Check my rank"
--    and the simulator both read it. Values below are the simulateRanks.js defaults; the
--    app also seeds/repairs this via db/scripts/seedRankConfig.mjs and DEFAULT_RANK_CONFIG.
INSERT INTO bot_config (config_name, config_group, config_value, description, updated_at)
VALUES (
  'rank_scoring',
  'ranks',
  '{
    "weights": {"gear":0.35,"ehb":0.25,"ca":0.10,"time":0.10,"clog":0.10,"level":0.10},
    "caps": {"ehb":3000,"months":24,"clog":1200,"levelMin":2000,"levelRange":376},
    "thresholds": [
      {"scoreMin":0.00,"womRole":"bronze"},
      {"scoreMin":0.08,"womRole":"iron"},
      {"scoreMin":0.14,"womRole":"steel"},
      {"scoreMin":0.20,"womRole":"gold"},
      {"scoreMin":0.27,"womRole":"mithril"},
      {"scoreMin":0.35,"womRole":"adamant"},
      {"scoreMin":0.43,"womRole":"rune"},
      {"scoreMin":0.52,"womRole":"dragon"},
      {"scoreMin":0.62,"womRole":"sage"},
      {"scoreMin":0.72,"womRole":"legend"},
      {"scoreMin":0.82,"womRole":"myth"},
      {"scoreMin":0.90,"womRole":"tztok"},
      {"scoreMin":0.95,"womRole":"tzkal"}
    ]
  }'::jsonb,
  'Composite rank scoring: weights, score→rank thresholds, normalization caps.',
  now()
)
ON CONFLICT (config_name) DO NOTHING;

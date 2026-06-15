// Built-in pack-opener sound effects, served from static/sfx. Used by PackOpener.
// Per-card sounds (vs_cards.sound_url) take precedence over these defaults.

// Plays once while the pack is being torn open.
export const SFX_OPENING = '/sfx/opening-pack.mp3';
// Plays when a Dragon-rarity card is revealed (unless the card has its own sound).
export const SFX_PULL_DRAGON = '/sfx/pull-rare.mp3';
// Plays when an SR-rarity card is revealed (unless the card has its own sound).
export const SFX_PULL_SR = '/sfx/pull-immersive.mp3';
// Shimmer that plays when the unopened pack is first shown (before it's ripped).
export const SFX_PACK_SHINE = '/sfx/pack-shine.mp3';
// Short whoosh when swiping between cards in the revealed deck (either direction).
export const SFX_NEXT_CARD = '/sfx/next-card.mp3';
// ~4.7s slot-machine spin that plays while the gamba crate reel scrolls + lands.
// Used as a FALLBACK when the per-cell tick/tock clips below aren't present.
export const SFX_CRATE_SPIN = '/sfx/slot-machine.mp3';
// Alternating click played each time a reel cell crosses the marker — auto-syncs
// to the reel's deceleration (preferred over the single slot clip). Add both files
// to enable; if missing, the reel falls back to SFX_CRATE_SPIN.
export const SFX_TICK = '/sfx/tick.mp3';
export const SFX_TOCK = '/sfx/tock.mp3';

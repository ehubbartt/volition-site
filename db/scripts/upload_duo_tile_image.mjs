// Upload a DuoWolf tile image to the public vs-card-art bucket (under duo-tiles/) and print
// its public URL — so tile art can be self-hosted instead of hotlinked from wikis that block
// referrers. Run with the project's anon key from .env:
//
//   node --env-file=.env db/scripts/upload_duo_tile_image.mjs <file> [destName]
//
// Paste the printed URL into the tile's "Image URL" at /admin/duo/duo-wolf/tiles.

import { createClient } from '@supabase/supabase-js';
import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';

const [, , filePath, destNameArg] = process.argv;
if (!filePath) {
	console.error('usage: node --env-file=.env db/scripts/upload_duo_tile_image.mjs <file> [destName]');
	process.exit(1);
}

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_ANON_KEY;
if (!url || !key) {
	console.error('Missing SUPABASE_URL / SUPABASE_ANON_KEY (run with --env-file=.env)');
	process.exit(1);
}

const BUCKET = 'vs-card-art';
const ext = (filePath.split('.').pop() || '').toLowerCase();
const CONTENT_TYPE =
	{ webp: 'image/webp', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif' }[ext] ||
	'application/octet-stream';
const dest = `duo-tiles/${destNameArg || basename(filePath)}`;

const sb = createClient(url, key, { auth: { persistSession: false } });
const buf = await readFile(filePath);

const { error } = await sb.storage
	.from(BUCKET)
	.upload(dest, buf, { contentType: CONTENT_TYPE, cacheControl: '31536000', upsert: true });
if (error) {
	console.error('Upload failed:', error.message);
	process.exit(1);
}

const { data } = sb.storage.from(BUCKET).getPublicUrl(dest);
console.log(data.publicUrl);

// Regenerate the checked-in planned tile list from a spreadsheet export.
//
//   node scripts/build_planned_tiles.mjs path/to/Tile_Planning-Tiles.csv
//
// Reads the export with the SAME parser the CSV importer uses, so whatever the
// button loads is exactly what an import of that file would have produced. Writes
// src/lib/server/data/connect4PlannedTiles.json and prints the totals to check
// against the sheet's own stats block.
import { createServer } from 'vite';
import { readFileSync, writeFileSync } from 'node:fs';

const src = process.argv[2];
if (!src) {
	console.error('usage: node scripts/build_planned_tiles.mjs <export.csv>');
	process.exit(2);
}

const server = await createServer({ server: { middlewareMode: true }, logLevel: 'error', appType: 'custom' });
try {
	const imp = await server.ssrLoadModule('/src/lib/server/connect4Import.ts');
	const report = imp.parseTileCsv(readFileSync(src, 'utf8'));
	if (report.errors.length) {
		console.error('✗ ' + report.errors.join('\n✗ '));
		process.exit(1);
	}
	const out = {
		source: 'Tile_Planning.xlsx — Tiles sheet',
		tiles: report.tiles.length,
		cells: report.cells,
		list: report.tiles
	};
	writeFileSync('src/lib/server/data/connect4PlannedTiles.json', JSON.stringify(out, null, '\t') + '\n');

	const byTier = {};
	for (const t of report.tiles) byTier[t.tier ?? '?'] = (byTier[t.tier ?? '?'] ?? 0) + t.copies;
	console.log(`${report.tiles.length} tiles → ${report.cells} cells`);
	console.log('cells by tier:', byTier);
	console.log(`${report.tiles.filter((t) => t.qty > 1).length} tiles need more than one drop`);
	for (const w of report.warnings) console.log('  ! ' + w);
} finally {
	await server.close();
}

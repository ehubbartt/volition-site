// Production entry (Dockerfile CMD): wraps the adapter-node handler with gzip
// compression, which adapter-node doesn't do itself and Fly's proxy doesn't add.
// The API payloads (full roster, event lists) shrink ~5-10x, which directly
// shortens the skeleton window on slow connections.
//
// Z_SYNC_FLUSH makes zlib emit every written chunk immediately — without it,
// streamed SSR responses would sit in zlib's buffer instead of reaching the
// browser as they're produced.
import { createServer } from 'node:http';
import { constants } from 'node:zlib';
import compression from 'compression';
import { handler } from './build/handler.js';

const compress = compression({ flush: constants.Z_SYNC_FLUSH });
const port = Number(process.env.PORT ?? 3000);

createServer((req, res) => {
	compress(req, res, () => {
		handler(req, res, () => {
			res.statusCode = 404;
			res.end('Not found');
		});
	});
}).listen(port, '0.0.0.0', () => {
	console.log(`listening on 0.0.0.0:${port}`);
});

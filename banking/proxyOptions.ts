import { readFileSync } from 'node:fs';
// Keep this import type-only under `verbatimModuleSyntax` so the annotation is
// erased and the proxy's runtime imports and behavior remain unchanged.
import type { IncomingMessage } from 'node:http';

const common_site_config = JSON.parse(
	readFileSync(new URL('../../../sites/common_site_config.json', import.meta.url), 'utf8')
) as { webserver_port: string | number };
const { webserver_port } = common_site_config;

export default {
	'^/(app|api|assets|files|private)': {
		target: `http://127.0.0.1:${webserver_port}`,
		ws: true,
		router: function (req: IncomingMessage) {
			const site_name = req.headers?.host?.split(':')[0];
			return `http://${site_name ?? 'localhost'}:${webserver_port}`;
		}
	}
};

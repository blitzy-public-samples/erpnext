import { readFileSync } from 'node:fs';
// Type-only import (required by `verbatimModuleSyntax`) so the proxy `router`
// callback parameter below can be annotated instead of falling back to an
// implicit `any`, which `strict` rejects with TS7006.
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

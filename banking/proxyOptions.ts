import { readFileSync } from 'node:fs';
import type { IncomingMessage } from 'node:http';

const DEFAULT_WEBSERVER_PORT: string | number = 8000;

function get_webserver_port(): string | number {
		try {
					const common_site_config = JSON.parse(
									readFileSync(new URL('../../../sites/common_site_config.json', import.meta.url), 'utf8')
								) as { webserver_port: string | number };
					return common_site_config.webserver_port ?? DEFAULT_WEBSERVER_PORT;
		} catch {
					// No bench checkout present (e.g. standalone build, CI, or a test run) — fall back to the
			// conventional Frappe webserver port so this module stays safe to import anywhere.
			return DEFAULT_WEBSERVER_PORT;
		}
}

const webserver_port = get_webserver_port();

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

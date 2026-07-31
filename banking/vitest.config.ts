import path from 'path';
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// https://vitest.dev/config/
// Keep tests independent of vite.config.ts: it imports proxyOptions.ts, whose
// module-scope bench-config read fails when the external bench file is absent.
export default defineConfig({
	plugins: [react(), tailwindcss()],
	resolve: {
		alias: {
			// Must stay in lockstep with the `@/*` -> `./src/*` mapping declared in
			// tsconfig.json and tsconfig.app.json; test files import via `@/…`.
			'@': path.resolve(__dirname, 'src')
		}
	},
	test: {
		environment: 'jsdom',
		// Exposes the Vitest API at runtime. It does NOT type it ambiently, because
		// tsconfig.app.json declares no `types` array — test files must still import
		// describe/it/expect/vi explicitly from 'vitest'.
		globals: true,
		setupFiles: ['./src/test/setup.ts'],
		include: ['src/**/*.{test,spec}.{ts,tsx}'],
		coverage: {
			provider: 'v8',
			reporter: ['text', 'json-summary', 'lcov'],
			include: ['src/**/*.{ts,tsx}'],
			exclude: [
				// Generated DocType declarations — not hand-written code.
				'src/types/**',
				// The harness itself must not skew the measured percentage.
				'src/test/**',
				// Declaration files carry no executable lines (covers src/vite-env.d.ts).
				'**/*.d.ts',
				// Browser entry point: startup side effects only, never mounted by a test.
				'src/main.tsx'
			],
			thresholds: {
				lines: 80
			}
		}
	}
});

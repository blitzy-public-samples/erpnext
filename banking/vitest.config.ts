import path from 'path';
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// https://vitest.dev/config/
//
// WHY THIS CONFIG IS DELIBERATELY STANDALONE
// ------------------------------------------
// A dedicated Vitest config takes precedence over — and fully overrides — the
// application's Vite build configuration. Relying on that precedence is load-bearing
// here, not stylistic: the app config pulls in the dev-server proxy module, which
// performs a synchronous, module-scope `readFileSync` of the Frappe Bench file
// `sites/common_site_config.json` — resolved three directory levels ABOVE this
// package, i.e. outside the repository entirely. Any test configuration that
// imported, extended or merged the app config would therefore die with ENOENT in a
// bare checkout before a single test ran.
//
// This file consequently re-declares inline the only two pieces of the app config the
// tests actually need — the React + Tailwind plugins and the `@` path alias — and
// imports nothing from the application build config or its proxy module. Practical
// consequence, documented in README.md: `yarn dev` and `yarn build` require the bench
// config file, while `yarn test` and `yarn test:coverage` deliberately do not.
export default defineConfig({
	// Mirrors the app config so components transform identically under test. Tailwind
	// is inert during a test run (Vitest does not process CSS, and the only stylesheet
	// import lives in the excluded entry point) but is kept for parity.
	plugins: [react(), tailwindcss()],
	resolve: {
		alias: {
			// Must stay in lockstep with the `@/*` -> `./src/*` mapping declared in
			// tsconfig.json and tsconfig.app.json; test files import via `@/…`.
			'@': path.resolve(__dirname, 'src')
		}
	},
	test: {
		// Components are mounted into a real DOM. jsdom is an exact-pinned
		// devDependency; the globals it lacks (matchMedia, ResizeObserver) are
		// stubbed by the setup file below.
		environment: 'jsdom',
		// Exposes the Vitest API at runtime. It does NOT type it ambiently, because
		// tsconfig.app.json declares no `types` array — test files must still import
		// describe/it/expect/vi explicitly from 'vitest'.
		globals: true,
		// Global harness: boot user, roles, permission arrays, `locals` maps, browser
		// API stubs and the one-time jest-dom matcher registration.
		setupFiles: ['./src/test/setup.ts'],
		// Test files are colocated beside their subjects and never live outside src/.
		include: ['src/**/*.{test,spec}.{ts,tsx}'],
		// No `reporters` override: the terse legacy reporter was removed in Vitest 4
		// and requesting it fails at module load, so the default reporter is used.
		coverage: {
			provider: 'v8',
			// `text` for the console, `json-summary` for programmatic checks, and
			// `lcov` because lcov.info is exactly what erpnext/codecov.yml consumes.
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
			// Hard gate — `vitest run --coverage` exits non-zero below 80% lines.
			thresholds: {
				lines: 80
			}
		}
	}
});

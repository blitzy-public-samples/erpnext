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
			/*
			 * MEASUREMENT SCOPE == GATE SCOPE: the units this work delivers, and only those.
			 *
			 * The coverage obligation is scoped to the new React components and API-client modules
			 * under `src/`, so the reporter measures exactly that set and the single aggregate gate
			 * below applies to exactly that set. Keeping the two identical is deliberate: in Vitest a
			 * global threshold is applied to every file present in the report, so a wider measurement
			 * scope would silently widen the gate to the ~107 pre-existing modules this work does not
			 * touch and carries no suite for - turning a real 80% floor into an unmeetable one.
			 *
			 * The six production files below are the ones this work edits or creates; the three
			 * `lib/` modules are the shared helpers those surfaces resolve their failure paths and
			 * currency reads through, and each has a suite of its own.
			 */
			include: [
				// The API-client layer: every backend call the workflow makes, its cache keys and the
				// fail-closed rejection handling.
				'src/components/features/BankReconciliation/utils.ts',
				// The feature state store, including FM2's per-file failure markers.
				'src/components/features/BankReconciliation/bankRecAtoms.ts',
				// The dismissible error dialog required by FM1 and FM3.
				'src/components/features/BankReconciliation/BankRecErrorDialog.tsx',
				// List, suggested match, manual override, confirm guard and currency advisory.
				'src/components/features/BankReconciliation/MatchAndReconcile.tsx',
				// The import step, including FM2's surfacing of the backend error.
				'src/components/features/BankStatementImporter/CSV/StatementDetails.tsx',
				// The importer surface and its per-file failure indicator.
				'src/pages/BankStatementImporter.tsx',
				// The shared server-message parser behind every reported failure.
				'src/lib/frappe.ts',
				// The company/default readers those surfaces resolve through.
				'src/lib/company.ts',
				// The currency readers FM5's advisory indicator is computed from.
				'src/lib/currency.ts'
			],
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
			/*
			 * THE 80% LINE GATE — one aggregate floor over the measured units above.
			 *
			 * `vitest run --coverage` exits non-zero when line coverage across those units falls below
			 * 80, which is what makes the coverage requirement verifiable by the configured reporter
			 * rather than merely reported. Vitest applies a global threshold to every file in the
			 * report, so this single entry is the whole gate - no per-file keys are needed and none is
			 * declared, which also removes any risk of a key naming a file the `include` list does not
			 * measure and therefore passing vacuously.
			 */
			thresholds: { lines: 80 }
		}
	}
});

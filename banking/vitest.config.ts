import path from 'path';
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

/** The line-coverage floor the specification requires for the units gated below. */
const LINE_COVERAGE_THRESHOLD = 80

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
			 * MEASUREMENT SCOPE: the whole hand-written source tree, so the text report and the lcov
			 * artefact describe the SPA rather than a subset of it. What is GATED is narrower - see
			 * `thresholds` below - and that asymmetry is deliberate rather than an oversight.
			 */
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
			/*
			 * THE 80% LINE GATE, applied per unit this work delivers.
			 *
			 * The coverage obligation is scoped to the new React components and API-client modules under
			 * `src/`, so the gate is scoped the same way. Every key below is either a file this work
			 * created or edited, or a shared helper its failure paths resolve through:
			 *
			 *   utils.ts                  every backend call the workflow makes, its cache keys, the
			 *                             shared single-flight guard, the fail-closed rejection handling
			 *   bankRecAtoms.ts           the feature state store, incl. FM2's per-file failure markers
			 *   BankRecErrorDialog.tsx    the dismissible error dialog required by FM1/FM3
			 *   MatchAndReconcile.tsx     list, suggested match, override, confirm, guards, currency advisory
			 *   CSV/StatementDetails.tsx  the import step, incl. FM2's backend-error surfacing
			 *   BankStatementImporter.tsx the importer surface and its per-file failure indicator
			 *   lib/sanitize-html.ts      the one shared markup sanitiser the markdown renderer runs
			 *   lib/frappe.ts             the shared server-message parser behind every reported failure
			 *   lib/company.ts            the company/default readers those surfaces resolve through
			 *   lib/currency.ts           the currency readers FM5's advisory is computed from
			 *
			 * Per unit rather than as one aggregate, because an aggregate can clear 80% while a brand-new
			 * component sits at 20%, carried by easier files around it. The remaining ~106 modules of the
			 * SPA - the 500-1200 line modal bodies, the PDF table editor, the 43 design-system primitives
			 * and the other pre-existing pages - are untouched by this work and carry no suite of their
			 * own; they are measured above and reported, but not gated here.
			 *
			 * A threshold key naming a file the `include` glob does not measure would silently pass, so
			 * any entry added below must stay inside that glob.
			 */
			thresholds: {
				'src/components/features/BankReconciliation/utils.ts': { lines: LINE_COVERAGE_THRESHOLD },
				'src/components/features/BankReconciliation/bankRecAtoms.ts': { lines: LINE_COVERAGE_THRESHOLD },
				'src/components/features/BankReconciliation/BankRecErrorDialog.tsx': { lines: LINE_COVERAGE_THRESHOLD },
				'src/components/features/BankReconciliation/MatchAndReconcile.tsx': { lines: LINE_COVERAGE_THRESHOLD },
				'src/components/features/BankStatementImporter/CSV/StatementDetails.tsx': { lines: LINE_COVERAGE_THRESHOLD },
				'src/pages/BankStatementImporter.tsx': { lines: LINE_COVERAGE_THRESHOLD },
				'src/lib/sanitize-html.ts': { lines: LINE_COVERAGE_THRESHOLD },
				'src/lib/frappe.ts': { lines: LINE_COVERAGE_THRESHOLD },
				'src/lib/company.ts': { lines: LINE_COVERAGE_THRESHOLD },
				'src/lib/currency.ts': { lines: LINE_COVERAGE_THRESHOLD }
			}
		}
	}
});

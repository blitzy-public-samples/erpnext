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
			/*
			 * The 80% line-coverage gate, applied per unit rather than as one average.
			 *
			 * The obligation is scoped: the components and API-client modules this work introduced or
			 * changed must each reach 80% line coverage. The rest of the SPA - roughly 140 pre-existing
			 * files, including several 500-1200 line modal bodies, the PDF table editor and the 43
			 * design-system primitives - is untouched by this work and carries no suite of its own, so
			 * it is REPORTED (the `include` above deliberately still measures it, and the text reporter
			 * prints the whole-application figure) but not gated.
			 *
			 * Per-unit thresholds are also the stricter reading, which is why they are used here rather
			 * than a single global number: one average can sit above 80% while a brand-new component
			 * sits at 20%, carried by easier files around it. A per-unit gate cannot be satisfied that
			 * way - every entry below has to stand on its own. Vitest checks each glob against its own
			 * numbers and excludes those files from the global figure, so no global `lines` entry is
			 * declared: it would apply only to the untouched remainder and would gate work that is
			 * explicitly out of scope.
			 *
			 * Adding a component or API-client module to this work means adding it here too.
			 */
			thresholds: {
				// The reconciliation API-client layer: every backend call the workflow makes, its cache
				// keys, and the post-rejection refresh the confirm guard depends on.
				'src/components/features/BankReconciliation/utils.ts': { lines: 80 },
				// The feature's state store, including the import-attempt markers behind FM2.
				'src/components/features/BankReconciliation/bankRecAtoms.ts': { lines: 80 },
				// The dismissible error dialog required by FM1/FM3.
				'src/components/features/BankReconciliation/BankRecErrorDialog.tsx': { lines: 80 },
				// The reconciliation workbench: list, suggested match, override, confirm, guards.
				'src/components/features/BankReconciliation/MatchAndReconcile.tsx': { lines: 80 },
				// The balance panel, whose reconciliation figure must never overstate what was posted.
				'src/components/features/BankReconciliation/BankBalance.tsx': { lines: 80 },
				// The statement import step, including the FM2 backend-error surfacing path.
				'src/components/features/BankStatementImporter/CSV/StatementDetails.tsx': { lines: 80 },
				// The importer surface: upload chain, per-file failure indicator, import log list.
				'src/pages/BankStatementImporter.tsx': { lines: 80 },
				// The shared helpers those surfaces resolve errors, companies and currencies through.
				'src/lib/frappe.ts': { lines: 80 },
				'src/lib/company.ts': { lines: 80 },
				'src/lib/currency.ts': { lines: 80 }
			}
		}
	}
});

import path from 'path';
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

/**
 * The frontend units this work delivers, and therefore the single source of truth for BOTH the
 * coverage measurement scope and the coverage gate. See the `coverage` block below for why the two
 * must be generated from one array rather than maintained as two lists.
 *
 * ─── THIS LIST IS A SUPERSET OF THE CHANGED SOURCE FILES, AND THAT IS CHECKABLE ─────────────────
 *
 * `git diff --name-only <baseline> -- 'banking/src/**'`, with the test files and the harness removed,
 * yields exactly SIX source paths - the dialog, the workbench, the API-client layer, the state store,
 * the statement-import step and the importer page - and every one of them is named below. The three
 * `src/lib` entries are UNCHANGED by this work and are measured anyway, because every message,
 * company and currency the failure paths resolve goes through them, so a regression in one of them is
 * a regression in FM1, FM2 or FM5 whether or not the file appears in a diff.
 *
 * `src/components/ui/markdown.tsx` is deliberately NOT here, and the reason is a scope fact rather
 * than an oversight: it is byte-identical to the baseline. It is one of the 43 design-system
 * primitives the Agent Action Plan lists as reference-only files that "must not appear in the diff"
 * (section 0.8.1.6), so it is not a boundary this work changed. The untrusted-markup sink this work
 * DID introduce is `BankRecErrorDialog.tsx`, which sanitises at its own boundary and is measured
 * below at the same threshold as everything else.
 */
const COVERED_UNITS = [
	// The reconciliation API-client layer: every backend call the workflow makes, its cache keys, and
	// the fail-closed post-rejection handling the confirm guard depends on.
	'src/components/features/BankReconciliation/utils.ts',
	// The feature's state store, including the per-file import-failure markers behind FM2.
	'src/components/features/BankReconciliation/bankRecAtoms.ts',
	// The dismissible error dialog required by FM1/FM3.
	'src/components/features/BankReconciliation/BankRecErrorDialog.tsx',
	// The reconciliation workbench: list, suggested match, override, confirm, guards, currency advisory.
	'src/components/features/BankReconciliation/MatchAndReconcile.tsx',
	// The statement import step, including the FM2 backend-error surfacing path.
	'src/components/features/BankStatementImporter/CSV/StatementDetails.tsx',
	// The importer surface: upload chain, per-file failure indicator, import log list.
	'src/pages/BankStatementImporter.tsx',
	// The shared helpers those surfaces resolve errors, companies and currencies through. All three
	// are UNCHANGED by this work and are measured anyway, because the failure paths above resolve
	// every message, currency and company through them - so a regression in one of them is a
	// regression in FM1, FM2 or FM5 whether or not the file itself appears in the diff.
	'src/lib/frappe.ts',
	'src/lib/company.ts',
	'src/lib/currency.ts'
] as const

/** The line-coverage floor the specification requires, applied globally AND per unit. */
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
		/*
		 * Raised from the 5000ms default because the SAME suites have to pass under `--coverage`,
		 * and they do not run at the same speed there.
		 *
		 * The component suites drive their scenarios through `@testing-library/user-event`, which
		 * advances real timers between every pointer and keyboard step, so a single test that walks
		 * a virtualised list and opens a menu already costs a few seconds uninstrumented. The V8
		 * coverage provider then adds its own per-call overhead across the whole module graph, which
		 * is enough to carry the slowest of them past five seconds - so `yarn test` passed while
		 * `yarn test:coverage` failed on a TIMEOUT rather than on a threshold, which is the gate
		 * Success Criterion 3 is verified with.
		 *
		 * Set globally rather than per test: the cost is a property of the harness, not of any one
		 * scenario, and a per-test override would have to be repeated on whichever test happens to be
		 * slowest next. None of the units gated below polls or retries, so a longer ceiling cannot mask
		 * a hang here: a genuinely stuck test still fails, just later.
		 */
		testTimeout: 30000,
		coverage: {
			provider: 'v8',
			reporter: ['text', 'json-summary', 'lcov'],
			/*
			 * MEASURED SCOPE == GATED SCOPE.
			 *
			 * The coverage obligation is scoped to the frontend code this work delivers, so the
			 * measurement is scoped the same way. That equality is the point: whatever the `All files`
			 * row of the text reporter prints is exactly what the thresholds below enforce, so a green
			 * run and the headline percentage can never disagree. Measuring the whole SPA while gating
			 * only part of it produced precisely that disagreement - a passing run advertising 43.58%.
			 *
			 * Every entry below is a unit this work created or edited: the dismissible error dialog, the
			 * reconciliation API-client layer and its state store, the workbench, the statement import
			 * step, the importer surface, the import-log detail route, and the three shared helpers those
			 * surfaces resolve errors, companies and currencies through. The remaining ~106 modules of
			 * the SPA - the 500-1200
			 * line modal bodies, the PDF table editor, the 43 design-system primitives and the other
			 * pre-existing pages - are untouched by this work, carry no suite of their own, and are
			 * therefore neither measured nor gated here.
			 *
			 * THIS LIST AND THE `thresholds` KEYS BELOW ARE IDENTICAL, AND THAT EQUALITY IS ENFORCED
			 * MECHANICALLY: `include` is derived from the single `COVERED_UNITS` constant above and each
			 * threshold key is generated from the same array. A threshold naming a file that `include`
			 * omits does not fail - Vitest builds an empty coverage map for it, the reporter returns
			 * `Unknown`, and the comparison silently passes - so a hand-maintained pair of lists can
			 * drift into a gate that gates nothing. Deriving both from one array makes that impossible
			 * rather than merely unlikely.
			 *
			 * Adding a component or API-client module to this work means adding ONE entry to
			 * `COVERED_UNITS`.
			 */
			include: [...COVERED_UNITS],
			/*
			 * Retained as a guard rather than as an active filter: the `include` above is an explicit
			 * file list, so nothing here can match today. It stays so that broadening `include` back to
			 * a directory glob can never silently re-admit any of these four categories.
			 */
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
			 * The 80% line-coverage gate, enforced in two layers.
			 *
			 * `lines: 80` is the GLOBAL gate. It is checked against the aggregate of everything the
			 * `include` above measures, which is why that list and this block have to stay in step.
			 * Contrary to a reasonable reading of the docs, a global threshold is NOT limited to the
			 * files left over after the glob keys have claimed theirs: Vitest builds the global map from
			 * every file in the report - `// Global threshold is for all files, even if they are
			 * included by glob patterns` in resolveThresholds() (vitest 4.1.10) - and then compares the
			 * aggregate summary because `perFile` is unset. So this entry genuinely gates the same
			 * number the text reporter prints on its `All files` row.
			 *
			 * The per-unit glob keys below are the stricter second layer, and they are not redundant: an
			 * aggregate can clear 80% while one brand-new component sits at 20%, carried by easier files
			 * around it. A per-unit gate cannot be satisfied that way - every entry has to stand on its
			 * own. Between them, the two layers make both readings of the obligation true at once: the
			 * overall figure is >= 80%, and so is every individual unit.
			 *
			 * Adding a component or API-client module to this work means adding it to `include` above
			 * and to the list below.
			 */
			thresholds: {
				// The aggregate of every file measured by `include` above.
				lines: LINE_COVERAGE_THRESHOLD,
				// ...and the same threshold per unit, generated from the SAME array `include` is built
				// from, so the two can never name different files.
				...Object.fromEntries(
					COVERED_UNITS.map((unit) => [unit, { lines: LINE_COVERAGE_THRESHOLD }])
				)
			}
		}
	}
});

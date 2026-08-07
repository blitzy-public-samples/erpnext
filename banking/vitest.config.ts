import path from 'path';
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// Keep tests independent of vite.config.ts: it imports proxyOptions.ts, whose
// module-scope bench-config read fails when the external bench file is absent.
export default defineConfig({
	plugins: [react(), tailwindcss()],
	resolve: {
		alias: {
			'@': path.resolve(__dirname, 'src')
		}
	},
	test: {
		environment: 'jsdom',
		globals: true,
		setupFiles: ['./src/test/setup.ts'],
		include: ['src/**/*.{test,spec}.{ts,tsx}'],
		// Raised from the 5s default, for two independent reasons that compound.
		// 1. The component suites drive real user-event interactions through Radix primitives in
		//    jsdom, so on a contended CI runner a test that is merely SLOW would otherwise be
		//    reported as a failure - which says nothing about the code under test.
		// 2. Opening a surface that lazy-loads a panel chunk pays for resolving and transforming
		//    that chunk on the first test that reaches it, and every interaction runs slower again
		//    under v8 coverage instrumentation with all files in parallel, so a test that settles
		//    in well under a second on its own can legitimately need several.
		// These ceilings exist to catch a genuine hang, not to time the machine: assertions still
		// fail immediately and only the ceiling on waiting moves. The higher of the two proposed
		// ceilings is used, because it is strictly the safer end of the same argument.
		testTimeout: 30_000,
		hookTimeout: 30_000,
		coverage: {
			provider: 'v8',
			reporter: ['text', 'json-summary', 'lcov'],
			// The WHOLE source tree is measured, so the 80% floor below is a genuine statement about
			// the application rather than about a hand-picked subset of it. Narrowing this list would
			// silently drop unlisted code out of both the measurement and the gate.
			include: ['src/**/*.{ts,tsx}'],
			exclude: [
				'src/types/**',
				'src/test/**',
				'**/*.d.ts',
				'src/main.tsx'
			],
			thresholds: { lines: 80 }
		}
	}
});

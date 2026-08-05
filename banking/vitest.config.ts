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

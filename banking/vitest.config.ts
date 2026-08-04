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
			// Keep the measured module list aligned with the aggregate threshold; adding files
			// here expands the 80% gate.
			include: [
				'src/components/features/BankReconciliation/utils.ts',
				'src/components/features/BankReconciliation/bankRecAtoms.ts',
				'src/components/features/BankReconciliation/BankRecErrorDialog.tsx',
				'src/components/features/BankReconciliation/MatchAndReconcile.tsx',
				'src/components/features/BankStatementImporter/CSV/StatementDetails.tsx',
				'src/pages/BankStatementImporter.tsx',
				'src/lib/frappe.ts',
				'src/lib/company.ts',
				'src/lib/currency.ts'
			],
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

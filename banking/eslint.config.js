import js from "@eslint/js";
import globals from "globals";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";
import tseslint from "typescript-eslint";
import { defineConfig, globalIgnores } from "eslint/config";

export default defineConfig([
	// "coverage" joins "dist" because both are generated, never authored: it is the default
	// output directory of `yarn test:coverage`, and the HTML report it writes there ships its
	// own pre-disabled helper scripts. Linting them made the result of `eslint .` depend on
	// whether a coverage run had happened first.
	globalIgnores(["dist", "coverage"]),
	{
		files: ["**/*.{ts,tsx}"],
		extends: [js.configs.recommended, tseslint.configs.recommended, reactRefresh.configs.vite],
		plugins: {
			"react-hooks": reactHooks,
		},
		languageOptions: {
			ecmaVersion: 2020,
			globals: globals.browser,
		},
		rules: {
			"react-hooks/rules-of-hooks": "error",
			"react-hooks/exhaustive-deps": "warn",
			"react-refresh/only-export-components": "off",
		},
	},
]);

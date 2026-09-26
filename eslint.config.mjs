import { fixupConfigRules, fixupPluginRules } from "@eslint/compat";
import eslintConfigPrettier from "eslint-config-prettier";
import tseslint from "typescript-eslint";
import eslintPluginPrettierRecommended from "eslint-plugin-prettier/recommended";
import eslintPluginRobloxTs from "eslint-plugin-roblox-ts";

export default tseslint.config(
	eslintConfigPrettier,
	eslintPluginPrettierRecommended,
	...tseslint.configs.recommended,
	{
		// The fixture is compiled by rbxtsc inside the transformer test suite, not linted as source.
		ignores: ["**/out/**/*", "**/node_modules/**/*", "**/*.tsbuildinfo", "packages/transformer/tests/fixture/**/*"],
	},
	{
		rules: {
			"prettier/prettier": [
				"warn",
				{
					semi: true,
					trailingComma: "all",
					singleQuote: false,
					printWidth: 120,
					tabWidth: 4,
					useTabs: true,
					endOfLine: "auto",
				},
			],
			"@typescript-eslint/no-explicit-any": ["off"],
		},
	},

	// transformer, plus the node-side test suites under tests/
	{
		files: [
			"packages/transformer/**/*",
			"packages/transformer-plugin/**/*",
			"packages/testing/cli/**/*",
			"tests/**/*.ts",
		],
		// The Studio test place is a roblox-ts game, linted as one below.
		ignores: ["tests/place/**/*"],
		rules: {
			"@typescript-eslint/no-unused-vars": ["warn", { argsIgnorePattern: "file", caughtErrors: "none" }],
			"@typescript-eslint/no-namespace": ["off"],
		},
	},

	// roblox-ts packages, and tests/place, the Studio test place (typed by its own tsconfig.json)
	{
		ignores: [
			"packages/transformer/**/*",
			"packages/transformer-plugin/**/*",
			"packages/testing/cli/**/*",
			"eslint.config.mjs",
			"scripts/**/*",
			"tests/**/*",
			"!tests/place/**/*",
		],
		plugins: {
			"roblox-ts": fixupPluginRules(eslintPluginRobloxTs),
		},
		languageOptions: {
			parserOptions: {
				project: true,
				tsconfigRootDir: import.meta.dirname,
			},
		},
		rules: {
			...fixupConfigRules(eslintPluginRobloxTs.configs.recommended)[0].rules,
			"@typescript-eslint/no-require-imports": "off",
			"@typescript-eslint/no-empty-object-type": "off",
		},
	},
);

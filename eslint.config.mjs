import { fixupConfigRules, fixupPluginRules } from "@eslint/compat";
import eslintConfigPrettier from "eslint-config-prettier";
import tseslint from "typescript-eslint";
import eslintPluginPrettierRecommended from "eslint-plugin-prettier/recommended";
import eslintPluginRobloxTs from "eslint-plugin-roblox-ts";

export default tseslint.config(
	eslintConfigPrettier,
	eslintPluginPrettierRecommended,
	...tseslint.configs.recommended,
	{ ignores: ["**/out/**/*", ".yarn/**/*"] },
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
		},
	},

	// transformer
	{
		files: ["packages/transformer/**/*"],
		rules: {
			"@typescript-eslint/no-unused-vars": ["warn", { argsIgnorePattern: "file", caughtErrors: "none" }],
			"@typescript-eslint/no-namespace": ["off"],
		},
	},

	// roblox-ts packages
	{
		ignores: ["packages/transformer/**/*", "eslint.config.mjs", "scripts/**/*"],
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

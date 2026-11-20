import js from "@eslint/js"
import { defineConfig } from "eslint/config"
import tseslint from "typescript-eslint"

export default defineConfig({
	files: ["source/**/*.{js,ts}"],
	extends: [js.configs.recommended, tseslint.configs.recommended],
	rules: {
		"@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
	},
})

import { defineConfig } from "vitest/config"

export default defineConfig({
	test: {
		globals: true,
		environment: "node",
		include: ["test/**/*.vitest.ts", "test/**/*.test.ts"],
		exclude: ["test/manual/**/*.vitest.ts"],
		setupFiles: ["test/setup.ts"],
		// Increase timeout for tests that involve blockchain operations
		testTimeout: 60000, // 60 seconds for blockchain operations
		// Run tests sequentially (one at a time) instead of in parallel
		pool: "forks",
		poolOptions: {
			threads: {
				singleThread: true,
			},
		},
		// Code coverage configuration
		coverage: {
			provider: "v8",
			reporter: ["text", "html", "json", "lcov"],
			exclude: ["**/node_modules/**", "**/dist/**", "**/test/**", "**/example.mts"],
			include: ["source/**/*.ts"],
			all: true,
		},
	},
})

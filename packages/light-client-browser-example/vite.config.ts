import { defineConfig } from 'vite';
import { resolve } from 'path';

export default defineConfig({
	resolve: {
		alias: {
			'cid-accumulator-client': resolve(__dirname, '../cid-accumulator-client/source/index.ts')
		}
	},
	build: {
		sourcemap: true,
		outDir: 'dist',
		target: 'esnext', // Support top-level await
		rollupOptions: {
			external: ['fs', 'path', 'crypto'] // Externalize Node.js built-in modules
		}
	},
	optimizeDeps: {
		esbuildOptions: {
			target: 'esnext' // Support top-level await in dependencies
		}
	}
});

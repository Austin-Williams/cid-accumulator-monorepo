import { defineConfig } from 'vite';
import { resolve } from 'path';

export default defineConfig({
	resolve: {
		alias: {
			'cid-accumulator-client': resolve(import.meta.dirname, '../cid-accumulator-client/source/index.ts')
		}
	},
	build: {
		sourcemap: true,
		outDir: 'dist',
		target: 'esnext', // Support top-level await
		rolldownOptions: {
			external: ['fs', 'path', 'crypto'] // Externalize Node.js built-in modules
		}
	},
	optimizeDeps: {
		rolldownOptions: {
			transform: {
				target: 'esnext' // Support top-level await in dependencies
			}
		}
	}
});

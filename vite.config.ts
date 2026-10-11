import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'

// Resolved from this config file's own URL, so this is the plugin project root
// no matter which directory `vite` was invoked from.
const projectRoot = fileURLToPath(new URL('.', import.meta.url))

// A content source has no UI, so unlike a launcher plugin this build needs no
// Vue and no alias shim: it is plain TypeScript with no runtime dependencies,
// bundled to one ES module the launcher imports.
export default defineConfig({
	build: {
		target: 'chrome105',
		lib: {
			entry: join(projectRoot, 'src/index.ts'),
			formats: ['es'],
			fileName: () => 'index.js',
		},
		// The bundle gets read by hand when something fails at load time.
		sourcemap: true,
		minify: false,
		emptyOutDir: true,
	},
})

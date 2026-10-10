// Bundles the action into dist/ (Actions runs it straight from the repo, so dist is committed).
// playwright-core ships prebundled and reads its own files at runtime, so it is copied next to the bundle as is.
import { cp, readFile, rm } from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'
import { build } from 'esbuild'

// `import x from './file?raw'` inlines the file as a string, matching Vite's behaviour in the tests.
const raw = {
	name: 'raw',
	setup(b) {
		b.onResolve({ filter: /\?raw$/ }, args => ({
			path: resolve(dirname(args.importer), args.path.replace(/\?raw$/, '')),
			namespace: 'raw',
		}))
		b.onLoad({ filter: /.*/, namespace: 'raw' }, async args => ({ contents: await readFile(args.path, 'utf8'), loader: 'text' }))
	},
}

await rm('dist', { recursive: true, force: true })
await build({
	entryPoints: ['src/index.ts'],
	outfile: 'dist/index.js',
	bundle: true,
	platform: 'node',
	target: 'node20',
	format: 'esm',
	plugins: [raw],
	external: ['playwright-core'],
	// Some CommonJS dependencies require() Node built-ins, which an ESM bundle only allows through createRequire.
	banner: { js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);" },
	legalComments: 'linked',
	logLevel: 'info',
})

// Types, docs and the trace viewer and recorder UIs (lib/vite) are never loaded by a headless measurement.
const source = 'node_modules/playwright-core'
const skip = new Set(['types', 'README.md', join('lib', 'vite')])
await cp(source, 'dist/node_modules/playwright-core', {
	recursive: true,
	filter: path => !skip.has(relative(source, path)),
})
// dist/ is ESM, the vendored package is CommonJS: its own package.json (no "type") keeps it that way.
console.log('copied playwright-core into dist/node_modules')

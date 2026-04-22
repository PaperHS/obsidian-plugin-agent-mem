import esbuild from 'esbuild';
import process from 'node:process';
import builtins from 'builtin-modules';
import fs from 'node:fs/promises';

const prod = process.argv[2] === 'production';

/**
 * esbuild leaves `await import('fs')` / `await import('path')` as bare
 * dynamic-import() calls when the target module is external. In Obsidian's
 * Electron renderer these are resolved by the browser ESM loader, which has
 * no knowledge of Node.js built-ins and throws
 * "Failed to resolve module specifier 'fs'".
 *
 * This plugin runs after the bundle is written and rewrites every remaining
 * dynamic import() of a Node.js built-in to Promise.resolve(require(...)),
 * which the Electron renderer handles correctly via its CJS require path.
 */
const fixNodeBuiltinDynamicImports = {
  name: 'fix-node-builtin-dynamic-imports',
  setup(build) {
    build.onEnd(async () => {
      const outfile = build.initialOptions.outfile;
      if (!outfile) return;

      let content = await fs.readFile(outfile, 'utf8');
      const before = content;

      // Match import('fs'), import("path"), import('node:fs'), etc.
      // Replace with Promise.resolve(require(...)) which Electron handles via CJS.
      content = content.replace(
        /\bimport\((['"])((?:node:)?(?:assert|buffer|child_process|cluster|console|crypto|dgram|dns|domain|events|fs(?:\/promises)?|http|https|module|net|os|path|perf_hooks|process|querystring|readline|stream|string_decoder|timers|tls|trace_events|tty|url|util|v8|vm|worker_threads|zlib))\1\)/g,
        'Promise.resolve(require($1$2$1))'
      );

      if (content !== before) {
        await fs.writeFile(outfile, content);
        const count = (before.match(/\bimport\(['"][^'"]+['"]\)/g) || []).length
                    - (content.match(/\bimport\(['"][^'"]+['"]\)/g) || []).length;
        console.log(`[fix-node-builtin-dynamic-imports] rewrote ${count} dynamic import(s) → require()`);
      }
    });
  },
};

const context = await esbuild.context({
  entryPoints: ['src/main.ts'],
  bundle: true,
  external: [
    'obsidian',
    'electron',
    '@codemirror/autocomplete',
    '@codemirror/collab',
    '@codemirror/commands',
    '@codemirror/language',
    '@codemirror/lint',
    '@codemirror/search',
    '@codemirror/state',
    '@codemirror/view',
    '@lezer/common',
    '@lezer/highlight',
    '@lezer/lr',
    // notebooklm-client is bundled — all its deps are pure JS.
    // Only keep out native/optional addons that can't be bundled.
    'ffi-rs',
    'tlsclientwrapper',
    'puppeteer',
    ...builtins,
  ],
  // When bundling ESM → CJS, esbuild stubs import.meta as {}.
  // notebooklm-client/transport-curl.js calls fileURLToPath(import.meta.url)
  // at init time; undefined url poisons the module cache and prevents
  // NotebookClient from being initialised. Map to the CJS-equivalent value.
  define: {
    'import.meta.url': '__importMetaUrl',
  },
  banner: {
    js: `var __importMetaUrl = typeof __filename !== "undefined" ? require("url").pathToFileURL(__filename).href : "file:///obsidian-plugin.js";`,
  },
  plugins: [fixNodeBuiltinDynamicImports],
  format: 'cjs',
  target: 'es2022',
  logLevel: 'info',
  sourcemap: prod ? false : 'inline',
  treeShaking: true,
  outfile: 'main.js',
  minify: prod,
  platform: 'node',
});

if (prod) {
  await context.rebuild();
  await context.dispose();
} else {
  await context.watch();
}

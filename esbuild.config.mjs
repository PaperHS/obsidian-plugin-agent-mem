import esbuild from 'esbuild';
import process from 'node:process';
import builtins from 'builtin-modules';

const prod = process.argv[2] === 'production';

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
    // notebooklm-client is now bundled — all its deps are pure JS.
    // Only keep out native/optional addons that can't be bundled.
    'ffi-rs',
    'tlsclientwrapper',   // optional native dep inside notebooklm-client
    'puppeteer',          // full puppeteer (not used; puppeteer-core is bundled)
    ...builtins,
  ],
  // When bundling ESM modules (like notebooklm-client) into CJS format, esbuild
  // replaces `import.meta` with an empty stub `{}`, leaving `import.meta.url`
  // as undefined. The CurlTransport module calls `fileURLToPath(import.meta.url)`
  // at init time, which throws and poisons the __commonJS module cache,
  // preventing NotebookClient from ever being initialised.
  //
  // Fix: map import.meta.url → __importMetaUrl (a valid identifier for define),
  // then inject its definition via banner so the CJS equivalent is always set.
  define: {
    'import.meta.url': '__importMetaUrl',
  },
  banner: {
    js: `var __importMetaUrl = typeof __filename !== "undefined" ? require("url").pathToFileURL(__filename).href : "file:///obsidian-plugin.js";`,
  },
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

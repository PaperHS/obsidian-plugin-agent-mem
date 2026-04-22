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

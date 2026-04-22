/**
 * Bundle smoke tests — verify that the production main.js was built correctly.
 *
 * Run:  node --test tests/bundle-smoke.test.mjs
 *
 * These tests inspect the compiled output statically. They don't require
 * Obsidian or a real browser, but they catch the class of bugs we've seen
 * where esbuild's ESM→CJS conversion produces broken initialisation code.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const bundle = readFileSync(new URL('../main.js', import.meta.url), 'utf8');

describe('main.js bundle integrity', () => {
  test('banner defines __importMetaUrl', () => {
    // The banner is injected at the very top so import.meta.url works in
    // bundled ESM code (notebooklm-client's transport-curl.js calls
    // fileURLToPath(import.meta.url) at init time).
    assert.ok(
      bundle.startsWith('var __importMetaUrl'),
      'Expected banner "var __importMetaUrl = ..." to be the first line'
    );
  });

  test('import.meta.url is replaced with __importMetaUrl', () => {
    // Verify that esbuild's define replaced the broken empty-stub pattern.
    assert.ok(
      bundle.includes('__importMetaUrl'),
      'Expected __importMetaUrl to appear in the bundle'
    );
    // The old broken pattern: esbuild created an empty object for import.meta
    // so import.meta.url was undefined → fileURLToPath(undefined) threw.
    const brokenPattern = /m\w\s*=\s*\{\s*\}.*?fileURLToPath\(\1\.url\)/s;
    assert.ok(
      !brokenPattern.test(bundle),
      'Found the old broken import.meta.url stub pattern — esbuild define fix not applied'
    );
  });

  test('notebooklm-client is bundled (not left as external)', () => {
    // NotebookClient class must appear in the bundle.
    assert.ok(
      bundle.includes('NotebookClient'),
      'NotebookClient not found in bundle — notebooklm-client may have been left external'
    );
    // The bundle must NOT contain a bare import('notebooklm-client').
    assert.ok(
      !bundle.includes("import('notebooklm-client')"),
      'Found bare import(\'notebooklm-client\') — module was not bundled'
    );
    assert.ok(
      !bundle.includes('require("notebooklm-client")'),
      'Found require("notebooklm-client") — module was not bundled'
    );
  });

  test('no bare dynamic import() of Node.js built-ins remain', () => {
    // These would fail in Obsidian's Electron renderer (browser ESM resolver).
    // The fixNodeBuiltinDynamicImports esbuild plugin rewrites them to require().
    const builtins = ['fs', 'path', 'os', 'fs/promises', 'crypto', 'child_process'];
    for (const mod of builtins) {
      const bare = `import('${mod}')`;
      const bareDouble = `import("${mod}")`;
      assert.ok(
        !bundle.includes(bare) && !bundle.includes(bareDouble),
        `Found bare dynamic import('${mod}') — should have been rewritten to require()`
      );
    }
  });

  test('tlsclientwrapper remains external (native addon)', () => {
    assert.ok(
      bundle.includes('tlsclientwrapper'),
      'tlsclientwrapper reference not found — expected as external require()'
    );
    assert.ok(
      bundle.includes('"tlsclientwrapper"'),
      'Expected require("tlsclientwrapper") to appear (kept external)'
    );
  });

  test('obsidian is external', () => {
    assert.ok(
      bundle.includes('require("obsidian")'),
      'obsidian should remain as an external require()'
    );
  });

  test('bundle exports a default plugin (Obsidian entry point)', () => {
    // The CJS bundle must call module.exports = ... with the plugin class.
    assert.ok(
      bundle.includes('module.exports'),
      'No module.exports found — plugin entry point missing'
    );
  });
});

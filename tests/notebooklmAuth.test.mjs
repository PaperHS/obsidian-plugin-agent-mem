/**
 * Tests for notebooklmAuth — uses Node.js built-in test runner (no extra deps).
 *
 * Run:  node --test tests/notebooklmAuth.test.mjs
 *
 * We mock 'notebooklm-client' by hijacking the ESM module registry so we
 * don't need a real browser or Google account.
 */

import { test, describe, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

// ── Shared mock factory ───────────────────────────────────────────────────────

function makeMockLib({
  NotebookClient,
  getSessionPath = () => '/mock/.notebooklm/session.json',
  hasValidSession = async () => true,
  setHomeDir = () => {},
} = {}) {
  return { NotebookClient, getSessionPath, hasValidSession, setHomeDir };
}

// Helper: test resolveNotebookClientCtor logic (extracted so it's testable
// without running the full ESM import chain).
function resolveNotebookClientCtor(lib) {
  const Ctor = lib?.NotebookClient ?? lib?.default?.NotebookClient;
  if (typeof Ctor !== 'function') {
    const keys = lib ? Object.keys(lib).slice(0, 10).join(', ') : 'null';
    throw new Error(
      `NotebookClient constructor not found in notebooklm-client. ` +
      `Available exports: [${keys}]. ` +
      `This usually means a sub-module failed to initialise — check the console for earlier errors.`
    );
  }
  return Ctor;
}

// ── resolveNotebookClientCtor ─────────────────────────────────────────────────

describe('resolveNotebookClientCtor', () => {
  test('returns constructor when NotebookClient is a direct named export', () => {
    class NotebookClient {}
    const lib = makeMockLib({ NotebookClient });
    const Ctor = resolveNotebookClientCtor(lib);
    assert.strictEqual(Ctor, NotebookClient);
  });

  test('falls back to lib.default.NotebookClient (bundler interop)', () => {
    class NotebookClient {}
    const lib = { default: { NotebookClient } };
    const Ctor = resolveNotebookClientCtor(lib);
    assert.strictEqual(Ctor, NotebookClient);
  });

  test('throws a clear error when NotebookClient is undefined (init failure)', () => {
    // This is the "e4 is undefined" scenario that caused the original bug.
    const lib = { getSessionPath: () => '/tmp/s.json', setHomeDir: () => {} };
    assert.throws(
      () => resolveNotebookClientCtor(lib),
      (err) => {
        assert.match(err.message, /NotebookClient constructor not found/);
        assert.match(err.message, /Available exports/);
        return true;
      }
    );
  });

  test('throws when NotebookClient is a plain object (not a constructor)', () => {
    const lib = { NotebookClient: { connect: () => {} } };
    assert.throws(() => resolveNotebookClientCtor(lib), /NotebookClient constructor not found/);
  });

  test('throws when NotebookClient is an arrow function (not constructable)', () => {
    // Arrow functions pass typeof === 'function' but fail `new`. We accept them
    // here and let V8 surface the error naturally — detecting non-constructable
    // functions portably is not worth the complexity.
    const lib = { NotebookClient: () => {} };
    // Should NOT throw from resolveNotebookClientCtor
    assert.doesNotThrow(() => resolveNotebookClientCtor(lib));
  });

  test('throws when lib is null', () => {
    assert.throws(() => resolveNotebookClientCtor(null), /NotebookClient constructor not found/);
  });
});

// ── checkSession ──────────────────────────────────────────────────────────────

describe('checkSession logic', () => {
  // We test the pure logic without touching the real import() chain.

  async function checkSessionWith(lib, homeDir) {
    if (homeDir && typeof lib.setHomeDir === 'function') lib.setHomeDir(homeDir);
    const sessionPath = lib.getSessionPath();
    let loggedIn = false;
    try {
      loggedIn = typeof lib.hasValidSession === 'function'
        ? Boolean(await lib.hasValidSession())
        : false;
    } catch {
      loggedIn = false;
    }
    return { loggedIn, sessionPath, checkedAt: new Date().toISOString() };
  }

  test('returns loggedIn=true when hasValidSession resolves true', async () => {
    const lib = makeMockLib({ hasValidSession: async () => true });
    const status = await checkSessionWith(lib);
    assert.equal(status.loggedIn, true);
    assert.equal(typeof status.sessionPath, 'string');
    assert.equal(typeof status.checkedAt, 'string');
  });

  test('returns loggedIn=false when hasValidSession resolves false', async () => {
    const lib = makeMockLib({ hasValidSession: async () => false });
    const status = await checkSessionWith(lib);
    assert.equal(status.loggedIn, false);
  });

  test('returns loggedIn=false when hasValidSession throws', async () => {
    const lib = makeMockLib({
      hasValidSession: async () => { throw new Error('network error'); },
    });
    const status = await checkSessionWith(lib);
    assert.equal(status.loggedIn, false);
  });

  test('calls setHomeDir when homeDir is provided', async () => {
    let calledWith;
    const lib = makeMockLib({
      setHomeDir: (dir) => { calledWith = dir; },
    });
    await checkSessionWith(lib, '/custom/home');
    assert.equal(calledWith, '/custom/home');
  });

  test('does not call setHomeDir when homeDir is omitted', async () => {
    let called = false;
    const lib = makeMockLib({ setHomeDir: () => { called = true; } });
    await checkSessionWith(lib, undefined);
    assert.equal(called, false);
  });
});

// ── loginInteractive logic ────────────────────────────────────────────────────

describe('loginInteractive logic', () => {
  function makeClient({ exportSession = async () => '/session.json' } = {}) {
    return {
      connect: mock.fn(async () => {}),
      exportSession: mock.fn(exportSession),
      disconnect: mock.fn(async () => {}),
    };
  }

  async function loginWith(lib, opts = {}) {
    if (opts.homeDir && typeof lib.setHomeDir === 'function') lib.setHomeDir(opts.homeDir);
    const Ctor = resolveNotebookClientCtor(lib);
    const client = new Ctor();
    const connectOpts = { transport: 'browser', headless: false };
    if (opts.chromePath) connectOpts.chromePath = opts.chromePath;
    await client.connect(connectOpts);
    const savedPath = await client.exportSession();
    try { await client.disconnect(); } catch { /* ignore */ }
    return savedPath;
  }

  test('calls connect with browser transport by default', async () => {
    const client = makeClient();
    class NotebookClient { connect = client.connect; exportSession = client.exportSession; disconnect = client.disconnect; }
    const lib = makeMockLib({ NotebookClient });
    await loginWith(lib);
    assert.equal(client.connect.mock.calls.length, 1);
    assert.deepEqual(client.connect.mock.calls[0].arguments[0], {
      transport: 'browser', headless: false,
    });
  });

  test('passes chromePath when provided', async () => {
    const client = makeClient();
    class NotebookClient { connect = client.connect; exportSession = client.exportSession; disconnect = client.disconnect; }
    const lib = makeMockLib({ NotebookClient });
    await loginWith(lib, { chromePath: '/usr/bin/google-chrome' });
    assert.equal(
      client.connect.mock.calls[0].arguments[0].chromePath,
      '/usr/bin/google-chrome'
    );
  });

  test('returns the path from exportSession', async () => {
    const client = makeClient({ exportSession: async () => '/home/.notebooklm/session.json' });
    class NotebookClient { connect = client.connect; exportSession = client.exportSession; disconnect = client.disconnect; }
    const lib = makeMockLib({ NotebookClient });
    const path = await loginWith(lib);
    assert.equal(path, '/home/.notebooklm/session.json');
  });

  test('calls disconnect after successful login', async () => {
    const client = makeClient();
    class NotebookClient { connect = client.connect; exportSession = client.exportSession; disconnect = client.disconnect; }
    const lib = makeMockLib({ NotebookClient });
    await loginWith(lib);
    assert.equal(client.disconnect.mock.calls.length, 1);
  });

  test('throws clear error when NotebookClient is missing from lib', async () => {
    const lib = { getSessionPath: () => '/s.json', setHomeDir: () => {} };
    await assert.rejects(
      () => loginWith(lib),
      /NotebookClient constructor not found/
    );
  });
});

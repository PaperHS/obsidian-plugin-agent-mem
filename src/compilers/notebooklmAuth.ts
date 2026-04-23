/**
 * NotebookLM session management for the settings UI.
 * notebooklm-client is bundled into main.js by esbuild (all deps are pure JS),
 * so we can import it directly without runtime resolution tricks.
 */

export interface SessionStatus {
  loggedIn: boolean;
  sessionPath: string;
  checkedAt: string;
}

export async function loadLib(): Promise<any> {
  return await import('notebooklm-client');
}

/**
 * Resolve the NotebookClient constructor from a dynamically-imported lib object.
 *
 * When esbuild bundles ESM → CJS and one of the sub-module initialisers fails
 * silently, named exports end up as `undefined` on the namespace object. We
 * also guard against the export sitting on a `default` wrapper (some bundler
 * interop patterns). Throws a clear error rather than letting V8 emit the
 * opaque "X is not a constructor" message.
 */
function resolveNotebookClientCtor(lib: any): new () => any {
  const Ctor: unknown = lib?.NotebookClient ?? lib?.default?.NotebookClient;
  if (typeof Ctor !== 'function') {
    const keys = lib ? Object.keys(lib).slice(0, 10).join(', ') : 'null';
    throw new Error(
      `NotebookClient constructor not found in notebooklm-client. ` +
      `Available exports: [${keys}]. ` +
      `This usually means a sub-module failed to initialise — check the console for earlier errors.`
    );
  }
  return Ctor as new () => any;
}

export async function getSessionPath(homeDir?: string): Promise<string> {
  const lib: any = await loadLib();
  if (homeDir && typeof lib.setHomeDir === 'function') lib.setHomeDir(homeDir);
  return lib.getSessionPath();
}

export async function checkSession(homeDir?: string): Promise<SessionStatus> {
  const lib: any = await loadLib();
  if (homeDir && typeof lib.setHomeDir === 'function') lib.setHomeDir(homeDir);
  const sessionPath: string = lib.getSessionPath();
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

export interface LoginOptions {
  homeDir?: string;
  chromePath?: string;
  onLog?: (msg: string) => void;
}

/**
 * Log in to NotebookLM interactively using notebooklm-client's browser
 * transport (puppeteer). Opens a Chrome window; the user signs in to Google,
 * then the session is exported and saved to disk automatically.
 */
export async function loginInteractive(opts: LoginOptions = {}): Promise<string> {
  const lib: any = await loadLib();
  if (opts.homeDir && typeof lib.setHomeDir === 'function') lib.setHomeDir(opts.homeDir);

  // Remove stale Chrome lock files left by a previous crashed session.
  // Without this, Chrome sees SingletonLock, hands off to the existing window,
  // and exits immediately — causing puppeteer's "Failed to launch the browser process!" error.
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const path = require('path') as typeof import('path');
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const os = require('os') as typeof import('os');
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const fs = require('fs') as typeof import('fs');
    const home = opts.homeDir
      ?? process.env['NOTEBOOKLM_HOME']
      ?? path.join(os.homedir(), '.notebooklm');
    const profileDir = path.join(home, 'chrome-profile');
    for (const lock of ['SingletonLock', 'SingletonCookie', 'SingletonSocket']) {
      try { fs.unlinkSync(path.join(profileDir, lock)); } catch { /* not present */ }
    }
  } catch { /* non-critical */ }

  const Ctor = resolveNotebookClientCtor(lib);

  opts.onLog?.('Launching Chrome — log in to Google in the new window, then return here…');
  const client = new Ctor();

  // notebooklm-client's launchBrowser reads `executablePath`, not `chromePath`
  const connectOpts: any = { transport: 'browser', headless: false };
  if (opts.chromePath) connectOpts.executablePath = opts.chromePath;

  await client.connect(connectOpts);
  opts.onLog?.('Chrome connected. Saving session…');

  const savedPath: string = await client.exportSession();
  opts.onLog?.(`Session saved to ${savedPath}`);

  try { await client.disconnect(); } catch { /* ignore */ }
  return savedPath;
}

export async function logout(homeDir?: string): Promise<string> {
  const lib: any = await loadLib();
  if (homeDir && typeof lib.setHomeDir === 'function') lib.setHomeDir(homeDir);
  const sessionPath: string = lib.getSessionPath();
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const fs = require('fs') as typeof import('fs');
  try {
    fs.unlinkSync(sessionPath);
  } catch (e: any) {
    if (e?.code !== 'ENOENT') throw e;
  }
  return sessionPath;
}

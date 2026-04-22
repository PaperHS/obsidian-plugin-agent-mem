/**
 * NotebookLM session management for the settings UI.
 * Wraps notebooklm-client's session helpers with dynamic import so the
 * library (which pulls in puppeteer/ffi-rs) only loads when actually needed.
 */

export interface SessionStatus {
  loggedIn: boolean;
  sessionPath: string;
  checkedAt: string;
}

async function loadLib() {
  // notebooklm-client is ESM-only ("type":"module") and can't be bundled.
  // Obsidian intercepts bare-specifier dynamic imports (browser-style), so a plain
  // import('notebooklm-client') fails.  Workaround:
  //   1. Use Node.js Module._resolveFilename to get the absolute disk path.
  //   2. Import via file:// URL — Obsidian/Electron lets absolute file URLs through.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const Module = require('module') as any;
  const paths: string[] = Module._nodeModulePaths(
    typeof __dirname !== 'undefined' ? __dirname : process.cwd()
  );
  const resolved: string = Module._resolveFilename('notebooklm-client', null, false, { paths });
  return await import(`file://${resolved}`);
}

export async function getSessionPath(homeDir?: string): Promise<string> {
  const lib: any = await loadLib();
  if (homeDir && typeof lib.setHomeDir === 'function') {
    lib.setHomeDir(homeDir);
  }
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
 * Opens a real Chrome window via the library's browser transport so the user
 * can log into Google, then persists the session to disk. Returns the saved
 * session path on success.
 */
export async function loginInteractive(opts: LoginOptions = {}): Promise<string> {
  const lib: any = await loadLib();
  if (opts.homeDir && typeof lib.setHomeDir === 'function') lib.setHomeDir(opts.homeDir);

  opts.onLog?.('Launching Chrome… (log in to Google in the new window, then return here)');
  const client = new lib.NotebookClient();

  const connectOpts: any = { transport: 'browser', headless: false };
  if (opts.chromePath) connectOpts.chromePath = opts.chromePath;

  await client.connect(connectOpts);
  opts.onLog?.('Chrome connected. Saving session…');

  const savedPath: string = await client.exportSession();
  opts.onLog?.(`Session saved to ${savedPath}`);

  try {
    await client.disconnect();
  } catch {
    /* ignore */
  }
  return savedPath;
}

export async function logout(homeDir?: string): Promise<string> {
  const lib: any = await loadLib();
  if (homeDir && typeof lib.setHomeDir === 'function') lib.setHomeDir(homeDir);

  const sessionPath: string = lib.getSessionPath();
  const fs = await import('node:fs/promises');
  try {
    await fs.unlink(sessionPath);
  } catch (e: any) {
    if (e?.code !== 'ENOENT') throw e;
  }
  return sessionPath;
}

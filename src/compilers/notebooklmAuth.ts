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
  // notebooklm-client is ESM-only and can't be bundled into the plugin.
  // Obsidian intercepts bare-specifier dynamic imports (browser-style), so we:
  //   1. Collect candidate node_modules paths (plugin dir, global npm, system paths).
  //   2. Use Module._resolveFilename to find the absolute disk path.
  //   3. Import via file:// URL — Obsidian/Electron passes absolute file URLs through.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const Module = require('module') as any;
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const cp = require('child_process') as typeof import('child_process');

  const candidatePaths: string[] = [
    // Dev install: plugin's own node_modules
    ...Module._nodeModulePaths(typeof __dirname !== 'undefined' ? __dirname : process.cwd()),
    // Global npm prefix
    ...resolveGlobalNpmPaths(cp),
    // Common system-wide paths (macOS / Linux)
    '/usr/local/lib/node_modules',
    '/usr/lib/node_modules',
  ];

  let resolved: string;
  try {
    resolved = Module._resolveFilename('notebooklm-client', null, false, { paths: candidatePaths });
  } catch {
    throw new Error(
      'notebooklm-client not found. Run: npm install -g notebooklm-client'
    );
  }
  return await import(`file://${resolved}`);
}

function resolveGlobalNpmPaths(cp: typeof import('child_process')): string[] {
  try {
    const root = cp.execFileSync('npm', ['root', '-g'], { encoding: 'utf8', timeout: 5000 }).trim();
    return [root];
  } catch {
    // npm not on PATH or timed out — try common prefix locations
    const home = process.env.HOME ?? '';
    return [
      `${home}/.npm-global/lib/node_modules`,
      `${home}/.nvm/versions/node/${process.version}/lib/node_modules`,
    ];
  }
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

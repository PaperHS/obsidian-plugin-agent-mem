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
 * Try to get Electron's BrowserWindow constructor from the renderer process.
 * Obsidian uses @electron/remote; older builds expose electron.remote.
 */
function getElectronBrowserWindow(): (new (opts: any) => any) | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const remote = require('@electron/remote');
    if (remote?.BrowserWindow) return remote.BrowserWindow;
  } catch { /* not available */ }
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const electron = require('electron');
    if ((electron as any)?.remote?.BrowserWindow) return (electron as any).remote.BrowserWindow;
  } catch { /* not available */ }
  return null;
}

const NOTEBOOKLM_URL = 'https://notebooklm.google.com/';
const GOOGLE_COOKIE_URLS = [
  'https://accounts.google.com',
  'https://google.com',
  'https://notebooklm.google.com',
];
const POLL_INTERVAL_MS = 2000;
const LOGIN_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Open a BrowserWindow inside Obsidian's Electron process, navigate to
 * NotebookLM, wait for the user to complete the Google login, then extract
 * the session tokens via CDP and persist them with lib.saveSession().
 *
 * Returns the saved session file path on success.
 */
async function loginWithElectronWindow(
  lib: any,
  opts: LoginOptions,
): Promise<string> {
  const BrowserWindow = getElectronBrowserWindow();
  if (!BrowserWindow) throw new Error('Electron BrowserWindow not available');

  const sessionPath: string = lib.getSessionPath();

  return new Promise<string>((resolve, reject) => {
    const win = new BrowserWindow({
      width: 1000,
      height: 720,
      title: 'Log in to NotebookLM',
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
      },
    });

    win.loadURL(NOTEBOOKLM_URL);
    opts.onLog?.('NotebookLM window opened — please log in with your Google account.');

    let done = false;

    const cleanup = () => {
      clearInterval(pollTimer);
      clearTimeout(timeoutTimer);
      try { win.close(); } catch { /* ignore */ }
    };

    const fail = (err: Error) => {
      if (done) return;
      done = true;
      cleanup();
      reject(err);
    };

    const succeed = (path: string) => {
      if (done) return;
      done = true;
      cleanup();
      resolve(path);
    };

    win.on('closed', () => {
      if (!done) fail(new Error('Login window was closed before completing sign-in.'));
    });

    const timeoutTimer = setTimeout(
      () => fail(new Error(`Login timed out after ${LOGIN_TIMEOUT_MS / 60000} minutes.`)),
      LOGIN_TIMEOUT_MS,
    );

    const pollTimer = setInterval(async () => {
      let wizData: any;
      try {
        wizData = await win.webContents.executeJavaScript(`
          (function() {
            var w = window.WIZ_global_data;
            if (!w || !w.SNlM0e) return null;
            return JSON.stringify({ at: w.SNlM0e, bl: w.cfb2h, fsid: w.FdrFJe });
          })()
        `);
      } catch {
        return; // page still loading
      }

      if (!wizData) return; // not logged in yet

      let tokens: { at: string; bl: string; fsid: string };
      try {
        tokens = JSON.parse(wizData);
      } catch {
        return;
      }

      opts.onLog?.('Login detected — saving session…');

      try {
        // Attach CDP debugger to extract HttpOnly cookies
        const dbg = win.webContents.debugger;
        let attached = false;
        try {
          dbg.attach('1.3');
          attached = true;
        } catch { /* already attached or not supported */ }

        const cookieArrays = await Promise.all(
          GOOGLE_COOKIE_URLS.map((url: string) =>
            dbg.sendCommand('Network.getCookies', { urls: [url] }).catch(() => ({ cookies: [] }))
          )
        );

        if (attached) {
          try { dbg.detach(); } catch { /* ignore */ }
        }

        // Deduplicate cookies by name+domain
        const seen = new Set<string>();
        const allCookies: any[] = [];
        for (const result of cookieArrays) {
          for (const c of (result.cookies ?? [])) {
            const key = `${c.name}@${c.domain}`;
            if (!seen.has(key)) { seen.add(key); allCookies.push(c); }
          }
        }

        const cookieStr = allCookies
          .map((c: any) => `${c.name}=${c.value}`)
          .join('; ');

        const userAgent: string = await win.webContents
          .executeJavaScript('navigator.userAgent')
          .catch(() => '');
        const language: string = await win.webContents
          .executeJavaScript('navigator.language')
          .catch(() => 'en-US');

        const session = {
          at: tokens.at,
          bl: tokens.bl,
          fsid: tokens.fsid,
          cookies: cookieStr,
          userAgent,
          language,
        };

        const saveSession = lib.saveSession ?? lib.default?.saveSession;
        if (typeof saveSession !== 'function') {
          throw new Error('saveSession not found in notebooklm-client exports');
        }

        const savedPath: string = await saveSession(session, sessionPath);
        opts.onLog?.(`Session saved to ${savedPath}`);
        succeed(savedPath);
      } catch (err: any) {
        fail(err instanceof Error ? err : new Error(String(err)));
      }
    }, POLL_INTERVAL_MS);
  });
}

/**
 * Log in to NotebookLM interactively.
 *
 * Prefers opening a window inside Obsidian's Electron process (no external
 * Chrome required). Falls back to the notebooklm-client puppeteer transport
 * if the Electron BrowserWindow API is unavailable.
 */
export async function loginInteractive(opts: LoginOptions = {}): Promise<string> {
  const lib: any = await loadLib();
  if (opts.homeDir && typeof lib.setHomeDir === 'function') lib.setHomeDir(opts.homeDir);

  // Try in-app Electron window first (preferred: no new Chrome process)
  if (getElectronBrowserWindow()) {
    return loginWithElectronWindow(lib, opts);
  }

  // Fall back to puppeteer-based transport
  const Ctor = resolveNotebookClientCtor(lib);
  opts.onLog?.('Launching Chrome… (log in to Google in the new window, then return here)');
  const client = new Ctor();

  const connectOpts: any = { transport: 'browser', headless: false };
  if (opts.chromePath) connectOpts.chromePath = opts.chromePath;

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

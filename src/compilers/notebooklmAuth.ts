/**
 * NotebookLM session management for the settings UI.
 * Wraps notebooklm-client's session helpers with dynamic import so the
 * library (which pulls in puppeteer/ffi-rs) only loads when actually needed.
 *
 * Because notebooklm-client is ESM-only and can't be bundled, we locate it
 * at runtime via Node's module resolution, auto-installing to ~/.mem-plugin/
 * on first use if it isn't already available.
 */

export interface SessionStatus {
  loggedIn: boolean;
  sessionPath: string;
  checkedAt: string;
}

// Cached resolved file URL so we only run resolution/install once per session.
let resolvedFileUrl: string | null = null;

export async function loadLib(onLog?: (msg: string) => void): Promise<any> {
  if (!resolvedFileUrl) {
    resolvedFileUrl = await resolveNotebookLmClient(onLog);
  }
  return await import(/* @vite-ignore */ resolvedFileUrl);
}

// ── Module resolution ─────────────────────────────────────────────────────────

async function resolveNotebookLmClient(onLog?: (msg: string) => void): Promise<string> {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const Module = require('module') as any;
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const path = require('path') as typeof import('path');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const os = require('os') as typeof import('os');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const cp = require('child_process') as typeof import('child_process');

  const installDir = path.join(os.homedir(), '.mem-plugin');

  const candidatePaths: string[] = [
    // Preferred: our own install dir (persists across plugin updates)
    path.join(installDir, 'node_modules'),
    // Dev: plugin's own node_modules
    ...Module._nodeModulePaths(typeof __dirname !== 'undefined' ? __dirname : process.cwd()),
    // Global npm
    ...getGlobalNpmPaths(cp),
    // System-wide fallbacks
    '/usr/local/lib/node_modules',
    '/usr/lib/node_modules',
  ];

  // First attempt — no install
  try {
    const p = Module._resolveFilename('notebooklm-client', null, false, { paths: candidatePaths });
    return `file://${p}`;
  } catch { /* not found yet */ }

  // Auto-install to ~/.mem-plugin/
  onLog?.('notebooklm-client not found — installing to ~/.mem-plugin/ (one-time setup)…');
  await npmInstall('notebooklm-client', installDir, cp, onLog);
  onLog?.('Install complete.');

  // Second attempt after install
  const p = Module._resolveFilename('notebooklm-client', null, false, {
    paths: [path.join(installDir, 'node_modules'), ...candidatePaths],
  });
  return `file://${p}`;
}

function getGlobalNpmPaths(cp: typeof import('child_process')): string[] {
  try {
    const root = cp.execFileSync('npm', ['root', '-g'], { encoding: 'utf8', timeout: 5000 }).trim();
    return [root];
  } catch {
    const home = process.env.HOME ?? '';
    return [
      `${home}/.npm-global/lib/node_modules`,
      `${home}/.nvm/versions/node/${process.version}/lib/node_modules`,
    ];
  }
}

function npmInstall(
  pkg: string,
  prefix: string,
  cp: typeof import('child_process'),
  onLog?: (msg: string) => void,
): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const fs = require('fs') as typeof import('fs');
  fs.mkdirSync(prefix, { recursive: true });

  return new Promise((resolve, reject) => {
    const proc = cp.spawn(
      'npm',
      ['install', pkg, '--prefix', prefix, '--no-save'],
      {
        stdio: 'pipe',
        // Skip Chromium download — user already has Chrome for the browser transport
        env: { ...process.env, PUPPETEER_SKIP_DOWNLOAD: '1', PUPPETEER_SKIP_CHROMIUM_DOWNLOAD: '1' },
      },
    );
    proc.stdout?.on('data', (d: Buffer) => onLog?.(d.toString().trim()));
    proc.stderr?.on('data', (d: Buffer) => onLog?.(d.toString().trim()));
    proc.on('close', (code: number | null) => {
      if (code === 0) resolve();
      else reject(new Error(`npm install ${pkg} failed (exit ${code})`));
    });
    proc.on('error', reject);
  });
}

// ── Public API ────────────────────────────────────────────────────────────────

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
 * Opens a real Chrome window via the library's browser transport so the user
 * can log into Google, then persists the session to disk. Returns the saved
 * session path on success.
 */
export async function loginInteractive(opts: LoginOptions = {}): Promise<string> {
  // Pass onLog so auto-install progress is surfaced to the user.
  const lib: any = await loadLib(opts.onLog);
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
  } catch { /* ignore */ }
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

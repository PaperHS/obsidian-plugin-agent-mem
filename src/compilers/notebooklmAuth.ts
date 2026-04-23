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

// ─── macOS: open-in-existing-Chrome approach ──────────────────────────────────

const NOTEBOOKLM_URL = 'https://notebooklm.google.com/';
const LOGIN_TIMEOUT_MS = 5 * 60 * 1000;
const POLL_INTERVAL_MS = 5_000;

/** Candidate Chrome cookie DB paths, tried in order. */
function chromeCookiePaths(): string[] {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const os = require('os') as typeof import('os');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const path = require('path') as typeof import('path');
  const home = os.homedir();
  const base = path.join(home, 'Library/Application Support');
  return [
    path.join(base, 'Google/Chrome/Default/Cookies'),
    path.join(base, 'Google/Chrome Beta/Default/Cookies'),
    path.join(base, 'Google/Chrome Canary/Default/Cookies'),
    path.join(base, 'Chromium/Default/Cookies'),
  ];
}

/**
 * Read encrypted Google cookies from the Chrome SQLite store on macOS.
 * Decrypts with the AES-128-CBC key stored in the macOS Keychain.
 */
async function readMacChromeCookies(): Promise<string> {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { execSync } = require('child_process') as typeof import('child_process');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const crypto = require('crypto') as typeof import('crypto');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const os = require('os') as typeof import('os');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const path = require('path') as typeof import('path');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const fs = require('fs') as typeof import('fs');

  // Find an accessible cookie database
  const dbPath = chromeCookiePaths().find(p => fs.existsSync(p));
  if (!dbPath) throw new Error('Chrome cookie database not found');

  // Copy DB to avoid lock contention (Chrome uses WAL, reads are usually fine)
  const tmpDb = path.join(os.tmpdir(), `nbm-cookies-${Date.now()}.db`);
  fs.copyFileSync(dbPath, tmpDb);

  // Retrieve the Chrome Safe Storage passphrase from Keychain
  let rawKey = '';
  for (const svc of ['Chrome Safe Storage', 'Chromium Safe Storage']) {
    try {
      rawKey = execSync(`security find-generic-password -w -s '${svc}' 2>/dev/null`, {
        stdio: ['pipe', 'pipe', 'pipe'],
      }).toString().trim();
      if (rawKey) break;
    } catch { /* try next */ }
  }
  if (!rawKey) throw new Error('Could not read Chrome encryption key from Keychain');

  // Derive AES-128 key: PBKDF2-SHA1, salt='saltysalt', 1003 iterations, 16 bytes
  const derivedKey = crypto.pbkdf2Sync(rawKey, 'saltysalt', 1003, 16, 'sha1');
  const iv = Buffer.alloc(16, 32); // 16 × 0x20 (space)

  // Query all google.com cookies — use stdin to avoid shell quoting issues
  const sql = `SELECT name, hex(encrypted_value), host_key FROM cookies WHERE host_key LIKE '%.google.com';`;
  let jsonOut = '';
  try {
    jsonOut = execSync(`sqlite3 -json "${tmpDb}"`, {
      input: sql,
      stdio: ['pipe', 'pipe', 'pipe'],
    }).toString().trim();
  } finally {
    try { fs.unlinkSync(tmpDb); } catch { /* ignore */ }
  }

  if (!jsonOut) return '';

  type Row = { name: string; 'hex(encrypted_value)': string; host_key: string };
  const rows: Row[] = JSON.parse(jsonOut);

  const seen = new Set<string>();
  const cookies: string[] = [];

  for (const row of rows) {
    const key = `${row.name}@${row.host_key}`;
    if (seen.has(key)) continue;
    seen.add(key);

    try {
      const encBuf = Buffer.from(row['hex(encrypted_value)'], 'hex');
      if (encBuf.length === 0) continue;

      // v10 prefix = AES-128-CBC encrypted
      if (encBuf.length > 3 && encBuf.slice(0, 3).toString('ascii') === 'v10') {
        const decipher = crypto.createDecipheriv('aes-128-cbc', derivedKey, iv);
        const dec = Buffer.concat([decipher.update(encBuf.slice(3)), decipher.final()]);
        cookies.push(`${row.name}=${dec.toString()}`);
      } else {
        // Plain-text cookie (unusual but possible)
        cookies.push(`${row.name}=${encBuf.toString()}`);
      }
    } catch { /* skip undecryptable entries */ }
  }

  return cookies.join('; ');
}

/** Follow up to `maxRedirects` HTTP redirects; reject if we land on Google sign-in. */
async function httpsGetFollowRedirects(
  url: string,
  headers: Record<string, string>,
  maxRedirects = 4,
): Promise<string> {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const https = require('https') as typeof import('https');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const http = require('http') as typeof import('http');

  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    const req = (mod as any).get(url, { headers }, (res: any) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        const next: string = res.headers.location;
        if (next.includes('accounts.google.com')) {
          reject(new Error('not-logged-in'));
          return;
        }
        if (maxRedirects <= 0) { reject(new Error('Too many redirects')); return; }
        httpsGetFollowRedirects(next, headers, maxRedirects - 1).then(resolve).catch(reject);
        return;
      }
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => { data += chunk; });
      res.on('end', () => resolve(data));
    });
    req.on('error', reject);
  });
}

/**
 * Fetch NotebookLM with Chrome cookies and extract WIZ_global_data tokens.
 * Throws 'not-logged-in' error if the page redirects to Google sign-in.
 */
async function extractWizTokens(
  cookieStr: string,
): Promise<{ at: string; bl: string; fsid: string; userAgent: string }> {
  const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 '
           + '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

  const html = await httpsGetFollowRedirects(NOTEBOOKLM_URL, {
    Cookie: cookieStr,
    'User-Agent': UA,
    'Accept-Language': 'en-US,en;q=0.9',
    Accept: 'text/html,application/xhtml+xml',
  });

  const at = html.match(/"SNlM0e"\s*:\s*"([^"]+)"/)?.[1];
  const bl = html.match(/"cfb2h"\s*:\s*"([^"]+)"/)?.[1];
  const fsid = html.match(/"FdrFJe"\s*:\s*"([^"]+)"/)?.[1];

  if (!at) throw new Error('not-logged-in');

  return { at, bl: bl ?? '', fsid: fsid ?? '', userAgent: UA };
}

/**
 * Open NotebookLM in the user's already-running Chrome, poll Chrome's cookie
 * database until login is detected, then save the session via notebooklm-client.
 *
 * macOS-only (uses sqlite3 + Keychain).
 */
async function loginWithExistingChrome(lib: any, opts: LoginOptions): Promise<string> {
  // Guard: macOS only
  if (process.platform !== 'darwin') throw new Error('macOS only');

  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { execSync } = require('child_process') as typeof import('child_process');

  // Verify sqlite3 CLI is present (it ships with macOS)
  try { execSync('which sqlite3', { stdio: 'pipe' }); } catch {
    throw new Error('sqlite3 CLI not found');
  }

  // Open NotebookLM in the user's existing Chrome
  try {
    execSync(`open -a "Google Chrome" "${NOTEBOOKLM_URL}"`, { stdio: 'pipe' });
  } catch {
    // Chrome not installed or launch failed — caller will fall back
    throw new Error('Could not open Google Chrome');
  }

  opts.onLog?.(
    'Chrome opened — please log in with your Google account. '
    + 'This dialog will close automatically once login is detected.'
  );

  // Poll Chrome's cookie store until login is confirmed or we time out
  const deadline = Date.now() + LOGIN_TIMEOUT_MS;
  const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

  while (Date.now() < deadline) {
    await sleep(POLL_INTERVAL_MS);
    try {
      const cookieStr = await readMacChromeCookies();
      if (!cookieStr) continue;

      const { at, bl, fsid, userAgent } = await extractWizTokens(cookieStr);

      const sessionPath: string = lib.getSessionPath();
      const session = { at, bl, fsid, cookies: cookieStr, userAgent, language: 'en-US' };

      const saveSession = lib.saveSession ?? lib.default?.saveSession;
      if (typeof saveSession !== 'function') {
        throw new Error('saveSession not found in notebooklm-client exports');
      }

      const savedPath: string = await saveSession(session, sessionPath);
      opts.onLog?.(`Session saved to ${savedPath}`);
      return savedPath;
    } catch (err: any) {
      if (err?.message === 'not-logged-in') continue; // not done yet
      throw err; // real error
    }
  }

  throw new Error(`Login timed out after ${LOGIN_TIMEOUT_MS / 60_000} minutes.`);
}

// ─── Fallback: puppeteer transport ────────────────────────────────────────────

async function loginWithPuppeteer(lib: any, opts: LoginOptions): Promise<string> {
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

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Log in to NotebookLM interactively.
 *
 * On macOS: opens a tab in the user's already-running Chrome, then polls
 * Chrome's on-disk cookie database until login is detected (no new process,
 * passkeys and saved Google accounts work normally).
 *
 * Fallback: puppeteer BrowserTransport (spawns a new Chrome window).
 */
export async function loginInteractive(opts: LoginOptions = {}): Promise<string> {
  const lib: any = await loadLib();
  if (opts.homeDir && typeof lib.setHomeDir === 'function') lib.setHomeDir(opts.homeDir);

  if (process.platform === 'darwin') {
    try {
      return await loginWithExistingChrome(lib, opts);
    } catch (err: any) {
      // Only fall through on setup failures, not polling errors
      const msg: string = err?.message ?? '';
      if (msg === 'macOS only' || msg.includes('sqlite3') || msg.includes('Chrome')) {
        console.warn('[notebooklmAuth] existing-Chrome approach unavailable, using puppeteer:', msg);
        // fall through
      } else {
        throw err;
      }
    }
  }

  return loginWithPuppeteer(lib, opts);
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

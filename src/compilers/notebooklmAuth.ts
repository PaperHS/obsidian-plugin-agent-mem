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

// ─── Shared constants ─────────────────────────────────────────────────────────

const NOTEBOOKLM_URL = 'https://notebooklm.google.com/';
const LOGIN_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes
const DEFAULT_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

// ─── macOS Chrome cookie extraction ──────────────────────────────────────────

const CHROME_VARIANTS = [
  { dir: 'Google/Chrome',        keychainSvc: 'Chrome Safe Storage' },
  { dir: 'Google/Chrome Beta',   keychainSvc: 'Chrome Safe Storage' },
  { dir: 'Google/Chrome Canary', keychainSvc: 'Chrome Safe Storage' },
  { dir: 'Chromium',             keychainSvc: 'Chromium Safe Storage' },
];

/**
 * Return all Chrome cookie DB paths across every profile directory and
 * every installed Chrome variant.  Searches Default + "Profile N" + "Guest Profile".
 */
function allChromeCookiePaths(fs: typeof import('fs'), path: typeof import('path'), os: typeof import('os')): string[] {
  const base = path.join(os.homedir(), 'Library/Application Support');
  const found: string[] = [];

  for (const v of CHROME_VARIANTS) {
    const variantBase = path.join(base, v.dir);
    if (!fs.existsSync(variantBase)) continue;

    let profileDirs: string[] = ['Default'];
    try {
      const entries = fs.readdirSync(variantBase);
      for (const e of entries) {
        if (/^Profile \d+$/.test(e) || e === 'Guest Profile') profileDirs.push(e);
      }
    } catch { /* ignore */ }

    for (const profile of profileDirs) {
      const p = path.join(variantBase, profile, 'Cookies');
      if (fs.existsSync(p)) found.push(p);
    }
  }

  return found;
}

/**
 * Return false if a string contains characters forbidden in HTTP header values
 * (control characters 0x00-0x08, 0x0a-0x1f, and 0x7f).
 */
function isValidHeaderValue(v: string): boolean {
  // eslint-disable-next-line no-control-regex
  return !/[\x00-\x08\x0a-\x1f\x7f]/.test(v);
}

/** Copy a Chrome SQLite DB plus its WAL/SHM files so recent writes are included. */
function copyWithWal(src: string, dst: string, fs: typeof import('fs')): void {
  fs.copyFileSync(src, dst);
  for (const suffix of ['-wal', '-shm']) {
    const walSrc = src + suffix;
    if (fs.existsSync(walSrc)) {
      try { fs.copyFileSync(walSrc, dst + suffix); } catch { /* best effort */ }
    }
  }
}

/** Clean up a temp DB copy and its WAL/SHM. */
function removeTmpDb(p: string, fs: typeof import('fs')): void {
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(p + suffix); } catch { /* ignore */ }
  }
}

/**
 * Read and decrypt Google cookies from ALL Chrome profiles on macOS.
 * Searches every installed Chrome variant and every profile directory so
 * the user's active profile is always found regardless of which one is open.
 * Copies the WAL file alongside the DB so freshly-written login cookies are included.
 * Cookies with invalid HTTP header characters are silently dropped.
 */
async function readMacChromeCookies(onLog?: (m: string) => void): Promise<string> {
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

  const dbPaths = allChromeCookiePaths(fs, path, os);
  if (dbPaths.length === 0) throw new Error('Chrome cookie database not found. Is Chrome installed?');
  onLog?.(`Found ${dbPaths.length} Chrome profile DB(s)`);

  // Cache derived keys per Keychain service
  const keyCache = new Map<string, Buffer>();
  const iv = Buffer.alloc(16, 32); // 16 × 0x20 (space)

  function getDerivedKey(svc: string): Buffer | null {
    if (keyCache.has(svc)) return keyCache.get(svc)!;
    try {
      const raw = execSync(`security find-generic-password -w -s '${svc}' 2>/dev/null`, {
        stdio: ['pipe', 'pipe', 'pipe'],
      }).toString().trim();
      if (!raw) return null;
      const dk = crypto.pbkdf2Sync(raw, 'saltysalt', 1003, 16, 'sha1');
      keyCache.set(svc, dk);
      return dk;
    } catch { return null; }
  }

  const seen = new Set<string>();
  const cookies: string[] = [];
  const sql = `SELECT name, hex(encrypted_value), host_key FROM cookies WHERE host_key LIKE '%.google.com';`;

  for (const dbPath of dbPaths) {
    const svc = dbPath.includes('Chromium') ? 'Chromium Safe Storage' : 'Chrome Safe Storage';
    const derivedKey = getDerivedKey(svc);
    if (!derivedKey) continue;

    const tmpDb = path.join(
      os.tmpdir(),
      `nbm-cookies-${Date.now()}-${Math.random().toString(36).slice(2)}.db`,
    );
    try {
      copyWithWal(dbPath, tmpDb, fs);

      let jsonOut = '';
      try {
        jsonOut = execSync(`sqlite3 -json "${tmpDb}"`, {
          input: sql,
          stdio: ['pipe', 'pipe', 'pipe'],
        }).toString().trim();
      } catch { /* DB locked or corrupt — skip this profile */ }

      if (!jsonOut) continue;

      type Row = { name: string; 'hex(encrypted_value)': string; host_key: string };
      const rows: Row[] = JSON.parse(jsonOut);
      onLog?.(`  ${dbPath.replace(os.homedir(), '~')}: ${rows.length} row(s)`);

      for (const row of rows) {
        const dupKey = `${row.name}@${row.host_key}`;
        if (seen.has(dupKey)) continue;
        seen.add(dupKey);

        try {
          const encBuf = Buffer.from(row['hex(encrypted_value)'], 'hex');
          if (encBuf.length === 0) continue;

          let value: string;

          if (encBuf.length > 3 && encBuf.slice(0, 3).toString('ascii') === 'v10') {
            // AES-128-CBC + PKCS7 padding (Node strips padding automatically)
            const decipher = crypto.createDecipheriv('aes-128-cbc', derivedKey, iv);
            const dec = Buffer.concat([decipher.update(encBuf.slice(3)), decipher.final()]);
            value = dec.toString('utf8');
          } else if (/^v\d{2}/.test(encBuf.slice(0, 3).toString('ascii'))) {
            // Unknown versioned format (v11+) — skip rather than output garbage
            continue;
          } else {
            // Plain-text cookie (legacy / unencrypted)
            value = encBuf.toString('utf8');
          }

          // Drop cookies whose decrypted value is invalid for HTTP headers
          if (!isValidHeaderValue(value)) continue;
          cookies.push(`${row.name}=${value}`);
        } catch { /* skip undecryptable entries */ }
      }
    } finally {
      removeTmpDb(tmpDb, fs);
    }
  }

  onLog?.(`Total cookies collected: ${cookies.length}`);
  return cookies.join('; ');
}

/** Follow redirects; throw 'not-logged-in' if we land on accounts.google.com. */
async function httpsGet(url: string, headers: Record<string, string>, hops = 5): Promise<string> {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const https = require('https') as typeof import('https');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const http = require('http') as typeof import('http');

  return new Promise((resolve, reject) => {
    const mod: any = url.startsWith('https') ? https : http;
    const req = mod.get(url, { headers }, (res: any) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        const loc: string = res.headers.location;
        if (loc.includes('accounts.google.com')) { reject(new Error('not-logged-in')); return; }
        if (hops <= 0) { reject(new Error('Too many redirects')); return; }
        httpsGet(loc, headers, hops - 1).then(resolve).catch(reject);
        return;
      }
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (c: string) => { data += c; });
      res.on('end', () => resolve(data));
    });
    req.on('error', reject);
  });
}

/** Fetch NotebookLM with Chrome cookies and extract WIZ_global_data tokens. */
async function extractWizTokens(cookieStr: string) {
  const html = await httpsGet(NOTEBOOKLM_URL, {
    Cookie: cookieStr,
    'User-Agent': DEFAULT_UA,
    'Accept-Language': 'en-US,en;q=0.9',
    Accept: 'text/html,application/xhtml+xml',
  });

  const at = html.match(/"SNlM0e"\s*:\s*"([^"]+)"/)?.[1];
  const bl = html.match(/"cfb2h"\s*:\s*"([^"]+)"/)?.[1];
  const fsid = html.match(/"FdrFJe"\s*:\s*"([^"]+)"/)?.[1];

  if (!at) throw new Error('not-logged-in');
  return { at, bl: bl ?? '', fsid: fsid ?? '' };
}

// ─── Local HTTP server login page ─────────────────────────────────────────────

const LOGIN_PAGE_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>NotebookLM Login — Obsidian</title>
<style>
  body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;
    background:#0d1117;color:#e6edf3;display:flex;align-items:center;
    justify-content:center;min-height:100vh;margin:0}
  .card{background:#161b22;border:1px solid #30363d;border-radius:12px;
    padding:40px 48px;max-width:480px;width:100%;text-align:center}
  h1{font-size:1.4rem;margin:0 0 8px}
  p{color:#8b949e;margin:0 0 28px;line-height:1.5}
  button{background:#238636;color:#fff;border:none;border-radius:6px;
    padding:12px 28px;font-size:1rem;cursor:pointer;transition:background .15s}
  button:hover:not(:disabled){background:#2ea043}
  button:disabled{background:#21262d;color:#484f58;cursor:not-allowed}
  #status{margin-top:20px;font-size:.9rem;min-height:1.2em}
  .ok{color:#3fb950}.err{color:#f85149}
</style>
</head>
<body>
<div class="card">
  <h1>NotebookLM Login</h1>
  <p>Log in to NotebookLM in the other tab,<br>then click the button below.</p>
  <button id="btn" onclick="complete()">I've logged in &mdash; Save session</button>
  <div id="status"></div>
</div>
<script>
async function complete() {
  const btn = document.getElementById('btn');
  const status = document.getElementById('status');
  btn.disabled = true;
  status.textContent = 'Extracting session…';
  status.className = '';
  try {
    const res = await fetch('/complete', { method: 'POST' });
    const data = await res.json();
    if (data.ok) {
      status.innerHTML = '&#10003; Done! Session saved. You can close this tab.';
      status.className = 'ok';
    } else {
      status.textContent = 'Error: ' + data.error;
      status.className = 'err';
      btn.disabled = false;
    }
  } catch (e) {
    status.textContent = 'Error: ' + e.message;
    status.className = 'err';
    btn.disabled = false;
  }
}
</script>
</body>
</html>`;

/**
 * macOS login via existing Chrome + local callback server.
 *
 * 1. Starts a local HTTP server on a random port.
 * 2. Opens two Chrome tabs: NotebookLM (for login) and our local page (Done button).
 * 3. When the user clicks Done, the server reads Chrome's cookie database,
 *    verifies the session against NotebookLM, and saves it.
 */
async function loginWithLocalServer(lib: any, opts: LoginOptions): Promise<string> {
  if (process.platform !== 'darwin') throw new Error('macOS only');

  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const http = require('http') as typeof import('http');

  const sessionPath: string = lib.getSessionPath();

  let resolveLogin!: (path: string) => void;
  let rejectLogin!: (err: Error) => void;
  const loginPromise = new Promise<string>((res, rej) => {
    resolveLogin = res;
    rejectLogin = rej;
  });

  const server = http.createServer(async (req: any, res: any) => {
    const url: string = req.url ?? '/';

    if (req.method === 'GET' && url === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(LOGIN_PAGE_HTML);
      return;
    }

    if (req.method === 'POST' && url === '/complete') {
      try {
        opts.onLog?.('Extracting Chrome session…');
        const cookieStr = await readMacChromeCookies(opts.onLog);
        if (!cookieStr) throw new Error('No Google cookies found across all Chrome profiles. Make sure you completed the Google sign-in in the NotebookLM tab.');

        opts.onLog?.('Verifying login with NotebookLM…');
        const { at, bl, fsid } = await extractWizTokens(cookieStr);

        const session = { at, bl, fsid, cookies: cookieStr, userAgent: DEFAULT_UA, language: 'en-US' };
        const saveSession = lib.saveSession ?? lib.default?.saveSession;
        if (typeof saveSession !== 'function') throw new Error('saveSession not found in notebooklm-client');

        const savedPath: string = await saveSession(session, sessionPath);
        opts.onLog?.(`Session saved → ${savedPath}`);

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, path: savedPath }));
        resolveLogin(savedPath);
      } catch (err: any) {
        const msg: string = err?.message === 'not-logged-in'
          ? 'Not logged in to NotebookLM yet — please complete Google sign-in first.'
          : (err?.message ?? String(err));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: msg }));
        // Don't reject — let the user retry by clicking the button again
      }
      return;
    }

    res.writeHead(404);
    res.end();
  });

  await new Promise<void>((resolve, reject) => {
    server.listen(0, '127.0.0.1', resolve as any);
    server.on('error', reject);
  });

  const port = (server.address() as any).port as number;
  const localUrl = `http://127.0.0.1:${port}/`;

  // Open Chrome: NotebookLM first, then our callback page (ends up focused)
  try {
    const { execSync } = require('child_process') as typeof import('child_process');
    execSync(`open -a "Google Chrome" "${NOTEBOOKLM_URL}"`, { stdio: 'pipe' });
    execSync(`open -a "Google Chrome" "${localUrl}"`, { stdio: 'pipe' });
  } catch {
    throw new Error('Could not open Google Chrome');
  }

  opts.onLog?.(`Log in to NotebookLM in Chrome, then click "Save session" in the other tab (${localUrl})`);

  const timeout = new Promise<never>((_, rej) =>
    setTimeout(() => rej(new Error(`Login timed out after ${LOGIN_TIMEOUT_MS / 60_000} minutes`)), LOGIN_TIMEOUT_MS)
  );

  try {
    return await Promise.race([loginPromise, timeout]);
  } finally {
    server.close();
  }
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
 * macOS: opens NotebookLM in the user's existing Chrome + a local callback
 * page. The user logs in, clicks "Save session", and the session is extracted
 * from Chrome's on-disk cookie database (no new Chrome process, passkeys work).
 *
 * Other platforms / fallback: puppeteer BrowserTransport (new Chrome window).
 */
export async function loginInteractive(opts: LoginOptions = {}): Promise<string> {
  const lib: any = await loadLib();
  if (opts.homeDir && typeof lib.setHomeDir === 'function') lib.setHomeDir(opts.homeDir);

  if (process.platform === 'darwin') {
    try {
      return await loginWithLocalServer(lib, opts);
    } catch (err: any) {
      const msg: string = err?.message ?? '';
      // Only fall through on setup errors (Chrome not installed, not macOS, etc.)
      if (msg.includes('macOS only') || msg.includes('Chrome') || msg.includes('sqlite3')) {
        console.warn('[notebooklmAuth] local-server approach unavailable, using puppeteer:', msg);
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

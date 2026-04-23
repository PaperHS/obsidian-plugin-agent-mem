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
const LOGIN_TIMEOUT_MS = 10 * 60 * 1000;
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

function allChromeCookiePaths(
  fs: typeof import('fs'),
  path: typeof import('path'),
  os: typeof import('os'),
): string[] {
  const base = path.join(os.homedir(), 'Library/Application Support');
  const found: string[] = [];
  for (const v of CHROME_VARIANTS) {
    const variantBase = path.join(base, v.dir);
    if (!fs.existsSync(variantBase)) continue;
    const profileDirs: string[] = ['Default'];
    try {
      for (const e of fs.readdirSync(variantBase)) {
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

// eslint-disable-next-line no-control-regex
const INVALID_HEADER_RE = /[\x00-\x08\x0a-\x1f\x7f]/;
function isValidHeaderValue(v: string): boolean { return !INVALID_HEADER_RE.test(v); }

function copyWithWal(src: string, dst: string, fs: typeof import('fs')): void {
  fs.copyFileSync(src, dst);
  for (const s of ['-wal', '-shm']) {
    if (fs.existsSync(src + s)) try { fs.copyFileSync(src + s, dst + s); } catch { /* ok */ }
  }
}

function removeTmpDb(p: string, fs: typeof import('fs')): void {
  for (const s of ['', '-wal', '-shm']) try { fs.unlinkSync(p + s); } catch { /* ok */ }
}

interface CookieDiag { path: string; rows: number; valid: number; keychainOk: boolean }

/**
 * Read and decrypt Google cookies from ALL Chrome profiles on macOS.
 * Uses spawnSync to call the `security` CLI directly (no shell), which is
 * more reliable from inside Electron's renderer process.
 * Returns both the cookie string and diagnostics for debugging.
 */
async function readMacChromeCookiesWithDiag(
  onLog?: (m: string) => void,
): Promise<{ cookies: string; diag: CookieDiag[] }> {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { spawnSync, execSync } = require('child_process') as typeof import('child_process');
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

  const keyCache = new Map<string, Buffer | null>();
  const iv = Buffer.alloc(16, 32); // 16 × 0x20 (space)

  function getDerivedKey(svc: string): Buffer | null {
    if (keyCache.has(svc)) return keyCache.get(svc) ?? null;
    try {
      // Use spawnSync directly — avoids shell interpretation issues in Electron
      const r = spawnSync('security', ['find-generic-password', '-w', '-s', svc], {
        encoding: 'buffer',
        timeout: 30_000,
      });
      const raw = r.stdout?.toString('utf8').trim() ?? '';
      if (!raw || r.status !== 0) { keyCache.set(svc, null); return null; }
      const dk = crypto.pbkdf2Sync(raw, 'saltysalt', 1003, 16, 'sha1');
      keyCache.set(svc, dk);
      return dk;
    } catch { keyCache.set(svc, null); return null; }
  }

  const seen = new Set<string>();
  const cookies: string[] = [];
  const diag: CookieDiag[] = [];
  const sql = `SELECT name, hex(encrypted_value), host_key FROM cookies WHERE host_key LIKE '%.google.com';`;

  for (const dbPath of dbPaths) {
    const svc = dbPath.includes('Chromium') ? 'Chromium Safe Storage' : 'Chrome Safe Storage';
    const derivedKey = getDerivedKey(svc);
    const keychainOk = derivedKey !== null;
    let rows = 0, valid = 0;

    if (!derivedKey) {
      onLog?.(`  SKIP ${dbPath.replace(os.homedir(), '~')} — Keychain key unavailable for "${svc}"`);
      diag.push({ path: dbPath, rows: 0, valid: 0, keychainOk: false });
      continue;
    }

    const tmpDb = path.join(os.tmpdir(), `nbm-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
    try {
      copyWithWal(dbPath, tmpDb, fs);

      let jsonOut = '';
      try {
        jsonOut = execSync(`sqlite3 -json "${tmpDb}"`, {
          input: sql,
          stdio: ['pipe', 'pipe', 'pipe'],
        }).toString().trim();
      } catch { /* DB locked or corrupt */ }

      if (jsonOut) {
        type Row = { name: string; 'hex(encrypted_value)': string; host_key: string };
        const dbRows: Row[] = JSON.parse(jsonOut);
        rows = dbRows.length;

        for (const row of dbRows) {
          const dupKey = `${row.name}@${row.host_key}`;
          if (seen.has(dupKey)) continue;
          seen.add(dupKey);

          try {
            const encBuf = Buffer.from(row['hex(encrypted_value)'], 'hex');
            if (encBuf.length === 0) continue;
            let value: string;

            if (encBuf.length > 3 && encBuf.slice(0, 3).toString('ascii') === 'v10') {
              const decipher = crypto.createDecipheriv('aes-128-cbc', derivedKey, iv);
              const dec = Buffer.concat([decipher.update(encBuf.slice(3)), decipher.final()]);
              value = dec.toString('utf8');
            } else if (/^v\d{2}/.test(encBuf.slice(0, 3).toString('ascii'))) {
              continue; // v11+ — unknown format, skip
            } else {
              value = encBuf.toString('utf8'); // plain-text (legacy)
            }

            if (!isValidHeaderValue(value)) continue;
            cookies.push(`${row.name}=${value}`);
            valid++;
          } catch { /* skip */ }
        }
      }

      onLog?.(`  ${dbPath.replace(os.homedir(), '~')}: ${rows} rows → ${valid} valid cookies`);
      diag.push({ path: dbPath, rows, valid, keychainOk });
    } finally {
      removeTmpDb(tmpDb, fs);
    }
  }

  onLog?.(`Total cookies: ${cookies.length}`);
  return { cookies: cookies.join('; '), diag };
}

// ─── HTTPS helper ─────────────────────────────────────────────────────────────

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

// ─── Login page HTML (with manual fallback) ────────────────────────────────────

const LOGIN_PAGE_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>NotebookLM Login — Obsidian</title>
<style>
  *{box-sizing:border-box}
  body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;
    background:#0d1117;color:#e6edf3;display:flex;align-items:flex-start;
    justify-content:center;min-height:100vh;margin:0;padding:32px 16px}
  .card{background:#161b22;border:1px solid #30363d;border-radius:12px;
    padding:36px 44px;max-width:560px;width:100%;text-align:center}
  h1{font-size:1.4rem;margin:0 0 8px}
  .sub{color:#8b949e;margin:0 0 28px;line-height:1.5}
  .btn{background:#238636;color:#fff;border:none;border-radius:6px;
    padding:12px 28px;font-size:1rem;cursor:pointer;transition:background .15s}
  .btn:hover:not(:disabled){background:#2ea043}
  .btn:disabled{background:#21262d;color:#484f58;cursor:not-allowed}
  .btn-sm{background:#21262d;color:#8b949e;border:1px solid #30363d;border-radius:6px;
    padding:8px 16px;font-size:.85rem;cursor:pointer;margin-top:16px}
  .btn-sm:hover{background:#30363d;color:#e6edf3}
  #status{margin-top:18px;font-size:.9rem;min-height:1.2em}
  .ok{color:#3fb950}.err{color:#f85149}
  hr{border:none;border-top:1px solid #30363d;margin:28px 0}
  h2{font-size:1.05rem;margin:0 0 12px;text-align:left}
  ol{color:#8b949e;text-align:left;margin:0 0 16px;padding-left:20px;line-height:1.9}
  ol li b{color:#e6edf3}
  kbd{background:#21262d;border:1px solid #444;border-radius:4px;
    padding:1px 6px;font-size:.8em;font-family:monospace}
  code{background:#21262d;border-radius:4px;padding:1px 5px;font-size:.85em;font-family:monospace}
  textarea{width:100%;background:#0d1117;border:1px solid #30363d;border-radius:6px;
    color:#e6edf3;padding:10px;font-family:monospace;font-size:.8rem;resize:vertical;
    margin-bottom:10px}
  #manual-status{margin-top:10px;font-size:.9rem;min-height:1.2em;text-align:left}
</style>
</head>
<body>
<div class="card">
  <h1>NotebookLM Login</h1>
  <p class="sub">Log in to NotebookLM in the other tab,<br>then click the button below.</p>
  <button class="btn" id="btn" onclick="complete()">I&rsquo;ve logged in &mdash; Save session</button>
  <div id="status"></div>
  <button class="btn-sm" id="manual-toggle" onclick="toggleManual()" style="display:none">
    Auto-extract failed? Paste cookies manually &darr;
  </button>

  <div id="manual-section" style="display:none">
    <hr>
    <h2>Manual cookie entry</h2>
    <ol>
      <li>Switch to the <b>NotebookLM</b> Chrome tab</li>
      <li>Press <kbd>&#8984;&#8997;I</kbd> &rarr; <b>Network</b> tab</li>
      <li>Reload (<kbd>&#8984;R</kbd>), then click any request to <code>notebooklm.google.com</code></li>
      <li>Under <b>Request Headers</b>, find <code>cookie</code></li>
      <li>Right-click the value &rarr; <b>Copy value</b>, paste below</li>
    </ol>
    <textarea id="cookie-input" rows="5"
      placeholder="SID=xxx; HSID=yyy; SSID=zzz; …"></textarea>
    <button class="btn" onclick="saveManual()">Save with pasted cookies</button>
    <div id="manual-status"></div>
  </div>
</div>
<script>
function toggleManual() {
  const s = document.getElementById('manual-section');
  s.style.display = s.style.display === 'none' ? 'block' : 'none';
}

async function complete() {
  const btn = document.getElementById('btn');
  const status = document.getElementById('status');
  btn.disabled = true;
  status.textContent = 'Extracting session\u2026';
  status.className = '';
  try {
    const res = await fetch('/complete', { method: 'POST' });
    const data = await res.json();
    if (data.ok) {
      status.innerHTML = '\u2713 Done! Session saved. You can close this tab.';
      status.className = 'ok';
      document.getElementById('manual-toggle').style.display = 'none';
    } else {
      status.textContent = 'Auto-extract failed: ' + data.error;
      status.className = 'err';
      document.getElementById('manual-toggle').style.display = 'inline-block';
      btn.disabled = false;
    }
  } catch (e) {
    status.textContent = 'Error: ' + e.message;
    status.className = 'err';
    document.getElementById('manual-toggle').style.display = 'inline-block';
    btn.disabled = false;
  }
}

async function saveManual() {
  const cookies = document.getElementById('cookie-input').value.trim();
  const status = document.getElementById('manual-status');
  if (!cookies) { status.textContent = 'Please paste the cookie string first.'; return; }
  status.textContent = 'Saving\u2026';
  try {
    const res = await fetch('/complete-manual', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cookies }),
    });
    const data = await res.json();
    if (data.ok) {
      status.innerHTML = '\u2713 Done! Session saved. You can close this tab.';
      status.style.color = '#3fb950';
    } else {
      status.textContent = 'Error: ' + data.error;
      status.style.color = '#f85149';
    }
  } catch (e) {
    status.textContent = 'Error: ' + e.message;
  }
}
</script>
</body>
</html>`;

// ─── Local HTTP server ─────────────────────────────────────────────────────────

async function loginWithLocalServer(lib: any, opts: LoginOptions): Promise<string> {
  if (process.platform !== 'darwin') throw new Error('macOS only');

  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const http = require('http') as typeof import('http');
  const sessionPath: string = lib.getSessionPath();

  let resolveLogin!: (path: string) => void;
  const loginPromise = new Promise<string>(res => { resolveLogin = res; });

  async function handleComplete(cookies: string, res: any): Promise<boolean> {
    try {
      opts.onLog?.('Verifying login with NotebookLM…');
      const { at, bl, fsid } = await extractWizTokens(cookies);
      const session = { at, bl, fsid, cookies, userAgent: DEFAULT_UA, language: 'en-US' };
      const saveSession = lib.saveSession ?? lib.default?.saveSession;
      if (typeof saveSession !== 'function') throw new Error('saveSession not found in notebooklm-client');
      const savedPath: string = await saveSession(session, sessionPath);
      opts.onLog?.(`Session saved → ${savedPath}`);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, path: savedPath }));
      resolveLogin(savedPath);
      return true;
    } catch (err: any) {
      const msg: string = err?.message === 'not-logged-in'
        ? 'Not logged in to NotebookLM — please complete Google sign-in first.'
        : (err?.message ?? String(err));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: msg }));
      return false;
    }
  }

  const server = http.createServer(async (req: any, res: any) => {
    const url: string = req.url ?? '/';

    if (req.method === 'GET' && url === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(LOGIN_PAGE_HTML);
      return;
    }

    // Auto-extract from Chrome's on-disk cookie store
    if (req.method === 'POST' && url === '/complete') {
      opts.onLog?.('Extracting Chrome session…');
      let cookieStr = '';
      try {
        const result = await readMacChromeCookiesWithDiag(opts.onLog);
        cookieStr = result.cookies;
      } catch (err: any) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: err?.message ?? String(err) }));
        return;
      }
      if (!cookieStr) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'No Google cookies found. Try the manual method below.' }));
        return;
      }
      await handleComplete(cookieStr, res);
      return;
    }

    // Manual cookie paste
    if (req.method === 'POST' && url === '/complete-manual') {
      let body = '';
      req.on('data', (chunk: any) => { body += chunk; });
      req.on('end', async () => {
        try {
          const { cookies } = JSON.parse(body) as { cookies: string };
          if (!cookies || typeof cookies !== 'string') throw new Error('No cookie string provided');
          // Sanitize: drop individual pairs with invalid chars
          const cleaned = cookies.split(/;\s*/)
            .filter(pair => {
              const v = pair.split('=').slice(1).join('=');
              return v !== undefined && isValidHeaderValue(v);
            })
            .join('; ');
          await handleComplete(cleaned, res);
        } catch (err: any) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: err?.message ?? String(err) }));
        }
      });
      return;
    }

    // Debug endpoint — returns diagnostic JSON
    if (req.method === 'GET' && url === '/debug') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      try {
        const result = await readMacChromeCookiesWithDiag(opts.onLog);
        res.end(JSON.stringify({
          cookieCount: result.cookies.split(';').filter(Boolean).length,
          profiles: result.diag,
          platform: process.platform,
          nodeVersion: process.version,
        }, null, 2));
      } catch (err: any) {
        res.end(JSON.stringify({ error: err?.message ?? String(err) }));
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

  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { execSync } = require('child_process') as typeof import('child_process');
    execSync(`open -a "Google Chrome" "${NOTEBOOKLM_URL}"`, { stdio: 'pipe' });
    execSync(`open -a "Google Chrome" "${localUrl}"`, { stdio: 'pipe' });
  } catch {
    throw new Error('Could not open Google Chrome');
  }

  opts.onLog?.(`Chrome opened. Log in to NotebookLM, then click "Save session" at ${localUrl}`);
  opts.onLog?.(`Debug info available at ${localUrl}debug`);

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

export async function loginInteractive(opts: LoginOptions = {}): Promise<string> {
  const lib: any = await loadLib();
  if (opts.homeDir && typeof lib.setHomeDir === 'function') lib.setHomeDir(opts.homeDir);

  if (process.platform === 'darwin') {
    try {
      return await loginWithLocalServer(lib, opts);
    } catch (err: any) {
      const msg: string = err?.message ?? '';
      if (msg.includes('macOS only') || msg.includes('Chrome') || msg.includes('sqlite3')) {
        console.warn('[notebooklmAuth] local-server unavailable, using puppeteer:', msg);
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

import type { CompilerAdapter } from './CompilerAdapter.js';
import type { BuildResult, KnowledgeEntry, QueryResult, Source } from '../types.js';
import { loadLib as loadNotebookLmLib } from './notebooklmAuth.js';

/**
 * Adapter over `notebooklm-client`. Kept loosely-typed because the library
 * relies on a headless browser session and its surface has been evolving.
 *
 * Module loading is delegated to notebooklmAuth.loadLib which auto-installs
 * notebooklm-client to ~/.mem-plugin/ on first use if needed.
 */

interface NotebookLmOptions {
  transport?: 'auto' | 'browser' | 'http' | 'curl-impersonate' | 'tls-client';
  pinnedNotebookId?: string;
  homeDir?: string;
  chromePath?: string;
}

export class NotebookLmCompiler implements CompilerAdapter {
  readonly id = 'notebooklm';
  private opts: NotebookLmOptions;
  private client: any = null;
  private notebookId: string | null = null;
  private sourceIds: string[] = [];

  constructor(opts: NotebookLmOptions = {}) {
    this.opts = opts;
  }

  private async ensureClient() {
    if (this.client) return;
    const mod: any = await loadNotebookLmLib();
    const Ctor = mod.NotebookClient || mod.default?.NotebookClient;
    if (!Ctor) throw new Error('notebooklm-client: NotebookClient export not found');
    if (this.opts.homeDir && typeof mod.setHomeDir === 'function') mod.setHomeDir(this.opts.homeDir);

    // Fail fast if no session file at all — connect() hangs indefinitely without one.
    // Short-lived tokens (~1-2h) may be expired, but long-lived cookies (weeks/months)
    // can refresh them automatically. Try refreshTokens() before giving up.
    const sessionPath: string | undefined = typeof mod.getSessionPath === 'function'
      ? mod.getSessionPath()
      : undefined;

    let session: any = null;
    if (typeof mod.loadSession === 'function') {
      session = await mod.loadSession(sessionPath);
    }

    if (!session) {
      throw new Error('No valid NotebookLM session — please log in via Settings → Provider settings → Log in to NotebookLM');
    }

    const isValid = typeof mod.hasValidSession === 'function'
      ? await mod.hasValidSession(sessionPath)
      : true;

    if (!isValid && typeof mod.refreshTokens === 'function') {
      try {
        console.log('[mem-plugin/notebooklm] tokens expired, refreshing…');
        session = await mod.refreshTokens(session, sessionPath);
      } catch (e) {
        console.warn('[mem-plugin/notebooklm] token refresh failed:', e);
        throw new Error('NotebookLM session expired and could not be refreshed — please log in again via Settings');
      }
    }

    this.client = new Ctor();
    const connectOpts: any = {
      transport: this.opts.transport ?? 'auto',
      session,  // pass refreshed session directly, skipping disk re-read
    };
    if (this.opts.chromePath) connectOpts.chromePath = this.opts.chromePath;
    await this.client.connect(connectOpts);
  }

  private async ensureNotebook() {
    await this.ensureClient();
    if (this.notebookId) return;
    if (this.opts.pinnedNotebookId) {
      this.notebookId = this.opts.pinnedNotebookId;
      const detail = await this.client.getNotebookDetail(this.notebookId);
      this.sourceIds = (detail?.sources ?? []).map((s: any) => s.id);
    } else {
      const created = await this.client.createNotebook();
      this.notebookId = created.notebookId || created.id;
    }
  }

  async build(sources: Source[]): Promise<BuildResult> {
    await this.ensureNotebook();

    for (const src of sources) {
      const res = await this.client.addTextSource(this.notebookId, src.title, src.content);
      if (res?.sourceId) this.sourceIds.push(res.sourceId);
    }

    // Give NotebookLM a moment to index the newly uploaded sources before querying.
    await new Promise((r) => setTimeout(r, 5_000));

    const entries = await this.synthesize(sources);

    return {
      entries,
      meta: {
        provider: 'notebooklm',
        notebookId: this.notebookId ?? undefined,
        sourceCount: sources.length,
        builtAt: new Date().toISOString(),
      },
    };
  }

  /**
   * Ask NotebookLM to synthesize knowledge from the uploaded sources and
   * return structured KnowledgeEntry objects for the knowledge store.
   */
  private async synthesize(sources: Source[]): Promise<KnowledgeEntry[]> {
    const queries = [
      'Provide a comprehensive overview of all the content in this notebook. Cover the main topics, key ideas, and important context.',
      'List the most important facts, insights, and conclusions from all sources in this notebook. Use bullet points.',
    ];

    const entries: KnowledgeEntry[] = [];

    for (const question of queries) {
      try {
        const { text } = await this.client.sendChat(this.notebookId, question, this.sourceIds);
        if (!text?.trim()) continue;

        const lines = (text as string)
          .split('\n')
          .map((l: string) => l.replace(/^[-•*\d.]+\s*/, '').trim())
          .filter(Boolean);

        entries.push({
          summary: lines[0] ?? text.slice(0, 200),
          facts: lines.slice(1),
          tags: ['notebooklm', 'synthesized'],
        });
      } catch (e) {
        console.warn('[mem-plugin/notebooklm] synthesis query failed:', e);
      }
    }

    // Fallback: if all queries failed, at least record source titles.
    if (entries.length === 0) {
      entries.push({
        summary: `NotebookLM notebook ${this.notebookId} — ${sources.length} sources uploaded`,
        facts: sources.map((s) => `Source: ${s.title}`),
        tags: ['notebooklm', 'compiled'],
      });
    }

    return entries;
  }

  async query(question: string): Promise<QueryResult> {
    await this.ensureNotebook();
    const { text, citations } = await this.client.sendChat(this.notebookId, question, this.sourceIds);
    return { answer: text, citations };
  }

  async dispose() {
    if (this.client?.disconnect) await this.client.disconnect();
    this.client = null;
    this.notebookId = null;
    this.sourceIds = [];
  }
}

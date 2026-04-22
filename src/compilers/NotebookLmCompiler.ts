import type { CompilerAdapter } from './CompilerAdapter.js';
import type { BuildResult, QueryResult, Source } from '../types.js';

/**
 * Adapter over `notebooklm-client`. Kept loosely-typed because the library
 * relies on a headless browser session and its surface has been evolving.
 *
 * Dynamic import avoids loading puppeteer/chromium until the user actually
 * selects NotebookLM as their provider.
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

  private async loadNotebookLmLib(): Promise<any> {
    // notebooklm-client is ESM-only and can't be bundled. Obsidian intercepts
    // bare-specifier imports, so resolve to an absolute path then use file:// URL.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const Module = require('module') as any;
    const paths: string[] = Module._nodeModulePaths(
      typeof __dirname !== 'undefined' ? __dirname : process.cwd()
    );
    const resolved: string = Module._resolveFilename('notebooklm-client', null, false, { paths });
    return await import(`file://${resolved}`);
  }

  private async ensureClient() {
    if (this.client) return;
    const mod: any = await this.loadNotebookLmLib();
    const Ctor = mod.NotebookClient || mod.default?.NotebookClient;
    if (!Ctor) throw new Error('notebooklm-client: NotebookClient export not found');
    if (this.opts.homeDir && typeof mod.setHomeDir === 'function') mod.setHomeDir(this.opts.homeDir);

    this.client = new Ctor();
    const connectOpts: any = { transport: this.opts.transport ?? 'auto' };
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

    // NotebookLM does the compilation internally. We don't pull a JSON KB back;
    // instead we record the notebook state and defer actual retrieval to query().
    return {
      entries: [
        {
          summary: `NotebookLM compiled ${sources.length} sources into notebook ${this.notebookId}`,
          facts: sources.map((s) => `Source: ${s.title}`),
          tags: ['notebooklm', 'compiled'],
        },
      ],
      meta: {
        provider: 'notebooklm',
        notebookId: this.notebookId ?? undefined,
        sourceCount: sources.length,
        builtAt: new Date().toISOString(),
      },
    };
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

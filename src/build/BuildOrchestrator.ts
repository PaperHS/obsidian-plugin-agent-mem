import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { App, TFile } from 'obsidian';
import type { CompilerAdapter } from '../compilers/CompilerAdapter.js';
import type { BuildResult, MemPluginSettings, Source } from '../types.js';
import { KnowledgeStoreWriter } from '../store/KnowledgeStoreWriter.js';

export interface BuildReport {
  sourceCount: number;
  entryCount: number;
  writtenFiles: string[];
  provider: string;
  notebookId?: string;
}

export class BuildOrchestrator {
  constructor(
    private readonly app: App,
    private readonly settings: MemPluginSettings
  ) {}

  async collectVaultSources(): Promise<Source[]> {
    const { includeFolders, excludeFolders, fileExtensions } = this.settings;
    const files = this.app.vault.getFiles() as TFile[];
    const exts = fileExtensions.length ? fileExtensions : ['.md'];

    const included = files.filter((f) => {
      const p = f.path;
      const extOk = exts.some((e) => p.endsWith(e));
      if (!extOk) return false;
      if (excludeFolders.some((dir) => p.startsWith(dir.replace(/\/$/, '') + '/'))) return false;
      if (includeFolders.length === 0) return true;
      return includeFolders.some((dir) => p.startsWith(dir.replace(/\/$/, '') + '/'));
    });

    const sources: Source[] = [];
    for (const f of included) {
      const content = await this.app.vault.cachedRead(f);
      sources.push({ id: f.path, title: f.basename, path: f.path, content });
    }
    return sources;
  }

  async collectRawStoreSources(): Promise<Source[]> {
    const dir = this.settings.rawStorePath;
    if (!dir) return [];
    try {
      const files = await fs.readdir(dir);
      const out: Source[] = [];
      for (const file of files.filter((f) => f.endsWith('.md'))) {
        const full = path.join(dir, file);
        const content = await fs.readFile(full, 'utf-8');
        out.push({
          id: `raw:${file}`,
          title: path.basename(file, '.md'),
          path: full,
          content,
        });
      }
      return out;
    } catch {
      return [];
    }
  }

  async run(compiler: CompilerAdapter): Promise<BuildReport> {
    const [vaultSources, rawSources] = await Promise.all([
      this.collectVaultSources(),
      this.collectRawStoreSources(),
    ]);
    const sources = [...vaultSources, ...rawSources];
    if (sources.length === 0) {
      return { sourceCount: 0, entryCount: 0, writtenFiles: [], provider: compiler.id };
    }

    const result: BuildResult = await compiler.build(sources);

    let writtenFiles: string[] = [];
    if (this.settings.knowledgeStorePath) {
      const writer = new KnowledgeStoreWriter(this.settings.knowledgeStorePath);
      writtenFiles = await writer.write(result.entries);
    }

    return {
      sourceCount: sources.length,
      entryCount: result.entries.length,
      writtenFiles,
      provider: compiler.id,
      notebookId: result.meta?.notebookId,
    };
  }
}

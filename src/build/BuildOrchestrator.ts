import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { App, TFile } from 'obsidian';
import type { CompilerAdapter } from '../compilers/CompilerAdapter.js';
import type { BuildResult, MemPluginSettings, Source } from '../types.js';
import { KnowledgeStoreWriter } from '../store/KnowledgeStoreWriter.js';
import { BuildState } from './BuildState.js';
import { SummaryPreprocessor } from './SummaryPreprocessor.js';
import { ConceptExtractor } from './ConceptExtractor.js';

export interface BuildReport {
  sourceCount: number;
  newCount: number;        // sources actually processed (incremental)
  entryCount: number;
  conceptCount: number;
  writtenFiles: string[];
  provider: string;
  notebookId?: string;
  /** Vault-relative folders that were used for filtering (empty = entire vault). */
  effectiveFolders: string[];
}

export class BuildOrchestrator {
  constructor(
    private readonly app: App,
    private readonly settings: MemPluginSettings
  ) {}

  /** Normalize a folder entry to a vault-relative path (strips vault base if user pasted an absolute path). */
  private normalizeFolder(dir: string): string {
    const trimmed = dir.replace(/\/$/, '').trim();
    const basePath: string = (this.app.vault.adapter as any).basePath ?? '';
    if (basePath && trimmed.startsWith(basePath)) {
      return trimmed.slice(basePath.length).replace(/^[\\/]/, '');
    }
    return trimmed;
  }

  async collectVaultSources(): Promise<{ sources: Source[]; effectiveFolders: string[] }> {
    const { includeFolders, excludeFolders, fileExtensions } = this.settings;
    const files = this.app.vault.getFiles() as TFile[];
    const exts = fileExtensions.length ? fileExtensions : ['.md'];

    const normInclude = includeFolders.map((d) => this.normalizeFolder(d)).filter(Boolean);
    const normExclude = excludeFolders.map((d) => this.normalizeFolder(d)).filter(Boolean);

    const included = files.filter((f) => {
      const p = f.path;
      if (!exts.some((e) => p.endsWith(e))) return false;
      if (normExclude.some((dir) => p.startsWith(dir + '/'))) return false;
      if (normInclude.length === 0) return true;
      return normInclude.some((dir) => p.startsWith(dir + '/'));
    });

    const sources: Source[] = [];
    for (const f of included) {
      const content = await this.app.vault.cachedRead(f);
      sources.push({ id: f.path, title: f.basename, path: f.path, content });
    }
    return { sources, effectiveFolders: normInclude };
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

  async run(
    compiler: CompilerAdapter,
    onProgress?: (stage: string, done: number, total: number) => void,
  ): Promise<BuildReport> {
    const { incrementalBuild, preSummarize, extractConcepts, preprocessor, knowledgeStorePath } = this.settings;

    // ── 1. Collect sources ────────────────────────────────────────────────
    const [{ sources: vaultSources, effectiveFolders }, rawSources] = await Promise.all([
      this.collectVaultSources(),
      this.collectRawStoreSources(),
    ]);
    const allSources = [...vaultSources, ...rawSources];

    // ── 2. Incremental filter ─────────────────────────────────────────────
    let state: BuildState | null = null;
    let toProcess = allSources;

    if (incrementalBuild && knowledgeStorePath) {
      state = new BuildState(knowledgeStorePath);
      await state.load();
      toProcess = allSources.filter((s) => state!.isChanged(s));
    }

    const newCount = toProcess.length;

    if (newCount === 0) {
      return {
        sourceCount: allSources.length,
        newCount: 0,
        entryCount: 0,
        conceptCount: 0,
        writtenFiles: [],
        provider: compiler.id,
        effectiveFolders,
      };
    }

    // ── 3. Pre-summarize ──────────────────────────────────────────────────
    let processedSources = toProcess;
    if (preSummarize && preprocessor.apiKey) {
      const summarizer = new SummaryPreprocessor({
        apiKey: preprocessor.apiKey,
        baseURL: preprocessor.baseURL,
        model: preprocessor.model,
      });
      processedSources = await summarizer.process(toProcess, (done, total) =>
        onProgress?.('Summarizing', done, total),
      );
    }

    // ── 4. Main compile ───────────────────────────────────────────────────
    const result: BuildResult = await compiler.build(processedSources);

    // ── 5. Concept extraction ─────────────────────────────────────────────
    let conceptEntries: typeof result.entries = [];
    if (extractConcepts && preprocessor.apiKey) {
      try {
        const extractor = new ConceptExtractor({
          apiKey: preprocessor.apiKey,
          baseURL: preprocessor.baseURL,
          model: preprocessor.model,
        });
        conceptEntries = await extractor.extract(processedSources);
      } catch (e) {
        console.warn('[mem-plugin] concept extraction failed:', e);
      }
    }

    // ── 6. Write to knowledge store ───────────────────────────────────────
    let writtenFiles: string[] = [];
    if (knowledgeStorePath) {
      const writer = new KnowledgeStoreWriter(knowledgeStorePath);
      writtenFiles = await writer.write([...result.entries, ...conceptEntries]);
    }

    // ── 7. Persist build state ────────────────────────────────────────────
    if (state) {
      for (const src of toProcess) state.markProcessed(src);
      await state.save();
    }

    return {
      sourceCount: allSources.length,
      newCount,
      entryCount: result.entries.length,
      conceptCount: conceptEntries.length,
      writtenFiles,
      provider: compiler.id,
      notebookId: result.meta?.notebookId,
      effectiveFolders,
    };
  }
}

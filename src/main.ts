import { Notice, Plugin, TFile } from 'obsidian';
import { DEFAULT_SETTINGS, type MemPluginSettings } from './types.js';
import { MemPluginSettingTab } from './settings.js';
import { BuildOrchestrator } from './build/BuildOrchestrator.js';
import { createCompiler, type CompilerAdapter } from './compilers/index.js';
import { QueryModal } from './ui/QueryModal.js';

export default class MemPluginBuild extends Plugin {
  settings!: MemPluginSettings;
  private activeCompiler: CompilerAdapter | null = null;
  private rebuildTimer: number | null = null;

  async onload() {
    await this.loadSettings();
    this.addSettingTab(new MemPluginSettingTab(this.app, this));

    this.addCommand({
      id: 'mem-plugin-run-build',
      name: 'Run build',
      callback: () => this.runBuild(),
    });

    this.addCommand({
      id: 'mem-plugin-query',
      name: 'Query knowledge (if provider supports it)',
      callback: () => this.openQueryModal(),
    });

    this.addCommand({
      id: 'mem-plugin-dispose',
      name: 'Dispose compiler session',
      callback: () => this.disposeCompiler(),
    });

    this.registerEvent(
      this.app.vault.on('modify', (f) => {
        if (!this.settings.autoBuildOnChange) return;
        if (!(f instanceof TFile)) return;
        this.scheduleAutoBuild();
      })
    );
  }

  onunload() {
    this.disposeCompiler();
  }

  async loadSettings() {
    const data = await this.loadData();
    this.settings = mergeDeep(DEFAULT_SETTINGS, data ?? {});
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  private getCompiler(): CompilerAdapter {
    if (this.activeCompiler) return this.activeCompiler;
    this.activeCompiler = createCompiler(this.settings.provider, this.settings);
    return this.activeCompiler;
  }

  private async disposeCompiler() {
    if (this.activeCompiler?.dispose) {
      try {
        await this.activeCompiler.dispose();
      } catch (e) {
        console.error('[mem-plugin] dispose error', e);
      }
    }
    this.activeCompiler = null;
  }

  private async runBuild() {
    const notice = new Notice(`Building with ${this.settings.provider}…`, 0);
    try {
      const compiler = this.getCompiler();
      const orchestrator = new BuildOrchestrator(this.app, this.settings);
      const report = await orchestrator.run(compiler, (stage, done, total) => {
        notice.setMessage(`${stage} ${done}/${total}…`);
      });

      // Persist the notebook ID so it survives plugin reloads/updates.
      if (report.notebookId && this.settings.provider === 'notebooklm') {
        const nblm = this.settings.providers.notebooklm;
        if (nblm.pinnedNotebookId !== report.notebookId) {
          nblm.pinnedNotebookId = report.notebookId;
          await this.saveSettings();
        }
      }

      notice.hide();

      if (report.newCount === 0) {
        new Notice(`Build done: no changes since last build (${report.sourceCount} sources total)`);
        return;
      }

      const folderInfo = report.effectiveFolders.length
        ? ` [${report.effectiveFolders.join(', ')}]`
        : ' [entire vault]';
      const conceptInfo = report.conceptCount > 0 ? `, ${report.conceptCount} concepts` : '';
      new Notice(
        `Build done: ${report.newCount}/${report.sourceCount} sources${folderInfo}` +
        ` → ${report.entryCount} entries${conceptInfo}` +
        (report.writtenFiles.length ? ` (${report.writtenFiles.length} files written)` : '')
      );
    } catch (e) {
      notice.hide();
      const msg = (e as Error).message || String(e);
      new Notice(`Build failed: ${msg}`, 10_000);
      console.error('[mem-plugin] build error', e);
    }
  }

  private openQueryModal() {
    try {
      const compiler = this.getCompiler();
      new QueryModal(this.app, compiler).open();
    } catch (e) {
      new Notice(`Cannot open query: ${(e as Error).message}`);
    }
  }

  private scheduleAutoBuild() {
    if (this.rebuildTimer !== null) window.clearTimeout(this.rebuildTimer);
    this.rebuildTimer = window.setTimeout(() => {
      this.rebuildTimer = null;
      this.runBuild();
    }, this.settings.autoBuildDebounceMs);
  }
}

function mergeDeep<T>(base: T, override: Partial<T>): T {
  if (override === null || typeof override !== 'object' || Array.isArray(override)) {
    return (override ?? base) as T;
  }
  const out: any = Array.isArray(base) ? [...(base as any)] : { ...(base as any) };
  for (const k of Object.keys(override)) {
    const ov = (override as any)[k];
    const bv = (base as any)?.[k];
    out[k] = ov && typeof ov === 'object' && !Array.isArray(ov) && bv && typeof bv === 'object'
      ? mergeDeep(bv, ov)
      : ov;
  }
  return out;
}

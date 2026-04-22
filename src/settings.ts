import { App, PluginSettingTab, Setting } from 'obsidian';
import type MemPluginBuild from './main.js';
import type { ProviderId } from './types.js';

const PROVIDER_LABELS: Record<ProviderId, string> = {
  notebooklm: 'NotebookLM (via notebooklm-client)',
  anthropic: 'Anthropic (Claude)',
  openai: 'OpenAI',
  gemini: 'Gemini',
  custom: 'Custom (OpenAI- or Anthropic-compatible)',
};

export class MemPluginSettingTab extends PluginSettingTab {
  constructor(app: App, private readonly plugin: MemPluginBuild) {
    super(app, plugin);
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    const s = this.plugin.settings;

    containerEl.createEl('h2', { text: 'Mem Plugin — Build' });

    new Setting(containerEl)
      .setName('Provider')
      .setDesc('Which compiler adapter runs the build.')
      .addDropdown((d) => {
        for (const [id, label] of Object.entries(PROVIDER_LABELS)) d.addOption(id, label);
        d.setValue(s.provider).onChange(async (v) => {
          s.provider = v as ProviderId;
          await this.plugin.saveSettings();
          this.display();
        });
      });

    containerEl.createEl('h3', { text: 'Storage' });

    new Setting(containerEl)
      .setName('Knowledge store path')
      .setDesc('Absolute path. Build output is written here (same format as mem-plugin). The MCP server reads this directory to serve recall.')
      .addText((t) =>
        t
          .setPlaceholder('/Users/me/.mem-plugin/knowledge')
          .setValue(s.knowledgeStorePath)
          .onChange(async (v) => {
            s.knowledgeStorePath = v.trim();
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName('Raw store path (optional)')
      .setDesc('If set, session records in this directory are pulled in alongside vault notes.')
      .addText((t) =>
        t
          .setPlaceholder('/Users/me/.mem-plugin/raw')
          .setValue(s.rawStorePath ?? '')
          .onChange(async (v) => {
            s.rawStorePath = v.trim();
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName('Include folders')
      .setDesc('Vault folders to include, comma-separated. Empty = entire vault.')
      .addText((t) =>
        t
          .setValue(s.includeFolders.join(', '))
          .setPlaceholder('Journal, Projects/mem-plugin')
          .onChange(async (v) => {
            s.includeFolders = v.split(',').map((x) => x.trim()).filter(Boolean);
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName('Exclude folders')
      .setDesc('Folders to skip, comma-separated.')
      .addText((t) =>
        t
          .setValue(s.excludeFolders.join(', '))
          .onChange(async (v) => {
            s.excludeFolders = v.split(',').map((x) => x.trim()).filter(Boolean);
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName('Auto-build on change')
      .setDesc('Debounced rebuild when vault files change. Leave off unless your provider is cheap.')
      .addToggle((t) =>
        t.setValue(s.autoBuildOnChange).onChange(async (v) => {
          s.autoBuildOnChange = v;
          await this.plugin.saveSettings();
        })
      );

    this.renderProviderSection(containerEl);
  }

  private renderProviderSection(c: HTMLElement) {
    const s = this.plugin.settings;
    c.createEl('h3', { text: `Provider settings — ${PROVIDER_LABELS[s.provider]}` });

    const save = () => this.plugin.saveSettings();

    switch (s.provider) {
      case 'notebooklm': {
        const p = s.providers.notebooklm;
        new Setting(c)
          .setName('Transport')
          .setDesc('auto / puppeteer / chromium. Requires one-time Google login in the launched browser.')
          .addDropdown((d) =>
            d
              .addOption('auto', 'auto')
              .addOption('puppeteer', 'puppeteer')
              .addOption('chromium', 'chromium')
              .setValue(p.transport)
              .onChange(async (v) => {
                p.transport = v as typeof p.transport;
                await save();
              })
          );
        new Setting(c)
          .setName('Pinned notebook ID (optional)')
          .setDesc('Reuse an existing notebook instead of creating a new one each build.')
          .addText((t) =>
            t.setValue(p.pinnedNotebookId ?? '').onChange(async (v) => {
              p.pinnedNotebookId = v.trim() || undefined;
              await save();
            })
          );
        break;
      }
      case 'anthropic':
      case 'openai':
      case 'gemini': {
        const p = s.providers[s.provider];
        new Setting(c).setName('API key').addText((t) =>
          t.setValue(p.apiKey ?? '').onChange(async (v) => {
            p.apiKey = v.trim() || undefined;
            await save();
          })
        );
        if (s.provider !== 'gemini') {
          new Setting(c)
            .setName('Base URL (optional)')
            .setDesc('For proxies or self-hosted compatible endpoints.')
            .addText((t) =>
              t.setValue(p.baseURL ?? '').onChange(async (v) => {
                p.baseURL = v.trim() || undefined;
                await save();
              })
            );
        }
        new Setting(c).setName('Model').addText((t) =>
          t.setValue(p.model ?? '').onChange(async (v) => {
            p.model = v.trim();
            await save();
          })
        );
        break;
      }
      case 'custom': {
        const p = s.providers.custom;
        new Setting(c)
          .setName('API format')
          .addDropdown((d) =>
            d
              .addOption('openai', 'OpenAI-compatible')
              .addOption('anthropic', 'Anthropic-compatible')
              .setValue(p.format)
              .onChange(async (v) => {
                p.format = v as 'openai' | 'anthropic';
                await save();
              })
          );
        new Setting(c).setName('Base URL').addText((t) =>
          t.setPlaceholder('https://my-proxy.example/v1').setValue(p.baseURL ?? '').onChange(async (v) => {
            p.baseURL = v.trim() || undefined;
            await save();
          })
        );
        new Setting(c).setName('API key').addText((t) =>
          t.setValue(p.apiKey ?? '').onChange(async (v) => {
            p.apiKey = v.trim() || undefined;
            await save();
          })
        );
        new Setting(c).setName('Model').addText((t) =>
          t.setValue(p.model ?? '').onChange(async (v) => {
            p.model = v.trim();
            await save();
          })
        );
        break;
      }
    }
  }
}

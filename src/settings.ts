import { App, Notice, PluginSettingTab, Setting } from 'obsidian';
import type MemPluginBuild from './main.js';
import type { ProviderId } from './types.js';
import { checkSession, loginInteractive, logout, type SessionStatus } from './compilers/notebooklmAuth.js';

const PROVIDER_LABELS: Record<ProviderId, string> = {
  notebooklm: 'NotebookLM (via notebooklm-client)',
  anthropic: 'Anthropic (Claude)',
  openai: 'OpenAI',
  gemini: 'Gemini',
  custom: 'Custom (OpenAI- or Anthropic-compatible)',
};

export class MemPluginSettingTab extends PluginSettingTab {
  private sessionStatus: SessionStatus | null = null;

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

        // ── Authentication block ─────────────────────────────────────
        c.createEl('h4', { text: 'NotebookLM authentication' });

        const statusRow = c.createDiv({ cls: 'mem-plugin-nblm-status' });
        statusRow.style.margin = '0 0 0.5em 0';
        statusRow.style.padding = '0.5em 0.75em';
        statusRow.style.borderLeft = '3px solid var(--interactive-accent)';
        statusRow.style.background = 'var(--background-secondary)';
        statusRow.style.fontSize = '0.9em';
        const renderStatus = () => {
          statusRow.empty();
          if (!this.sessionStatus) {
            statusRow.setText('Session: unknown — click "Check status" to verify.');
            return;
          }
          const { loggedIn, sessionPath, checkedAt } = this.sessionStatus;
          const icon = loggedIn ? '✓' : '✗';
          const color = loggedIn ? 'var(--color-green)' : 'var(--color-red)';
          const badge = statusRow.createSpan({ text: `${icon} ${loggedIn ? 'Logged in' : 'Not logged in'}` });
          badge.style.color = color;
          badge.style.fontWeight = '600';
          statusRow.createSpan({ text: `  ·  session path: ${sessionPath}` });
          statusRow.createEl('br');
          const ts = statusRow.createSpan({ text: `checked ${new Date(checkedAt).toLocaleTimeString()}` });
          ts.style.opacity = '0.6';
        };
        renderStatus();

        new Setting(c)
          .setName('Session actions')
          .setDesc(
            'Log in launches a real Chrome window so you can sign into Google. ' +
              'The session is saved to disk and reused for all subsequent builds.'
          )
          .addButton((b) =>
            b
              .setButtonText('Check status')
              .onClick(async () => {
                try {
                  this.sessionStatus = await checkSession(p.homeDir);
                  renderStatus();
                  new Notice(this.sessionStatus.loggedIn ? 'NotebookLM: session valid' : 'NotebookLM: not logged in');
                } catch (e) {
                  new Notice(`Check failed: ${(e as Error).message}`, 8000);
                }
              })
          )
          .addButton((b) =>
            b
              .setButtonText('Log in to NotebookLM')
              .setCta()
              .onClick(async () => {
                const notice = new Notice('Opening Chrome — log in with your Google account, this dialog will close automatically…', 0);
                try {
                  const path = await loginInteractive({
                    homeDir: p.homeDir,
                    chromePath: p.chromePath,
                    onLog: (msg) => console.log('[mem-plugin/notebooklm]', msg),
                  });
                  notice.hide();
                  new Notice(`Logged in. Session → ${path}`, 6000);
                  this.sessionStatus = await checkSession(p.homeDir);
                  renderStatus();
                } catch (e) {
                  notice.hide();
                  new Notice(`Login failed: ${(e as Error).message}`, 10_000);
                  console.error('[mem-plugin/notebooklm] login error', e);
                }
              })
          )
          .addButton((b) =>
            b
              .setButtonText('Log out')
              .setWarning()
              .onClick(async () => {
                try {
                  const path = await logout(p.homeDir);
                  new Notice(`Session removed: ${path}`);
                  this.sessionStatus = await checkSession(p.homeDir);
                  renderStatus();
                } catch (e) {
                  new Notice(`Logout failed: ${(e as Error).message}`);
                }
              })
          );

        // Check status on first render (non-blocking).
        if (!this.sessionStatus) {
          void checkSession(p.homeDir)
            .then((st) => {
              this.sessionStatus = st;
              renderStatus();
            })
            .catch(() => {
              /* keep "unknown" */
            });
        }

        // ── Runtime settings ─────────────────────────────────────────
        c.createEl('h4', { text: 'Runtime' });

        new Setting(c)
          .setName('Transport')
          .setDesc(
            'auto = best available non-browser (fastest). browser = real Chrome via Puppeteer. ' +
              'http/curl-impersonate/tls-client use the saved session.'
          )
          .addDropdown((d) =>
            d
              .addOption('auto', 'auto (recommended)')
              .addOption('browser', 'browser (Puppeteer)')
              .addOption('http', 'http')
              .addOption('curl-impersonate', 'curl-impersonate')
              .addOption('tls-client', 'tls-client')
              .setValue(p.transport)
              .onChange(async (v) => {
                p.transport = v as typeof p.transport;
                await save();
              })
          );

        new Setting(c)
          .setName('Session home directory (optional)')
          .setDesc('Override ~/.notebooklm. Useful for multiple Google accounts.')
          .addText((t) =>
            t
              .setPlaceholder('/Users/me/.notebooklm-work')
              .setValue(p.homeDir ?? '')
              .onChange(async (v) => {
                p.homeDir = v.trim() || undefined;
                await save();
                this.sessionStatus = null;
                renderStatus();
              })
          );

        new Setting(c)
          .setName('Chrome executable path (optional)')
          .setDesc('Path to Chrome used for interactive login. Auto-detected if empty.')
          .addText((t) =>
            t
              .setPlaceholder('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome')
              .setValue(p.chromePath ?? '')
              .onChange(async (v) => {
                p.chromePath = v.trim() || undefined;
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

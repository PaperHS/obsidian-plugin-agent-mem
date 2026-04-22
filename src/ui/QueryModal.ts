import { App, Modal, Notice, Setting } from 'obsidian';
import type { CompilerAdapter } from '../compilers/CompilerAdapter.js';
import { CompilerUnsupportedError } from '../compilers/CompilerAdapter.js';

export class QueryModal extends Modal {
  private question = '';

  constructor(app: App, private readonly compiler: CompilerAdapter) {
    super(app);
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl('h2', { text: `Query knowledge (${this.compiler.id})` });

    new Setting(contentEl)
      .setName('Question')
      .addTextArea((t) =>
        t.setPlaceholder('e.g. 之前关于架构的决策演化过程是什么？').onChange((v) => (this.question = v))
      );

    const resultEl = contentEl.createEl('div', { cls: 'mem-plugin-result' });
    resultEl.style.whiteSpace = 'pre-wrap';
    resultEl.style.marginTop = '1em';

    new Setting(contentEl).addButton((b) =>
      b
        .setButtonText('Ask')
        .setCta()
        .onClick(async () => {
          if (!this.question.trim()) return;
          resultEl.setText('Thinking...');
          try {
            const r = await this.compiler.query(this.question);
            resultEl.setText(r.answer);
          } catch (e) {
            if (e instanceof CompilerUnsupportedError) {
              new Notice(`${this.compiler.id} does not support direct query. Use recall via mem-plugin MCP server instead.`);
              resultEl.setText(`(${this.compiler.id} has no query method — the compiled knowledge lives in the knowledge store; query via mem-plugin's recall tool.)`);
            } else {
              resultEl.setText(`Error: ${(e as Error).message}`);
            }
          }
        })
    );
  }

  onClose() {
    this.contentEl.empty();
  }
}

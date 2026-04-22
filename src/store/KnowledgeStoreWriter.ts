import { promises as fs } from 'node:fs';
import path from 'node:path';
import { nanoid } from 'nanoid';
import type { KnowledgeEntry } from '../types.js';

/**
 * Writes build output in the same YAML+Markdown format used by mem-plugin's
 * MarkdownStore, so the MCP server can pick it up as-is.
 */
export class KnowledgeStoreWriter {
  constructor(private readonly dir: string) {}

  async write(entries: KnowledgeEntry[], project?: string): Promise<string[]> {
    if (!this.dir) throw new Error('Knowledge store path is not configured');
    await fs.mkdir(this.dir, { recursive: true });
    const now = new Date().toISOString();
    const written: string[] = [];

    for (const entry of entries) {
      const id = nanoid(12);
      const body = serialize(id, entry, now, project);
      const file = path.join(this.dir, `${id}.md`);
      await fs.writeFile(file, body, 'utf-8');
      written.push(file);
    }
    return written;
  }
}

function serialize(id: string, e: KnowledgeEntry, now: string, project?: string): string {
  const facts = e.facts.map((f) => `  - ${escapeYaml(f)}`).join('\n');
  const tags = e.tags.length ? `[${e.tags.join(', ')}]` : '[]';
  const summary = e.summary.replace(/"/g, '\\"');
  const projectLine = project ? `\nproject: ${project}` : '';

  const fm = [
    '---',
    `id: ${id}`,
    `source: built`,
    `summary: "${summary}"`,
    `tags: ${tags}`,
    `facts:`,
    facts || '  []',
    `createdAt: ${now}`,
    `updatedAt: ${now}`,
    projectLine.trim() ? projectLine.trim() : null,
    '---',
  ]
    .filter((l) => l !== null)
    .join('\n');

  const body = [e.summary, '', ...e.facts.map((f) => `- ${f}`)].join('\n');
  return `${fm}\n\n${body}\n`;
}

function escapeYaml(s: string): string {
  return s.replace(/\n/g, ' ');
}

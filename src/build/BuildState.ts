import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { Source } from '../types.js';

interface BuildStateData {
  fileHashes: Record<string, string>;
  lastBuiltAt: string;
}

/**
 * Tracks per-file content hashes to enable incremental builds.
 * State is persisted to `{knowledgeStorePath}/.build-state.json`.
 */
export class BuildState {
  private data: BuildStateData = { fileHashes: {}, lastBuiltAt: '' };
  private readonly stateFile: string;

  constructor(stateDir: string) {
    this.stateFile = path.join(stateDir, '.build-state.json');
  }

  async load(): Promise<void> {
    try {
      const raw = await fs.readFile(this.stateFile, 'utf-8');
      this.data = JSON.parse(raw) as BuildStateData;
    } catch {
      this.data = { fileHashes: {}, lastBuiltAt: '' };
    }
  }

  async save(): Promise<void> {
    this.data.lastBuiltAt = new Date().toISOString();
    await fs.writeFile(this.stateFile, JSON.stringify(this.data, null, 2), 'utf-8');
  }

  private hash(content: string): string {
    return createHash('md5').update(content).digest('hex');
  }

  isChanged(source: Source): boolean {
    return this.data.fileHashes[source.id] !== this.hash(source.content);
  }

  markProcessed(source: Source): void {
    this.data.fileHashes[source.id] = this.hash(source.content);
  }

  get lastBuiltAt(): string {
    return this.data.lastBuiltAt;
  }
}

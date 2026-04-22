import type { Source, BuildResult, QueryResult } from '../types.js';

export interface CompilerAdapter {
  readonly id: string;

  /**
   * Push all sources and produce a structured knowledge base.
   * Implementations may either:
   *   (a) send sources to an external system that does the compilation (NotebookLM), or
   *   (b) feed sources + a build prompt to a generic LLM and parse the response.
   */
  build(sources: Source[]): Promise<BuildResult>;

  /**
   * Query the compiled knowledge (optional — not all adapters persist a queryable state).
   * Adapters that don't support query can throw `CompilerUnsupportedError`.
   */
  query(question: string): Promise<QueryResult>;

  /**
   * Tear down any stateful resources (browser sessions, open notebooks, etc.).
   */
  dispose?(): Promise<void>;
}

export class CompilerUnsupportedError extends Error {
  constructor(op: string, adapter: string) {
    super(`${op} is not supported by compiler ${adapter}`);
    this.name = 'CompilerUnsupportedError';
  }
}

export const BUILD_SYSTEM_PROMPT = `You are a knowledge compiler.
You receive a list of source documents (notes, sessions, transcripts).
Produce a compiled knowledge base by:
- Extracting discrete, self-contained facts
- Merging redundant information across sources
- Noting temporal evolution when dates are present
- Discovering cross-document connections

Return ONLY a JSON array. Each element:
{"summary": "one sentence", "facts": ["fact1", "fact2", ...], "tags": ["tag1", ...]}

Aim for ≤25 entries. Each entry covers a coherent topic or decision thread.`;

export function formatSourcesForPrompt(sources: Source[]): string {
  return sources
    .map(
      (s, i) =>
        `### Source ${i + 1}: ${s.title}${s.path ? ` (${s.path})` : ''}\n\n${s.content}`
    )
    .join('\n\n---\n\n');
}

export function parseBuildJson(text: string): { summary: string; facts: string[]; tags: string[] }[] {
  const clean = text.replace(/^```(?:json)?\n?/m, '').replace(/\n?```$/m, '').trim();
  const parsed = JSON.parse(clean) as unknown;
  if (!Array.isArray(parsed)) throw new Error('Expected JSON array from compiler');
  return parsed as { summary: string; facts: string[]; tags: string[] }[];
}

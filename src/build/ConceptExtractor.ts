import Anthropic from '@anthropic-ai/sdk';
import type { KnowledgeEntry, Source } from '../types.js';

export interface ConceptExtractorConfig {
  apiKey: string;
  baseURL?: string;
  model?: string;
}

// Rough token budget per batch (haiku: 200k ctx, keep well within limits)
const CHARS_PER_BATCH = 80_000;

interface RawConcept {
  name: string;
  definition: string;
  sources: string[];
  related?: string[];
}

/**
 * Extracts cross-document concepts from a set of (pre-summarized) sources.
 * Returns one KnowledgeEntry per concept, tagged with 'concept'.
 */
export class ConceptExtractor {
  private client: Anthropic;
  private model: string;

  constructor(cfg: ConceptExtractorConfig) {
    this.client = new Anthropic({
      apiKey: cfg.apiKey,
      ...(cfg.baseURL ? { baseURL: cfg.baseURL } : {}),
    });
    this.model = cfg.model ?? 'claude-haiku-4-5-20251001';
  }

  private batch(sources: Source[]): Source[][] {
    const batches: Source[][] = [];
    let current: Source[] = [];
    let chars = 0;
    for (const s of sources) {
      if (chars + s.content.length > CHARS_PER_BATCH && current.length > 0) {
        batches.push(current);
        current = [];
        chars = 0;
      }
      current.push(s);
      chars += s.content.length;
    }
    if (current.length > 0) batches.push(current);
    return batches;
  }

  private async extractBatch(sources: Source[]): Promise<RawConcept[]> {
    const content = sources
      .map((s) => `## ${s.title}\n${s.content.slice(0, 2000)}`)
      .join('\n\n');

    const res = await this.client.messages.create({
      model: this.model,
      max_tokens: 2048,
      messages: [
        {
          role: 'user',
          content: `Extract key concepts from these documents. For each concept provide:
- name: short concept name
- definition: 1-2 sentence explanation
- sources: which document titles mention it
- related: other concept names it connects to (optional)

Return ONLY a valid JSON array:
[{"name":"...","definition":"...","sources":["..."],"related":["..."]}]

Documents:
${content}`,
        },
      ],
    });

    const block = res.content.find((b) => b.type === 'text');
    const text = block?.type === 'text' ? block.text : '[]';
    const match = text.match(/\[[\s\S]*\]/);
    try {
      return JSON.parse(match?.[0] ?? '[]') as RawConcept[];
    } catch {
      return [];
    }
  }

  async extract(sources: Source[]): Promise<KnowledgeEntry[]> {
    const batches = this.batch(sources);
    const allConcepts: RawConcept[] = [];

    for (const batch of batches) {
      try {
        const concepts = await this.extractBatch(batch);
        allConcepts.push(...concepts);
      } catch (e) {
        console.warn('[mem-plugin/concepts] extraction failed for batch:', e);
      }
    }

    // Deduplicate by name (case-insensitive)
    const seen = new Set<string>();
    const deduped = allConcepts.filter((c) => {
      const key = c.name.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    return deduped.map((c) => ({
      summary: `**${c.name}**: ${c.definition}`,
      facts: [
        ...c.sources.map((s) => `Mentioned in: ${s}`),
        ...(c.related?.length ? [`Related: ${c.related.join(', ')}`] : []),
      ],
      tags: ['concept', 'extracted'],
    }));
  }
}

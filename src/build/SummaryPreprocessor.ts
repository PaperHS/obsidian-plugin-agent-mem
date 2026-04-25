import Anthropic from '@anthropic-ai/sdk';
import type { Source } from '../types.js';

export interface PreprocessorConfig {
  apiKey: string;
  baseURL?: string;
  model?: string;
  concurrency?: number;
}

const SUMMARY_PROMPT = `Summarize this document using this exact structure:

**Core Conclusions**: Main insights and takeaways (2-3 sentences)
**Key Evidence**: Important facts, data, or examples
**Open Questions**: Unresolved issues or areas needing investigation
**Key Terms**: Domain-specific terminology and concepts

Be concise. Preserve technical accuracy. Output only the structured summary.`;

const MIN_LENGTH = 200; // skip summarizing very short docs

/**
 * Pre-processes each source document into a structured summary before
 * passing to the main compiler. Reduces noise and improves compilation quality.
 */
export class SummaryPreprocessor {
  private client: Anthropic;
  private model: string;
  private concurrency: number;

  constructor(cfg: PreprocessorConfig) {
    this.client = new Anthropic({
      apiKey: cfg.apiKey,
      ...(cfg.baseURL ? { baseURL: cfg.baseURL } : {}),
    });
    this.model = cfg.model ?? 'claude-haiku-4-5-20251001';
    this.concurrency = cfg.concurrency ?? 3;
  }

  private async summarizeOne(source: Source): Promise<Source> {
    if (source.content.trim().length < MIN_LENGTH) return source;

    try {
      const res = await this.client.messages.create({
        model: this.model,
        max_tokens: 1024,
        messages: [
          {
            role: 'user',
            content: `${SUMMARY_PROMPT}\n\n---\nTitle: ${source.title}\n\n${source.content}`,
          },
        ],
      });
      const block = res.content.find((b) => b.type === 'text');
      const summary = block?.type === 'text' ? block.text : '';
      if (!summary) return source;

      return {
        ...source,
        content: `# ${source.title}\n\n${summary}\n\n---\n*Original: ${source.content.length} chars*`,
      };
    } catch (e) {
      console.warn(`[mem-plugin/summarize] failed for "${source.title}":`, e);
      return source;
    }
  }

  async process(
    sources: Source[],
    onProgress?: (done: number, total: number) => void,
  ): Promise<Source[]> {
    const results: Source[] = new Array(sources.length);
    let done = 0;

    // Process in sliding window of `concurrency` concurrent requests
    const queue = sources.map((src, i) => ({ src, i }));
    const inFlight = new Set<Promise<void>>();

    const run = async (item: { src: Source; i: number }) => {
      results[item.i] = await this.summarizeOne(item.src);
      done++;
      onProgress?.(done, sources.length);
    };

    for (const item of queue) {
      let p: Promise<void>;
      p = run(item).then(() => { inFlight.delete(p); });
      inFlight.add(p);
      if (inFlight.size >= this.concurrency) {
        await Promise.race(inFlight);
      }
    }
    await Promise.all(inFlight);

    return results;
  }
}
